import { readFileSync } from "node:fs";
import { ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readServiceEnv, type ServiceEnv } from "./env.js";
import type { GateRoute } from "./gate.js";
import { productionRoutes } from "./index.js";

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

import { REQUEST_TIMEOUT_MS, startServer } from "./server.js";

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
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
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

    const env = envFor(18451);
    const server = startServer({ env, routes: productionRoutes(env, pem) });
    servers.push(server);
    await listening(server);

    expect(REQUEST_TIMEOUT_MS).toBe(30000);
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect(server.keepAliveTimeout).toBe(65000);
    expect(server.headersTimeout).toBe(30000);
    expect(server.address()).toMatchObject({ address: "0.0.0.0", port: 18451 });

    const response = await fetch("http://127.0.0.1:18451/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(db.createDirectSql).not.toHaveBeenCalled();
    expect(db.createAppSql).not.toHaveBeenCalled();
    expect(db.createIdentitySql).not.toHaveBeenCalled();
    expect(db.createPlatformSql).not.toHaveBeenCalled();
    expect(kms.createAwsKmsPort).not.toHaveBeenCalled();
  });

  it("drains on an injected signal and exits without stopping the test runner", async () => {
    const env = envFor(18452);
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
    const quick = fetch("http://127.0.0.1:18452/quick", { headers });
    const hangSettled = fetch("http://127.0.0.1:18452/hang", { headers }).then(
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

  it("answers TRACE and still serves the next health check", async () => {
    const env = envFor(18454);
    const server = startServer({ env, routes: [health] });
    servers.push(server);
    await listening(server);

    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(18454, "127.0.0.1");
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.includes("\r\n\r\n")) {
          socket.end();
          resolve(received);
        }
      });
      socket.on("error", reject);
      socket.write("TRACE /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    });

    const body = raw.split("\r\n\r\n")[1] ?? "";
    expect(raw.startsWith("HTTP/1.1 ")).toBe(true);
    expect(body).toBe("");
    expect(raw).not.toContain("TypeError");
    const response = await fetch("http://127.0.0.1:18454/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("closes a request that never sends its body", async () => {
    const requestTimeoutMs = 200;
    const env = envFor(18458);
    const server = startServer({ env, routes: [health], requestTimeoutMs });
    servers.push(server);
    await listening(server);

    const started = Date.now();
    const closed = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("still-open")), requestTimeoutMs + 1000);
      const socket = net.connect(18458, "127.0.0.1");
      socket.on("data", () => {});
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(Date.now() - started);
      });
      socket.on("error", () => {});
      socket.write("POST /health HTTP/1.1\r\nHost: parish.example\r\nContent-Length: 64\r\n\r\n");
    });
    expect(closed).toBeLessThan(requestTimeoutMs + 800);
  });

  it("destroys the socket when headers were already sent", async () => {
    const env = envFor(18457);
    const server = startServer({
      env,
      routes: [
        health,
        {
          method: "GET",
          pattern: "/partial",
          surface: "tenant",
          handle: () => new Response("ok"),
        },
      ],
    });
    servers.push(server);
    await listening(server);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const originalEnd = ServerResponse.prototype.end;
    const originalWriteHead = ServerResponse.prototype.writeHead;
    let thrown = false;
    let writeHeads = 0;
    ServerResponse.prototype.end = function end(this: ServerResponse, ...args: unknown[]) {
      if (!thrown) {
        thrown = true;
        throw new Error("marker-end");
      }
      return Reflect.apply(originalEnd, this, args) as ServerResponse;
    } as typeof ServerResponse.prototype.end;
    ServerResponse.prototype.writeHead = function writeHead(
      this: ServerResponse,
      ...args: unknown[]
    ) {
      writeHeads += 1;
      return Reflect.apply(originalWriteHead, this, args) as ServerResponse;
    } as typeof ServerResponse.prototype.writeHead;

    try {
      const settled = await fetch("http://127.0.0.1:18457/partial", {
        headers: { "x-community-hub-hostname": "au.api.example.test" },
        signal: AbortSignal.timeout(1000),
      }).then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
      expect(settled).toBe("rejected");
      expect(writeHeads).toBe(1);
      expect(writes.join("")).not.toContain("marker-end");
    } finally {
      ServerResponse.prototype.end = originalEnd;
      ServerResponse.prototype.writeHead = originalWriteHead;
      spy.mockRestore();
    }

    const response = await fetch("http://127.0.0.1:18457/health");
    expect(response.status).toBe(200);
  });

  it("keeps listening when a handler throws", async () => {
    const env = envFor(18455);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const server = startServer({
      env,
      routes: [
        health,
        {
          method: "GET",
          pattern: "/boom",
          surface: "tenant",
          handle: () => {
            throw new Error("marker-handler");
          },
        },
      ],
    });
    servers.push(server);
    await listening(server);

    const boom = await fetch("http://127.0.0.1:18455/boom", {
      headers: { "x-community-hub-hostname": "au.api.example.test" },
    });
    expect(boom.status).toBeGreaterThanOrEqual(400);
    expect(await boom.text()).toBe("");
    expect(writes.join("")).not.toContain("marker-handler");
    const response = await fetch("http://127.0.0.1:18455/health");
    expect(response.status).toBe(200);
    spy.mockRestore();
  });

  it("exits after the accept window when nothing is connected", async () => {
    const env = envFor(18456);
    let exitCode: number | undefined;
    let onTerm: (() => void) | undefined;
    const server = startServer({
      env,
      routes: [health],
      acceptForMs: 40,
      forceCloseMs: 250,
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

    const marked = Date.now();
    onTerm?.();
    await vi.waitFor(() => expect(exitCode).toBe(0), { timeout: 400 });
    const elapsed = Date.now() - marked;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(150);
  });

  it("rejects a POST body over 4096 bytes without calling the handler", async () => {
    const env = envFor(18459);
    let calls = 0;
    const server = startServer({
      env,
      routes: [
        health,
        {
          method: "POST",
          pattern: "/v1/auth/email-otp/start",
          surface: "tenant",
          handle: () => {
            calls += 1;
            return new Response(null, { status: 204 });
          },
        },
      ],
    });
    servers.push(server);
    await listening(server);

    const response = await fetch("http://127.0.0.1:18459/v1/auth/email-otp/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-community-hub-hostname": "auth.au.example.test",
      },
      body: "a".repeat(4097),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(calls).toBe(0);
  });

  it("a 10 KiB POST to the webhook path with the webhooks hostname header reaches the handler", async () => {
    const env = envFor(18460);
    let calls = 0;
    const server = startServer({
      env,
      routes: [
        health,
        {
          method: "POST",
          pattern: "/v1/stripe/webhook",
          surface: "tenant",
          largeBody: "webhooks",
          handle: () => {
            calls += 1;
            return new Response(null, { status: 200 });
          },
        },
      ],
    });
    servers.push(server);
    await listening(server);

    const response = await fetch("http://127.0.0.1:18460/v1/stripe/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-community-hub-hostname": env.WEBHOOKS_HOSTNAME,
      },
      body: "a".repeat(10240),
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("262145 bytes to the webhook path gets 413, and the handler is not called", async () => {
    const env = envFor(18461);
    let calls = 0;
    const server = startServer({
      env,
      routes: [
        health,
        {
          method: "POST",
          pattern: "/v1/stripe/webhook",
          surface: "tenant",
          largeBody: "webhooks",
          handle: () => {
            calls += 1;
            return new Response(null, { status: 200 });
          },
        },
      ],
    });
    servers.push(server);
    await listening(server);

    const response = await fetch("http://127.0.0.1:18461/v1/stripe/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-community-hub-hostname": env.WEBHOOKS_HOSTNAME,
      },
      body: "a".repeat(262145),
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("");
    expect(calls).toBe(0);
  });

  it("a 4097-byte POST to /v1/access/grants still gets 400", async () => {
    const env = envFor(18462);
    let calls = 0;
    const server = startServer({
      env,
      routes: [
        health,
        {
          method: "POST",
          pattern: "/v1/access/grants",
          surface: "tenant",
          handle: () => {
            calls += 1;
            return new Response(null, { status: 204 });
          },
        },
      ],
    });
    servers.push(server);
    await listening(server);

    const response = await fetch("http://127.0.0.1:18462/v1/access/grants", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-community-hub-hostname": env.API_HOSTNAME,
      },
      body: "a".repeat(4097),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(calls).toBe(0);
  });

  it("a 10 KiB POST to the webhook path with the api hostname header gets 400", async () => {
    const env = envFor(18463);
    let calls = 0;
    const server = startServer({
      env,
      routes: [
        health,
        {
          method: "POST",
          pattern: "/v1/stripe/webhook",
          surface: "tenant",
          largeBody: "webhooks",
          handle: () => {
            calls += 1;
            return new Response(null, { status: 200 });
          },
        },
      ],
    });
    servers.push(server);
    await listening(server);

    const response = await fetch("http://127.0.0.1:18463/v1/stripe/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-community-hub-hostname": env.API_HOSTNAME,
      },
      body: "a".repeat(10240),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(calls).toBe(0);
  });
});
