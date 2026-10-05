import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readServiceEnv, type ServiceEnv } from "./env.js";
import type { GateRoute } from "./gate.js";

const db = vi.hoisted(() => ({
  createDirectSql: vi.fn(),
  createAppSql: vi.fn(),
  createIdentitySql: vi.fn(),
  createPlatformSql: vi.fn(),
}));

const kms = vi.hoisted(() => ({
  createAwsKmsPort: vi.fn(),
}));

vi.mock("@community-hub/db", () => db);
vi.mock("./kms/aws-kms-adapter.js", () => kms);

import { startServer } from "./server.js";

const pem = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../certs/rds-ap-southeast-2-bundle.pem"),
  "utf8",
);

function envFor(port: number): ServiceEnv {
  const read = readServiceEnv(
    {
      PORT: String(port),
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
      ENVELOPE_KEY_ARN: `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`,
      APP_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app",
      IDENTITY_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity",
      PLATFORM_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform",
    },
    pem,
  );
  if (!read.ok) {
    throw new Error("synthetic env");
  }
  return read.env;
}

const health: GateRoute = {
  method: "GET",
  pattern: "/health",
  surface: "all",
  handle: () => Response.json({ ok: true }),
};

async function listening(server: ReturnType<typeof startServer>): Promise<void> {
  if (server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });
}

describe("startServer", () => {
  const servers: Array<ReturnType<typeof startServer>> = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("listens and answers loopback health without a factory or send", async () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@community-hub/db");
    expect(source).not.toContain("aws-kms-adapter");

    const env = envFor(39451);
    const server = startServer({ env, routes: [health] });
    servers.push(server);
    await listening(server);

    expect(server.keepAliveTimeout).toBe(65000);
    expect(server.headersTimeout).toBe(66000);
    expect(server.address()).toMatchObject({ address: "0.0.0.0", port: 39451 });

    const response = await fetch("http://127.0.0.1:39451/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(db.createDirectSql).not.toHaveBeenCalled();
    expect(db.createAppSql).not.toHaveBeenCalled();
    expect(db.createIdentitySql).not.toHaveBeenCalled();
    expect(db.createPlatformSql).not.toHaveBeenCalled();
    expect(kms.createAwsKmsPort).not.toHaveBeenCalled();
  });

  it("drains on an injected signal and exits without stopping the test runner", async () => {
    const env = envFor(39452);
    let exitCode: number | undefined;
    let onTerm: (() => void) | undefined;
    const started = Date.now();
    const server = startServer({
      env,
      routes: [
        health,
        {
          method: "GET",
          pattern: "/quick",
          surface: "tenant",
          handle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return Response.json({ ok: true });
          },
        },
        {
          method: "GET",
          pattern: "/hang",
          surface: "tenant",
          handle: () => new Promise(() => {}),
        },
      ],
      acceptForMs: 30,
      forceCloseMs: 80,
      signals: {
        on(_signal, listener) {
          onTerm = listener;
        },
      },
      exit: (code) => {
        exitCode = code;
      },
    });
    servers.push(server);
    await listening(server);

    const headers = { "x-community-hub-hostname": "au.api.example.test" };
    const quick = fetch("http://127.0.0.1:39452/quick", { headers });
    const hangSettled = fetch("http://127.0.0.1:39452/hang", { headers }).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    onTerm?.();

    const finished = await quick;
    expect(finished.status).toBe(200);
    expect(await finished.json()).toEqual({ ok: true });

    await vi.waitFor(() => expect(exitCode).toBe(0), { timeout: 500 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(await hangSettled).toBe("rejected");
  });
});
