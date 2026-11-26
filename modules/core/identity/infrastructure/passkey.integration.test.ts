import { createHash, generateKeyPairSync, sign as signDer } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { type KmsPort } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import { beforeAll, describe, expect, it } from "vitest";

import { encodeCbor, type Cbor } from "../domain/cbor.js";
import { IdentityError } from "../domain/error.js";
import type { SecondFactorNotice, SecondFactorNoticeKind } from "../domain/second-factor-notice.js";
import { base32Decode, stepAt, totpCode } from "../domain/totp.js";
import { insertIdentityUser } from "./identity-user.js";
import { lockSecondFactor } from "./second-factor-lock.js";
import { createSession, sessionAccessHash } from "./session.js";
import {
  beginFreshPasskey,
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  beginSecondStepPasskey,
  beginTenantPasskeyRegistration,
  confirmTotpSetup,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  finishTenantPasskeyRegistration,
  listSecondFactors,
  readSession,
  readSessionWithKind,
  regenerateBackupCodes,
  removePasskey,
  signInWithPasskey,
  startTotpSetup,
  verifyFreshPasskey,
  verifyPasskeyAssertion,
  verifySecondStep,
  verifySecondStepPasskey,
} from "../public/index.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const RP_ID = "auth.example.test";
const ORIGIN = "https://auth.example.test";
const ADMIN_RP_ID = "admin.example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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
  async function clearIdentity(
    sql: ReturnType<typeof createPlaintextIdentitySql>,
    direct?: ReturnType<typeof createPlaintextDirectSql>,
  ): Promise<void> {
    const ownedDirect = direct ?? createPlaintextDirectSql(loadRuntime().productOnlyUrl);
    try {
      await ownedDirect`delete from identity.second_factor_events`;
    } finally {
      if (direct === undefined) {
        await ownedDirect.end({ timeout: 1 });
      }
    }
    await sql`delete from identity.backup_codes`;
    await sql`delete from identity.totp_credentials`;
    await sql`delete from identity.sessions`;
    await sql`delete from identity.passkey_credentials`;
    await sql`delete from identity.passkey_challenges`;
    await sql`delete from identity.otp_challenges`;
    await sql`delete from identity.users`;
    await sql`delete from identity.identity_keys`;
  }

  async function withSql<T>(
    run: (sql: ReturnType<typeof createPlaintextIdentitySql>, direct: Sql) => Promise<T>,
    options?: { max?: number },
  ) {
    const runtime = loadRuntime();
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    const sql =
      options?.max !== undefined
        ? postgres(identityUrl(runtime), {
            max: options.max,
            prepare: true,
            onnotice: () => undefined,
          })
        : createPlaintextIdentitySql(identityUrl(runtime));
    try {
      await clearIdentity(sql, direct);
      return await run(sql, direct);
    } finally {
      await clearIdentity(sql, direct);
      await sql.end({ timeout: 1 });
      await direct.end({ timeout: 1 });
    }
  }

  class MemoryNotice implements SecondFactorNotice {
    calls: { to: string; kind: SecondFactorNoticeKind }[] = [];

    send(input: { to: string; kind: SecondFactorNoticeKind }): Promise<void> {
      this.calls.push(input);
      return Promise.resolve();
    }
  }

  async function waitForAdvisoryLockWaiter(
    observer: Sql,
    userId: string,
    excludePid: number,
    isSettled: () => boolean,
  ): Promise<boolean> {
    const pollStart = Date.now();
    while (Date.now() - pollStart < 5_000) {
      if (isSettled()) {
        return false;
      }
      const waitingRows = await observer<{ pid: number }[]>`
        with lock_key as (
          select hashtextextended('2fa:' || ${userId}::text, 0) as key
        )
        select l.pid
        from pg_locks l, lock_key
        where l.locktype = 'advisory'
          and l.objsubid = 1
          and not l.granted
          and l.classid::bigint = ((lock_key.key >> 32) & 4294967295::bigint)
          and l.objid::bigint = (lock_key.key & 4294967295::bigint)
          and l.pid <> ${excludePid}
      `;
      if (waitingRows.length > 0) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    return false;
  }

  function pauseOnSql(
    sql: Sql,
    needle: string,
  ): {
    bound: Sql;
    reached: Promise<void>;
    release: () => void;
  } {
    let releaseQuery = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    let markReached = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    let armed = true;
    const originalBegin = sql.begin.bind(sql);
    const bound = new Proxy(sql, {
      apply(target, thisArg, argArray) {
        return Reflect.apply(target, thisArg, argArray);
      },
      get(target, prop, receiver) {
        if (prop === "begin") {
          return (fn: (tx: Sql) => Promise<unknown>) =>
            originalBegin(async (tx) => {
              const wrapped = new Proxy(tx, {
                apply(txTarget, txThis, txArgs) {
                  const strings = txArgs[0];
                  const text = Array.isArray(strings) ? strings.join("") : "";
                  if (armed && text.includes(needle)) {
                    armed = false;
                    markReached();
                    return released.then(() => Reflect.apply(txTarget, txThis, txArgs));
                  }
                  return Reflect.apply(txTarget, txThis, txArgs);
                },
              });
              return fn(wrapped as unknown as Sql);
            });
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { bound, reached, release: releaseQuery };
  }

  async function enrolTotp(
    sql: Sql,
    kms: KmsPort,
    keyArn: string,
    userId: string,
    now: Date,
    adminRpId: string | null = ADMIN_RP_ID,
  ): Promise<{ key: Uint8Array; backupCodes: string[]; tokens: { accessToken: string } }> {
    const sf = await createSession(sql, kms, keyArn, { userId, now, kind: "second_factor" });
    const started = await startTotpSetup(sql, kms, keyArn, {
      accessToken: sf.accessToken,
      now,
      adminRpId,
    });
    if (started.outcome !== "started") {
      throw new Error("expected TOTP setup start");
    }
    const key = base32Decode(started.secret)!;
    const confirmed = await confirmTotpSetup(
      sql,
      kms,
      keyArn,
      {
        accessToken: sf.accessToken,
        now,
        code: totpCode(key, stepAt(now)),
        adminRpId,
      },
      { notice: new MemoryNotice() },
    );
    if (confirmed.outcome !== "confirmed" || !confirmed.backupCodes || !confirmed.tokens) {
      throw new Error("expected TOTP setup confirm");
    }
    return { key, backupCodes: confirmed.backupCodes, tokens: confirmed.tokens };
  }

  async function registerTenantPasskey(
    sql: Sql,
    kms: KmsPort,
    keyArn: string,
    userId: string,
    now: Date,
    options?: { credentialId?: Uint8Array; notice?: SecondFactorNotice },
  ): Promise<{
    credentialId: Uint8Array;
    key: Awaited<ReturnType<typeof signer>>;
    backupCodes: string[];
    tokens: { accessToken: string; refreshToken: string; userId: string };
  }> {
    const sf = await createSession(sql, kms, keyArn, { userId, now, kind: "second_factor" });
    const started = await beginTenantPasskeyRegistration(sql, kms, keyArn, {
      accessToken: sf.accessToken,
      now,
      adminRpId: ADMIN_RP_ID,
    });
    if (started.outcome !== "started") {
      throw new Error("expected tenant passkey registration start");
    }
    const key = await signer();
    const credentialId = options?.credentialId ?? crypto.getRandomValues(new Uint8Array(16));
    const authData = authenticatorData({
      rpId: ADMIN_RP_ID,
      signCount: 0,
      credentialId,
      cose: coseKey(key.x, key.y),
      flags: 0x45,
    });
    const enrolled = await finishTenantPasskeyRegistration(
      sql,
      kms,
      keyArn,
      {
        accessToken: sf.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
        clientDataJSON: clientData("webauthn.create", started.options.challenge, ADMIN_ORIGIN),
        attestationObject: attestationObject(authData),
      },
      { notice: options?.notice ?? new MemoryNotice() },
    );
    if (enrolled.outcome !== "enrolled" || !enrolled.backupCodes || !enrolled.tokens) {
      throw new Error("expected first-factor passkey enrolment");
    }
    return {
      credentialId,
      key,
      backupCodes: enrolled.backupCodes,
      tokens: enrolled.tokens,
    };
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

  it("authentication refuses a credential for another RP ID", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(21);
    const opsRpId = "ops.example.test";
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      await sql`
        insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count, rp_id)
        values (
          ${crypto.randomUUID()},
          ${created.userId},
          ${credentialId},
          ${coseKey(key.x, key.y)},
          0,
          ${opsRpId}
        )
      `;
      const options = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const authData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const client = clientData("webauthn.get", options.challenge, ORIGIN);
      const signature = await key.sign(concat([authData, await sha256(client)]));
      const result = await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature,
      });
      expect(result).toBeNull();
    });
  });

  it("a legacy credential needs acceptLegacy", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(22);
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      await sql`
        insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count, rp_id)
        values (
          ${crypto.randomUUID()},
          ${created.userId},
          ${credentialId},
          ${coseKey(key.x, key.y)},
          0,
          null
        )
      `;
      const options = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const authData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const client = clientData("webauthn.get", options.challenge, ORIGIN);
      const signature = await key.sign(concat([authData, await sha256(client)]));

      const refused = await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature,
        acceptLegacy: false,
      });
      expect(refused).toBeNull();

      const accepted = await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature,
      });
      expect(accepted).toMatchObject({ userId: created.userId, expiresIn: 900 });
    });
  });

  it("a legacy challenge needs acceptLegacy", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });

      const regChallenge = new Uint8Array(32).fill(31);
      await sql`
        insert into identity.passkey_challenges (id, user_id, kind, challenge, expires_at, rp_id)
        values (${crypto.randomUUID()}, ${created.userId}, 'register', ${regChallenge}, ${expiresAt}::timestamptz, null)
      `;
      const regCredId = new Uint8Array(16).fill(32);
      const regAuthData = authenticatorData({
        rpId: RP_ID,
        signCount: 0,
        credentialId: regCredId,
        cose: coseKey(key.x, key.y),
      });

      await expect(
        finishPasskeyRegistration(sql, {
          userId: created.userId,
          rpId: RP_ID,
          now,
          clientDataJSON: clientData("webauthn.create", regChallenge, ORIGIN),
          attestationObject: attestationObject(regAuthData),
          acceptLegacy: false,
        }),
      ).rejects.toMatchObject({ code: "invalid_ceremony" });

      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", regChallenge, ORIGIN),
        attestationObject: attestationObject(regAuthData),
      });

      const authChallenge = new Uint8Array(32).fill(33);
      await sql`
        insert into identity.passkey_challenges (id, user_id, kind, challenge, expires_at, rp_id)
        values (${crypto.randomUUID()}, null, 'authenticate', ${authChallenge}, ${expiresAt}::timestamptz, null)
      `;
      const authData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const authClient = clientData("webauthn.get", authChallenge, ORIGIN);
      const authSig = await key.sign(concat([authData, await sha256(authClient)]));

      const refused = await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
        rpId: RP_ID,
        now,
        credentialId: regCredId,
        clientDataJSON: authClient,
        authenticatorData: authData,
        signature: authSig,
        acceptLegacy: false,
      });
      expect(refused).toBeNull();

      const accepted = await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
        rpId: RP_ID,
        now,
        credentialId: regCredId,
        clientDataJSON: authClient,
        authenticatorData: authData,
        signature: authSig,
      });
      expect(accepted).toMatchObject({ userId: created.userId, expiresIn: 900 });
    });
  });

  it("a challenge begun for another RP ID is refused", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const opsRpId = "ops.example.test";
    const credentialId = new Uint8Array(16).fill(41);
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      const reg = await beginPasskeyRegistration(sql, { userId: created.userId, rpId: RP_ID, now });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", reg.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId,
            cose: coseKey(key.x, key.y),
          }),
        ),
      });

      const options = await beginPasskeyAuthentication(sql, { rpId: opsRpId, now });
      const authData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const client = clientData("webauthn.get", options.challenge, ORIGIN);
      const signature = await key.sign(concat([authData, await sha256(client)]));

      const result = await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature,
      });
      expect(result).toBeNull();

      const regOptions = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: opsRpId,
        now,
      });
      await expect(
        finishPasskeyRegistration(sql, {
          userId: created.userId,
          rpId: RP_ID,
          now,
          clientDataJSON: clientData("webauthn.create", regOptions.challenge, ORIGIN),
          attestationObject: attestationObject(
            authenticatorData({
              rpId: RP_ID,
              signCount: 0,
              credentialId: new Uint8Array(16).fill(42),
              cose: coseKey(key.x, key.y),
            }),
          ),
        }),
      ).rejects.toMatchObject({ code: "invalid_ceremony" });
    });
  });

  it("a tenant registration with no options stores the RP ID", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(51);
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      const options = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      const regChallenges = await sql<{ rp_id: string | null }[]>`
        select rp_id from identity.passkey_challenges where challenge = ${options.challenge}
      `;
      expect(regChallenges[0]?.rp_id).toBe(RP_ID);

      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", options.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId,
            cose: coseKey(key.x, key.y),
          }),
        ),
      });

      const credentials = await sql<{ rp_id: string | null }[]>`
        select rp_id from identity.passkey_credentials where credential_id = ${credentialId}
      `;
      expect(credentials[0]?.rp_id).toBe(RP_ID);

      const authOptions = await beginPasskeyAuthentication(sql, { rpId: RP_ID, now });
      const authChallenges = await sql<{ rp_id: string | null }[]>`
        select rp_id from identity.passkey_challenges where challenge = ${authOptions.challenge}
      `;
      expect(authChallenges[0]?.rp_id).toBe(RP_ID);
    });
  });

  it("required user verification is in the options", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });

      const regRequired = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        userVerification: "required",
      });
      expect(regRequired.authenticatorSelection.userVerification).toBe("required");

      const regChallenge = await sql<{ user_verification: string }[]>`
        select user_verification from identity.passkey_challenges where challenge = ${regRequired.challenge}
      `;
      expect(regChallenge[0]?.user_verification).toBe("required");

      const authRequired = await beginPasskeyAuthentication(sql, {
        rpId: RP_ID,
        now,
        userVerification: "required",
      });
      expect(authRequired.userVerification).toBe("required");

      const authChallenge = await sql<{ user_verification: string }[]>`
        select user_verification from identity.passkey_challenges where challenge = ${authRequired.challenge}
      `;
      expect(authChallenge[0]?.user_verification).toBe("required");

      const regDefault = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      expect(regDefault.authenticatorSelection.userVerification).toBe("preferred");

      const authDefault = await beginPasskeyAuthentication(sql, {
        rpId: RP_ID,
        now,
      });
      expect(authDefault.userVerification).toBeUndefined();
    });
  });

  it("registration without UV fails when required", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(61);
    const credentialIdUv = new Uint8Array(16).fill(62);
    const credentialIdPreferred = new Uint8Array(16).fill(63);

    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });

      const regRequired = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        userVerification: "required",
      });

      // Without UV flag (0x41 = AT | UP, UV bit 0x04 is 0)
      const authDataWithoutUv = authenticatorData({
        rpId: RP_ID,
        signCount: 0,
        credentialId,
        cose: coseKey(key.x, key.y),
        flags: 0x41,
      });

      await expect(
        finishPasskeyRegistration(sql, {
          userId: created.userId,
          rpId: RP_ID,
          now,
          clientDataJSON: clientData("webauthn.create", regRequired.challenge, ORIGIN),
          attestationObject: attestationObject(authDataWithoutUv),
        }),
      ).rejects.toMatchObject({ code: "invalid_ceremony" });

      // Positive control: with UV flag (0x45 = AT | UP | UV)
      const authDataWithUv = authenticatorData({
        rpId: RP_ID,
        signCount: 0,
        credentialId: credentialIdUv,
        cose: coseKey(key.x, key.y),
        flags: 0x45,
      });

      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", regRequired.challenge, ORIGIN),
        attestationObject: attestationObject(authDataWithUv),
      });

      const stored = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.passkey_credentials where credential_id = ${credentialIdUv}
      `;
      expect(stored).toEqual([{ n: 1 }]);

      // Positive control: preferred ceremony succeeds without UV flag
      const regPreferred = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        userVerification: "preferred",
      });
      const authDataPreferred = authenticatorData({
        rpId: RP_ID,
        signCount: 0,
        credentialId: credentialIdPreferred,
        cose: coseKey(key.x, key.y),
        flags: 0x41,
      });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", regPreferred.challenge, ORIGIN),
        attestationObject: attestationObject(authDataPreferred),
      });
    });
  });

  it("authentication without UV fails when required", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(71);

    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });
      const reg = await beginPasskeyRegistration(sql, { userId: created.userId, rpId: RP_ID, now });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", reg.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId,
            cose: coseKey(key.x, key.y),
          }),
        ),
      });

      // Authentication with required UV, but authenticatorData without UV (flags: 0x01)
      const authOptions = await beginPasskeyAuthentication(sql, {
        rpId: RP_ID,
        now,
        userVerification: "required",
      });
      const authDataWithoutUv = authenticatorData({ rpId: RP_ID, signCount: 1, flags: 0x01 });
      const clientWithoutUv = clientData("webauthn.get", authOptions.challenge, ORIGIN);
      const signatureWithoutUv = await key.sign(
        concat([authDataWithoutUv, await sha256(clientWithoutUv)]),
      );

      const rejected = await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: clientWithoutUv,
        authenticatorData: authDataWithoutUv,
        signature: signatureWithoutUv,
      });
      expect(rejected).toBeNull();

      // Positive control: with UV flag (flags: 0x05 = UP | UV)
      const authOptionsWithUv = await beginPasskeyAuthentication(sql, {
        rpId: RP_ID,
        now,
        userVerification: "required",
      });
      const authDataWithUv = authenticatorData({ rpId: RP_ID, signCount: 2, flags: 0x05 });
      const clientWithUv = clientData("webauthn.get", authOptionsWithUv.challenge, ORIGIN);
      const signatureWithUv = await key.sign(concat([authDataWithUv, await sha256(clientWithUv)]));

      const accepted = await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: clientWithUv,
        authenticatorData: authDataWithUv,
        signature: signatureWithUv,
      });
      expect(accepted).toMatchObject({ userId: created.userId, expiresIn: 900 });

      // Positive control: preferred authentication succeeds without UV flag
      const authOptionsPreferred = await beginPasskeyAuthentication(sql, {
        rpId: RP_ID,
        now,
        userVerification: "preferred",
      });
      const authDataPreferred = authenticatorData({ rpId: RP_ID, signCount: 3, flags: 0x01 });
      const clientPreferred = clientData("webauthn.get", authOptionsPreferred.challenge, ORIGIN);
      const signaturePreferred = await key.sign(
        concat([authDataPreferred, await sha256(clientPreferred)]),
      );

      const acceptedPreferred = await finishPasskeyAuthentication(sql, kms, KEY_ARN, {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: clientPreferred,
        authenticatorData: authDataPreferred,
        signature: signaturePreferred,
      });
      expect(acceptedPreferred).toMatchObject({ userId: created.userId, expiresIn: 900 });
    });
  });

  it("excludeExisting lists this RP ID only", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const opsRpId = "ops.example.test";
    const opsOrigin = "https://ops.example.test";
    const authCredId = new Uint8Array(16).fill(81);
    const opsCredId = new Uint8Array(16).fill(82);

    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "ada@example.com" });

      // Register credential 1 for RP_ID (auth.example.test)
      const regAuth = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", regAuth.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId: authCredId,
            cose: coseKey(key.x, key.y),
          }),
        ),
      });

      // Register credential 2 for opsRpId (ops.example.test)
      const regOps = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: opsRpId,
        now,
      });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: opsRpId,
        now,
        clientDataJSON: clientData("webauthn.create", regOps.challenge, opsOrigin),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: opsCredId,
            cose: coseKey(key.x, key.y),
          }),
        ),
      });

      // Begin registration for RP_ID with excludeExisting: true
      const optionsWithExclude = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        excludeExisting: true,
      });
      expect(optionsWithExclude.excludeCredentials).toEqual([
        { type: "public-key", id: authCredId },
      ]);

      // Begin registration with excludeExisting: false or omitted
      const optionsWithoutExclude = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      expect(optionsWithoutExclude.excludeCredentials).toBeUndefined();

      const optionsWithFalse = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        excludeExisting: false,
      });
      expect(optionsWithFalse.excludeCredentials).toBeUndefined();
    });
  });

  it("onStored failure rolls back the credential", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(91);

    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "pin9@example.com" });
      const reg = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });

      const onStoredError = new Error("onStored simulated failure");

      await expect(
        finishPasskeyRegistration(sql, {
          userId: created.userId,
          rpId: RP_ID,
          now,
          clientDataJSON: clientData("webauthn.create", reg.challenge, ORIGIN),
          attestationObject: attestationObject(
            authenticatorData({
              rpId: RP_ID,
              signCount: 0,
              credentialId,
              cose: coseKey(key.x, key.y),
            }),
          ),
          onStored: async () => {
            throw onStoredError;
          },
        }),
      ).rejects.toThrow(onStoredError);

      // Verify no credential was stored
      const credRows = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials
        where user_id = ${created.userId}
          and credential_id = ${credentialId}
      `;
      expect(credRows).toHaveLength(0);

      // Assert the challenge is still unconsumed
      const challengeRows = await sql<{ id: string; consumed_at: Date | null }[]>`
        select id, consumed_at from identity.passkey_challenges
        where user_id = ${created.userId}
          and kind = 'register'
          and challenge = ${reg.challenge}
      `;
      expect(challengeRows).toHaveLength(1);
      expect(challengeRows[0]?.consumed_at).toBeNull();
    });
  });

  it("onStored sees the new credential inside the transaction", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(92);

    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "hook-success@example.com",
      });
      const reg = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });

      let hookSeenCount = 0;
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", reg.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId,
            cose: coseKey(key.x, key.y),
          }),
        ),
        onStored: async (tx, stored) => {
          expect(stored.userId).toBe(created.userId);
          expect(stored.credentialId).toEqual(credentialId);

          const insideTx = await tx<{ id: string }[]>`
            select id from identity.passkey_credentials
            where user_id = ${stored.userId}
              and credential_id = ${stored.credentialId}
          `;
          hookSeenCount = insideTx.length;
        },
      });

      expect(hookSeenCount).toBe(1);

      const outsideTx = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials
        where user_id = ${created.userId}
          and credential_id = ${credentialId}
      `;
      expect(outsideTx).toHaveLength(1);
    });
  });

  it("verifyPasskeyAssertion mints nothing", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(93);

    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "pin10@example.com" });

      const reg = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", reg.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId,
            cose: coseKey(key.x, key.y),
          }),
        ),
      });

      const countBefore = await sql<{ count: string }[]>`
        select count(*) from identity.sessions where user_id = ${created.userId}
      `;
      expect(Number(countBefore[0]?.count)).toBe(0);

      const authOptions = await beginPasskeyAuthentication(sql, {
        rpId: RP_ID,
        now,
      });
      const authData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const client = clientData("webauthn.get", authOptions.challenge, ORIGIN);
      const signature = await key.sign(concat([authData, await sha256(client)]));

      const verified = await verifyPasskeyAssertion(sql, {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature,
      });
      expect(verified).toEqual({ userId: created.userId });

      const countAfter = await sql<{ count: string }[]>`
        select count(*) from identity.sessions where user_id = ${created.userId}
      `;
      expect(Number(countAfter[0]?.count)).toBe(Number(countBefore[0]?.count));
    });
  });

  it("verifyPasskeyAssertion returns the user id and consumes the challenge (a replay fails)", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credentialId = new Uint8Array(16).fill(94);

    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "verify-replay@example.com",
      });

      const reg = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", reg.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId,
            cose: coseKey(key.x, key.y),
          }),
        ),
      });

      const authOptions = await beginPasskeyAuthentication(sql, {
        rpId: RP_ID,
        now,
      });
      const authData = authenticatorData({ rpId: RP_ID, signCount: 1 });
      const client = clientData("webauthn.get", authOptions.challenge, ORIGIN);
      const signature = await key.sign(concat([authData, await sha256(client)]));

      const result = await verifyPasskeyAssertion(sql, {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature,
      });
      expect(result).toEqual({ userId: created.userId });

      const challengeRows = await sql<{ id: string; consumed_at: Date | null }[]>`
        select id, consumed_at from identity.passkey_challenges
        where kind = 'authenticate'
          and challenge = ${authOptions.challenge}
      `;
      expect(challengeRows).toHaveLength(1);
      expect(challengeRows[0]?.consumed_at).not.toBeNull();

      const credRows = await sql<{ sign_count: string | number }[]>`
        select sign_count from identity.passkey_credentials
        where credential_id = ${credentialId}
      `;
      expect(Number(credRows[0]?.sign_count)).toBe(1);

      const replay = await verifyPasskeyAssertion(sql, {
        rpId: RP_ID,
        now,
        credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature,
      });
      expect(replay).toBeNull();
    });
  });

  it("beforeStore runs before the credential exists", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: `beforestore-${crypto.randomUUID()}@example.test`,
      });

      // 1. A throwing hook leaves no credential, challenge unconsumed, and error propagates
      const reg1 = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      const credId1 = new Uint8Array(16).fill(1);
      const authData1 = authenticatorData({
        rpId: RP_ID,
        signCount: 0,
        credentialId: credId1,
        cose: coseKey(key.x, key.y),
      });
      const hookError = new Error("beforeStore abort");
      await expect(
        finishPasskeyRegistration(sql, {
          userId: created.userId,
          rpId: RP_ID,
          now,
          clientDataJSON: clientData("webauthn.create", reg1.challenge, ORIGIN),
          attestationObject: attestationObject(authData1),
          beforeStore: async () => {
            throw hookError;
          },
        }),
      ).rejects.toThrow("beforeStore abort");

      const credRows1 = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.passkey_credentials where user_id = ${created.userId}
      `;
      expect(credRows1).toEqual([{ n: 0 }]);

      const challengeRows1 = await sql<{ consumed_at: Date | null }[]>`
        select consumed_at from identity.passkey_challenges where challenge = ${reg1.challenge}
      `;
      expect(challengeRows1).toHaveLength(1);
      expect(challengeRows1[0]?.consumed_at).toBeNull();

      // 2. Inside beforeStore, count(*) of user's credentials through tx is 0
      let hookRan = false;
      let countDuringHook = -1;
      let hookUserId = "";
      const reg2 = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      const credId2 = new Uint8Array(16).fill(2);
      const authData2 = authenticatorData({
        rpId: RP_ID,
        signCount: 0,
        credentialId: credId2,
        cose: coseKey(key.x, key.y),
      });

      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", reg2.challenge, ORIGIN),
        attestationObject: attestationObject(authData2),
        beforeStore: async (tx, input) => {
          hookRan = true;
          hookUserId = input.userId;
          const rows = await tx<{ n: number }[]>`
            select count(*)::int as n from identity.passkey_credentials where user_id = ${input.userId}
          `;
          countDuringHook = rows[0]?.n ?? -1;
        },
      });

      expect(hookRan).toBe(true);
      expect(hookUserId).toBe(created.userId);
      expect(countDuringHook).toBe(0);

      const credRows2 = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.passkey_credentials where user_id = ${created.userId}
      `;
      expect(credRows2).toEqual([{ n: 1 }]);

      // 3. With no hook, tenant registration behaves as today
      const reg3 = await beginPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
      });
      const credId3 = new Uint8Array(16).fill(3);
      const authData3 = authenticatorData({
        rpId: RP_ID,
        signCount: 0,
        credentialId: credId3,
        cose: coseKey(key.x, key.y),
      });
      await finishPasskeyRegistration(sql, {
        userId: created.userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", reg3.challenge, ORIGIN),
        attestationObject: attestationObject(authData3),
      });
      const credRows3 = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.passkey_credentials where user_id = ${created.userId}
      `;
      expect(credRows3).toEqual([{ n: 2 }]);
    });
  });

  // Pin 64
  it("refuses a tenant registration without the UV flag on a preferred challenge and saves nothing", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credId = crypto.getRandomValues(new Uint8Array(16));
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin64@example.test",
      });
      const preferred = await beginPasskeyRegistration(sql, {
        userId,
        rpId: ADMIN_RP_ID,
        now,
        userVerification: "preferred",
      });
      const noUvAuthData = authenticatorData({
        rpId: ADMIN_RP_ID,
        signCount: 0,
        credentialId: credId,
        cose: coseKey(key.x, key.y),
        flags: 0x41,
      });

      await expect(
        finishPasskeyRegistration(sql, {
          userId,
          rpId: ADMIN_RP_ID,
          now,
          clientDataJSON: clientData("webauthn.create", preferred.challenge, ADMIN_ORIGIN),
          attestationObject: attestationObject(noUvAuthData),
          acceptLegacy: false,
          requireUvFlag: true,
        }),
      ).rejects.toMatchObject({ code: "invalid_ceremony" });

      const creds = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials where user_id = ${userId}
      `;
      expect(creds).toHaveLength(0);
      const challenges = await sql<{ consumed_at: Date | null }[]>`
        select consumed_at from identity.passkey_challenges where challenge = ${preferred.challenge}
      `;
      expect(challenges[0]?.consumed_at).toBeNull();

      // Tenant registration wrapper also refuses a preferred challenge when UV is missing
      const sf = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "second_factor" });
      const notice = new MemoryNotice();
      const started = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(started.outcome).toBe("started");
      if (started.outcome !== "started") {
        throw new Error("expected started");
      }
      await sql`
        update identity.passkey_challenges
        set user_verification = 'preferred'
        where challenge = ${started.options.challenge}
      `;
      await expect(
        finishTenantPasskeyRegistration(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sf.accessToken,
            now,
            adminRpId: ADMIN_RP_ID,
            clientDataJSON: clientData("webauthn.create", started.options.challenge, ADMIN_ORIGIN),
            attestationObject: attestationObject(noUvAuthData),
          },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });
      expect(notice.calls).toHaveLength(0);
      const credsAfter = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials where user_id = ${userId}
      `;
      expect(credsAfter).toHaveLength(0);
    });
  });

  // Pin 65
  it("a tenant registration stores user_verified", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin65@example.test",
      });
      const enrolled = await registerTenantPasskey(sql, kms, KEY_ARN, userId, now);
      const rows = await sql<
        { user_verified: boolean; rp_id: string | null; created_at: Date | null }[]
      >`
        select user_verified, rp_id, created_at
        from identity.passkey_credentials
        where user_id = ${userId}
          and credential_id = ${enrolled.credentialId}
      `;
      expect(rows).toEqual([
        {
          user_verified: true,
          rp_id: ADMIN_RP_ID,
          created_at: now,
        },
      ]);

      // Preferred registration without UV stores user_verified = false
      const key2 = await signer();
      const credId2 = crypto.getRandomValues(new Uint8Array(16));
      const prefReg = await beginPasskeyRegistration(sql, {
        userId,
        rpId: RP_ID,
        now,
        userVerification: "preferred",
      });
      await finishPasskeyRegistration(sql, {
        userId,
        rpId: RP_ID,
        now,
        clientDataJSON: clientData("webauthn.create", prefReg.challenge, ORIGIN),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: RP_ID,
            signCount: 0,
            credentialId: credId2,
            cose: coseKey(key2.x, key2.y),
            flags: 0x41,
          }),
        ),
      });
      const rows2 = await sql<{ user_verified: boolean; created_at: Date | null }[]>`
        select user_verified, created_at
        from identity.passkey_credentials
        where credential_id = ${credId2}
      `;
      expect(rows2).toEqual([{ user_verified: false, created_at: now }]);
    });
  });

  // Pin 66
  it("refuses a tenant assertion without UV even on a preferred challenge", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin66@example.test",
      });
      const enrolled = await registerTenantPasskey(sql, kms, KEY_ARN, userId, now);

      const preferredAuth = await beginPasskeyAuthentication(sql, {
        rpId: ADMIN_RP_ID,
        now,
        userVerification: "preferred",
      });
      const authDataNoUv = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x01 });
      const client = clientData("webauthn.get", preferredAuth.challenge, ADMIN_ORIGIN);
      const sig = await enrolled.key.sign(concat([authDataNoUv, await sha256(client)]));

      await expect(
        signInWithPasskey(sql, kms, KEY_ARN, {
          adminRpId: ADMIN_RP_ID,
          now,
          credentialId: enrolled.credentialId,
          clientDataJSON: client,
          authenticatorData: authDataNoUv,
          signature: sig,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const challenges = await sql<{ consumed_at: Date | null }[]>`
        select consumed_at from identity.passkey_challenges where challenge = ${preferredAuth.challenge}
      `;
      expect(challenges[0]?.consumed_at).toBeNull();
      const creds = await sql<{ sign_count: number | string }[]>`
        select sign_count from identity.passkey_credentials where credential_id = ${enrolled.credentialId}
      `;
      expect(Number(creds[0]?.sign_count)).toBe(0);
    });
  });

  // Pin 67
  it("refuses a tenant passkey whose user_verified is false", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credId = crypto.getRandomValues(new Uint8Array(16));
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin67@example.test",
      });
      await sql`
        insert into identity.passkey_credentials (
          id, user_id, credential_id, cose_key, sign_count, rp_id, user_verified, created_at
        ) values (
          ${newId()}, ${userId}, ${credId}, ${coseKey(key.x, key.y)}, 0, ${ADMIN_RP_ID}, false, ${now}
        )
      `;

      // 1. Tenant sign-in
      const signInOpts = await beginPasskeyAuthentication(sql, {
        rpId: ADMIN_RP_ID,
        now,
        userVerification: "required",
      });
      const signInData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const signInClient = clientData("webauthn.get", signInOpts.challenge, ADMIN_ORIGIN);
      await expect(
        signInWithPasskey(sql, kms, KEY_ARN, {
          adminRpId: ADMIN_RP_ID,
          now,
          credentialId: credId,
          clientDataJSON: signInClient,
          authenticatorData: signInData,
          signature: await key.sign(concat([signInData, await sha256(signInClient)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // 2. Second step
      const sf = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "second_factor" });
      const sfOpts = await beginSecondStepPasskey(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(sfOpts.outcome).toBe("started");
      if (sfOpts.outcome !== "started") {
        throw new Error("expected started");
      }
      const sfData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const sfClient = clientData("webauthn.get", sfOpts.options.challenge, ADMIN_ORIGIN);
      await expect(
        verifySecondStepPasskey(sql, kms, KEY_ARN, {
          accessToken: sf.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
          credentialId: credId,
          clientDataJSON: sfClient,
          authenticatorData: sfData,
          signature: await key.sign(concat([sfData, await sha256(sfClient)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // 3. Fresh check
      const admin = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
      });
      const freshOpts = await beginFreshPasskey(sql, kms, KEY_ARN, {
        accessToken: admin.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(freshOpts.outcome).toBe("started");
      if (freshOpts.outcome !== "started") {
        throw new Error("expected started");
      }
      const freshData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const freshClient = clientData("webauthn.get", freshOpts.options.challenge, ADMIN_ORIGIN);
      await expect(
        verifyFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: admin.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
          credentialId: credId,
          clientDataJSON: freshClient,
          authenticatorData: freshData,
          signature: await key.sign(concat([freshData, await sha256(freshClient)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const creds = await sql<{ sign_count: number | string }[]>`
        select sign_count from identity.passkey_credentials where credential_id = ${credId}
      `;
      expect(Number(creds[0]?.sign_count)).toBe(0);
    });
  });

  // Pin 68
  it("refuses a passkey with no rp id on tenant routes", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const key = await signer();
    const credId = crypto.getRandomValues(new Uint8Array(16));
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin68@example.test",
      });
      await sql`
        insert into identity.passkey_credentials (
          id, user_id, credential_id, cose_key, sign_count, rp_id, user_verified, created_at
        ) values (
          ${newId()}, ${userId}, ${credId}, ${coseKey(key.x, key.y)}, 0, ${null}, true, ${now}
        )
      `;

      // 1. Tenant sign-in
      const signInOpts = await beginPasskeyAuthentication(sql, {
        rpId: ADMIN_RP_ID,
        now,
        userVerification: "required",
      });
      const signInData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const signInClient = clientData("webauthn.get", signInOpts.challenge, ADMIN_ORIGIN);
      await expect(
        signInWithPasskey(sql, kms, KEY_ARN, {
          adminRpId: ADMIN_RP_ID,
          now,
          credentialId: credId,
          clientDataJSON: signInClient,
          authenticatorData: signInData,
          signature: await key.sign(concat([signInData, await sha256(signInClient)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // 2. Second step
      const sf = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "second_factor" });
      const sfOpts = await beginSecondStepPasskey(sql, kms, KEY_ARN, {
        accessToken: sf.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (sfOpts.outcome !== "started") {
        throw new Error("expected started");
      }
      const sfData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const sfClient = clientData("webauthn.get", sfOpts.options.challenge, ADMIN_ORIGIN);
      await expect(
        verifySecondStepPasskey(sql, kms, KEY_ARN, {
          accessToken: sf.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
          credentialId: credId,
          clientDataJSON: sfClient,
          authenticatorData: sfData,
          signature: await key.sign(concat([sfData, await sha256(sfClient)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // 3. Fresh check
      const admin = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "otp_totp",
      });
      const freshOpts = await beginFreshPasskey(sql, kms, KEY_ARN, {
        accessToken: admin.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (freshOpts.outcome !== "started") {
        throw new Error("expected started");
      }
      const freshData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const freshClient = clientData("webauthn.get", freshOpts.options.challenge, ADMIN_ORIGIN);
      await expect(
        verifyFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: admin.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
          credentialId: credId,
          clientDataJSON: freshClient,
          authenticatorData: freshData,
          signature: await key.sign(concat([freshData, await sha256(freshClient)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // 4. Legacy registration challenge (rp_id = null) refused when acceptLegacy = false
      const legacyRegChallenge = crypto.getRandomValues(new Uint8Array(32));
      await sql`
        insert into identity.passkey_challenges (id, user_id, kind, challenge, expires_at, rp_id, user_verification)
        values (
          ${newId()}, ${userId}, 'register', ${legacyRegChallenge},
          ${new Date(now.getTime() + FIVE_MINUTES_MS).toISOString()}::timestamptz, null, 'required'
        )
      `;
      const regKey = await signer();
      const regCredId = crypto.getRandomValues(new Uint8Array(16));
      await expect(
        finishTenantPasskeyRegistration(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sf.accessToken,
            now,
            adminRpId: ADMIN_RP_ID,
            clientDataJSON: clientData("webauthn.create", legacyRegChallenge, ADMIN_ORIGIN),
            attestationObject: attestationObject(
              authenticatorData({
                rpId: ADMIN_RP_ID,
                signCount: 0,
                credentialId: regCredId,
                cose: coseKey(regKey.x, regKey.y),
                flags: 0x45,
              }),
            ),
          },
          { notice: new MemoryNotice() },
        ),
      ).resolves.toEqual({ outcome: "refused" });
    });
  });

  // Pin 69
  it("refuses an ops passkey on the tenant sign-in", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    const opsKey = await signer();
    const opsCredId = crypto.getRandomValues(new Uint8Array(16));
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin69@example.test",
      });
      await sql`
        insert into identity.passkey_credentials (
          id, user_id, credential_id, cose_key, sign_count, rp_id, user_verified, created_at
        ) values (
          ${newId()}, ${userId}, ${opsCredId}, ${coseKey(opsKey.x, opsKey.y)}, 0, ${"ops.example.test"}, true, ${now}
        )
      `;

      const options = await beginPasskeyAuthentication(sql, {
        rpId: ADMIN_RP_ID,
        now,
        userVerification: "required",
      });
      // Signed with the ops credential's key over the admin origin and the admin rpId hash
      const authData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const client = clientData("webauthn.get", options.challenge, ADMIN_ORIGIN);
      const signature = await opsKey.sign(concat([authData, await sha256(client)]));

      await expect(
        signInWithPasskey(sql, kms, KEY_ARN, {
          adminRpId: ADMIN_RP_ID,
          now,
          credentialId: opsCredId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const sessions = await sql<{ id: string }[]>`
        select id from identity.sessions where user_id = ${userId}
      `;
      expect(sessions).toHaveLength(0);
      const [cred] = await sql<{ sign_count: number | string }[]>`
        select sign_count from identity.passkey_credentials where credential_id = ${opsCredId}
      `;
      expect(Number(cred?.sign_count)).toBe(0);
    });
  });

  // Pin 71
  it("a passkey of another user as the second step leaves its sign count and the challenge unconsumed", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const { userId: userA } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin71-a@example.test",
      });
      const { userId: userB } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin71-b@example.test",
      });
      const passkeyA = await registerTenantPasskey(sql, kms, KEY_ARN, userA, now);
      const passkeyB = await registerTenantPasskey(sql, kms, KEY_ARN, userB, now);

      const sfA = await createSession(sql, kms, KEY_ARN, {
        userId: userA,
        now,
        kind: "second_factor",
      });
      const optsA = await beginSecondStepPasskey(sql, kms, KEY_ARN, {
        accessToken: sfA.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(optsA.outcome).toBe("started");
      if (optsA.outcome !== "started") {
        throw new Error("expected started");
      }

      const authDataB = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const clientB = clientData("webauthn.get", optsA.options.challenge, ADMIN_ORIGIN);
      const sigB = await passkeyB.key.sign(concat([authDataB, await sha256(clientB)]));

      await expect(
        verifySecondStepPasskey(sql, kms, KEY_ARN, {
          accessToken: sfA.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
          credentialId: passkeyB.credentialId,
          clientDataJSON: clientB,
          authenticatorData: authDataB,
          signature: sigB,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const [credB] = await sql<{ sign_count: number | string }[]>`
        select sign_count from identity.passkey_credentials where credential_id = ${passkeyB.credentialId}
      `;
      expect(Number(credB?.sign_count)).toBe(0);

      const [chRow] = await sql<{ consumed_at: Date | null }[]>`
        select consumed_at from identity.passkey_challenges where challenge = ${optsA.options.challenge}
      `;
      expect(chRow?.consumed_at).toBeNull();

      const failedEventsA = await sql<{ event: string }[]>`
        select event from identity.second_factor_events
        where user_id = ${userA} and event = 'verify_failed'
      `;
      expect(failedEventsA).toHaveLength(1);

      // User A can still pass the second step with their own passkey on the unconsumed challenge
      const authDataA = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const clientA = clientData("webauthn.get", optsA.options.challenge, ADMIN_ORIGIN);
      const sigA = await passkeyA.key.sign(concat([authDataA, await sha256(clientA)]));
      const ok = await verifySecondStepPasskey(sql, kms, KEY_ARN, {
        accessToken: sfA.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
        credentialId: passkeyA.credentialId,
        clientDataJSON: clientA,
        authenticatorData: authDataA,
        signature: sigA,
      });
      expect(ok.outcome).toBe("verified");
    });
  });

  // Pin 72
  it("a second-step challenge is bound to the session user", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const { userId: userA } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin72-a@example.test",
      });
      const { userId: userB } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin72-b@example.test",
      });
      const passkeyA = await registerTenantPasskey(sql, kms, KEY_ARN, userA, now);
      const passkeyB = await registerTenantPasskey(sql, kms, KEY_ARN, userB, now);

      const sfA = await createSession(sql, kms, KEY_ARN, {
        userId: userA,
        now,
        kind: "second_factor",
      });
      const optsA = await beginSecondStepPasskey(sql, kms, KEY_ARN, {
        accessToken: sfA.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(optsA.outcome).toBe("started");
      if (optsA.outcome !== "started") {
        throw new Error("expected started");
      }

      const [challengeRow] = await sql<{ user_id: string | null }[]>`
        select user_id from identity.passkey_challenges where challenge = ${optsA.options.challenge}
      `;
      expect(challengeRow?.user_id).toBe(userA);

      // User B cannot verify their own passkey against User A's second-step challenge
      const sfB = await createSession(sql, kms, KEY_ARN, {
        userId: userB,
        now,
        kind: "second_factor",
      });
      const authDataB = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const clientB = clientData("webauthn.get", optsA.options.challenge, ADMIN_ORIGIN);
      await expect(
        verifySecondStepPasskey(sql, kms, KEY_ARN, {
          accessToken: sfB.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
          credentialId: passkeyB.credentialId,
          clientDataJSON: clientB,
          authenticatorData: authDataB,
          signature: await passkeyB.key.sign(concat([authDataB, await sha256(clientB)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // User A's second-step challenge cannot be used on passwordless signInWithPasskey either
      const authDataA = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const clientA = clientData("webauthn.get", optsA.options.challenge, ADMIN_ORIGIN);
      await expect(
        signInWithPasskey(sql, kms, KEY_ARN, {
          adminRpId: ADMIN_RP_ID,
          now,
          credentialId: passkeyA.credentialId,
          clientDataJSON: clientA,
          authenticatorData: authDataA,
          signature: await passkeyA.key.sign(concat([authDataA, await sha256(clientA)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });
    });
  });

  // Pin 73
  it("a passkey of another user cannot pass the fresh check", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const { userId: userA } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin73-a@example.test",
      });
      const { userId: userB } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin73-b@example.test",
      });
      await registerTenantPasskey(sql, kms, KEY_ARN, userA, now);
      const passkeyB = await registerTenantPasskey(sql, kms, KEY_ARN, userB, now);

      const adminA = await createSession(sql, kms, KEY_ARN, {
        userId: userA,
        now,
        kind: "tenant",
        factor: "passkey_uv",
        freshFactorAt: null,
      });
      const accessHashA = await sessionAccessHash(sql, kms, KEY_ARN, adminA.accessToken);
      const freshOpts = await beginFreshPasskey(sql, kms, KEY_ARN, {
        accessToken: adminA.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(freshOpts.outcome).toBe("started");
      if (freshOpts.outcome !== "started") {
        throw new Error("expected started");
      }

      const authDataB = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const clientB = clientData("webauthn.get", freshOpts.options.challenge, ADMIN_ORIGIN);
      await expect(
        verifyFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: adminA.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
          credentialId: passkeyB.credentialId,
          clientDataJSON: clientB,
          authenticatorData: authDataB,
          signature: await passkeyB.key.sign(concat([authDataB, await sha256(clientB)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const [sessionRow] = await sql<{ fresh_factor_at: Date | null }[]>`
        select fresh_factor_at from identity.sessions where access_hash = ${accessHashA}
      `;
      expect(sessionRow?.fresh_factor_at).toBeNull();
      const [credB] = await sql<{ sign_count: number | string }[]>`
        select sign_count from identity.passkey_credentials where credential_id = ${passkeyB.credentialId}
      `;
      expect(Number(credB?.sign_count)).toBe(0);
      const [chRow] = await sql<{ consumed_at: Date | null }[]>`
        select consumed_at from identity.passkey_challenges where challenge = ${freshOpts.options.challenge}
      `;
      expect(chRow?.consumed_at).toBeNull();
    });
  });

  // Pin 74
  it("refuses a tenant ceremony from another origin", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin74@example.test",
      });
      const notice = new MemoryNotice();

      // 1. Registration from auth host origin refused
      const sfReg = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "second_factor" });
      const regOpts = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
        accessToken: sfReg.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (regOpts.outcome !== "started") {
        throw new Error("expected started");
      }
      const keyReg = await signer();
      const credReg = crypto.getRandomValues(new Uint8Array(16));
      await expect(
        finishTenantPasskeyRegistration(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sfReg.accessToken,
            now,
            adminRpId: ADMIN_RP_ID,
            clientDataJSON: clientData("webauthn.create", regOpts.options.challenge, ORIGIN),
            attestationObject: attestationObject(
              authenticatorData({
                rpId: ADMIN_RP_ID,
                signCount: 0,
                credentialId: credReg,
                cose: coseKey(keyReg.x, keyReg.y),
                flags: 0x45,
              }),
            ),
          },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });
      expect(notice.calls).toHaveLength(0);

      // Register valid passkey on ADMIN_ORIGIN to test assertion ceremonies from ORIGIN
      const enrolled = await registerTenantPasskey(sql, kms, KEY_ARN, userId, now);

      // 2. Passkey sign-in from auth host origin refused
      const signInOpts = await beginPasskeyAuthentication(sql, {
        rpId: ADMIN_RP_ID,
        now,
        userVerification: "required",
      });
      const signInData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const signInClient = clientData("webauthn.get", signInOpts.challenge, ORIGIN);
      await expect(
        signInWithPasskey(sql, kms, KEY_ARN, {
          adminRpId: ADMIN_RP_ID,
          now,
          credentialId: enrolled.credentialId,
          clientDataJSON: signInClient,
          authenticatorData: signInData,
          signature: await enrolled.key.sign(concat([signInData, await sha256(signInClient)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // 3. Second step from auth host origin refused
      const sfStep = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "second_factor" });
      const sfOpts = await beginSecondStepPasskey(sql, kms, KEY_ARN, {
        accessToken: sfStep.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (sfOpts.outcome !== "started") {
        throw new Error("expected started");
      }
      const sfData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const sfClient = clientData("webauthn.get", sfOpts.options.challenge, ORIGIN);
      await expect(
        verifySecondStepPasskey(sql, kms, KEY_ARN, {
          accessToken: sfStep.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
          credentialId: enrolled.credentialId,
          clientDataJSON: sfClient,
          authenticatorData: sfData,
          signature: await enrolled.key.sign(concat([sfData, await sha256(sfClient)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // 4. Fresh check from auth host origin refused
      const admin = await createSession(sql, kms, KEY_ARN, {
        userId,
        now,
        kind: "tenant",
        factor: "passkey_uv",
      });
      const freshOpts = await beginFreshPasskey(sql, kms, KEY_ARN, {
        accessToken: admin.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (freshOpts.outcome !== "started") {
        throw new Error("expected started");
      }
      const freshData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const freshClient = clientData("webauthn.get", freshOpts.options.challenge, ORIGIN);
      await expect(
        verifyFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: admin.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
          credentialId: enrolled.credentialId,
          clientDataJSON: freshClient,
          authenticatorData: freshData,
          signature: await enrolled.key.sign(concat([freshData, await sha256(freshClient)])),
        }),
      ).resolves.toEqual({ outcome: "refused" });
    });
  });

  // Pin 75
  it("a passkey sign-in records passkey_uv and a fresh factor", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 60_000);
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin75@example.test",
      });
      const enrolled = await registerTenantPasskey(sql, kms, KEY_ARN, userId, now);

      const options = await beginPasskeyAuthentication(sql, {
        rpId: ADMIN_RP_ID,
        now: t1,
        userVerification: "required",
      });
      const authData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const client = clientData("webauthn.get", options.challenge, ADMIN_ORIGIN);
      const sig = await enrolled.key.sign(concat([authData, await sha256(client)]));

      const signedIn = await signInWithPasskey(sql, kms, KEY_ARN, {
        adminRpId: ADMIN_RP_ID,
        now: t1,
        credentialId: enrolled.credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature: sig,
      });
      expect(signedIn.outcome).toBe("signed_in");
      if (signedIn.outcome !== "signed_in") {
        throw new Error("expected signed_in");
      }

      const accessHash = await sessionAccessHash(sql, kms, KEY_ARN, signedIn.tokens.accessToken);
      const [row] = await sql<
        {
          kind: string;
          factor: string | null;
          fresh_factor_at: Date | null;
          recovery_until: Date | null;
        }[]
      >`
        select kind, factor, fresh_factor_at, recovery_until
        from identity.sessions
        where access_hash = ${accessHash}
      `;
      expect(row).toEqual({
        kind: "tenant",
        factor: "passkey_uv",
        fresh_factor_at: t1,
        recovery_until: null,
      });

      const listed = await listSecondFactors(sql, kms, KEY_ARN, {
        accessToken: signedIn.tokens.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      expect(listed.outcome).toBe("listed");
      if (listed.outcome === "listed") {
        expect(listed.freshUntil).toEqual(new Date(t1.getTime() + FIVE_MINUTES_MS));
      }

      const made = await regenerateBackupCodes(
        sql,
        kms,
        KEY_ARN,
        { accessToken: signedIn.tokens.accessToken, now: t1 },
        { notice: new MemoryNotice() },
      );
      expect(made.outcome).toBe("made");
    });
  });

  // Pin 76
  it("a passkey sign-in waits for the second factor lock", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    const kms = createLocalKmsPort();
    const runtime = loadRuntime();
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    const sql = postgres(identityUrl(runtime), {
      max: 10,
      prepare: true,
      onnotice: () => undefined,
    });
    const removeSql = postgres(identityUrl(runtime), {
      max: 10,
      prepare: true,
      onnotice: () => undefined,
    });
    const holder = createPlaintextIdentitySql(identityUrl(runtime));
    const observer = createPlaintextDirectSql(runtime.productOnlyUrl);

    let releaseHolder: () => void = () => undefined;
    let releasePause: () => void = () => undefined;
    let holderPromise: Promise<void> | undefined;
    let signInPromise: ReturnType<typeof signInWithPasskey> | undefined;
    let removePromise: ReturnType<typeof removePasskey> | undefined;

    try {
      await clearIdentity(sql, direct);

      // 1. Lock pin via pg_locks: signInWithPasskey waits for lockSecondFactor
      {
        const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
          email: "pin76-lock@example.test",
        });
        const enrolled = await registerTenantPasskey(sql, kms, KEY_ARN, userId, now);
        const options = await beginPasskeyAuthentication(sql, {
          rpId: ADMIN_RP_ID,
          now: t1,
          userVerification: "required",
        });
        const authData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
        const client = clientData("webauthn.get", options.challenge, ADMIN_ORIGIN);
        const signature = await enrolled.key.sign(concat([authData, await sha256(client)]));

        const holderGate = new Promise<void>((resolve) => {
          releaseHolder = resolve;
        });
        let lockAcquiredNotify: () => void = () => undefined;
        const lockAcquired = new Promise<void>((resolve) => {
          lockAcquiredNotify = resolve;
        });
        let holderPid = 0;
        let settled = false;

        holderPromise = holder.begin(async (tx) => {
          const pidRows = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          holderPid = pidRows[0]!.pid;
          await lockSecondFactor(tx, userId);
          lockAcquiredNotify();
          await holderGate;
        });
        await Promise.race([lockAcquired, holderPromise]);

        signInPromise = signInWithPasskey(sql, kms, KEY_ARN, {
          adminRpId: ADMIN_RP_ID,
          now: t1,
          credentialId: enrolled.credentialId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature,
        }).finally(() => {
          settled = true;
        });

        const waiterFound = await waitForAdvisoryLockWaiter(
          observer,
          userId,
          holderPid,
          () => settled,
        );
        expect(waiterFound).toBe(true);
        expect(settled).toBe(false);

        releaseHolder();
        await holderPromise;
        const result = await signInPromise;
        expect(result.outcome).toBe("signed_in");
      }

      // 2a. Removal acquires the lock first -> passkey sign-in sees credential removed and mints nothing
      {
        const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
          email: "pin76-race-remove-first@example.test",
        });
        const totp = await enrolTotp(sql, kms, KEY_ARN, userId, now);
        const notice = new MemoryNotice();
        const freshAdmin = await createSession(sql, kms, KEY_ARN, {
          userId,
          now: t1,
          kind: "tenant",
          factor: "otp_totp",
          freshFactorAt: t1,
        });
        const addOpts = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
          accessToken: freshAdmin.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
        });
        if (addOpts.outcome !== "started") {
          throw new Error("expected started");
        }
        const pkKey = await signer();
        const pkCredId = crypto.getRandomValues(new Uint8Array(16));
        await finishTenantPasskeyRegistration(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: freshAdmin.accessToken,
            now: t1,
            adminRpId: ADMIN_RP_ID,
            clientDataJSON: clientData("webauthn.create", addOpts.options.challenge, ADMIN_ORIGIN),
            attestationObject: attestationObject(
              authenticatorData({
                rpId: ADMIN_RP_ID,
                signCount: 0,
                credentialId: pkCredId,
                cose: coseKey(pkKey.x, pkKey.y),
                flags: 0x45,
              }),
            ),
          },
          { notice },
        );
        const [pkRow] = await sql<{ id: string }[]>`
          select id from identity.passkey_credentials where credential_id = ${pkCredId}
        `;
        const authOpts = await beginPasskeyAuthentication(sql, {
          rpId: ADMIN_RP_ID,
          now: t1,
          userVerification: "required",
        });
        const authData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
        const client = clientData("webauthn.get", authOpts.challenge, ADMIN_ORIGIN);
        const signature = await pkKey.sign(concat([authData, await sha256(client)]));

        const pausedRemove = pauseOnSql(removeSql, "delete from identity.passkey_credentials");
        releasePause = pausedRemove.release;
        let signInSettled = false;

        removePromise = removePasskey(
          pausedRemove.bound,
          kms,
          KEY_ARN,
          {
            accessToken: freshAdmin.accessToken,
            now: t1,
            adminRpId: ADMIN_RP_ID,
            passkeyId: pkRow!.id,
          },
          { notice },
        );
        await Promise.race([
          pausedRemove.reached,
          removePromise.then(() => {
            throw new Error("removePasskey finished without pausing");
          }),
        ]);

        signInPromise = signInWithPasskey(sql, kms, KEY_ARN, {
          adminRpId: ADMIN_RP_ID,
          now: t1,
          credentialId: pkCredId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature,
        }).finally(() => {
          signInSettled = true;
        });

        const waiterFound = await waitForAdvisoryLockWaiter(
          observer,
          userId,
          0,
          () => signInSettled,
        );
        expect(waiterFound).toBe(true);

        pausedRemove.release();
        const [removedRes, signInRes] = await Promise.all([removePromise, signInPromise]);
        expect(removedRes).toEqual({ outcome: "removed" });
        expect(signInRes).toEqual({ outcome: "refused" });

        const passkeySessions = await sql<{ id: string }[]>`
          select id from identity.sessions
          where user_id = ${userId} and factor = 'passkey_uv' and revoked_at is null
        `;
        expect(passkeySessions).toHaveLength(0);
        expect(totp.key).toBeDefined();
      }

      // 2b. Passkey sign-in acquires the lock first -> removal revokes the newly minted session via endOtherSessions
      {
        const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
          email: "pin76-race-signin-first@example.test",
        });
        await enrolTotp(sql, kms, KEY_ARN, userId, now);
        const notice = new MemoryNotice();
        const freshAdmin = await createSession(sql, kms, KEY_ARN, {
          userId,
          now: t1,
          kind: "tenant",
          factor: "otp_totp",
          freshFactorAt: t1,
        });
        const addOpts = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
          accessToken: freshAdmin.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
        });
        if (addOpts.outcome !== "started") {
          throw new Error("expected started");
        }
        const pkKey = await signer();
        const pkCredId = crypto.getRandomValues(new Uint8Array(16));
        await finishTenantPasskeyRegistration(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: freshAdmin.accessToken,
            now: t1,
            adminRpId: ADMIN_RP_ID,
            clientDataJSON: clientData("webauthn.create", addOpts.options.challenge, ADMIN_ORIGIN),
            attestationObject: attestationObject(
              authenticatorData({
                rpId: ADMIN_RP_ID,
                signCount: 0,
                credentialId: pkCredId,
                cose: coseKey(pkKey.x, pkKey.y),
                flags: 0x45,
              }),
            ),
          },
          { notice },
        );
        const [pkRow] = await sql<{ id: string }[]>`
          select id from identity.passkey_credentials where credential_id = ${pkCredId}
        `;
        const authOpts = await beginPasskeyAuthentication(sql, {
          rpId: ADMIN_RP_ID,
          now: t1,
          userVerification: "required",
        });
        const authData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
        const client = clientData("webauthn.get", authOpts.challenge, ADMIN_ORIGIN);
        const signature = await pkKey.sign(concat([authData, await sha256(client)]));

        const pausedSignIn = pauseOnSql(sql, "insert into identity.sessions");
        releasePause = pausedSignIn.release;
        let removeSettled = false;

        signInPromise = signInWithPasskey(pausedSignIn.bound, kms, KEY_ARN, {
          adminRpId: ADMIN_RP_ID,
          now: t1,
          credentialId: pkCredId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature,
        });
        await Promise.race([
          pausedSignIn.reached,
          signInPromise.then(() => {
            throw new Error("signInWithPasskey finished without pausing");
          }),
        ]);

        removePromise = removePasskey(
          removeSql,
          kms,
          KEY_ARN,
          {
            accessToken: freshAdmin.accessToken,
            now: t1,
            adminRpId: ADMIN_RP_ID,
            passkeyId: pkRow!.id,
          },
          { notice },
        ).finally(() => {
          removeSettled = true;
        });

        const waiterFound = await waitForAdvisoryLockWaiter(
          observer,
          userId,
          0,
          () => removeSettled,
        );
        expect(waiterFound).toBe(true);

        pausedSignIn.release();
        const [signInRes, removedRes] = await Promise.all([signInPromise, removePromise]);
        expect(removedRes).toEqual({ outcome: "removed" });
        expect(signInRes.outcome).toBe("signed_in");
        if (signInRes.outcome === "signed_in") {
          expect(
            await readSession(sql, kms, KEY_ARN, {
              accessToken: signInRes.tokens.accessToken,
              now: t1,
            }),
          ).toBeNull();
        }
        const livePasskeySessions = await sql<{ id: string }[]>`
          select id from identity.sessions
          where user_id = ${userId} and factor = 'passkey_uv' and revoked_at is null
        `;
        expect(livePasskeySessions).toHaveLength(0);
      }
    } finally {
      releaseHolder();
      releasePause();
      await signInPromise?.catch(() => undefined);
      await removePromise?.catch(() => undefined);
      await holderPromise?.catch(() => undefined);
      await clearIdentity(sql, direct);
      await holder.end({ timeout: 1 });
      await observer.end({ timeout: 1 });
      await removeSql.end({ timeout: 1 });
      await sql.end({ timeout: 1 });
      await direct.end({ timeout: 1 });
    }
  }, 15_000);

  // Pin 77
  it("refuses passkey register options from a pre-2FA session when the user has a factor", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      // Case A: user with confirmed TOTP
      const { userId: totpUser } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin77-totp@example.test",
      });
      await enrolTotp(sql, kms, KEY_ARN, totpUser, now);
      const sfTotp = await createSession(sql, kms, KEY_ARN, {
        userId: totpUser,
        now,
        kind: "second_factor",
      });
      await expect(
        beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
          accessToken: sfTotp.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      const chTotp = await sql<{ id: string }[]>`
        select id from identity.passkey_challenges where user_id = ${totpUser}
      `;
      expect(chTotp).toHaveLength(0);

      // Case B: user with counting passkey
      const { userId: pkUser } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin77-pk@example.test",
      });
      await registerTenantPasskey(sql, kms, KEY_ARN, pkUser, now);
      const sfPk = await createSession(sql, kms, KEY_ARN, {
        userId: pkUser,
        now,
        kind: "second_factor",
      });
      await expect(
        beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
          accessToken: sfPk.accessToken,
          now,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      const chPk = await sql<{ id: string }[]>`
        select id from identity.passkey_challenges where user_id = ${pkUser} and consumed_at is null
      `;
      expect(chPk).toHaveLength(0);

      // Positive control: user with only a non-counting pre-chunk passkey can still enrol
      const { userId: legacyUser } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin77-legacy@example.test",
      });
      const legacyKey = await signer();
      await sql`
        insert into identity.passkey_credentials (
          id, user_id, credential_id, cose_key, sign_count, rp_id, user_verified, created_at
        ) values
          (${newId()}, ${legacyUser}, ${crypto.getRandomValues(new Uint8Array(16))}, ${coseKey(legacyKey.x, legacyKey.y)}, 0, ${RP_ID}, true, ${now}),
          (${newId()}, ${legacyUser}, ${crypto.getRandomValues(new Uint8Array(16))}, ${coseKey(legacyKey.x, legacyKey.y)}, 0, ${ADMIN_RP_ID}, false, ${now})
      `;
      const sfLegacy = await createSession(sql, kms, KEY_ARN, {
        userId: legacyUser,
        now,
        kind: "second_factor",
      });
      const allowed = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
        accessToken: sfLegacy.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(allowed.outcome).toBe("started");
    });
  });

  // Pin 78
  it("refuses passkey register verify from a pre-2FA session when the user has a factor", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      // Case A: user starts passkey setup with no factor, enrols TOTP before finishing
      const { userId: userA } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin78-a@example.test",
      });
      const sfA = await createSession(sql, kms, KEY_ARN, {
        userId: userA,
        now,
        kind: "second_factor",
      });
      const optsA = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
        accessToken: sfA.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (optsA.outcome !== "started") {
        throw new Error("expected started");
      }
      await enrolTotp(sql, kms, KEY_ARN, userA, now);

      const keyA = await signer();
      const credIdA = crypto.getRandomValues(new Uint8Array(16));
      const notice = new MemoryNotice();
      await expect(
        finishTenantPasskeyRegistration(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sfA.accessToken,
            now,
            adminRpId: ADMIN_RP_ID,
            clientDataJSON: clientData("webauthn.create", optsA.options.challenge, ADMIN_ORIGIN),
            attestationObject: attestationObject(
              authenticatorData({
                rpId: ADMIN_RP_ID,
                signCount: 0,
                credentialId: credIdA,
                cose: coseKey(keyA.x, keyA.y),
                flags: 0x45,
              }),
            ),
          },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });
      expect(notice.calls).toHaveLength(0);
      const credsA = await sql<{ id: string }[]>`
        select id from identity.passkey_credentials where user_id = ${userA}
      `;
      expect(credsA).toHaveLength(0);

      // Case B: user starts passkey setup with no factor, another passkey is enrolled before finishing
      const { userId: userB } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "pin78-b@example.test",
      });
      const sfB = await createSession(sql, kms, KEY_ARN, {
        userId: userB,
        now,
        kind: "second_factor",
      });
      const optsB = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
        accessToken: sfB.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      if (optsB.outcome !== "started") {
        throw new Error("expected started");
      }
      const firstPk = await registerTenantPasskey(sql, kms, KEY_ARN, userB, now);

      const keyB2 = await signer();
      const credIdB2 = crypto.getRandomValues(new Uint8Array(16));
      await expect(
        finishTenantPasskeyRegistration(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sfB.accessToken,
            now,
            adminRpId: ADMIN_RP_ID,
            clientDataJSON: clientData("webauthn.create", optsB.options.challenge, ADMIN_ORIGIN),
            attestationObject: attestationObject(
              authenticatorData({
                rpId: ADMIN_RP_ID,
                signCount: 0,
                credentialId: credIdB2,
                cose: coseKey(keyB2.x, keyB2.y),
                flags: 0x45,
              }),
            ),
          },
          { notice },
        ),
      ).resolves.toEqual({ outcome: "refused" });
      expect(notice.calls).toHaveLength(0);
      const credsB = await sql<{ credential_id: Uint8Array }[]>`
        select credential_id from identity.passkey_credentials where user_id = ${userB}
      `;
      expect(credsB).toHaveLength(1);
      expect(Buffer.from(credsB[0]!.credential_id)).toEqual(Buffer.from(firstPk.credentialId));
    });
  });

  // Success-path tests for Task 6
  it("first-factor passkey from a pre-2FA session returns backup codes and an admin session", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const email = "first-factor-pk@example.test";
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, { email });
      const sf1 = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "second_factor" });
      const sf2 = await createSession(sql, kms, KEY_ARN, { userId, now, kind: "second_factor" });
      const notice = new MemoryNotice();

      const start1 = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
        accessToken: sf1.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      const start2 = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
        accessToken: sf2.accessToken,
        now,
        adminRpId: ADMIN_RP_ID,
      });
      expect(start1.outcome).toBe("started");
      expect(start2.outcome).toBe("started");
      if (start1.outcome !== "started" || start2.outcome !== "started") {
        throw new Error("expected both starts to succeed");
      }
      expect(start1.options.rp.id).toBe(ADMIN_RP_ID);
      expect(start1.options.authenticatorSelection.userVerification).toBe("required");

      const key1 = await signer();
      const credId1 = crypto.getRandomValues(new Uint8Array(16));
      const key2 = await signer();
      const credId2 = crypto.getRandomValues(new Uint8Array(16));

      // Parallel first-factor passkey finishes leave exactly one passkey, 10 backup codes, and one admin session
      const results = await Promise.all([
        finishTenantPasskeyRegistration(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sf1.accessToken,
            now,
            adminRpId: ADMIN_RP_ID,
            clientDataJSON: clientData("webauthn.create", start1.options.challenge, ADMIN_ORIGIN),
            attestationObject: attestationObject(
              authenticatorData({
                rpId: ADMIN_RP_ID,
                signCount: 0,
                credentialId: credId1,
                cose: coseKey(key1.x, key1.y),
                flags: 0x45,
              }),
            ),
          },
          { notice },
        ),
        finishTenantPasskeyRegistration(
          sql,
          kms,
          KEY_ARN,
          {
            accessToken: sf2.accessToken,
            now,
            adminRpId: ADMIN_RP_ID,
            clientDataJSON: clientData("webauthn.create", start2.options.challenge, ADMIN_ORIGIN),
            attestationObject: attestationObject(
              authenticatorData({
                rpId: ADMIN_RP_ID,
                signCount: 0,
                credentialId: credId2,
                cose: coseKey(key2.x, key2.y),
                flags: 0x45,
              }),
            ),
          },
          { notice },
        ),
      ]);

      const enrolledResults = results.filter((r) => r.outcome === "enrolled");
      const refusedResults = results.filter((r) => r.outcome === "refused");
      expect(enrolledResults).toHaveLength(1);
      expect(refusedResults).toHaveLength(1);

      const winner = enrolledResults[0]!;
      if (winner.outcome !== "enrolled" || !winner.backupCodes || !winner.tokens) {
        throw new Error("expected backupCodes and tokens");
      }
      expect(winner.backupCodes).toHaveLength(10);
      expect(new Set(winner.backupCodes).size).toBe(10);
      expect(notice.calls).toEqual([{ to: email, kind: "passkey_added" }]);

      const accessHash = await sessionAccessHash(sql, kms, KEY_ARN, winner.tokens.accessToken);
      const [sessionRow] = await sql<
        {
          kind: string;
          factor: string | null;
          fresh_factor_at: Date | null;
          recovery_until: Date | null;
        }[]
      >`
        select kind, factor, fresh_factor_at, recovery_until
        from identity.sessions
        where access_hash = ${accessHash}
      `;
      expect(sessionRow).toEqual({
        kind: "tenant",
        factor: "otp_passkey",
        fresh_factor_at: null,
        recovery_until: null,
      });

      const [backupCount] = await sql<{ n: number }[]>`
        select count(*)::int as n from identity.backup_codes where user_id = ${userId} and used_at is null
      `;
      expect(backupCount?.n).toBe(10);

      const events = await sql<{ event: string }[]>`
        select event from identity.second_factor_events where user_id = ${userId} order by occurred_at asc
      `;
      expect(events.map((e) => e.event).sort()).toEqual([
        "backup_codes_generated",
        "passkey_enrolled",
      ]);

      // Adding a second passkey from a fresh tenant session excludes the existing one, writes no backup codes, and keeps other sessions
      const freshAdmin = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_passkey",
        freshFactorAt: t1,
      });
      const addStart = await beginTenantPasskeyRegistration(sql, kms, KEY_ARN, {
        accessToken: freshAdmin.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      expect(addStart.outcome).toBe("started");
      if (addStart.outcome !== "started") {
        throw new Error("expected addStart");
      }
      expect(addStart.options.excludeCredentials).toHaveLength(1);

      const extraKey = await signer();
      const extraCred = crypto.getRandomValues(new Uint8Array(16));
      const added = await finishTenantPasskeyRegistration(
        sql,
        kms,
        KEY_ARN,
        {
          accessToken: freshAdmin.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
          clientDataJSON: clientData("webauthn.create", addStart.options.challenge, ADMIN_ORIGIN),
          attestationObject: attestationObject(
            authenticatorData({
              rpId: ADMIN_RP_ID,
              signCount: 0,
              credentialId: extraCred,
              cose: coseKey(extraKey.x, extraKey.y),
              flags: 0x45,
            }),
          ),
        },
        { notice },
      );
      expect(added).toEqual({ outcome: "enrolled" });
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: winner.tokens.accessToken, now: t1 }),
      ).toEqual({ userId });

      // Backup code generated at first passkey enrolment works
      const sfBackup = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const backupSignIn = await verifySecondStep(sql, kms, KEY_ARN, {
        accessToken: sfBackup.accessToken,
        now: t1,
        method: "backup_code",
        code: winner.backupCodes[0]!,
      });
      expect(backupSignIn.outcome).toBe("verified");
    });
  });

  it("second step by user-verified passkey creates a fresh admin session and enforces limits", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 30_000);
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "second-step-pk@example.test",
      });
      const enrolled = await registerTenantPasskey(sql, kms, KEY_ARN, userId, now);

      // Success path
      const sfOk = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const optsOk = await beginSecondStepPasskey(sql, kms, KEY_ARN, {
        accessToken: sfOk.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      expect(optsOk.outcome).toBe("started");
      if (optsOk.outcome !== "started") {
        throw new Error("expected started");
      }
      expect(optsOk.options.userVerification).toBe("required");
      const authDataOk = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const clientOk = clientData("webauthn.get", optsOk.options.challenge, ADMIN_ORIGIN);
      const verified = await verifySecondStepPasskey(sql, kms, KEY_ARN, {
        accessToken: sfOk.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
        credentialId: enrolled.credentialId,
        clientDataJSON: clientOk,
        authenticatorData: authDataOk,
        signature: await enrolled.key.sign(concat([authDataOk, await sha256(clientOk)])),
      });
      expect(verified.outcome).toBe("verified");
      if (verified.outcome !== "verified") {
        throw new Error("expected verified");
      }
      expect(
        await readSessionWithKind(sql, kms, KEY_ARN, {
          accessToken: sfOk.accessToken,
          now: t1,
          kinds: ["second_factor"],
        }),
      ).toBeNull();
      const accessHash = await sessionAccessHash(sql, kms, KEY_ARN, verified.tokens.accessToken);
      const [sessionRow] = await sql<
        { kind: string; factor: string | null; fresh_factor_at: Date | null }[]
      >`
        select kind, factor, fresh_factor_at from identity.sessions where access_hash = ${accessHash}
      `;
      expect(sessionRow).toEqual({
        kind: "tenant",
        factor: "otp_passkey",
        fresh_factor_at: t1,
      });

      // Five wrong attempts revoke the pre-2FA session; ten hourly failures limit across sessions
      const badKey = await signer();
      for (const sessionIndex of [1, 2]) {
        const sf = await createSession(sql, kms, KEY_ARN, {
          userId,
          now: t1,
          kind: "second_factor",
        });
        const opts = await beginSecondStepPasskey(sql, kms, KEY_ARN, {
          accessToken: sf.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
        });
        if (opts.outcome !== "started") {
          throw new Error("expected started");
        }
        const badData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 2, flags: 0x05 });
        const badClient = clientData("webauthn.get", opts.options.challenge, ADMIN_ORIGIN);
        const badSig = await badKey.sign(concat([badData, await sha256(badClient)]));

        for (let attempt = 0; attempt < 5; attempt += 1) {
          await expect(
            verifySecondStepPasskey(sql, kms, KEY_ARN, {
              accessToken: sf.accessToken,
              now: t1,
              adminRpId: ADMIN_RP_ID,
              credentialId: enrolled.credentialId,
              clientDataJSON: badClient,
              authenticatorData: badData,
              signature: badSig,
            }),
          ).resolves.toEqual({ outcome: "refused" });
        }

        // Session is now revoked at 5 wrong attempts
        expect(
          await readSessionWithKind(sql, kms, KEY_ARN, {
            accessToken: sf.accessToken,
            now: t1,
            kinds: ["second_factor"],
          }),
        ).toBeNull();
        expect(sessionIndex).toBeGreaterThan(0);
      }

      // 11th attempt on a fresh pre-2FA session is limited even with the right passkey
      const sf3 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "second_factor",
      });
      const opts3 = await beginSecondStepPasskey(sql, kms, KEY_ARN, {
        accessToken: sf3.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      if (opts3.outcome !== "started") {
        throw new Error("expected started");
      }
      const rightData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 2, flags: 0x05 });
      const rightClient = clientData("webauthn.get", opts3.options.challenge, ADMIN_ORIGIN);
      await expect(
        verifySecondStepPasskey(sql, kms, KEY_ARN, {
          accessToken: sf3.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
          credentialId: enrolled.credentialId,
          clientDataJSON: rightClient,
          authenticatorData: rightData,
          signature: await enrolled.key.sign(concat([rightData, await sha256(rightClient)])),
        }),
      ).resolves.toEqual({ outcome: "limited" });

      // After 1 hour, passes again
      const afterHour = new Date(t1.getTime() + HOUR_MS);
      const sf4 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: afterHour,
        kind: "second_factor",
      });
      const opts4 = await beginSecondStepPasskey(sql, kms, KEY_ARN, {
        accessToken: sf4.accessToken,
        now: afterHour,
        adminRpId: ADMIN_RP_ID,
      });
      if (opts4.outcome !== "started") {
        throw new Error("expected started");
      }
      const data4 = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 2, flags: 0x05 });
      const client4 = clientData("webauthn.get", opts4.options.challenge, ADMIN_ORIGIN);
      await expect(
        verifySecondStepPasskey(sql, kms, KEY_ARN, {
          accessToken: sf4.accessToken,
          now: afterHour,
          adminRpId: ADMIN_RP_ID,
          credentialId: enrolled.credentialId,
          clientDataJSON: client4,
          authenticatorData: data4,
          signature: await enrolled.key.sign(concat([data4, await sha256(client4)])),
        }),
      ).resolves.toMatchObject({ outcome: "verified" });
    });
  });

  it("fresh check by user-verified passkey refreshes the factor and enforces limits", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const t1 = new Date(now.getTime() + 6 * 60 * 1000);
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const { userId } = await insertIdentityUser(sql, kms, KEY_ARN, {
        email: "fresh-pk@example.test",
      });
      const enrolled = await registerTenantPasskey(sql, kms, KEY_ARN, userId, now);
      const notice = new MemoryNotice();

      // Non-tenant and recovery sessions are refused on beginFreshPasskey and verifyFreshPasskey
      const sf = await createSession(sql, kms, KEY_ARN, { userId, now: t1, kind: "second_factor" });
      await expect(
        beginFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: sf.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      const recovery = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_backup_code",
        recoveryUntil: new Date(t1.getTime() + TEN_MINUTES_MS),
      });
      await expect(
        beginFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: recovery.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });
      // Still refused after the 10-minute recovery window ends
      await expect(
        beginFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: recovery.accessToken,
          now: new Date(t1.getTime() + TEN_MINUTES_MS + 1000),
          adminRpId: ADMIN_RP_ID,
        }),
      ).resolves.toEqual({ outcome: "refused" });

      // Stale tenant session passes fresh check via passkey
      const admin = enrolled.tokens;
      const freshOpts = await beginFreshPasskey(sql, kms, KEY_ARN, {
        accessToken: admin.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      expect(freshOpts.outcome).toBe("started");
      if (freshOpts.outcome !== "started") {
        throw new Error("expected started");
      }
      const authData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 1, flags: 0x05 });
      const client = clientData("webauthn.get", freshOpts.options.challenge, ADMIN_ORIGIN);
      await expect(
        verifyFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: admin.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
          credentialId: enrolled.credentialId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature: await enrolled.key.sign(concat([authData, await sha256(client)])),
        }),
      ).resolves.toEqual({ outcome: "fresh" });

      // Fresh check allows factor management
      const made = await regenerateBackupCodes(
        sql,
        kms,
        KEY_ARN,
        { accessToken: admin.accessToken, now: t1 },
        { notice },
      );
      expect(made.outcome).toBe("made");

      // 6th wrong fresh passkey answer on an admin session returns limited and keeps the session active
      const admin2 = await createSession(sql, kms, KEY_ARN, {
        userId,
        now: t1,
        kind: "tenant",
        factor: "otp_passkey",
      });
      const badKey = await signer();
      const limitOpts = await beginFreshPasskey(sql, kms, KEY_ARN, {
        accessToken: admin2.accessToken,
        now: t1,
        adminRpId: ADMIN_RP_ID,
      });
      if (limitOpts.outcome !== "started") {
        throw new Error("expected started");
      }
      const badData = authenticatorData({ rpId: ADMIN_RP_ID, signCount: 2, flags: 0x05 });
      const badClient = clientData("webauthn.get", limitOpts.options.challenge, ADMIN_ORIGIN);
      const badSig = await badKey.sign(concat([badData, await sha256(badClient)]));

      for (let i = 0; i < 5; i += 1) {
        await expect(
          verifyFreshPasskey(sql, kms, KEY_ARN, {
            accessToken: admin2.accessToken,
            now: t1,
            adminRpId: ADMIN_RP_ID,
            credentialId: enrolled.credentialId,
            clientDataJSON: badClient,
            authenticatorData: badData,
            signature: badSig,
          }),
        ).resolves.toEqual({ outcome: "refused" });
      }
      await expect(
        verifyFreshPasskey(sql, kms, KEY_ARN, {
          accessToken: admin2.accessToken,
          now: t1,
          adminRpId: ADMIN_RP_ID,
          credentialId: enrolled.credentialId,
          clientDataJSON: badClient,
          authenticatorData: badData,
          signature: badSig,
        }),
      ).resolves.toEqual({ outcome: "limited" });

      // Session stays active
      expect(
        await readSession(sql, kms, KEY_ARN, { accessToken: admin2.accessToken, now: t1 }),
      ).toEqual({ userId });
    });
  });
});
