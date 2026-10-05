import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { boot, listeningServer, run } from "./index.js";

const pem = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../certs/rds-ap-southeast-2-bundle.pem"),
  "utf8",
);

const marker = "arn:aws:kms:ap-southeast-2:123456789012:alias/not-a-key";

function source(): NodeJS.ProcessEnv {
  return {
    PORT: "39453",
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
