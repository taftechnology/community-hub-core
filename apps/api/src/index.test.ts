import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@community-hub/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readServiceEnv } from "./env.js";
import { bindServices, boot, listeningServer, run } from "./index.js";

const pem = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../certs/rds-ap-southeast-2-bundle.pem"),
  "utf8",
);

const marker = "arn:aws:kms:ap-southeast-2:123456789012:alias/not-a-key";

function source(): NodeJS.ProcessEnv {
  return {
    PORT: "18453",
    PGPORT: "5432",
    AWS_REGION: "ap-southeast-2",
    NODE_ENV: "test",
    COMMUNITY_HUB_ENVIRONMENT: "staging",
    API_HOSTNAME: "au.api.example.test",
    AUTH_HOSTNAME: "auth.au.example.test",
    WEBHOOKS_HOSTNAME: "webhooks.au.example.test",
    OPS_HOSTNAME: "ops.au.example.test",
    PGHOST: "db.internal",
    PGDATABASE: "communityhub",
    PGUSER_APP: "app",
    PGUSER_IDENTITY: "identity",
    PGUSER_PLATFORM: "platform",
    PGPASSWORD_APP: "pw-app",
    PGPASSWORD_IDENTITY: "pw-identity",
    PGPASSWORD_PLATFORM: "pw-platform",
    ENVELOPE_KEY_ARN: marker,
    APP_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app",
    IDENTITY_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity",
    PLATFORM_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform",
  };
}

describe("api entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeningServer()?.closeAllConnections();
    listeningServer()?.close();
  });

  it("does not listen when the module is imported", () => {
    expect(listeningServer()).toBeUndefined();
  });

  it("writes env and does not listen when the envelope key is an alias", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    const code = run(source(), pem, [
      {
        method: "GET",
        pattern: "/health",
        surface: "all",
        handle: () => Response.json({ ok: true }),
      },
    ]);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["env\n"]);
    expect(stderr.join("")).not.toContain(marker);
    expect(listeningServer()).toBeUndefined();
  });

  it("writes routes when the table is rejected", () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const env = source();
    env.ENVELOPE_KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

    const code = run(env, pem, [
      {
        method: "GET",
        pattern: "/other",
        surface: "all",
        handle: () => new Response(null, { status: 204 }),
      },
    ]);

    expect(code).toBe(1);
    expect(stderr).toEqual(["routes\n"]);
    expect(stderr.join("")).not.toContain("/other");
    expect(listeningServer()).toBeUndefined();
  });

  it("prints env and exits 1 when the certificate file is missing", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    let code: number | undefined;
    boot({
      readPem: () => {
        throw new Error("marker-missing-cert");
      },
      source: source(),
      routes: [
        {
          method: "GET",
          pattern: "/health",
          surface: "all",
          handle: () => Response.json({ ok: true }),
        },
      ],
      exit: (value) => {
        code = value;
      },
    });
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["env\n"]);
    expect(stderr.join("")).not.toContain("marker-missing-cert");
    expect(listeningServer()).toBeUndefined();
  });
});

describe("api boot wiring of the kms adapter log", () => {
  const keyArn = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
  const otherKeyId = "marker-not-the-configured-key-9d41";
  const context = { key_kind: "identity", region: "au", key_version: "1" } as const;

  function env() {
    const read = readServiceEnv({ ...source(), ENVELOPE_KEY_ARN: keyArn }, pem);
    if (!read.ok) {
      throw new Error("test env is invalid");
    }
    return read.env;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a kms line with only allow-listed fields when the adapter reports a failure", async () => {
    const written: string[] = [];
    const logger = createLogger({ write: (line) => written.push(line) });
    const bound = bindServices(env(), pem, logger);

    await expect(
      bound.auth.kms.decrypt(otherKeyId, new Uint8Array([1, 2, 3]), context),
    ).rejects.toThrow();

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "{}")).toEqual({
      level: "info",
      message: "kms",
      operation: "decrypt",
      key_kind: "identity",
      outcome: "rejected",
    });
    expect(written[0]).not.toContain(otherKeyId);
    expect(written[0]).not.toContain(keyArn);
    expect(written[0]).not.toContain("123456789012");
    expect(logger.getDroppedFieldCount()).toBe(0);
  });

  it("shares one adapter between the auth and access routes", async () => {
    const written: string[] = [];
    const bound = bindServices(env(), pem, createLogger({ write: (line) => written.push(line) }));

    await expect(bound.access.kms.generateDataKey(otherKeyId, context)).rejects.toThrow();

    expect(bound.access.kms).toBe(bound.auth.kms);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "{}")).toMatchObject({
      message: "kms",
      operation: "generate_data_key",
      outcome: "rejected",
    });
  });

  it("uses a real logger when none is passed", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const bound = bindServices(env(), pem);

    await expect(
      bound.auth.kms.decrypt(otherKeyId, new Uint8Array([1]), context),
    ).rejects.toThrow();

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ message: "kms", outcome: "rejected" });
  });
});
