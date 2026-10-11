import { createHash, generateKeyPairSync, sign as signDer } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import { beforeAll, describe, expect, it } from "vitest";

import { encodeCbor, type Cbor } from "../domain/cbor.js";
import { IdentityError } from "../domain/error.js";
import { insertIdentityUser } from "./identity-user.js";
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
} from "../public/index.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const RP_ID = "auth.example.test";
const ORIGIN = "https://auth.example.test";

type Runtime = {
  productOnlyUrl: string;
  passwords: { identity: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function identityUrl(runtime: Runtime): string {
  const password = encodeURIComponent(runtime.passwords.identity);
  return `postgres://identity:${password}@127.0.0.1:5432/hub_product_only`;
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

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function clientData(type: string, challenge: Uint8Array, origin: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: Buffer.from(challenge).toString("base64url"),
      origin,
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
  rpId: string;
  signCount: number;
  credentialId?: Uint8Array;
  cose?: Uint8Array;
}): Uint8Array {
  const rpIdHash = new Uint8Array(createHash("sha256").update(Buffer.from(input.rpId)).digest());
  const attested = input.credentialId !== undefined && input.cose !== undefined;
  const flags = attested ? 0x41 : 0x01;
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, input.signCount);
  const parts: Uint8Array[] = [rpIdHash, Uint8Array.of(flags), count];
  if (attested && input.credentialId && input.cose) {
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, input.credentialId.byteLength);
    parts.push(new Uint8Array(16), length, input.credentialId, input.cose);
  }
  return concat(parts);
}

function attestationObject(authData: Uint8Array): Uint8Array {
  return encodeCbor(
    new Map<Cbor, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map<Cbor, Cbor>()],
      ["authData", authData],
    ]),
  );
}

async function signer(): Promise<{
  x: Uint8Array;
  y: Uint8Array;
  sign: (data: Uint8Array) => Promise<Uint8Array>;
  signRaw: (data: Uint8Array) => Promise<Uint8Array>;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const webKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKey.export({ format: "der", type: "pkcs8" }),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return {
    x: new Uint8Array(Buffer.from(jwk.x ?? "", "base64url")),
    y: new Uint8Array(Buffer.from(jwk.y ?? "", "base64url")),
    sign: async (data) =>
      new Uint8Array(signDer("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "der" })),
    signRaw: async (data) =>
      new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, webKey, data)),
  };
}

beforeAll(async () => {
  const runtime = loadRuntime();
  const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

describe("passkeys", () => {
  async function clearIdentity(sql: ReturnType<typeof createPlaintextIdentitySql>): Promise<void> {
    await sql`delete from identity.sessions`;
    await sql`delete from identity.passkey_credentials`;
    await sql`delete from identity.passkey_challenges`;
    await sql`delete from identity.otp_challenges`;
    await sql`delete from identity.users`;
    await sql`delete from identity.identity_keys`;
  }

  async function withSql<T>(
    run: (sql: ReturnType<typeof createPlaintextIdentitySql>) => Promise<T>,
  ) {
    const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
    try {
      await clearIdentity(sql);
      return await run(sql);
    } finally {
      await clearIdentity(sql);
      await sql.end({ timeout: 1 });
    }
  }

  it("registers an ES256 credential and rejects a duplicate id", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(7);
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      const options = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      expect(options.user.name).toBe(created.userId);
      expect(options.user.displayName).toBe(created.userId);
      expect(options.user.name).not.toContain("ada@example.com");
      expect(options.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
      expect(options.attestation).toBe("none");
      expect(options.authenticatorSelection).toEqual({
        userVerification: "preferred",
        residentKey: "required",
      });
      const authData = authenticatorData({
        rpId: RP_ID,
        signCount: 0,
        credentialId,
        cose: coseKey(key.x, key.y),
      });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", options.challenge, ORIGIN),
        attestationObject: attestationObject(authData),
      });
      const stored = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.passkey_credentials
      `;
      expect(stored).toEqual([{ n: 1 }]);

      const again = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      const duplicate = authenticatorData({
        rpId: RP_ID,
        signCount: 0,
        credentialId,
        cose: coseKey(key.x, key.y),
      });
      await expect(
        finishPasskeyRegistration(sql, {
          userId: created.userId,
          rpId: RP_ID,
          now,
          clientDataJSON: clientData("webauthn.create", again.challenge, ORIGIN),
          attestationObject: attestationObject(duplicate),
        }),
      ).rejects.toBeInstanceOf(IdentityError);
      const after = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.passkey_credentials
      `;
      expect(after).toEqual([{ n: 1 }]);
    });
  });

  it("authenticates, rejects a bad origin, an old challenge, and a sign count that does not increase", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(9);
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      const registration = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", registration.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId,
            cose: coseKey(key.x, key.y),
          }),
        ),
      });

      const options = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const challenges = await sql<{ user_id: string | null; kind: string }[]>`
        select user_id, kind from identity.passkey_challenges where kind = 'authenticate'
      `;
      expect(challenges).toEqual([{ user_id: null, kind: "authenticate" }]);
      const authData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const client = clientData("webauthn.get", options.challenge, ORIGIN);
      const signature = await key.sign(concat([authData, await sha256(client)]));
      const verified = await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature,
      });
      expect(verified).toMatchObject({ userId: created.userId, expiresIn: 900 });
      const counts = await sql<{ sign_count: number | string }[]>`
        select sign_count from identity.passkey_credentials
      `;
      expect(Number(counts[0]?.sign_count)).toBe(1);

      const usersBefore = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.users
      `;
      const badOrigin = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const badData = authenticatorData({ rpId: RP_ID, signCount: 2 });
      const badClient = clientData("webauthn.get", badOrigin.challenge, "https://evil.example");
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId,
          clientDataJSON: badClient,
          authenticatorData: badData,
          signature: await key.sign(concat([badData, await sha256(badClient)])),
        }),
      ).toBeNull();
      const usersAfter = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.users
      `;
      expect(usersAfter).toEqual(usersBefore);

      const stale = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const staleData = authenticatorData({ rpId: RP_ID, signCount: 3 });
      const staleClient = clientData("webauthn.get", stale.challenge, ORIGIN);
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now: new Date(now.getTime() + 5 * 60 * 1000 + 1),
          credentialId,
          clientDataJSON: staleClient,
          authenticatorData: staleData,
          signature: await key.sign(concat([staleData, await sha256(staleClient)])),
        }),
      ).toBeNull();

      await sql`update identity.passkey_credentials set sign_count = 2`;
      const held = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const heldData = authenticatorData({ rpId: RP_ID, signCount: 2 });
      const heldClient = clientData("webauthn.get", held.challenge, ORIGIN);
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId,
          clientDataJSON: heldClient,
          authenticatorData: heldData,
          signature: await key.sign(concat([heldData, await sha256(heldClient)])),
        }),
      ).toBeNull();

      const zeroId = new Uint8Array(16).fill(4);
      const zeroRegistration = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", zeroRegistration.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId: zeroId,
            cose: coseKey(key.x, key.y),
          }),
        ),
      });
      const zeroOptions = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const zeroData = authenticatorData({ rpId: RP_ID, signCount: 0 });
      const zeroClient = clientData("webauthn.get", zeroOptions.challenge, ORIGIN);
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId: zeroId,
          clientDataJSON: zeroClient,
          authenticatorData: zeroData,
          signature: await key.sign(concat([zeroData, await sha256(zeroClient)])),
        }),
      ).toMatchObject({ userId: created.userId, expiresIn: 900 });
    });
  });

  it("rejects a malformed DER signature and a raw 64-byte signature", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(3);
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      const registration = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", registration.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId,
            cose: coseKey(key.x, key.y),
          }),
        ),
      });

      const malformed = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const malformedData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const malformedClient = clientData("webauthn.get", malformed.challenge, ORIGIN);
      const der = await key.sign(concat([malformedData, await sha256(malformedClient)]));
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId,
          clientDataJSON: malformedClient,
          authenticatorData: malformedData,
          signature: concat([der, Uint8Array.of(0xff)]),
        }),
      ).toBeNull();

      const raw = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const rawData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const rawClient = clientData("webauthn.get", raw.challenge, ORIGIN);
      const rawSignature = await key.signRaw(concat([rawData, await sha256(rawClient)]));
      expect(rawSignature.byteLength).toBe(64);
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId,
          clientDataJSON: rawClient,
          authenticatorData: rawData,
          signature: rawSignature,
        }),
      ).toBeNull();
    });
  });

  it("returns one session when one assertion is finished twice in parallel", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(5);
    const runtime = loadRuntime();
    const url = identityUrl(runtime);
    const holder = postgres(url, { max: 1, prepare: true, onnotice: () => undefined });
    const sql = postgres(url, { max: 4, prepare: true, onnotice: () => undefined });
    const observer = createPlaintextDirectSql(runtime.productOnlyUrl);
    let pending: Promise<Awaited<ReturnType<typeof finishPasskeyAuthentication>>[]> =
      Promise.resolve([]);
    try {
      await clearIdentity(sql);
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      const registration = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", registration.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId,
            cose: coseKey(key.x, key.y),
          }),
        ),
      });
      const options = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const authData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const client = clientData("webauthn.get", options.challenge, ORIGIN);
      const signature = await key.sign(concat([authData, await sha256(client)]));
      const input = {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature,
      };
      let locked: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = holder.begin(async (tx) => {
        await tx`
          select id from identity.passkey_challenges
          where kind = 'authenticate'
          for update
        `;
        locked();
        const started = Date.now();
        while (Date.now() - started < 5_000) {
          const waiting = await observer<{ n: number }[]>`
            select count(*)::int as n
            from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event_type = 'Lock'
              and query like '%update identity.passkey_challenges%'
          `;
          if ((waiting[0]?.n ?? 0) >= 2) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        throw new Error("assertions did not wait on the challenge");
      });
      await lockHeld;
      pending = Promise.all([
        finishPasskeyAuthentication(sql, kms, KEY_ARN, input),
        finishPasskeyAuthentication(sql, kms, KEY_ARN, input),
      ]);
      await gate;
      const results = await pending;
      expect(results.filter((result) => result !== null)).toHaveLength(1);
    } finally {
      await pending.catch(() => undefined);
      await clearIdentity(sql);
      await sql.end({ timeout: 1 });
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
    }
  }, 15_000);
});
