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
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    "x-community-hub-hostname": AUTH_HOSTNAME,
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
});
