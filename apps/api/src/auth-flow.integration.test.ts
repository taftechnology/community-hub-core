import { createHash, generateKeyPairSync, sign as signDer } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import type { OtpMail } from "@community-hub/identity";
import { beforeAll, describe, expect, it } from "vitest";

import { authRoutes } from "./auth-routes.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { startServer } from "./server.js";
import { encodeCbor, type Cbor } from "../../../modules/core/identity/domain/cbor.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const AUTH_HOSTNAME = "auth.au.example.test";
const RP_ID = AUTH_HOSTNAME;
const ORIGIN = `https://${AUTH_HOSTNAME}`;

const pem = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../certs/rds-ap-southeast-2-bundle.pem"),
  "utf8",
);

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/test/.runtime.json",
);

type Runtime = {
  productOnlyUrl: string;
  passwords: { identity: string };
};

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function identityUrl(runtime: Runtime): string {
  const password = encodeURIComponent(runtime.passwords.identity);
  return `postgres://identity:${password}@127.0.0.1:5432/hub_product_only`;
}

function envFor(port: number): ServiceEnv {
  const read = readServiceEnv(
    {
      PORT: String(port),
      PGPORT: "5432",
      AWS_REGION: "ap-southeast-2",
      NODE_ENV: "test",
      COMMUNITY_HUB_ENVIRONMENT: "staging",
      API_HOSTNAME: "au.api.example.test",
      AUTH_HOSTNAME,
      WEBHOOKS_HOSTNAME: "webhooks.au.example.test",
      OPS_HOSTNAME: "ops.au.example.test",
      PGHOST: "127.0.0.1",
      PGDATABASE: "hub_product_only",
      PGUSER_APP: "app",
      PGUSER_IDENTITY: "identity",
      PGUSER_PLATFORM: "platform",
      PGPASSWORD_APP: "pw-app",
      PGPASSWORD_IDENTITY: "pw-identity",
      PGPASSWORD_PLATFORM: "pw-platform",
      ENVELOPE_KEY_ARN: KEY_ARN,
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

class MemoryMail implements OtpMail {
  last: { to: string; code: string } | undefined;

  send(input: { to: string; code: string }): Promise<void> {
    this.last = input;
    return Promise.resolve();
  }
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function bytesFrom(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function clientData(type: string, challenge: Uint8Array): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: b64(challenge),
      origin: ORIGIN,
    }),
  );
}

function coseKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  return encodeCbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}

function authenticatorData(input: {
  signCount: number;
  credentialId?: Uint8Array;
  cose?: Uint8Array;
}): Uint8Array {
  const rpIdHash = new Uint8Array(createHash("sha256").update(RP_ID).digest());
  const attested = input.credentialId !== undefined && input.cose !== undefined;
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, input.signCount);
  const parts = [rpIdHash, Uint8Array.of(attested ? 0x41 : 0x01), count];
  if (attested && input.credentialId && input.cose) {
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, input.credentialId.byteLength);
    parts.push(
      new Uint8Array(16),
      length,
      new Uint8Array(input.credentialId),
      new Uint8Array(input.cose),
    );
  }
  return concat(parts);
}

async function signer(): Promise<{
  x: Uint8Array;
  y: Uint8Array;
  sign: (data: Uint8Array) => Uint8Array;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    x: new Uint8Array(Buffer.from(jwk.x ?? "", "base64url")),
    y: new Uint8Array(Buffer.from(jwk.y ?? "", "base64url")),
    sign: (data) =>
      new Uint8Array(signDer("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "der" })),
  };
}

async function post(
  port: number,
  pathName: string,
  body: unknown,
  authorization?: string,
  hostname = AUTH_HOSTNAME,
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    "x-community-hub-hostname": hostname,
  });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

type CapturedLog = { message: string; fields: Record<string, unknown> };

type TestArtifact = {
  logs: CapturedLog[];
  responses: string[];
  secrets: string[];
};

const capturedArtifacts: TestArtifact[] = [];

async function cleanIdentity(sql: ReturnType<typeof createPlaintextIdentitySql>): Promise<void> {
  await sql`delete from identity.sessions`;
  await sql`delete from identity.passkey_credentials`;
  await sql`delete from identity.passkey_challenges`;
  await sql`delete from identity.otp_challenges`;
  await sql`delete from identity.users`;
  await sql`delete from identity.identity_keys`;
}

async function signInUser(
  port: number,
  mail: MemoryMail,
  email = "ada@example.com",
): Promise<{
  userId: string;
  accessToken: string;
  refreshToken: string;
}> {
  const started = await post(port, "/v1/auth/email-otp/start", { email });
  expect(started.status).toBe(204);
  const code = mail.last?.code ?? "";
  expect(code).toMatch(/^\d{8}$/);

  const verified = await post(port, "/v1/auth/email-otp/verify", {
    email,
    code,
  });
  expect(verified.status).toBe(200);
  return (await verified.json()) as {
    userId: string;
    accessToken: string;
    refreshToken: string;
  };
}

async function startAuthServer(options: {
  port: number;
  now: () => Date;
  sql: ReturnType<typeof createPlaintextIdentitySql>;
  mail: MemoryMail;
  log?: (message: string, fields: Record<string, unknown>) => void;
}) {
  const server = startServer({
    env: envFor(options.port),
    routes: authRoutes({
      checkout: (_role, run) => run(options.sql),
      kms: createLocalKmsPort(),
      keyArn: KEY_ARN,
      mail: options.mail,
      now: options.now,
      authHostname: AUTH_HOSTNAME,
      log: options.log ?? (() => undefined),
    }),
  });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  await cleanIdentity(options.sql);
  return server;
}

async function stopAuthServer(
  server: ReturnType<typeof startServer>,
  sql: ReturnType<typeof createPlaintextIdentitySql>,
) {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await cleanIdentity(sql);
  await sql.end({ timeout: 1 });
}

beforeAll(async () => {
  const migration = createPlaintextDirectSql(loadRuntime().productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

describe("auth flow", () => {
  it("starts, verifies, registers, authenticates, and refreshes through the server", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const runtime = loadRuntime();
    const sql = createPlaintextIdentitySql(identityUrl(runtime));
    const mail = new MemoryMail();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(4);
    const server = startServer({
      env: envFor(18470),
      routes: authRoutes({
        checkout: (_role, run) => run(sql),
        kms: createLocalKmsPort(),
        keyArn: KEY_ARN,
        mail,
        now: () => now,
        authHostname: AUTH_HOSTNAME,
        log: () => undefined,
      }),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        if (server.listening) {
          resolve();
          return;
        }
        server.once("listening", () => resolve());
        server.once("error", reject);
      });
      await sql`delete from identity.sessions`;
      await sql`delete from identity.passkey_credentials`;
      await sql`delete from identity.passkey_challenges`;
      await sql`delete from identity.otp_challenges`;
      await sql`delete from identity.users`;
      await sql`delete from identity.identity_keys`;

      const started = await post(18470, "/v1/auth/email-otp/start", { email: "ada@example.com" });
      expect(started.status).toBe(204);
      const code = mail.last?.code ?? "";
      expect(code).toMatch(/^\d{8}$/);

      const verified = await post(18470, "/v1/auth/email-otp/verify", {
        email: "ada@example.com",
        code,
      });
      expect(verified.status).toBe(200);
      expect(verified.headers.get("cache-control")).toBe("no-store");
      const first = (await verified.json()) as {
        userId: string;
        accessToken: string;
        refreshToken: string;
      };

      const options = await post(
        18470,
        "/v1/auth/passkey/register/options",
        {},
        `Bearer ${first.accessToken}`,
      );
      expect(options.status).toBe(200);
      const registration = (await options.json()) as { challenge: string };
      const challenge = bytesFrom(registration.challenge);
      const registered = await post(
        18470,
        "/v1/auth/passkey/register/verify",
        {
          clientDataJSON: b64(clientData("webauthn.create", challenge)),
          attestationObject: b64(
            encodeCbor(
              new Map<Cbor, Cbor>([
                ["fmt", "none"],
                ["attStmt", new Map<Cbor, Cbor>()],
                [
                  "authData",
                  authenticatorData({
                    signCount: 0,
                    credentialId,
                    cose: coseKey(key.x, key.y),
                  }),
                ],
              ]),
            ),
          ),
        },
        `Bearer ${first.accessToken}`,
      );
      expect(registered.status).toBe(204);

      const authOptions = await post(18470, "/v1/auth/passkey/authenticate/options", {});
      expect(authOptions.status).toBe(200);
      const authentication = (await authOptions.json()) as { challenge: string };
      const authChallenge = bytesFrom(authentication.challenge);
      const authData = authenticatorData({ signCount: 1 });
      const client = clientData("webauthn.get", authChallenge);
      const clientHash = new Uint8Array(createHash("sha256").update(client).digest());
      const authenticated = await post(18470, "/v1/auth/passkey/authenticate/verify", {
        credentialId: b64(credentialId),
        clientDataJSON: b64(client),
        authenticatorData: b64(authData),
        signature: b64(key.sign(concat([authData, clientHash]))),
      });
      expect(authenticated.status).toBe(200);
      expect(authenticated.headers.get("cache-control")).toBe("no-store");
      const second = (await authenticated.json()) as {
        userId: string;
        refreshToken: string;
      };
      expect(second.userId).toBe(first.userId);

      const refreshed = await post(18470, "/v1/auth/session/refresh", {
        refreshToken: second.refreshToken,
      });
      expect(refreshed.status).toBe(200);
      expect(refreshed.headers.get("cache-control")).toBe("no-store");
      const third = (await refreshed.json()) as { userId: string; refreshToken: string };
      expect(third.userId).toBe(first.userId);
      expect(third.refreshToken).not.toBe(second.refreshToken);
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await sql`delete from identity.sessions`;
      await sql`delete from identity.passkey_credentials`;
      await sql`delete from identity.passkey_challenges`;
      await sql`delete from identity.otp_challenges`;
      await sql`delete from identity.users`;
      await sql`delete from identity.identity_keys`;
      await sql.end({ timeout: 1 });
    }
  });

  it("signs out through the server, invalidating the session family", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const runtime = loadRuntime();
    const sql = createPlaintextIdentitySql(identityUrl(runtime));
    const mail = new MemoryMail();
    const server = startServer({
      env: envFor(18471),
      routes: authRoutes({
        checkout: (_role, run) => run(sql),
        kms: createLocalKmsPort(),
        keyArn: KEY_ARN,
        mail,
        now: () => now,
        authHostname: AUTH_HOSTNAME,
        log: () => undefined,
      }),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        if (server.listening) {
          resolve();
          return;
        }
        server.once("listening", () => resolve());
        server.once("error", reject);
      });
      await cleanIdentity(sql);

      const session = await signInUser(18471, mail, "ada@example.com");

      const beforeSignOut = await post(
        18471,
        "/v1/auth/passkey/register/options",
        {},
        `Bearer ${session.accessToken}`,
      );
      expect(beforeSignOut.status).toBe(200);

      const noBearer = await post(18471, "/v1/auth/session/end", {});
      expect(noBearer.status).toBe(401);

      const wrongHost = await post(
        18471,
        "/v1/auth/session/end",
        {},
        `Bearer ${session.accessToken}`,
        "wrong.example.test",
      );
      expect(wrongHost.status).toBe(404);

      const ended = await post(18471, "/v1/auth/session/end", {}, `Bearer ${session.accessToken}`);
      expect(ended.status).toBe(204);
      expect(ended.headers.get("cache-control")).toBe("no-store");

      const afterSignOutPasskey = await post(
        18471,
        "/v1/auth/passkey/register/options",
        {},
        `Bearer ${session.accessToken}`,
      );
      expect(afterSignOutPasskey.status).toBe(401);

      const afterSignOutRefresh = await post(18471, "/v1/auth/session/refresh", {
        refreshToken: session.refreshToken,
      });
      expect(afterSignOutRefresh.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await sql`delete from identity.sessions`;
      await sql`delete from identity.passkey_credentials`;
      await sql`delete from identity.passkey_challenges`;
      await sql`delete from identity.otp_challenges`;
      await sql`delete from identity.users`;
      await sql`delete from identity.identity_keys`;
      await sql.end({ timeout: 1 });
    }
  });

  it("cross-site POST is refused", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const logs: CapturedLog[] = [];
    const mail = new MemoryMail();
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    const server = await startAuthServer({
      port: 18472,
      now: () => now,
      sql,
      mail,
      log: (message, fields) => logs.push({ message, fields }),
    });
    try {
      const session = await signInUser(18472, mail);

      const crossSite = await fetch("http://127.0.0.1:18472/v1/auth/session/end", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-community-hub-hostname": AUTH_HOSTNAME,
          origin: "https://evil.example",
          cookie: "session=stolen",
        },
        body: JSON.stringify({}),
      });
      expect(crossSite.status).toBe(401);
      const crossSiteBody = await crossSite.text();
      expect(crossSiteBody).toBe("");
      expect(crossSite.headers.get("access-control-allow-origin")).toBeNull();

      const live = await post(
        18472,
        "/v1/auth/passkey/register/options",
        {},
        `Bearer ${session.accessToken}`,
      );
      expect(live.status).toBe(200);
      const liveBody = await live.text();

      capturedArtifacts.push({
        logs,
        responses: [crossSiteBody, liveBody],
        secrets: [session.accessToken, session.refreshToken, "ada@example.com"],
      });
    } finally {
      await stopAuthServer(server, sql);
    }
  });

  it("cross-site preflight gets no permission", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const logs: CapturedLog[] = [];
    const mail = new MemoryMail();
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    const server = await startAuthServer({
      port: 18473,
      now: () => now,
      sql,
      mail,
      log: (message, fields) => logs.push({ message, fields }),
    });
    try {
      const preflight = await fetch("http://127.0.0.1:18473/v1/auth/session/end", {
        method: "OPTIONS",
        headers: {
          "x-community-hub-hostname": AUTH_HOSTNAME,
          origin: "https://evil.example",
          "access-control-request-method": "POST",
        },
      });
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
      expect(preflight.headers.get("access-control-allow-headers")).toBeNull();
      const preflightBody = await preflight.text();

      capturedArtifacts.push({
        logs,
        responses: [preflightBody],
        secrets: [],
      });
    } finally {
      await stopAuthServer(server, sql);
    }
  });

  it("calling it twice is harmless", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const logs: CapturedLog[] = [];
    const mail = new MemoryMail();
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    const server = await startAuthServer({
      port: 18474,
      now: () => now,
      sql,
      mail,
      log: (message, fields) => logs.push({ message, fields }),
    });
    try {
      const session = await signInUser(18474, mail);

      const first = await post(18474, "/v1/auth/session/end", {}, `Bearer ${session.accessToken}`);
      expect(first.status).toBe(204);
      const firstBody = await first.text();
      expect(firstBody).toBe("");
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(first.headers.get("set-cookie")).toBeNull();

      const second = await post(18474, "/v1/auth/session/end", {}, `Bearer ${session.accessToken}`);
      expect(second.status).toBe(204);
      const secondBody = await second.text();
      expect(secondBody).toBe("");
      expect(second.headers.get("cache-control")).toBe("no-store");
      expect(second.headers.get("set-cookie")).toBeNull();

      capturedArtifacts.push({
        logs,
        responses: [firstBody, secondBody],
        secrets: [session.accessToken, session.refreshToken, "ada@example.com"],
      });
    } finally {
      await stopAuthServer(server, sql);
    }
  });

  it("expired session", async () => {
    let now = new Date("2026-10-11T00:00:00.000Z");
    const logs: CapturedLog[] = [];
    const mail = new MemoryMail();
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    const server = await startAuthServer({
      port: 18475,
      now: () => now,
      sql,
      mail,
      log: (message, fields) => logs.push({ message, fields }),
    });
    try {
      const session = await signInUser(18475, mail);
      now = new Date(now.getTime() + 16 * 60 * 1000);

      const ended = await post(18475, "/v1/auth/session/end", {}, `Bearer ${session.accessToken}`);
      expect(ended.status).toBe(204);
      const endedBody = await ended.text();
      expect(endedBody).toBe("");

      const refreshed = await post(18475, "/v1/auth/session/refresh", {
        refreshToken: session.refreshToken,
      });
      expect(refreshed.status).toBe(401);
      const refreshedBody = await refreshed.text();

      capturedArtifacts.push({
        logs,
        responses: [endedBody, refreshedBody],
        secrets: [session.accessToken, session.refreshToken, "ada@example.com"],
      });
    } finally {
      await stopAuthServer(server, sql);
    }
  });

  it("no oracle", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const logs: CapturedLog[] = [];
    const mail = new MemoryMail();
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    const server = await startAuthServer({
      port: 18476,
      now: () => now,
      sql,
      mail,
      log: (message, fields) => logs.push({ message, fields }),
    });
    try {
      const session = await signInUser(18476, mail);

      const matched = await post(
        18476,
        "/v1/auth/session/end",
        {},
        `Bearer ${session.accessToken}`,
      );
      const repeated = await post(
        18476,
        "/v1/auth/session/end",
        {},
        `Bearer ${session.accessToken}`,
      );
      const garbled = await post(18476, "/v1/auth/session/end", {}, "Bearer not-a-real-token");

      expect(matched.status).toBe(204);
      expect(repeated.status).toBe(matched.status);
      expect(garbled.status).toBe(matched.status);

      const matchedBody = await matched.text();
      const repeatedBody = await repeated.text();
      const garbledBody = await garbled.text();
      expect(matchedBody).toBe("");
      expect(repeatedBody).toBe("");
      expect(garbledBody).toBe("");

      const headerNames = (r: Response) => Array.from(r.headers.keys()).sort();
      expect(headerNames(repeated)).toEqual(headerNames(matched));
      expect(headerNames(garbled)).toEqual(headerNames(matched));

      capturedArtifacts.push({
        logs,
        responses: [matchedBody, repeatedBody, garbledBody],
        secrets: [session.accessToken, session.refreshToken, "ada@example.com"],
      });
    } finally {
      await stopAuthServer(server, sql);
    }
  });

  it("nothing leaks", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const logs: CapturedLog[] = [];
    const mail = new MemoryMail();
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    const server = await startAuthServer({
      port: 18477,
      now: () => now,
      sql,
      mail,
      log: (message, fields) => logs.push({ message, fields }),
    });
    try {
      const session = await signInUser(18477, mail);
      const ended = await post(18477, "/v1/auth/session/end", {}, `Bearer ${session.accessToken}`);
      expect(ended.status).toBe(204);
      const endedBody = await ended.text();
      expect(endedBody).toBe("");

      capturedArtifacts.push({
        logs,
        responses: [endedBody],
        secrets: [session.accessToken, session.refreshToken, "ada@example.com"],
      });

      expect(capturedArtifacts.length).toBeGreaterThanOrEqual(1);
      for (const artifact of capturedArtifacts) {
        const joinedLogs = artifact.logs.map((entry) => JSON.stringify(entry)).join("\n");
        for (const secret of artifact.secrets) {
          expect(joinedLogs).not.toContain(secret);
          for (const body of artifact.responses) {
            expect(body).not.toContain(secret);
          }
        }
      }
    } finally {
      await stopAuthServer(server, sql);
    }
  });
});
