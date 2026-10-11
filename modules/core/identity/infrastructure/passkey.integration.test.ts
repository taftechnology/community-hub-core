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
  flags?: number;
}): Uint8Array {
  const rpIdHash = new Uint8Array(createHash("sha256").update(Buffer.from(input.rpId)).digest());
  const attested = input.credentialId !== undefined && input.cose !== undefined;
  const flags = input.flags ?? (attested ? 0x41 : 0x01);
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

function derInteger(value: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(0x02, value.byteLength), value]);
}

function encodeDer(r: Uint8Array, s: Uint8Array): Uint8Array {
  const body = concat([derInteger(r), derInteger(s)]);
  return concat([Uint8Array.of(0x30, body.byteLength), body]);
}

function splitDer(der: Uint8Array): { r: Uint8Array; s: Uint8Array } {
  const rLength = der[3] ?? 0;
  const r = der.slice(4, 4 + rLength);
  const sLength = der[4 + rLength + 1] ?? 0;
  const sStart = 4 + rLength + 2;
  return { r, s: der.slice(sStart, sStart + sLength) };
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
      const trailing = concat([der, Uint8Array.of(0xff)]);
      expect(trailing.byteLength).toBe(der.byteLength + 1);
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId,
          clientDataJSON: malformedClient,
          authenticatorData: malformedData,
          signature: trailing,
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

  it("rejects an off-curve point and a credential id longer than 1023 bytes", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const offCurve = new Uint8Array(32).fill(1);
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      const options = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      await expect(
        finishPasskeyRegistration(sql, {
          userId: created.userId,
          rpId: RP_ID,
          now,
          clientDataJSON: clientData("webauthn.create", options.challenge, ORIGIN),
          attestationObject: attestationObject(
            authenticatorData({
              rpId: RP_ID,
              signCount: 0,
              credentialId: new Uint8Array(16).fill(2),
              cose: coseKey(offCurve, offCurve),
            }),
          ),
        }),
      ).rejects.toMatchObject({ code: "invalid_ceremony" });
      const stored = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.passkey_credentials
      `;
      expect(stored).toEqual([{ n: 0 }]);

      const again = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      const key = await signer();
      await expect(
        finishPasskeyRegistration(sql, {
          userId: created.userId,
          rpId: RP_ID,
          now,
          clientDataJSON: clientData("webauthn.create", again.challenge, ORIGIN),
          attestationObject: attestationObject(
            authenticatorData({
              rpId: RP_ID,
              signCount: 0,
              credentialId: new Uint8Array(1024).fill(3),
              cose: coseKey(key.x, key.y),
            }),
          ),
        }),
      ).rejects.toMatchObject({ code: "invalid_ceremony" });
      const after = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.passkey_credentials
      `;
      expect(after).toEqual([{ n: 0 }]);

      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId: new Uint8Array(1024).fill(3),
          clientDataJSON: clientData("webauthn.get", new Uint8Array(32), ORIGIN),
          authenticatorData: authenticatorData({ rpId: RP_ID, signCount: 1 }),
          signature: Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01),
        }),
      ).toBeNull();
    });
  });

  it("returns null when a stored passkey cannot be imported", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const offCurve = new Uint8Array(32).fill(1);
    const credentialId = new Uint8Array(16).fill(8);
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      await sql`
        insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count)
        values (
          ${crypto.randomUUID()},
          ${created.userId},
          ${credentialId},
          ${coseKey(offCurve, offCurve)},
          0
        )
      `;
      const options = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const authData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const client = clientData("webauthn.get", options.challenge, ORIGIN);
      await expect(
        finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature: Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01),
        }),
      ).resolves.toBeNull();
    });
  });

  it("rejects each registration check that the ceremony requires", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      const cases: Array<(challenge: Uint8Array) => { client: Uint8Array; object: Uint8Array }> = [
        (challenge) => ({
          client: clientData("webauthn.create", challenge, "https://evil.example"),
          object: attestationObject(
            authenticatorData({
              rpId: RP_ID,
              signCount: 0,
              credentialId: new Uint8Array(16).fill(1),
              cose: coseKey(key.x, key.y),
            }),
          ),
        }),
        (challenge) => ({
          client: clientData("webauthn.get", challenge, ORIGIN),
          object: attestationObject(
            authenticatorData({
              rpId: RP_ID,
              signCount: 0,
              credentialId: new Uint8Array(16).fill(1),
              cose: coseKey(key.x, key.y),
            }),
          ),
        }),
        (challenge) => ({
          client: clientData("webauthn.create", challenge, ORIGIN),
          object: attestationObject(
            authenticatorData({
              rpId: "other.example.test",
              signCount: 0,
              credentialId: new Uint8Array(16).fill(1),
              cose: coseKey(key.x, key.y),
            }),
          ),
        }),
        (challenge) => ({
          client: clientData("webauthn.create", challenge, ORIGIN),
          object: attestationObject(
            authenticatorData({
              rpId: RP_ID,
              signCount: 0,
              credentialId: new Uint8Array(16).fill(1),
              cose: coseKey(key.x, key.y),
              flags: 0x40,
            }),
          ),
        }),
        (challenge) => ({
          client: clientData("webauthn.create", challenge, ORIGIN),
          object: encodeCbor(
            new Map<Cbor, Cbor>([
              ["fmt", "packed"],
              ["attStmt", new Map<Cbor, Cbor>()],
              [
                "authData",
                authenticatorData({
                  rpId: RP_ID,
                  signCount: 0,
                  credentialId: new Uint8Array(16).fill(1),
                  cose: coseKey(key.x, key.y),
                }),
              ],
            ]),
          ),
        }),
        (challenge) => ({
          client: clientData("webauthn.create", challenge, ORIGIN),
          object: encodeCbor(
            new Map<Cbor, Cbor>([
              ["fmt", "none"],
              ["attStmt", new Map<Cbor, Cbor>([["alg", -7]])],
              [
                "authData",
                authenticatorData({
                  rpId: RP_ID,
                  signCount: 0,
                  credentialId: new Uint8Array(16).fill(1),
                  cose: coseKey(key.x, key.y),
                }),
              ],
            ]),
          ),
        }),
        (challenge) => ({
          client: clientData("webauthn.create", challenge, ORIGIN),
          object: attestationObject(
            authenticatorData({
              rpId: RP_ID,
              signCount: 0,
              credentialId: new Uint8Array(16).fill(1),
              cose: encodeCbor(
                new Map<Cbor, Cbor>([
                  [1, 2],
                  [3, -8],
                  [-1, 1],
                  [-2, key.x],
                  [-3, key.y],
                ]),
              ),
            }),
          ),
        }),
      ];
      for (const [index, build] of cases.entries()) {
        const options = await beginPasskeyRegistration(sql, {
          userId: created.userId,
          rpId: RP_ID,
          now,
        });
        const built = build(options.challenge);
        await expect(
          finishPasskeyRegistration(sql, {
            userId: created.userId,
            rpId: RP_ID,
            now,
            clientDataJSON: built.client,
            attestationObject: built.object,
          }),
        ).rejects.toMatchObject({ code: "invalid_ceremony" });
        const stored = await sql<{ n: number }[]>`
          select count(*)::int as n from identity.passkey_credentials
        `;
        expect(stored, `case ${index}`).toEqual([{ n: 0 }]);
      }

      const expired = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      await expect(
        finishPasskeyRegistration(sql, {
          userId: created.userId,
          rpId: RP_ID,
          now: new Date(now.getTime() + 5 * 60 * 1000 + 1),
          clientDataJSON: clientData("webauthn.create", expired.challenge, ORIGIN),
          attestationObject: attestationObject(
            authenticatorData({
              rpId: RP_ID,
              signCount: 0,
              credentialId: new Uint8Array(16).fill(1),
              cose: coseKey(key.x, key.y),
            }),
          ),
        }),
      ).rejects.toMatchObject({ code: "invalid_ceremony" });
    });
  });

  it("rejects each authentication check that the ceremony requires", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(6);
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

      const typed = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const typedData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const typedClient = clientData("webauthn.create", typed.challenge, ORIGIN);
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId,
          clientDataJSON: typedClient,
          authenticatorData: typedData,
          signature: await key.sign(concat([typedData, await sha256(typedClient)])),
        }),
      ).toBeNull();

      const hashed = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const hashedData = authenticatorData({ rpId: "other.example.test", signCount: 1 });
      const hashedClient = clientData("webauthn.get", hashed.challenge, ORIGIN);
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId,
          clientDataJSON: hashedClient,
          authenticatorData: hashedData,
          signature: await key.sign(concat([hashedData, await sha256(hashedClient)])),
        }),
      ).toBeNull();

      const present = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const presentData = authenticatorData({ rpId: RP_ID, signCount: 1, flags: 0x00 });
      const presentClient = clientData("webauthn.get", present.challenge, ORIGIN);
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId,
          clientDataJSON: presentClient,
          authenticatorData: presentData,
          signature: await key.sign(concat([presentData, await sha256(presentClient)])),
        }),
      ).toBeNull();

      const length = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const lengthData = concat([
        authenticatorData({ rpId: RP_ID, signCount: 1 }),
        Uint8Array.of(0x00),
      ]);
      expect(lengthData.byteLength).toBe(38);
      const lengthClient = clientData("webauthn.get", length.challenge, ORIGIN);
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId,
          clientDataJSON: lengthClient,
          authenticatorData: lengthData,
          signature: await key.sign(concat([lengthData, await sha256(lengthClient)])),
        }),
      ).toBeNull();
    });
  });

  it("rejects a DER integer that is non-minimal, negative, too long, or short of the sequence end", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      const options = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const authData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const client = clientData("webauthn.get", options.challenge, ORIGIN);
      const payload = concat([authData, await sha256(client)]);
      let padded: { key: Awaited<ReturnType<typeof signer>>; der: Uint8Array } | undefined;
      let bare: { key: Awaited<ReturnType<typeof signer>>; der: Uint8Array } | undefined;
      for (
        let attempt = 0;
        attempt < 40 && (padded === undefined || bare === undefined);
        attempt += 1
      ) {
        const key = await signer();
        const der = await key.sign(payload);
        const parts = splitDer(der);
        if (padded === undefined && parts.s[0] === 0x00) {
          padded = { key, der };
        }
        const first = parts.r[0] ?? 0;
        if (bare === undefined && first > 0 && first < 0x80) {
          bare = { key, der };
        }
      }
      if (padded === undefined || bare === undefined) {
        throw new Error("signer did not produce both integer shapes");
      }

      async function register(key: Awaited<ReturnType<typeof signer>>, id: Uint8Array) {
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
              credentialId: id,
              cose: coseKey(key.x, key.y),
            }),
          ),
        });
      }

      const negativeId = new Uint8Array(16).fill(11);
      await register(padded.key, negativeId);
      const negativeParts = splitDer(padded.der);
      const negative = encodeDer(negativeParts.r, negativeParts.s.subarray(1));
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId: negativeId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature: negative,
        }),
      ).toBeNull();

      const minimalId = new Uint8Array(16).fill(12);
      await register(bare.key, minimalId);
      const minimalParts = splitDer(bare.der);
      const minimal = encodeDer(concat([Uint8Array.of(0x00), minimalParts.r]), minimalParts.s);
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId: minimalId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature: minimal,
        }),
      ).toBeNull();

      const trailingId = new Uint8Array(16).fill(13);
      await register(padded.key, trailingId);
      const inside = concat([padded.der, Uint8Array.of(0x00)]);
      const length = inside[1] ?? 0;
      inside[1] = length + 1;
      expect(
        await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId: trailingId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature: inside,
        }),
      ).toBeNull();

      const longId = new Uint8Array(16).fill(14);
      await register(padded.key, longId);
      const longS = encodeDer(Uint8Array.of(0x01), new Uint8Array(33).fill(0x01));
      await expect(
        finishPasskeyAuthentication(sql, kms, KEY_ARN, {
          rpId: RP_ID,
          now,
          credentialId: longId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature: longS,
        }),
      ).resolves.toBeNull();
    });
  });
});
