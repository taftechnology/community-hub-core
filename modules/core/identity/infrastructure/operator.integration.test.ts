import { createHash, generateKeyPairSync, sign as signDer } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId } from "@community-hub/db";
import {
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { encodeCbor, type Cbor } from "../domain/cbor.js";
import { IdentityError } from "../domain/error.js";
import { type OtpMail, OtpMailUnavailable, rejectingOtpMail } from "../domain/otp-mail.js";
import { deriveIdentityEmailKeys, emailBlindIndex } from "./email-lookup.js";
import { startEmailOtp, verifyEmailOtp } from "./email-otp.js";
import { insertIdentityUser } from "./identity-user.js";
import {
  beginOperatorAuthentication,
  beginOperatorPasskeyRegistration,
  endOperatorSession,
  finishOperatorAuthentication,
  finishOperatorPasskeyRegistration,
  grantOperator,
  lockOperatorUser,
  readOperatorSession,
  recoverOperator,
  refreshOperatorSession,
  revokeOperator,
  startOperatorEnrolment,
  verifyOperatorEnrolment,
  type VerifyOperatorEnrolmentResult,
} from "./operator.js";
import { beginPasskeyRegistration } from "./passkey.js";
import {
  createSession,
  createSessionInTransaction,
  readSession,
  readSessionWithKind,
  refreshSession,
  type SessionTokens,
} from "./session.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "identity" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
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

function clientData(type: string, challenge: Uint8Array, origin: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: Buffer.from(challenge).toString("base64url"),
      origin,
    }),
  );
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
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

function pauseOnSessionInsert(sql: Sql): {
  bound: Sql;
  reached: Promise<void>;
  release: () => void;
} {
  let releaseInsert = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    releaseInsert = resolve;
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
                if (armed && text.includes("insert into identity.sessions")) {
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
  return { bound, reached, release: releaseInsert };
}

beforeAll(async () => {
  const runtime = loadRuntime();
  const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(direct);
  } finally {
    await direct.end({ timeout: 1 });
  }
});

describe("operator tables privileges", () => {
  const kms = createLocalKmsPort();

  beforeAll(async () => {
    const runtime = loadRuntime();
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await applyProductMigrations(direct);
      await direct`delete from identity.operator_events`;
      await direct`delete from identity.operator_grants`;
      await direct`delete from identity.identity_keys`;
      await direct`delete from identity.sessions`;
      await direct`delete from identity.users`;
    } finally {
      await direct.end({ timeout: 1 });
    }
  });

  afterAll(async () => {
    const runtime = loadRuntime();
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await direct`delete from identity.operator_events`;
      await direct`delete from identity.operator_grants`;
      await direct`delete from identity.identity_keys`;
      await direct`delete from identity.sessions`;
      await direct`delete from identity.users`;
    } finally {
      await direct.end({ timeout: 1 });
    }
  });

  it("enforces append-only on operator_events and restricted delete on operator_grants for identity role", async () => {
    const runtime = loadRuntime();
    const identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    try {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "operator-priv@example.test",
      });
      const grantId = newId();
      const now = new Date("2026-10-24T12:00:00.000Z");
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const codeHash = Buffer.from("enrolment-code-hash-placeholder-32b");

      // Positive case: identity role can insert into operator_grants
      await identitySql`
        insert into identity.operator_grants (
          id, user_id, role_key, enrolment_code_hash, granted_at, enrolment_expires_at
        ) values (
          ${grantId}, ${user.userId}, 'platform_admin', ${codeHash}, ${now}, ${expiresAt}
        )
      `;

      // Positive case: identity role can update operator_grants
      const activatedAt = new Date("2026-10-24T13:00:00.000Z");
      await identitySql`
        update identity.operator_grants
        set activated_at = ${activatedAt}
        where id = ${grantId}
      `;
      const [updatedGrant] = await identitySql<{ activated_at: Date }[]>`
        select activated_at from identity.operator_grants where id = ${grantId}
      `;
      expect(updatedGrant?.activated_at).toEqual(activatedAt);

      // Positive case: identity role can insert into operator_events
      const eventId = newId();
      await identitySql`
        insert into identity.operator_events (
          id, user_id, action, role_key, occurred_at
        ) values (
          ${eventId}, ${user.userId}, 'granted', 'platform_admin', ${now}
        )
      `;

      // Identity role CANNOT update operator_events (fails with 42501)
      await expect(
        identitySql`update identity.operator_events set action = 'revoked' where id = ${eventId}`,
      ).rejects.toMatchObject({ code: "42501" });

      // Identity role CANNOT delete operator_events (fails with 42501)
      await expect(
        identitySql`delete from identity.operator_events where id = ${eventId}`,
      ).rejects.toMatchObject({ code: "42501" });

      // Identity role CANNOT delete operator_grants (fails with 42501)
      await expect(
        identitySql`delete from identity.operator_grants where id = ${grantId}`,
      ).rejects.toMatchObject({ code: "42501" });

      // Identity role has NO TRUNCATE privilege on either table
      const [privs] = await identitySql<{ events_truncate: boolean; grants_truncate: boolean }[]>`
        select
          has_table_privilege('identity', 'identity.operator_events', 'TRUNCATE') as events_truncate,
          has_table_privilege('identity', 'identity.operator_grants', 'TRUNCATE') as grants_truncate
      `;
      expect(privs).toEqual({ events_truncate: false, grants_truncate: false });
    } finally {
      await identitySql.end({ timeout: 1 });
    }
  });

  it("denies select on operator_grants to platform role", async () => {
    const runtime = loadRuntime();
    const platformSql = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    try {
      await expect(platformSql`select id from identity.operator_grants`).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await platformSql.end({ timeout: 1 });
    }
  });

  it("enforces operator_grants_role_key check constraint", async () => {
    const runtime = loadRuntime();
    const identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    try {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "operator-grant-check@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const codeHash = Buffer.from("enrolment-code-hash-placeholder-32b");

      await expect(
        identitySql`
          insert into identity.operator_grants (
            id, user_id, role_key, enrolment_code_hash, granted_at, enrolment_expires_at
          ) values (
            ${newId()}, ${user.userId}, 'member', ${codeHash}, ${now}, ${expiresAt}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await identitySql.end({ timeout: 1 });
    }
  });

  it("enforces operator_events_role_key check constraint", async () => {
    const runtime = loadRuntime();
    const identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    try {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "operator-event-check@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");

      // action = 'signed_in' with role_key fails with 23514
      await expect(
        identitySql`
          insert into identity.operator_events (
            id, user_id, action, role_key, occurred_at
          ) values (
            ${newId()}, ${user.userId}, 'signed_in', 'platform_admin', ${now}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });

      // action = 'granted' without role_key fails with 23514
      await expect(
        identitySql`
          insert into identity.operator_events (
            id, user_id, action, role_key, occurred_at
          ) values (
            ${newId()}, ${user.userId}, 'granted', null, ${now}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });

      // Positive case: action = 'signed_in' without role_key succeeds
      const signedInId = newId();
      await identitySql`
        insert into identity.operator_events (
          id, user_id, action, role_key, occurred_at
        ) values (
          ${signedInId}, ${user.userId}, 'signed_in', null, ${now}
        )
      `;
      const [event] = await identitySql<{ id: string }[]>`
        select id from identity.operator_events where id = ${signedInId}
      `;
      expect(event?.id).toBe(signedInId);
    } finally {
      await identitySql.end({ timeout: 1 });
    }
  });
});

function throwOnGrantInsert(sql: Sql): Sql {
  const originalBegin = sql.begin.bind(sql);
  return new Proxy(sql, {
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
                if (text.includes("insert into identity.operator_grants")) {
                  throw new Error("simulated failure on insert into identity.operator_grants");
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
}

async function insertTestSession(
  sql: Sql,
  input: {
    userId: string;
    kind: "tenant" | "operator" | "enrolment";
    now: Date;
    absoluteExpiresAt?: Date;
  },
): Promise<string> {
  const sessionId = newId();
  const hash = Buffer.from(newId().replaceAll("-", ""));
  const accessExpiresAt = new Date(input.now.getTime() + 15 * 60 * 1000);
  const refreshExpiresAt = new Date(input.now.getTime() + 8 * 60 * 60 * 1000);
  const absExp = input.kind === "operator" ? (input.absoluteExpiresAt ?? refreshExpiresAt) : null;
  await sql`
    insert into identity.sessions (
      id, user_id, refresh_family, access_hash, refresh_hash,
      access_expires_at, refresh_expires_at, kind, absolute_expires_at
    ) values (
      ${sessionId}, ${input.userId}, ${newId()}, ${hash}, ${Buffer.from(newId().replaceAll("-", ""))},
      ${accessExpiresAt}, ${refreshExpiresAt}, ${input.kind}, ${absExp}
    )
  `;
  return sessionId;
}

async function insertTestPasskeyCredential(
  sql: Sql,
  input: {
    userId: string;
    rpId?: string | null;
  },
): Promise<string> {
  const credId = newId();
  const rawCredId = Buffer.from("cred-" + newId().replaceAll("-", ""));
  const cose = Buffer.from("cose-key-bytes");
  await sql`
    insert into identity.passkey_credentials (
      id, user_id, credential_id, cose_key, sign_count, rp_id
    ) values (
      ${credId}, ${input.userId}, ${rawCredId}, ${cose}, 0, ${input.rpId ?? null}
    )
  `;
  return credId;
}

describe("grantOperator, revokeOperator and recoverOperator", () => {
  const kms = createLocalKmsPort();
  let identitySql: Sql;
  let directSql: Sql;
  const runtime = loadRuntime();

  beforeAll(async () => {
    directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    await directSql`delete from identity.operator_events`;
    await directSql`delete from identity.operator_grants`;
    await directSql`delete from identity.sessions`;
    await directSql`delete from identity.passkey_credentials`;
    await directSql`delete from identity.identity_keys`;
    await directSql`delete from identity.users`;
  });

  afterAll(async () => {
    try {
      await directSql`delete from identity.operator_events`;
      await directSql`delete from identity.operator_grants`;
      await directSql`delete from identity.sessions`;
      await directSql`delete from identity.passkey_credentials`;
      await directSql`delete from identity.identity_keys`;
      await directSql`delete from identity.users`;
    } finally {
      await identitySql.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  describe("pin 3a: grantOperator refuses malformed codes", () => {
    it("refuses a code that is too short (25 chars)", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-short@example.test",
      });
      const shortCode = "A".repeat(25);
      await expect(
        grantOperator(identitySql, kms, KEY_ARN, {
          userId: user.userId,
          roleKeys: ["platform_admin"],
          enrolmentCode: shortCode,
          opsRpId: "ops.example.test",
          now: new Date("2026-10-24T12:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    });

    it("refuses a code containing non-base32 characters", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-non-base32@example.test",
      });
      const invalidCode = "A".repeat(25) + "8";
      await expect(
        grantOperator(identitySql, kms, KEY_ARN, {
          userId: user.userId,
          roleKeys: ["platform_admin"],
          enrolmentCode: invalidCode,
          opsRpId: "ops.example.test",
          now: new Date("2026-10-24T12:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    });

    it("refuses a code containing = padding", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-equals@example.test",
      });
      const paddedCode = "A".repeat(26) + "=";
      await expect(
        grantOperator(identitySql, kms, KEY_ARN, {
          userId: user.userId,
          roleKeys: ["platform_admin"],
          enrolmentCode: paddedCode,
          opsRpId: "ops.example.test",
          now: new Date("2026-10-24T12:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    });
  });

  describe("pin 3b: the enrolment code is stored only as an HMAC", () => {
    it("stores only HMAC and exposes no cleartext code in db, return value or logs", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-pin3b@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");
      const rawCode = "abcdef-234567-abcdef-234567-aa";
      const normalisedCode = "ABCDEF234567ABCDEF234567AA";
      const rawBytes = Buffer.from(rawCode, "utf8");
      const normalisedBytes = Buffer.from(normalisedCode, "utf8");

      const spyLog = vi.spyOn(console, "log");
      const spyInfo = vi.spyOn(console, "info");
      const spyWarn = vi.spyOn(console, "warn");
      const spyError = vi.spyOn(console, "error");
      const spyDebug = vi.spyOn(console, "debug");

      try {
        const result = await grantOperator(identitySql, kms, KEY_ARN, {
          userId: user.userId,
          roleKeys: ["platform_admin"],
          enrolmentCode: rawCode,
          opsRpId: "ops.example.test",
          now,
        });

        // Return value holds no code
        const jsonResult = JSON.stringify(result);
        expect(jsonResult).not.toContain(rawCode);
        expect(jsonResult).not.toContain(normalisedCode);

        // Console spy sees no call containing it
        const allSpies = [spyLog, spyInfo, spyWarn, spyError, spyDebug];
        for (const spy of allSpies) {
          for (const call of spy.mock.calls) {
            const str = call.map((arg) => String(arg)).join(" ");
            expect(str).not.toContain(rawCode);
            expect(str).not.toContain(normalisedCode);
          }
        }

        // Code UTF-8 bytes and normalised form appear in no column of operator_grants
        const [grantMatches] = await identitySql<
          {
            pos_raw_hash: number;
            pos_norm_hash: number;
            pos_raw_role: number;
            pos_norm_role: number;
          }[]
        >`
          select
            position(${rawBytes} in enrolment_code_hash) as pos_raw_hash,
            position(${normalisedBytes} in enrolment_code_hash) as pos_norm_hash,
            position(${rawCode} in role_key) as pos_raw_role,
            position(${normalisedCode} in role_key) as pos_norm_role
          from identity.operator_grants
          where user_id = ${user.userId}
        `;
        expect(grantMatches).toEqual({
          pos_raw_hash: 0,
          pos_norm_hash: 0,
          pos_raw_role: 0,
          pos_norm_role: 0,
        });

        // Code UTF-8 bytes and normalised form appear in no column of operator_events
        const [eventMatches] = await identitySql<
          {
            pos_raw_action: number;
            pos_norm_action: number;
            pos_raw_role: number;
            pos_norm_role: number;
            pos_raw_req: number;
            pos_norm_req: number;
          }[]
        >`
          select
            position(${rawCode} in action) as pos_raw_action,
            position(${normalisedCode} in action) as pos_norm_action,
            position(${rawCode} in coalesce(role_key, '')) as pos_raw_role,
            position(${normalisedCode} in coalesce(role_key, '')) as pos_norm_role,
            position(${rawCode} in coalesce(request_id, '')) as pos_raw_req,
            position(${normalisedCode} in coalesce(request_id, '')) as pos_norm_req
          from identity.operator_events
          where user_id = ${user.userId}
        `;
        expect(eventMatches).toEqual({
          pos_raw_action: 0,
          pos_norm_action: 0,
          pos_raw_role: 0,
          pos_norm_role: 0,
          pos_raw_req: 0,
          pos_norm_req: 0,
        });

        // Carry-over from Task 4 review: refused grant's error message contains no enrolment code text
        const invalidCode = "A".repeat(25) + "=";
        let grantError: unknown;
        try {
          await grantOperator(identitySql, kms, KEY_ARN, {
            userId: user.userId,
            roleKeys: ["platform_admin"],
            enrolmentCode: invalidCode,
            opsRpId: "ops.example.test",
            now,
          });
        } catch (err) {
          grantError = err;
        }
        expect(grantError).toBeInstanceOf(IdentityError);
        expect((grantError as IdentityError).code).toBe("invalid_grant");
        expect((grantError as Error).message).not.toContain(invalidCode);
      } finally {
        spyLog.mockRestore();
        spyInfo.mockRestore();
        spyWarn.mockRestore();
        spyError.mockRestore();
        spyDebug.mockRestore();
      }
    });
  });

  describe("pin 18a: revoke deletes ops passkeys and keeps tenant passkeys", () => {
    it("deletes ops passkeys and keeps tenant passkeys", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-pin18a@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");
      await insertTestPasskeyCredential(identitySql, {
        userId: user.userId,
        rpId: "ops.example.test",
      });
      await insertTestPasskeyCredential(identitySql, {
        userId: user.userId,
        rpId: "auth.example.test",
      });

      await revokeOperator(identitySql, {
        userId: user.userId,
        opsRpId: "ops.example.test",
        now,
      });

      const [opsCount] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.passkey_credentials
        where user_id = ${user.userId} and rp_id = 'ops.example.test'
      `;
      const [tenantCount] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.passkey_credentials
        where user_id = ${user.userId} and rp_id = 'auth.example.test'
      `;
      expect(opsCount?.count).toBe("0");
      expect(tenantCount?.count).toBe("1");
    });
  });

  describe("pin 18b: grant with no active grant clears leftovers; keeps beside active grant", () => {
    it("a fresh grant clears ops passkeys left from an expired window", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-pin18b-1@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");
      const expiredAt = new Date(now.getTime() - 1000);
      const grantedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000);

      // Expired unactivated grant
      await identitySql`
        insert into identity.operator_grants (
          id, user_id, role_key, enrolment_code_hash, granted_at, enrolment_expires_at
        ) values (
          ${newId()}, ${user.userId}, 'platform_admin', ${Buffer.from("old-hash-32-bytes-placeholder-")}, ${grantedAt}, ${expiredAt}
        )
      `;
      // Leftover ops passkey
      await insertTestPasskeyCredential(identitySql, {
        userId: user.userId,
        rpId: "ops.example.test",
      });

      // Fresh grant
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode: "A".repeat(26),
        opsRpId: "ops.example.test",
        now,
      });

      const [opsCount] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.passkey_credentials
        where user_id = ${user.userId} and rp_id = 'ops.example.test'
      `;
      expect(opsCount?.count).toBe("0");
    });

    it("a grant beside an active grant keeps the user's ops passkeys", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-pin18b-2@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // Active grant
      await identitySql`
        insert into identity.operator_grants (
          id, user_id, role_key, enrolment_code_hash, granted_at, enrolment_expires_at, activated_at
        ) values (
          ${newId()}, ${user.userId}, 'platform_admin', ${Buffer.from("old-hash-32-bytes-placeholder-")}, ${now}, ${expiresAt}, ${now}
        )
      `;
      // Existing ops passkey
      await insertTestPasskeyCredential(identitySql, {
        userId: user.userId,
        rpId: "ops.example.test",
      });

      // Grant a second role
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_support"],
        enrolmentCode: "A".repeat(26),
        opsRpId: "ops.example.test",
        now,
      });

      const [opsCount] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.passkey_credentials
        where user_id = ${user.userId} and rp_id = 'ops.example.test'
      `;
      expect(opsCount?.count).toBe("1");
    });
  });

  describe("pin 19: recovery writes revoked, recovery_regrant and granted together or not at all", () => {
    it("recovery writes revoked, recovery_regrant and granted together on success", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-pin19-ok@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const reqId = newId();

      const oldGrantId = newId();
      await identitySql`
        insert into identity.operator_grants (
          id, user_id, role_key, enrolment_code_hash, granted_at, enrolment_expires_at
        ) values (
          ${oldGrantId}, ${user.userId}, 'platform_admin', ${Buffer.from("old-hash-32-bytes-placeholder-")}, ${now}, ${expiresAt}
        )
      `;
      await insertTestPasskeyCredential(identitySql, {
        userId: user.userId,
        rpId: "ops.example.test",
      });
      await insertTestSession(identitySql, {
        userId: user.userId,
        kind: "operator",
        now,
      });

      const recovered = await recoverOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_security"],
        enrolmentCode: "B".repeat(26),
        opsRpId: "ops.example.test",
        now,
        requestId: reqId,
      });

      expect(recovered.grantIds).toHaveLength(1);

      // Old grant is revoked
      const [oldGrant] = await identitySql<{ revoked_at: Date | null }[]>`
        select revoked_at from identity.operator_grants where id = ${oldGrantId}
      `;
      expect(oldGrant?.revoked_at).toEqual(now);

      // Ops passkey deleted
      const [opsCredCount] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId} and rp_id = 'ops.example.test'
      `;
      expect(opsCredCount?.count).toBe("0");

      // Events written: revoked, recovery_regrant, granted
      const events = await identitySql<
        { action: string; role_key: string | null; request_id: string | null }[]
      >`
        select action, role_key, request_id
        from identity.operator_events
        where user_id = ${user.userId}
        order by occurred_at asc
      `;
      expect(events).toEqual([
        { action: "revoked", role_key: "platform_admin", request_id: reqId },
        { action: "recovery_regrant", role_key: null, request_id: reqId },
        { action: "granted", role_key: "platform_security", request_id: reqId },
      ]);
    });

    it("recovery rolls back all changes if grant insertion fails", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-pin19-fail@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const reqId = newId();

      const oldGrantId = newId();
      await identitySql`
        insert into identity.operator_grants (
          id, user_id, role_key, enrolment_code_hash, granted_at, enrolment_expires_at
        ) values (
          ${oldGrantId}, ${user.userId}, 'platform_admin', ${Buffer.from("old-hash-32-bytes-placeholder-")}, ${now}, ${expiresAt}
        )
      `;
      await insertTestPasskeyCredential(identitySql, {
        userId: user.userId,
        rpId: "ops.example.test",
      });

      const proxySql = throwOnGrantInsert(identitySql);

      await expect(
        recoverOperator(proxySql, kms, KEY_ARN, {
          userId: user.userId,
          roleKeys: ["platform_security"],
          enrolmentCode: "C".repeat(26),
          opsRpId: "ops.example.test",
          now,
          requestId: reqId,
        }),
      ).rejects.toThrow("simulated failure on insert into identity.operator_grants");

      // Old grant is STILL unrevoked
      const [oldGrant] = await identitySql<{ revoked_at: Date | null }[]>`
        select revoked_at from identity.operator_grants where id = ${oldGrantId}
      `;
      expect(oldGrant?.revoked_at).toBeNull();

      // Ops credentials STILL exist
      const [opsCredCount] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId} and rp_id = 'ops.example.test'
      `;
      expect(opsCredCount?.count).toBe("1");

      // No events written
      const events = await identitySql<{ action: string }[]>`
        select action from identity.operator_events where user_id = ${user.userId}
      `;
      expect(events).toEqual([]);
    });
  });

  describe("grantOperator, revokeOperator and recoverOperator edge cases", () => {
    it("grant to an unknown user throws invalid_grant", async () => {
      const fakeUserId = newId();
      await expect(
        grantOperator(identitySql, kms, KEY_ARN, {
          userId: fakeUserId,
          roleKeys: ["platform_admin"],
          enrolmentCode: "A".repeat(26),
          opsRpId: "ops.example.test",
          now: new Date("2026-10-24T12:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    });

    it("an unknown role key, an empty list and duplicates throw", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-roles@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");

      // Empty list
      await expect(
        grantOperator(identitySql, kms, KEY_ARN, {
          userId: user.userId,
          roleKeys: [],
          enrolmentCode: "A".repeat(26),
          opsRpId: "ops.example.test",
          now,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });

      // Unknown role key
      await expect(
        grantOperator(identitySql, kms, KEY_ARN, {
          userId: user.userId,
          roleKeys: ["platform_unknown"],
          enrolmentCode: "A".repeat(26),
          opsRpId: "ops.example.test",
          now,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });

      // Duplicates
      await expect(
        grantOperator(identitySql, kms, KEY_ARN, {
          userId: user.userId,
          roleKeys: ["platform_admin", "platform_admin"],
          enrolmentCode: "A".repeat(26),
          opsRpId: "ops.example.test",
          now,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    });

    it("a second grant for an open or active role throws and writes nothing", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-dup-role@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");

      // Open grant
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode: "A".repeat(26),
        opsRpId: "ops.example.test",
        now,
      });

      const [eventsBefore] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_events where user_id = ${user.userId}
      `;

      // Second grant for open role
      await expect(
        grantOperator(identitySql, kms, KEY_ARN, {
          userId: user.userId,
          roleKeys: ["platform_admin"],
          enrolmentCode: "B".repeat(26),
          opsRpId: "ops.example.test",
          now,
        }),
      ).rejects.toMatchObject({ code: "invalid_grant" });

      const [eventsAfter] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_events where user_id = ${user.userId}
      `;
      expect(eventsAfter?.count).toBe(eventsBefore?.count);
    });

    it("a grant for a role whose earlier grant expired unactivated succeeds and marks the old one revoked", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-expired-regrant@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");
      const expiredAt = new Date(now.getTime() - 1000);
      const grantedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000);

      const oldGrantId = newId();
      await identitySql`
        insert into identity.operator_grants (
          id, user_id, role_key, enrolment_code_hash, granted_at, enrolment_expires_at
        ) values (
          ${oldGrantId}, ${user.userId}, 'platform_admin', ${Buffer.from("old-hash-32-bytes-placeholder-")}, ${grantedAt}, ${expiredAt}
        )
      `;

      const result = await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode: "A".repeat(26),
        opsRpId: "ops.example.test",
        now,
      });
      expect(result.grantIds).toHaveLength(1);
      expect(result.grantIds[0]).not.toBe(oldGrantId);

      const [oldGrant] = await identitySql<{ revoked_at: Date | null }[]>`
        select revoked_at from identity.operator_grants where id = ${oldGrantId}
      `;
      expect(oldGrant?.revoked_at).toEqual(now);

      const revokedEvents = await identitySql<{ action: string; role_key: string | null }[]>`
        select action, role_key
        from identity.operator_events
        where user_id = ${user.userId} and action = 'revoked'
      `;
      expect(revokedEvents).toEqual([{ action: "revoked", role_key: "platform_admin" }]);
    });

    it("two roles granted together share the hash and window", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-shared-hash@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");

      const result = await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin", "platform_security"],
        enrolmentCode: "A".repeat(26),
        opsRpId: "ops.example.test",
        now,
      });
      expect(result.grantIds).toHaveLength(2);

      const rows = await identitySql<
        {
          role_key: string;
          enrolment_code_hash: Buffer;
          granted_at: Date;
          enrolment_expires_at: Date;
        }[]
      >`
        select role_key, enrolment_code_hash, granted_at, enrolment_expires_at
        from identity.operator_grants
        where user_id = ${user.userId}
        order by role_key asc
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.enrolment_code_hash).toEqual(rows[1]?.enrolment_code_hash);
      expect(rows[0]?.granted_at).toEqual(rows[1]?.granted_at);
      expect(rows[0]?.enrolment_expires_at).toEqual(rows[1]?.enrolment_expires_at);
    });

    it("revoke revokes operator and enrolment sessions but not a tenant session of the same user", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-session-revoke@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");

      const opSessionId = await insertTestSession(identitySql, {
        userId: user.userId,
        kind: "operator",
        now,
      });
      const enrolSessionId = await insertTestSession(identitySql, {
        userId: user.userId,
        kind: "enrolment",
        now,
      });
      const tenantSessionId = await insertTestSession(identitySql, {
        userId: user.userId,
        kind: "tenant",
        now,
      });

      await revokeOperator(identitySql, {
        userId: user.userId,
        opsRpId: "ops.example.test",
        now,
      });

      const [opSession] = await identitySql<{ revoked_at: Date | null }[]>`
        select revoked_at from identity.sessions where id = ${opSessionId}
      `;
      const [enrolSession] = await identitySql<{ revoked_at: Date | null }[]>`
        select revoked_at from identity.sessions where id = ${enrolSessionId}
      `;
      const [tenantSession] = await identitySql<{ revoked_at: Date | null }[]>`
        select revoked_at from identity.sessions where id = ${tenantSessionId}
      `;

      expect(opSession?.revoked_at).toEqual(now);
      expect(enrolSession?.revoked_at).toEqual(now);
      expect(tenantSession?.revoked_at).toBeNull();
    });

    it("granted and revoked events carry the role key, recovery_regrant does not", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-event-roles@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");

      await recoverOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_support"],
        enrolmentCode: "A".repeat(26),
        opsRpId: "ops.example.test",
        now,
      });

      const events = await identitySql<{ action: string; role_key: string | null }[]>`
        select action, role_key
        from identity.operator_events
        where user_id = ${user.userId}
        order by occurred_at asc
      `;
      const regrantEvent = events.find((e) => e.action === "recovery_regrant");
      const grantedEvent = events.find((e) => e.action === "granted");
      expect(regrantEvent?.role_key).toBeNull();
      expect(grantedEvent?.role_key).toBe("platform_support");
    });

    it("a non-UUID requestId is stored as null", async () => {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
        email: "op-reqid@example.test",
      });
      const now = new Date("2026-10-24T12:00:00.000Z");

      // Non-UUID
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode: "A".repeat(26),
        opsRpId: "ops.example.test",
        now,
        requestId: "not-a-valid-uuid",
      });

      const [event1] = await identitySql<{ request_id: string | null }[]>`
        select request_id from identity.operator_events where user_id = ${user.userId} and action = 'granted'
      `;
      expect(event1?.request_id).toBeNull();

      // Valid UUID
      const validUuid = newId();
      await revokeOperator(identitySql, {
        userId: user.userId,
        opsRpId: "ops.example.test",
        now,
        requestId: validUuid,
      });

      const [event2] = await identitySql<{ request_id: string | null }[]>`
        select request_id from identity.operator_events where user_id = ${user.userId} and action = 'revoked'
      `;
      expect(event2?.request_id).toBe(validUuid);
    });
  });
});

function createCapturingMail(): OtpMail & { sent: { to: string; code: string }[] } {
  const sent: { to: string; code: string }[] = [];
  return {
    sent,
    async send(input) {
      sent.push(input);
    },
  };
}

describe("startOperatorEnrolment and verifyOperatorEnrolment", () => {
  const kms = createLocalKmsPort();
  let identitySql: Sql;
  let directSql: Sql;
  const runtime = loadRuntime();

  beforeAll(async () => {
    directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    await directSql`delete from identity.operator_events`;
    await directSql`delete from identity.operator_grants`;
    await directSql`delete from identity.sessions`;
    await directSql`delete from identity.passkey_credentials`;
    await directSql`delete from identity.identity_keys`;
    await directSql`delete from identity.otp_challenges`;
    await directSql`delete from identity.users`;
  });

  afterAll(async () => {
    try {
      await directSql`delete from identity.operator_events`;
      await directSql`delete from identity.operator_grants`;
      await directSql`delete from identity.sessions`;
      await directSql`delete from identity.passkey_credentials`;
      await directSql`delete from identity.identity_keys`;
      await directSql`delete from identity.otp_challenges`;
      await directSql`delete from identity.users`;
    } finally {
      await identitySql.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  describe("pin 10: enrolment start inserts before lookup, no mail without grant", () => {
    it("enrolment start for an address with no grant inserts a challenge and sends nothing", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const mail = createCapturingMail();
      const email = "op-nogrant@example.test";
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, {
        email,
        now,
      });

      const { bidx } = await deriveIdentityEmailKeys(identitySql, kms, KEY_ARN);
      const emailBidx = await emailBlindIndex(bidx, email);
      const [challenge] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.otp_challenges
        where email_bidx = ${emailBidx}
          and purpose = 'operator_enrolment'
      `;
      expect(Number(challenge?.count ?? 0)).toBe(1);
      expect(mail.sent).toHaveLength(0);

      const [events] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.operator_events
        where action = 'enrolment_started'
      `;
      expect(Number(events?.count ?? 0)).toBe(0);
    });
  });

  describe("operator_enrolment rate cap", () => {
    it("five startOperatorEnrolment calls inside an hour send five mails, sixth sends none, and sign_in does not count toward it", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-rate-cap@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });

      const { bidx } = await deriveIdentityEmailKeys(identitySql, kms, KEY_ARN);
      const emailBidx = await emailBlindIndex(bidx, email);

      const mail = createCapturingMail();

      // A sign_in challenge for the same address (via startEmailOtp) does not count toward it
      await startEmailOtp(identitySql, kms, KEY_ARN, mail, {
        email,
        now,
        purpose: "sign_in",
      });
      expect(mail.sent).toHaveLength(1);

      // Five startOperatorEnrolment calls inside an hour for an address with an open grant send five mails
      for (let i = 0; i < 5; i++) {
        const callTime = new Date(now.getTime() + (i + 1) * 60 * 1000);
        await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, {
          email,
          now: callTime,
        });
      }
      expect(mail.sent).toHaveLength(6);

      // The sixth inserts no challenge and sends no mail
      const sixthTime = new Date(now.getTime() + 6 * 60 * 1000);
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, {
        email,
        now: sixthTime,
      });
      expect(mail.sent).toHaveLength(6);

      const [opChallenges] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.otp_challenges
        where email_bidx = ${emailBidx}
          and purpose = 'operator_enrolment'
      `;
      expect(Number(opChallenges?.count ?? 0)).toBe(5);
    });
  });

  describe("pin 1a: verify never returns an operator session", () => {
    it("enrolment verification yields only an enrolment session", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-pin1a@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });

      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      expect(mail.sent).toHaveLength(1);
      const emailCode = mail.sent[0]!.code;

      const result = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode,
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      expect(result).not.toBeNull();
      expect(result?.kind).toBe("enrolment");
      if (result?.kind === "enrolment") {
        const [sessionRow] = await identitySql<
          { kind: string; absolute_expires_at: Date | null }[]
        >`
          select kind, absolute_expires_at
          from identity.sessions
          where user_id = ${user.userId}
        `;
        expect(sessionRow?.kind).toBe("enrolment");
        expect(sessionRow?.absolute_expires_at).toBeNull();

        const refreshed = await refreshSession(identitySql, kms, KEY_ARN, {
          refreshToken: result.session.refreshToken,
          now,
          kinds: ["tenant", "operator", "enrolment"],
        });
        expect(refreshed).toBeNull();
      }
    });
  });

  describe("pin 1b: verify never creates a user", () => {
    it("verification for an unknown address creates no user", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-unknown-user@example.test";
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });

      const { bidx } = await deriveIdentityEmailKeys(identitySql, kms, KEY_ARN);
      const emailBidx = await emailBlindIndex(bidx, email);

      const [challenge] = await identitySql<{ code_hash: Uint8Array }[]>`
        select code_hash from identity.otp_challenges where email_bidx = ${emailBidx}
      `;
      expect(challenge).toBeDefined();

      const result = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: "12345678",
        enrolmentCode: "A".repeat(26),
        opsRpId: "ops.example.test",
        now,
      });
      expect(result).toBeNull();

      const [userCount] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.users where email_bidx = ${emailBidx}
      `;
      expect(Number(userCount?.count ?? 0)).toBe(0);
    });
  });

  describe("pin 2: wrong enrolment code counts one attempt; consumed at five", () => {
    it("a wrong enrolment code with a right email code counts an attempt", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-pin2@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const rightEnrolmentCode = "A".repeat(26);
      const wrongEnrolmentCode = "B".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode: rightEnrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });

      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const emailCode = mail.sent[0]!.code;

      const { bidx } = await deriveIdentityEmailKeys(identitySql, kms, KEY_ARN);
      const emailBidx = await emailBlindIndex(bidx, email);

      // 1st wrong attempt
      const res1 = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode,
        enrolmentCode: wrongEnrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      expect(res1).toBeNull();
      const [c1] = await identitySql<{ attempts: number; consumed_at: Date | null }[]>`
        select attempts, consumed_at
        from identity.otp_challenges
        where email_bidx = ${emailBidx} and purpose = 'operator_enrolment'
      `;
      expect(c1?.attempts).toBe(1);
      expect(c1?.consumed_at).toBeNull();

      // attempts 2, 3, 4
      for (let i = 2; i <= 4; i++) {
        const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
          email,
          emailCode,
          enrolmentCode: wrongEnrolmentCode,
          opsRpId: "ops.example.test",
          now,
        });
        expect(res).toBeNull();
        const [ci] = await identitySql<{ attempts: number; consumed_at: Date | null }[]>`
          select attempts, consumed_at
          from identity.otp_challenges
          where email_bidx = ${emailBidx} and purpose = 'operator_enrolment'
        `;
        expect(ci?.attempts).toBe(i);
        expect(ci?.consumed_at).toBeNull();
      }

      // 5th wrong attempt consumes
      const res5 = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode,
        enrolmentCode: wrongEnrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      expect(res5).toBeNull();
      const [c5] = await identitySql<{ attempts: number; consumed_at: Date | null }[]>`
        select attempts, consumed_at
        from identity.otp_challenges
        where email_bidx = ${emailBidx} and purpose = 'operator_enrolment'
      `;
      expect(c5?.attempts).toBe(5);
      expect(c5?.consumed_at).not.toBeNull();

      // Now even with both right codes, verification fails
      const resRight = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode,
        enrolmentCode: rightEnrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      expect(resRight).toBeNull();
    });
  });

  describe("pin 4: enrolment fails after window, activation, revocation", () => {
    it("enrolment fails after the window", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-win-exp@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      const mail = createCapturingMail();
      const startAt = new Date(now.getTime() + 24 * 60 * 60 * 1000 - 60 * 1000);
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now: startAt });
      const emailCode = mail.sent[0]!.code;

      const afterWindow = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1000);
      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode,
        enrolmentCode,
        opsRpId: "ops.example.test",
        now: afterWindow,
      });
      expect(res).toBeNull();
    });

    it("enrolment succeeds just before the window expires", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-win-ctrl@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      const mail = createCapturingMail();
      const startAt = new Date(now.getTime() + 24 * 60 * 60 * 1000 - 60 * 1000);
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now: startAt });
      const emailCode = mail.sent[0]!.code;

      const beforeWindow = new Date(now.getTime() + 24 * 60 * 60 * 1000 - 30 * 1000);
      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode,
        enrolmentCode,
        opsRpId: "ops.example.test",
        now: beforeWindow,
      });
      expect(res?.kind).toBe("enrolment");
    });

    it("enrolment fails after activation", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-act-fail@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const enrolmentCode = "A".repeat(26);
      const { grantIds } = await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const emailCode = mail.sent[0]!.code;

      await identitySql`
        update identity.operator_grants
        set activated_at = ${now}
        where id = ${grantIds[0]!}
      `;

      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode,
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      expect(res).toBeNull();
    });

    it("enrolment fails after revocation", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-rev-fail@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const emailCode = mail.sent[0]!.code;

      await revokeOperator(identitySql, {
        userId: user.userId,
        opsRpId: "ops.example.test",
        now,
      });

      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode,
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      expect(res).toBeNull();
    });

    it("a grant revoked while verification waits for the user lock refuses enrolment", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-lock-rev@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const emailCode = mail.sent[0]!.code;

      const holder = createPlaintextDirectSql(runtime.productOnlyUrl);
      const observer = createPlaintextDirectSql(runtime.productOnlyUrl);

      let releaseHolder: () => void = () => undefined;
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });

      let lockAcquired: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });

      let pendingVerify: Promise<VerifyOperatorEnrolmentResult> | undefined;

      try {
        const holderPromise = holder.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtextextended('operator:' || ${user.userId}::text, 0))`;
          await tx`
            update identity.operator_grants
            set revoked_at = ${now}
            where user_id = ${user.userId}
          `;
          lockAcquired();
          await holderGate;
        });

        await lockHeld;

        let settled = false;
        pendingVerify = verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
          email,
          emailCode,
          enrolmentCode,
          opsRpId: "ops.example.test",
          now,
        }).finally(() => {
          settled = true;
        });

        const started = Date.now();
        let waiting = false;
        while (Date.now() - started < 5_000) {
          if (settled) {
            break;
          }
          const waitingRows = await observer<{ n: number }[]>`
            select count(*)::int as n
            from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event_type = 'Lock'
              and pid <> pg_backend_pid()
          `;
          if ((waitingRows[0]?.n ?? 0) >= 1) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        if (!waiting && !settled) {
          throw new Error("verifyOperatorEnrolment did not wait on the user lock within 5s");
        }

        releaseHolder();
        await holderPromise;

        const result = await pendingVerify;
        expect(result).toBeNull();

        const [sessionCount] = await identitySql<{ count: string }[]>`
          select count(*)::text as count
          from identity.sessions
          where user_id = ${user.userId}
        `;
        expect(Number(sessionCount?.count ?? 0)).toBe(0);
      } finally {
        releaseHolder();
        await pendingVerify?.catch(() => undefined);
        await holder.end({ timeout: 1 });
        await observer.end({ timeout: 1 });
      }
    });
  });

  describe("enrolment verification plus cases", () => {
    it("gives an enrolment session that reads with readSessionWithKind(['enrolment']) and not with default readSession", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-session-kinds@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const emailCode = mail.sent[0]!.code;

      const result = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode,
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      expect(result?.kind).toBe("enrolment");
      if (result?.kind === "enrolment") {
        const readWithEnrol = await readSessionWithKind(identitySql, kms, KEY_ARN, {
          accessToken: result.session.accessToken,
          now,
          kinds: ["enrolment"],
        });
        expect(readWithEnrol?.userId).toBe(user.userId);

        const readDefault = await readSession(identitySql, kms, KEY_ARN, {
          accessToken: result.session.accessToken,
          now,
        });
        expect(readDefault).toBeNull();
      }
    });

    it("a sign_in challenge for the same address is neither used nor consumed", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-coexist-challenges@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });

      const tenantMail = createCapturingMail();
      await startEmailOtp(identitySql, kms, KEY_ARN, tenantMail, {
        email,
        now,
        purpose: "sign_in",
      });
      expect(tenantMail.sent).toHaveLength(1);
      const tenantCode = tenantMail.sent[0]!.code;

      const opMail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, opMail, { email, now });
      expect(opMail.sent).toHaveLength(1);
      const opCode = opMail.sent[0]!.code;

      const opResult = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: opCode,
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      expect(opResult?.kind).toBe("enrolment");

      const { bidx } = await deriveIdentityEmailKeys(identitySql, kms, KEY_ARN);
      const emailBidx = await emailBlindIndex(bidx, email);
      const [signInChallenge] = await identitySql<{ attempts: number; consumed_at: Date | null }[]>`
        select attempts, consumed_at
        from identity.otp_challenges
        where email_bidx = ${emailBidx}
          and purpose = 'sign_in'
      `;
      expect(signInChallenge?.consumed_at).toBeNull();
      expect(signInChallenge?.attempts).toBe(0);

      const tenantSession = await verifyEmailOtp(identitySql, kms, KEY_ARN, {
        email,
        code: tenantCode,
        now,
      });
      expect(tenantSession).not.toBeNull();
      expect(tenantSession?.userId).toBe(user.userId);
    });

    it("a malformed enrolment code counts an attempt", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-malformed-code@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const emailCode = mail.sent[0]!.code;

      const { bidx } = await deriveIdentityEmailKeys(identitySql, kms, KEY_ARN);
      const emailBidx = await emailBlindIndex(bidx, email);

      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode,
        enrolmentCode: "A".repeat(25),
        opsRpId: "ops.example.test",
        now,
      });
      expect(res).toBeNull();

      const [challenge] = await identitySql<{ attempts: number }[]>`
        select attempts from identity.otp_challenges where email_bidx = ${emailBidx} and purpose = 'operator_enrolment'
      `;
      expect(challenge?.attempts).toBe(1);
    });

    it("an existing operator granted a new role with two ops credentials gets { kind: 'activated' } and the new grant becomes active", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-two-creds-act@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });

      // Existing operator has an active grant
      const firstEnrolmentCode = "A".repeat(26);
      const { grantIds: initialGrantIds } = await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode: firstEnrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      await identitySql`
        update identity.operator_grants
        set activated_at = ${now}
        where id = ${initialGrantIds[0]!}
      `;

      // Holds two ops passkey credentials
      await insertTestPasskeyCredential(identitySql, {
        userId: user.userId,
        rpId: "ops.example.test",
      });
      await insertTestPasskeyCredential(identitySql, {
        userId: user.userId,
        rpId: "ops.example.test",
      });

      // Now granted a new role
      const newEnrolmentCode = "B".repeat(26);
      const { grantIds: newGrantIds } = await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_support"],
        enrolmentCode: newEnrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });

      const enrolSessionId = await insertTestSession(identitySql, {
        userId: user.userId,
        kind: "enrolment",
        now,
      });

      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const emailCode = mail.sent[0]!.code;

      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode,
        enrolmentCode: newEnrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      expect(res).toEqual({ kind: "activated" });

      const [grant] = await identitySql<{ activated_at: Date | null }[]>`
        select activated_at from identity.operator_grants where id = ${newGrantIds[0]!}
      `;
      expect(grant?.activated_at).toEqual(now);

      const [enrolSession] = await identitySql<{ revoked_at: Date | null }[]>`
        select revoked_at from identity.sessions where id = ${enrolSessionId}
      `;
      expect(enrolSession?.revoked_at).toEqual(now);

      const [actEvent] = await identitySql<{ action: string; role_key: string }[]>`
        select action, role_key
        from identity.operator_events
        where user_id = ${user.userId} and action = 'activated' and role_key = 'platform_support'
      `;
      expect(actEvent?.role_key).toBe("platform_support");
    });

    it("the same enrolment code works again after a first successful verification while the grant is open with a new email code", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-reuse-code@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });

      const mail1 = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail1, { email, now });
      const emailCode1 = mail1.sent[0]!.code;

      const res1 = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: emailCode1,
        enrolmentCode,
        opsRpId: "ops.example.test",
        now,
      });
      expect(res1?.kind).toBe("enrolment");

      const now2 = new Date(now.getTime() + 1000);
      const mail2 = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail2, { email, now: now2 });
      const emailCode2 = mail2.sent[0]!.code;

      const res2 = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: emailCode2,
        enrolmentCode,
        opsRpId: "ops.example.test",
        now: now2,
      });
      expect(res2?.kind).toBe("enrolment");
    });

    it("enrolment_started is appended only after a successful send and deleted on send failure", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-mail-fail@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode: "A".repeat(26),
        opsRpId: "ops.example.test",
        now,
      });

      const { bidx } = await deriveIdentityEmailKeys(identitySql, kms, KEY_ARN);
      const emailBidx = await emailBlindIndex(bidx, email);

      await expect(
        startOperatorEnrolment(identitySql, kms, KEY_ARN, rejectingOtpMail, { email, now }),
      ).rejects.toBeInstanceOf(OtpMailUnavailable);

      const [ch1] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.otp_challenges where email_bidx = ${emailBidx}
      `;
      expect(Number(ch1?.count ?? 0)).toBe(0);

      const [ev1] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_events where user_id = ${user.userId} and action = 'enrolment_started'
      `;
      expect(Number(ev1?.count ?? 0)).toBe(0);

      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const [ev2] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.operator_events where user_id = ${user.userId} and action = 'enrolment_started'
      `;
      expect(Number(ev2?.count ?? 0)).toBe(1);
    });
  });

  describe("operator passkey registration security pins", () => {
    const kms = createLocalKmsPort();
    let identitySql: Sql;
    let directSql: Sql;
    const runtime = loadRuntime();

    beforeAll(async () => {
      directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
      identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
      await directSql`delete from identity.operator_events`;
      await directSql`delete from identity.operator_grants`;
      await directSql`delete from identity.sessions`;
      await directSql`delete from identity.passkey_credentials`;
      await directSql`delete from identity.passkey_challenges`;
      await directSql`delete from identity.identity_keys`;
      await directSql`delete from identity.otp_challenges`;
      await directSql`delete from identity.users`;
    });

    afterAll(async () => {
      try {
        await directSql`delete from identity.operator_events`;
        await directSql`delete from identity.operator_grants`;
        await directSql`delete from identity.sessions`;
        await directSql`delete from identity.passkey_credentials`;
        await directSql`delete from identity.passkey_challenges`;
        await directSql`delete from identity.identity_keys`;
        await directSql`delete from identity.otp_challenges`;
        await directSql`delete from identity.users`;
      } finally {
        await identitySql.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    });

    it("two tenant passkeys and one ops passkey do not activate (pin 5a)", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-pin5a@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const tenantRpId = "auth.example.test";

      for (let i = 0; i < 2; i++) {
        const credId = crypto.getRandomValues(new Uint8Array(32));
        const k = await signer();
        await directSql`
          insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count, rp_id)
          values (${newId()}, ${user.userId}, ${credId}, ${coseKey(k.x, k.y)}, 0, ${tenantRpId})
        `;
      }

      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId,
        now,
      });

      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now,
      });
      expect(res?.kind).toBe("enrolment");
      const session = (res as { kind: "enrolment"; session: SessionTokens }).session;

      const regOpts = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
      });
      expect(regOpts).not.toBeNull();
      const opsKey = await signer();
      const opsCredId = crypto.getRandomValues(new Uint8Array(32));
      const authData = authenticatorData({
        rpId: opsRpId,
        signCount: 0,
        credentialId: opsCredId,
        cose: coseKey(opsKey.x, opsKey.y),
        flags: 0x45,
      });
      const ok = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
        clientDataJSON: clientData("webauthn.create", regOpts!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(authData),
      });
      expect(ok).toBe(true);

      const [totalCreds] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId}
      `;
      expect(Number(totalCreds?.count ?? 0)).toBe(3);

      const [opsCreds] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId} and rp_id = ${opsRpId}
      `;
      expect(Number(opsCreds?.count ?? 0)).toBe(1);

      const [grant] = await identitySql<{ activated_at: Date | null }[]>`
        select activated_at from identity.operator_grants where user_id = ${user.userId}
      `;
      expect(grant?.activated_at).toBeNull();

      const read = await readSessionWithKind(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        now,
        kinds: ["enrolment"],
      });
      expect(read).not.toBeNull();
    });

    it("a second ops passkey after the window is not stored and the grant stays inactive (pin 5b)", async () => {
      const t0 = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-pin5b@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId,
        now: t0,
      });

      const t1 = new Date(t0.getTime() + 60 * 60 * 1000);
      const mail1 = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail1, { email, now: t1 });
      const res1 = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail1.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now: t1,
      });
      expect(res1?.kind).toBe("enrolment");
      const session1 = (res1 as { kind: "enrolment"; session: SessionTokens }).session;

      const regOpts1 = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session1.accessToken,
        opsRpId,
        now: t1,
      });
      expect(regOpts1).not.toBeNull();
      const key1 = await signer();
      const credId1 = crypto.getRandomValues(new Uint8Array(32));
      const authData1 = authenticatorData({
        rpId: opsRpId,
        signCount: 0,
        credentialId: credId1,
        cose: coseKey(key1.x, key1.y),
        flags: 0x45,
      });
      const ok1 = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session1.accessToken,
        opsRpId,
        now: t1,
        clientDataJSON: clientData("webauthn.create", regOpts1!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(authData1),
      });
      expect(ok1).toBe(true);

      const [grant1] = await identitySql<{ activated_at: Date | null }[]>`
        select activated_at from identity.operator_grants where user_id = ${user.userId}
      `;
      expect(grant1?.activated_at).toBeNull();

      const windowMs = 24 * 60 * 60 * 1000;
      const enrolmentExpiresAt = new Date(t0.getTime() + windowMs);
      const tNearEnd = new Date(enrolmentExpiresAt.getTime() - 5 * 60 * 1000);
      const mail2 = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail2, { email, now: tNearEnd });
      const res2 = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail2.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now: tNearEnd,
      });
      expect(res2?.kind).toBe("enrolment");
      const session2 = (res2 as { kind: "enrolment"; session: SessionTokens }).session;

      const tBegin = new Date(tNearEnd.getTime() + 60 * 1000);
      const regOpts2 = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session2.accessToken,
        opsRpId,
        now: tBegin,
      });
      expect(regOpts2).not.toBeNull();

      const tAfterWindow = new Date(enrolmentExpiresAt.getTime() + 1000);
      const key2 = await signer();
      const credId2 = crypto.getRandomValues(new Uint8Array(32));
      const authData2 = authenticatorData({
        rpId: opsRpId,
        signCount: 0,
        credentialId: credId2,
        cose: coseKey(key2.x, key2.y),
        flags: 0x45,
      });
      const ok2 = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session2.accessToken,
        opsRpId,
        now: tAfterWindow,
        clientDataJSON: clientData("webauthn.create", regOpts2!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(authData2),
      });
      expect(ok2).toBe(false);

      const [opsCredsAfter] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId} and rp_id = ${opsRpId}
      `;
      expect(Number(opsCredsAfter?.count ?? 0)).toBe(1);

      const [grantAfter] = await identitySql<{ activated_at: Date | null }[]>`
        select activated_at from identity.operator_grants where user_id = ${user.userId}
      `;
      expect(grantAfter?.activated_at).toBeNull();
    });

    it("operator registration options require UV and exclude ops passkeys (pin 7)", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-pin7@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const tenantRpId = "auth.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId,
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now,
      });
      const session = (res as { kind: "enrolment"; session: SessionTokens }).session;

      const tenantCredId = crypto.getRandomValues(new Uint8Array(32));
      const opsCredId = crypto.getRandomValues(new Uint8Array(32));
      const k1 = await signer();
      const k2 = await signer();
      await directSql`
        insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count, rp_id)
        values
          (${newId()}, ${user.userId}, ${tenantCredId}, ${coseKey(k1.x, k1.y)}, 0, ${tenantRpId}),
          (${newId()}, ${user.userId}, ${opsCredId}, ${coseKey(k2.x, k2.y)}, 0, ${opsRpId})
      `;

      const opts = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
      });
      expect(opts).not.toBeNull();
      expect(opts!.authenticatorSelection.userVerification).toBe("required");
      expect(opts!.authenticatorSelection.residentKey).toBe("required");
      expect(opts!.excludeCredentials).toBeDefined();
      expect(opts!.excludeCredentials).toHaveLength(1);
      expect(opts!.excludeCredentials![0]!.id).toEqual(opsCredId);
    });

    it("after revoke and re-grant the grant activates only on two new ops passkeys (pin 18c)", async () => {
      const t0 = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-pin18c@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId,
        now: t0,
      });

      const mail1 = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail1, { email, now: t0 });
      const res1 = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail1.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now: t0,
      });
      const session1 = (res1 as { kind: "enrolment"; session: SessionTokens }).session;
      const opts1 = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session1.accessToken,
        opsRpId,
        now: t0,
      });
      const k1 = await signer();
      const c1 = crypto.getRandomValues(new Uint8Array(32));
      await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session1.accessToken,
        opsRpId,
        now: t0,
        clientDataJSON: clientData("webauthn.create", opts1!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c1,
            cose: coseKey(k1.x, k1.y),
            flags: 0x45,
          }),
        ),
      });

      const [cCount1] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId} and rp_id = ${opsRpId}
      `;
      expect(Number(cCount1?.count ?? 0)).toBe(1);

      const tRevoke = new Date(t0.getTime() + 60 * 60 * 1000);
      await revokeOperator(identitySql, { userId: user.userId, opsRpId, now: tRevoke });

      const tReGrant = new Date(t0.getTime() + 2 * 60 * 60 * 1000);
      const newEnrolmentCode = "B".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode: newEnrolmentCode,
        opsRpId,
        now: tReGrant,
      });

      const mail2 = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail2, { email, now: tReGrant });
      const res2 = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail2.sent[0]!.code,
        enrolmentCode: newEnrolmentCode,
        opsRpId,
        now: tReGrant,
      });
      const session2 = (res2 as { kind: "enrolment"; session: SessionTokens }).session;

      const opts2 = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session2.accessToken,
        opsRpId,
        now: tReGrant,
      });
      const k2 = await signer();
      const c2 = crypto.getRandomValues(new Uint8Array(32));
      const okNew1 = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session2.accessToken,
        opsRpId,
        now: tReGrant,
        clientDataJSON: clientData("webauthn.create", opts2!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c2,
            cose: coseKey(k2.x, k2.y),
            flags: 0x45,
          }),
        ),
      });
      expect(okNew1).toBe(true);

      const [grantMid] = await identitySql<{ activated_at: Date | null }[]>`
        select activated_at from identity.operator_grants where user_id = ${user.userId} and revoked_at is null
      `;
      expect(grantMid?.activated_at).toBeNull();

      const opts3 = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session2.accessToken,
        opsRpId,
        now: tReGrant,
      });
      const k3 = await signer();
      const c3 = crypto.getRandomValues(new Uint8Array(32));
      const okNew2 = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session2.accessToken,
        opsRpId,
        now: tReGrant,
        clientDataJSON: clientData("webauthn.create", opts3!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c3,
            cose: coseKey(k3.x, k3.y),
            flags: 0x45,
          }),
        ),
      });
      expect(okNew2).toBe(true);

      const [grantEnd] = await identitySql<{ activated_at: Date | null }[]>`
        select activated_at from identity.operator_grants where user_id = ${user.userId} and revoked_at is null
      `;
      expect(grantEnd?.activated_at).not.toBeNull();
    });

    it("registration waits for the user lock before inserting (pin 18d)", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-pin18d@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId,
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now,
      });
      const session = (res as { kind: "enrolment"; session: SessionTokens }).session;

      const opts = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
      });
      expect(opts).not.toBeNull();
      const key = await signer();
      const credId = crypto.getRandomValues(new Uint8Array(32));
      const authData = authenticatorData({
        rpId: opsRpId,
        signCount: 0,
        credentialId: credId,
        cose: coseKey(key.x, key.y),
        flags: 0x45,
      });
      const clientDataJSON = clientData("webauthn.create", opts!.challenge, `https://${opsRpId}`);
      const attestationObjectData = attestationObject(authData);

      const observer = createPlaintextDirectSql(runtime.productOnlyUrl);
      const direct = createPlaintextDirectSql(runtime.productOnlyUrl);

      let releaseHolder!: () => void;
      const holdPromise = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let holderAcquired = false;

      const holderPromise = direct.begin(async (tx) => {
        await lockOperatorUser(tx, user.userId);
        holderAcquired = true;
        await tx`update identity.operator_grants set revoked_at = ${now} where user_id = ${user.userId}`;
        await tx`update identity.sessions set revoked_at = ${now} where user_id = ${user.userId}`;
        await holdPromise;
      });

      const acquireStarted = Date.now();
      while (!holderAcquired && Date.now() - acquireStarted < 3_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(holderAcquired).toBe(true);

      let settled = false;
      let finishPromise: Promise<boolean> | undefined;
      try {
        finishPromise = finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
          accessToken: session.accessToken,
          opsRpId,
          now,
          clientDataJSON,
          attestationObject: attestationObjectData,
        }).finally(() => {
          settled = true;
        });

        const started = Date.now();
        let waiting = false;
        let waitingPid: number | null = null;
        while (Date.now() - started < 5_000) {
          if (settled) break;
          const waitingRows = await observer<{ pid: number }[]>`
            select pid
            from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event_type = 'Lock'
              and pid <> pg_backend_pid()
          `;
          if (waitingRows.length > 0) {
            waiting = true;
            waitingPid = waitingRows[0]!.pid;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        if (!waiting && !settled) {
          throw new Error(
            "finishOperatorPasskeyRegistration did not wait on the user lock within 5s",
          );
        }

        expect(waitingPid).not.toBeNull();

        const [credLockCount] = await observer<{ n: number }[]>`
          select count(*)::int as n
          from pg_locks l
          join pg_class c on c.oid = l.relation
          join pg_namespace n on n.oid = c.relnamespace
          where l.pid = ${waitingPid}
            and n.nspname = 'identity'
            and c.relname = 'passkey_credentials'
            and l.mode = 'RowExclusiveLock'
        `;
        expect(credLockCount?.n ?? 0).toBe(0);

        releaseHolder();
        await holderPromise;

        const result = await finishPromise;
        expect(result).toBe(false);

        const [finalCreds] = await identitySql<{ count: string }[]>`
          select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId}
        `;
        expect(Number(finalCreds?.count ?? 0)).toBe(0);
      } finally {
        releaseHolder();
        await finishPromise?.catch(() => undefined);
        await holderPromise.catch(() => undefined);
        await direct.end({ timeout: 1 });
        await observer.end({ timeout: 1 });
      }
    });

    it("operator registration refuses a null-RP challenge (pin 20)", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-pin20@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId,
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now,
      });
      const session = (res as { kind: "enrolment"; session: SessionTokens }).session;

      const challenge = new Uint8Array(32);
      crypto.getRandomValues(challenge);
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
      await directSql`
        insert into identity.passkey_challenges (id, user_id, kind, challenge, expires_at, rp_id, user_verification)
        values (${newId()}, ${user.userId}, 'register', ${challenge}, ${expiresAt}::timestamptz, null, 'required')
      `;

      const key = await signer();
      const credId = crypto.getRandomValues(new Uint8Array(32));
      const authData = authenticatorData({
        rpId: opsRpId,
        signCount: 0,
        credentialId: credId,
        cose: coseKey(key.x, key.y),
        flags: 0x45,
      });
      const clientDataJSON = clientData("webauthn.create", challenge, `https://${opsRpId}`);
      const attestationObjectData = attestationObject(authData);

      const result = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
        clientDataJSON,
        attestationObject: attestationObjectData,
      });
      expect(result).toBe(false);

      const [stored] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId}
      `;
      expect(Number(stored?.count ?? 0)).toBe(0);
    });
  });

  describe("operator passkey registration plus cases", () => {
    const kms = createLocalKmsPort();
    let identitySql: Sql;
    let directSql: Sql;
    const runtime = loadRuntime();

    beforeAll(async () => {
      directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
      identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
      await directSql`delete from identity.operator_events`;
      await directSql`delete from identity.operator_grants`;
      await directSql`delete from identity.sessions`;
      await directSql`delete from identity.passkey_credentials`;
      await directSql`delete from identity.passkey_challenges`;
      await directSql`delete from identity.identity_keys`;
      await directSql`delete from identity.otp_challenges`;
      await directSql`delete from identity.users`;
    });

    afterAll(async () => {
      try {
        await directSql`delete from identity.operator_events`;
        await directSql`delete from identity.operator_grants`;
        await directSql`delete from identity.sessions`;
        await directSql`delete from identity.passkey_credentials`;
        await directSql`delete from identity.passkey_challenges`;
        await directSql`delete from identity.identity_keys`;
        await directSql`delete from identity.otp_challenges`;
        await directSql`delete from identity.users`;
      } finally {
        await identitySql.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    });

    it("two ops passkeys inside the window activate every open grant of the user and revoke the enrolment session", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-plus-activate@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      const requestId = newId();
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin", "platform_support"],
        enrolmentCode,
        opsRpId,
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now,
      });
      const session = (res as { kind: "enrolment"; session: SessionTokens }).session;

      const opts1 = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
      });
      const k1 = await signer();
      const c1 = crypto.getRandomValues(new Uint8Array(32));
      const ok1 = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
        clientDataJSON: clientData("webauthn.create", opts1!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c1,
            cose: coseKey(k1.x, k1.y),
            flags: 0x45,
          }),
        ),
        requestId,
      });
      expect(ok1).toBe(true);

      const grants1 = await identitySql<{ activated_at: Date | null }[]>`
        select activated_at from identity.operator_grants where user_id = ${user.userId}
      `;
      expect(grants1).toHaveLength(2);
      expect(grants1[0]?.activated_at).toBeNull();
      expect(grants1[1]?.activated_at).toBeNull();

      const read1 = await readSessionWithKind(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        now,
        kinds: ["enrolment"],
      });
      expect(read1?.userId).toBe(user.userId);

      const opts2 = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
      });
      const k2 = await signer();
      const c2 = crypto.getRandomValues(new Uint8Array(32));
      const ok2 = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
        clientDataJSON: clientData("webauthn.create", opts2!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c2,
            cose: coseKey(k2.x, k2.y),
            flags: 0x45,
          }),
        ),
        requestId,
      });
      expect(ok2).toBe(true);

      const grants2 = await identitySql<{ activated_at: Date | null; role_key: string }[]>`
        select activated_at, role_key from identity.operator_grants where user_id = ${user.userId}
      `;
      expect(grants2).toHaveLength(2);
      expect(grants2[0]?.activated_at).toEqual(now);
      expect(grants2[1]?.activated_at).toEqual(now);

      const activatedEvents = await identitySql<
        { role_key: string; action: string; request_id: string }[]
      >`
        select role_key, action, request_id from identity.operator_events where user_id = ${user.userId} and action = 'activated' order by role_key
      `;
      expect(activatedEvents).toHaveLength(2);
      expect(activatedEvents.map((e) => e.role_key).sort()).toEqual([
        "platform_admin",
        "platform_support",
      ]);
      expect(activatedEvents[0]?.request_id).toBe(requestId);

      const readAfter = await readSessionWithKind(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        now,
        kinds: ["enrolment"],
      });
      expect(readAfter).toBeNull();
    });

    it("a revoked enrolment session cannot finish", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-plus-revoked-finish@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId,
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now,
      });
      const session = (res as { kind: "enrolment"; session: SessionTokens }).session;

      const opts = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
      });
      expect(opts).not.toBeNull();

      await directSql`
        update identity.sessions set revoked_at = ${now} where user_id = ${user.userId}
      `;

      const k = await signer();
      const c = crypto.getRandomValues(new Uint8Array(32));
      const result = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
        clientDataJSON: clientData("webauthn.create", opts!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c,
            cose: coseKey(k.x, k.y),
            flags: 0x45,
          }),
        ),
      });
      expect(result).toBe(false);

      const [stored] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId}
      `;
      expect(Number(stored?.count ?? 0)).toBe(0);
    });

    it("an operator session can add a third ops passkey without changing grants", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-plus-third-passkey@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId,
        now,
      });

      const c1 = crypto.getRandomValues(new Uint8Array(32));
      const c2 = crypto.getRandomValues(new Uint8Array(32));
      const k1 = await signer();
      const k2 = await signer();
      await directSql`
        insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count, rp_id)
        values
          (${newId()}, ${user.userId}, ${c1}, ${coseKey(k1.x, k1.y)}, 0, ${opsRpId}),
          (${newId()}, ${user.userId}, ${c2}, ${coseKey(k2.x, k2.y)}, 0, ${opsRpId})
      `;
      await directSql`
        update identity.operator_grants set activated_at = ${now} where user_id = ${user.userId}
      `;

      const { bidx } = await deriveIdentityEmailKeys(identitySql, kms, KEY_ARN);
      const operatorSession = await identitySql.begin(async (tx) => {
        return createSessionInTransaction(tx, bidx, {
          userId: user.userId,
          now,
          kind: "operator",
          absoluteExpiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000),
        });
      });

      const opts = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: operatorSession.accessToken,
        opsRpId,
        now,
      });
      expect(opts).not.toBeNull();
      expect(opts!.excludeCredentials).toHaveLength(2);

      const k3 = await signer();
      const c3 = crypto.getRandomValues(new Uint8Array(32));
      const ok = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: operatorSession.accessToken,
        opsRpId,
        now,
        clientDataJSON: clientData("webauthn.create", opts!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c3,
            cose: coseKey(k3.x, k3.y),
            flags: 0x45,
          }),
        ),
      });
      expect(ok).toBe(true);

      const [totalCreds] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId} and rp_id = ${opsRpId}
      `;
      expect(Number(totalCreds?.count ?? 0)).toBe(3);

      const [grant] = await identitySql<{ activated_at: Date }[]>`
        select activated_at from identity.operator_grants where user_id = ${user.userId}
      `;
      expect(grant?.activated_at).toEqual(now);

      const readOp = await readSessionWithKind(identitySql, kms, KEY_ARN, {
        accessToken: operatorSession.accessToken,
        now,
        kinds: ["operator"],
      });
      expect(readOp?.userId).toBe(user.userId);
    });

    it("an operator session whose user has only an open grant (no active one) cannot finish registration", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-open-grant-op-session@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId,
        now,
      });

      const { bidx } = await deriveIdentityEmailKeys(identitySql, kms, KEY_ARN);
      const operatorSession = await identitySql.begin(async (tx) => {
        return createSessionInTransaction(tx, bidx, {
          userId: user.userId,
          now,
          kind: "operator",
          absoluteExpiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000),
        });
      });

      const opts = await beginPasskeyRegistration(identitySql, {
        userId: user.userId,
        rpId: opsRpId,
        now,
        userVerification: "required",
      });

      const k = await signer();
      const c = crypto.getRandomValues(new Uint8Array(32));
      const ok = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: operatorSession.accessToken,
        opsRpId,
        now,
        clientDataJSON: clientData("webauthn.create", opts.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c,
            cose: coseKey(k.x, k.y),
            flags: 0x45,
          }),
        ),
      });
      expect(ok).toBe(false);

      const [stored] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId} and rp_id = ${opsRpId}
      `;
      expect(Number(stored?.count ?? 0)).toBe(0);
    });

    it("a tenant (auth.example.test) registration challenge cannot be finished through the operator function", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-plus-tenant-chal@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId,
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now,
      });
      const session = (res as { kind: "enrolment"; session: SessionTokens }).session;

      const tenantOpts = await beginPasskeyRegistration(identitySql, {
        userId: user.userId,
        rpId: "auth.example.test",
        now,
      });

      const k = await signer();
      const c = crypto.getRandomValues(new Uint8Array(32));
      const authData = authenticatorData({
        rpId: "auth.example.test",
        signCount: 0,
        credentialId: c,
        cose: coseKey(k.x, k.y),
        flags: 0x45,
      });
      const clientDataJSON = clientData(
        "webauthn.create",
        tenantOpts.challenge,
        "https://auth.example.test",
      );
      const attestationObjectData = attestationObject(authData);

      const result = await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
        clientDataJSON,
        attestationObject: attestationObjectData,
      });
      expect(result).toBe(false);

      const [stored] = await identitySql<{ count: string }[]>`
        select count(*)::text as count from identity.passkey_credentials where user_id = ${user.userId} and rp_id = ${opsRpId}
      `;
      expect(Number(stored?.count ?? 0)).toBe(0);
    });
  });

  describe("operator authentication (sign-in)", () => {
    const kms = createLocalKmsPort();
    let identitySql: Sql;
    let directSql: Sql;
    const runtime = loadRuntime();

    beforeAll(async () => {
      directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
      identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
      await directSql`delete from identity.operator_events`;
      await directSql`delete from identity.operator_grants`;
      await directSql`delete from identity.sessions`;
      await directSql`delete from identity.passkey_credentials`;
      await directSql`delete from identity.passkey_challenges`;
      await directSql`delete from identity.identity_keys`;
      await directSql`delete from identity.otp_challenges`;
      await directSql`delete from identity.users`;
    });

    afterAll(async () => {
      try {
        await directSql`delete from identity.operator_events`;
        await directSql`delete from identity.operator_grants`;
        await directSql`delete from identity.sessions`;
        await directSql`delete from identity.passkey_credentials`;
        await directSql`delete from identity.passkey_challenges`;
        await directSql`delete from identity.identity_keys`;
        await directSql`delete from identity.otp_challenges`;
        await directSql`delete from identity.users`;
      } finally {
        await identitySql.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    });

    async function createActiveOperator(
      email: string,
      now: Date,
      roleKeys: readonly string[] = ["platform_admin"],
    ) {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys,
        enrolmentCode,
        opsRpId,
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now,
      });
      const session = (res as { kind: "enrolment"; session: SessionTokens }).session;

      const opts1 = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
      });
      const k1 = await signer();
      const c1 = crypto.getRandomValues(new Uint8Array(32));
      await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
        clientDataJSON: clientData("webauthn.create", opts1!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c1,
            cose: coseKey(k1.x, k1.y),
            flags: 0x45,
          }),
        ),
      });

      const opts2 = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
      });
      const k2 = await signer();
      const c2 = crypto.getRandomValues(new Uint8Array(32));
      await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
        clientDataJSON: clientData("webauthn.create", opts2!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c2,
            cose: coseKey(k2.x, k2.y),
            flags: 0x45,
          }),
        ),
      });

      return {
        userId: user.userId,
        email,
        opsRpId,
        credentials: [
          { credentialId: c1, key: k1 },
          { credentialId: c2, key: k2 },
        ],
      };
    }

    it("operator sign-in refuses tenant credentials", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const op = await createActiveOperator("op-sign-in-6a@example.test", now);

      // Case 1: a credential row with null rp_id (legacy) and an assertion built for the ops RP against an ops challenge
      const kLegacy = await signer();
      const cLegacy = crypto.getRandomValues(new Uint8Array(32));
      await directSql`
        insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count, rp_id)
        values (${newId()}, ${op.userId}, ${cLegacy}, ${coseKey(kLegacy.x, kLegacy.y)}, 0, null)
      `;

      const auth1 = await beginOperatorAuthentication(identitySql, {
        opsRpId: op.opsRpId,
        now,
      });
      const authData1 = authenticatorData({ rpId: op.opsRpId, signCount: 1, flags: 0x05 });
      const client1 = clientData("webauthn.get", auth1.challenge, `https://${op.opsRpId}`);
      const sig1 = await kLegacy.sign(concat([authData1, sha256(client1)]));

      const res1 = await finishOperatorAuthentication(identitySql, kms, KEY_ARN, {
        opsRpId: op.opsRpId,
        now,
        credentialId: cLegacy,
        clientDataJSON: client1,
        authenticatorData: authData1,
        signature: sig1,
      });
      expect(res1).toBeNull();

      const refused1 = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.operator_events
        where user_id = ${op.userId} and action = 'sign_in_refused'
      `;
      expect(Number(refused1[0]?.count ?? 0)).toBe(0);

      const sess1 = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.sessions
        where user_id = ${op.userId} and kind = 'operator'
      `;
      expect(Number(sess1[0]?.count ?? 0)).toBe(0);

      // Case 2: an auth.example.test credential
      const kTenant = await signer();
      const cTenant = crypto.getRandomValues(new Uint8Array(32));
      await directSql`
        insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count, rp_id)
        values (${newId()}, ${op.userId}, ${cTenant}, ${coseKey(kTenant.x, kTenant.y)}, 0, 'auth.example.test')
      `;

      const auth2 = await beginOperatorAuthentication(identitySql, {
        opsRpId: op.opsRpId,
        now,
      });
      const authData2 = authenticatorData({ rpId: op.opsRpId, signCount: 1, flags: 0x05 });
      const client2 = clientData("webauthn.get", auth2.challenge, `https://${op.opsRpId}`);
      const sig2 = await kTenant.sign(concat([authData2, sha256(client2)]));

      const res2 = await finishOperatorAuthentication(identitySql, kms, KEY_ARN, {
        opsRpId: op.opsRpId,
        now,
        credentialId: cTenant,
        clientDataJSON: client2,
        authenticatorData: authData2,
        signature: sig2,
      });
      expect(res2).toBeNull();

      const refused2 = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.operator_events
        where user_id = ${op.userId} and action = 'sign_in_refused'
      `;
      expect(Number(refused2[0]?.count ?? 0)).toBe(0);

      const sess2 = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.sessions
        where user_id = ${op.userId} and kind = 'operator'
      `;
      expect(Number(sess2[0]?.count ?? 0)).toBe(0);
    });

    it("operator sign-in refuses an assertion without UV", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const op = await createActiveOperator("op-sign-in-6b@example.test", now);
      const cred = op.credentials[0]!;

      const auth = await beginOperatorAuthentication(identitySql, {
        opsRpId: op.opsRpId,
        now,
      });
      const authData = authenticatorData({ rpId: op.opsRpId, signCount: 1, flags: 0x01 });
      const client = clientData("webauthn.get", auth.challenge, `https://${op.opsRpId}`);
      const sig = await cred.key.sign(concat([authData, sha256(client)]));

      const res = await finishOperatorAuthentication(identitySql, kms, KEY_ARN, {
        opsRpId: op.opsRpId,
        now,
        credentialId: cred.credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature: sig,
      });
      expect(res).toBeNull();

      const refused = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.operator_events
        where user_id = ${op.userId} and action = 'sign_in_refused'
      `;
      expect(Number(refused[0]?.count ?? 0)).toBe(0);

      const sess = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.sessions
        where user_id = ${op.userId} and kind = 'operator'
      `;
      expect(Number(sess[0]?.count ?? 0)).toBe(0);
    });

    it("invalid and unknown assertions write no operator event", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const op = await createActiveOperator("op-sign-in-11@example.test", now);
      const cred = op.credentials[0]!;

      const [eventsBefore] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.operator_events
        where user_id = ${op.userId}
      `;

      // 1. Bad signature on real ops credential
      const auth1 = await beginOperatorAuthentication(identitySql, {
        opsRpId: op.opsRpId,
        now,
      });
      const authData1 = authenticatorData({ rpId: op.opsRpId, signCount: 1, flags: 0x05 });
      const client1 = clientData("webauthn.get", auth1.challenge, `https://${op.opsRpId}`);
      const badSig = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]);

      const res1 = await finishOperatorAuthentication(identitySql, kms, KEY_ARN, {
        opsRpId: op.opsRpId,
        now,
        credentialId: cred.credentialId,
        clientDataJSON: client1,
        authenticatorData: authData1,
        signature: badSig,
      });
      expect(res1).toBeNull();

      const [eventsAfter1] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.operator_events
        where user_id = ${op.userId}
      `;
      expect(eventsAfter1?.count).toBe(eventsBefore?.count);

      // 2. Unknown credential id
      const unknownCredId = crypto.getRandomValues(new Uint8Array(32));
      const unknownKey = await signer();
      const auth2 = await beginOperatorAuthentication(identitySql, {
        opsRpId: op.opsRpId,
        now,
      });
      const authData2 = authenticatorData({ rpId: op.opsRpId, signCount: 1, flags: 0x05 });
      const client2 = clientData("webauthn.get", auth2.challenge, `https://${op.opsRpId}`);
      const sig2 = await unknownKey.sign(concat([authData2, sha256(client2)]));

      const res2 = await finishOperatorAuthentication(identitySql, kms, KEY_ARN, {
        opsRpId: op.opsRpId,
        now,
        credentialId: unknownCredId,
        clientDataJSON: client2,
        authenticatorData: authData2,
        signature: sig2,
      });
      expect(res2).toBeNull();

      const [eventsAfter2] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.operator_events
        where user_id = ${op.userId}
      `;
      expect(eventsAfter2?.count).toBe(eventsBefore?.count);
    });

    it("operator sign-in mints an eight-hour operator session", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const op = await createActiveOperator("op-sign-in-14a@example.test", now);
      const cred = op.credentials[0]!;
      const requestId = newId();

      const auth = await beginOperatorAuthentication(identitySql, {
        opsRpId: op.opsRpId,
        now,
      });
      const authData = authenticatorData({ rpId: op.opsRpId, signCount: 1, flags: 0x05 });
      const client = clientData("webauthn.get", auth.challenge, `https://${op.opsRpId}`);
      const sig = await cred.key.sign(concat([authData, sha256(client)]));

      const tokens = await finishOperatorAuthentication(identitySql, kms, KEY_ARN, {
        opsRpId: op.opsRpId,
        now,
        credentialId: cred.credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature: sig,
        requestId,
      });
      expect(tokens).not.toBeNull();
      expect(tokens!.userId).toBe(op.userId);
      expect(tokens!.expiresIn).toBe(900);

      const [sessionRow] = await identitySql<
        {
          kind: string;
          absolute_expires_at: Date;
          access_expires_at: Date;
        }[]
      >`
        select kind, absolute_expires_at, access_expires_at
        from identity.sessions
        where user_id = ${op.userId} and kind = 'operator'
      `;
      expect(sessionRow?.kind).toBe("operator");
      expect(sessionRow?.absolute_expires_at).toEqual(new Date(now.getTime() + 8 * 60 * 60 * 1000));

      const [signedInEvent] = await identitySql<
        {
          action: string;
          role_key: string | null;
          request_id: string | null;
          occurred_at: Date;
        }[]
      >`
        select action, role_key, request_id, occurred_at
        from identity.operator_events
        where user_id = ${op.userId} and action = 'signed_in'
      `;
      expect(signedInEvent).toBeDefined();
      expect(signedInEvent?.action).toBe("signed_in");
      expect(signedInEvent?.role_key).toBeNull();
      expect(signedInEvent?.request_id).toBe(requestId);
      expect(signedInEvent?.occurred_at).toEqual(now);
    });

    it("a revoke holding the user lock wins over sign-in", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const op = await createActiveOperator("op-sign-in-14b@example.test", now);
      const cred = op.credentials[0]!;

      const auth = await beginOperatorAuthentication(identitySql, {
        opsRpId: op.opsRpId,
        now,
      });
      const authData = authenticatorData({ rpId: op.opsRpId, signCount: 1, flags: 0x05 });
      const client = clientData("webauthn.get", auth.challenge, `https://${op.opsRpId}`);
      const sig = await cred.key.sign(concat([authData, sha256(client)]));

      const holder = createPlaintextDirectSql(runtime.productOnlyUrl);
      const observer = createPlaintextDirectSql(runtime.productOnlyUrl);

      let releaseHolder!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let holderAcquired = false;
      let pendingSignIn: Promise<SessionTokens | null> | undefined;

      try {
        const holderPromise = holder.begin(async (tx) => {
          await lockOperatorUser(tx, op.userId);
          await tx`
            update identity.operator_grants
            set revoked_at = ${now}
            where user_id = ${op.userId}
              and revoked_at is null
          `;
          holderAcquired = true;
          await releasePromise;
        });

        const holderStart = Date.now();
        while (!holderAcquired) {
          if (Date.now() - holderStart > 5_000) {
            throw new Error("Timed out waiting for holder to acquire lock");
          }
          await Promise.race([holderPromise, new Promise((r) => setTimeout(r, 20))]);
        }

        let settled = false;
        pendingSignIn = finishOperatorAuthentication(identitySql, kms, KEY_ARN, {
          opsRpId: op.opsRpId,
          now,
          credentialId: cred.credentialId,
          clientDataJSON: client,
          authenticatorData: authData,
          signature: sig,
          requestId: newId(),
        }).finally(() => {
          settled = true;
        });

        const started = Date.now();
        let waiting = false;
        while (Date.now() - started < 5_000) {
          if (settled) break;
          const waitingRows = await observer<{ pid: number }[]>`
            select pid
            from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event_type = 'Lock'
              and pid <> pg_backend_pid()
          `;
          if (waitingRows.length > 0) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        if (!waiting && !settled) {
          throw new Error("finishOperatorAuthentication did not wait on the user lock within 5s");
        }

        releaseHolder();
        await holderPromise;

        const result = await pendingSignIn;
        expect(result).toBeNull();

        const [refusedEvent] = await identitySql<{ count: string }[]>`
          select count(*)::text as count
          from identity.operator_events
          where user_id = ${op.userId} and action = 'sign_in_refused'
        `;
        expect(Number(refusedEvent?.count ?? 0)).toBe(1);

        const [sessionCount] = await identitySql<{ count: string }[]>`
          select count(*)::text as count
          from identity.sessions
          where user_id = ${op.userId} and kind = 'operator'
        `;
        expect(Number(sessionCount?.count ?? 0)).toBe(0);
      } finally {
        releaseHolder();
        await pendingSignIn?.catch(() => undefined);
        await holder.end({ timeout: 1 });
        await observer.end({ timeout: 1 });
      }
    });

    it("a valid assertion from a user with only an open (unactivated) grant returns null and writes sign_in_refused", async () => {
      const now = new Date("2026-10-24T12:00:00.000Z");
      const email = "op-open-only@example.test";
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys: ["platform_admin"],
        enrolmentCode,
        opsRpId,
        now,
      });

      const k = await signer();
      const c = crypto.getRandomValues(new Uint8Array(32));
      await directSql`
        insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count, rp_id)
        values (${newId()}, ${user.userId}, ${c}, ${coseKey(k.x, k.y)}, 0, ${opsRpId})
      `;

      const auth = await beginOperatorAuthentication(identitySql, {
        opsRpId,
        now,
      });
      const authData = authenticatorData({ rpId: opsRpId, signCount: 1, flags: 0x05 });
      const client = clientData("webauthn.get", auth.challenge, `https://${opsRpId}`);
      const sig = await k.sign(concat([authData, sha256(client)]));

      const res = await finishOperatorAuthentication(identitySql, kms, KEY_ARN, {
        opsRpId,
        now,
        credentialId: c,
        clientDataJSON: client,
        authenticatorData: authData,
        signature: sig,
      });
      expect(res).toBeNull();

      const [refused] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.operator_events
        where user_id = ${user.userId} and action = 'sign_in_refused'
      `;
      expect(Number(refused?.count ?? 0)).toBe(1);

      const [sessions] = await identitySql<{ count: string }[]>`
        select count(*)::text as count
        from identity.sessions
        where user_id = ${user.userId}
      `;
      expect(Number(sessions?.count ?? 0)).toBe(0);
    });
  });

  describe("readOperatorSession, refreshOperatorSession and endOperatorSession", () => {
    async function createActiveOperator(
      email: string,
      now: Date,
      roleKeys: readonly string[] = ["platform_admin"],
    ) {
      const user = await insertIdentityUser(identitySql, kms, KEY_ARN, { email });
      const opsRpId = "ops.example.test";
      const enrolmentCode = "A".repeat(26);
      await grantOperator(identitySql, kms, KEY_ARN, {
        userId: user.userId,
        roleKeys,
        enrolmentCode,
        opsRpId,
        now,
      });
      const mail = createCapturingMail();
      await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, { email, now });
      const res = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
        email,
        emailCode: mail.sent[0]!.code,
        enrolmentCode,
        opsRpId,
        now,
      });
      const session = (res as { kind: "enrolment"; session: SessionTokens }).session;

      const opts1 = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
      });
      const k1 = await signer();
      const c1 = crypto.getRandomValues(new Uint8Array(32));
      await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
        clientDataJSON: clientData("webauthn.create", opts1!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c1,
            cose: coseKey(k1.x, k1.y),
            flags: 0x45,
          }),
        ),
      });

      const opts2 = await beginOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
      });
      const k2 = await signer();
      const c2 = crypto.getRandomValues(new Uint8Array(32));
      await finishOperatorPasskeyRegistration(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        opsRpId,
        now,
        clientDataJSON: clientData("webauthn.create", opts2!.challenge, `https://${opsRpId}`),
        attestationObject: attestationObject(
          authenticatorData({
            rpId: opsRpId,
            signCount: 0,
            credentialId: c2,
            cose: coseKey(k2.x, k2.y),
            flags: 0x45,
          }),
        ),
      });

      return {
        userId: user.userId,
        email,
        opsRpId,
        credentials: [
          { credentialId: c1, key: k1 },
          { credentialId: c2, key: k2 },
        ],
      };
    }

    async function signInOperator(
      op: {
        userId: string;
        opsRpId: string;
        credentials: {
          credentialId: Uint8Array;
          key: { sign: (data: Uint8Array) => Promise<Uint8Array> };
        }[];
      },
      now: Date,
    ): Promise<SessionTokens> {
      const auth = await beginOperatorAuthentication(identitySql, {
        opsRpId: op.opsRpId,
        now,
      });
      const cred = op.credentials[0]!;
      const authData = authenticatorData({ rpId: op.opsRpId, signCount: 1, flags: 0x05 });
      const client = clientData("webauthn.get", auth.challenge, `https://${op.opsRpId}`);
      const sig = await cred.key.sign(concat([authData, sha256(client)]));
      const session = await finishOperatorAuthentication(identitySql, kms, KEY_ARN, {
        opsRpId: op.opsRpId,
        now,
        credentialId: cred.credentialId,
        clientDataJSON: client,
        authenticatorData: authData,
        signature: sig,
      });
      if (!session) {
        throw new Error("signInOperator returned null");
      }
      return session;
    }

    describe("pin 8: readOperatorSession refuses tenant, enrolment, and grantless sessions", () => {
      it("readOperatorSession refuses tenant, enrolment, and grantless sessions", async () => {
        const now = new Date("2026-10-24T14:00:00.000Z");
        const op = await createActiveOperator("op-read-8-valid@example.test", now);
        const opSession = await signInOperator(op, now);

        // 1. Create a tenant session for the operator
        const tenantSession = await createSession(identitySql, kms, KEY_ARN, {
          userId: op.userId,
          now,
          kind: "tenant",
        });
        const tenantRead = await readOperatorSession(identitySql, kms, KEY_ARN, {
          accessToken: tenantSession.accessToken,
          now,
        });
        expect(tenantRead).toBeNull();

        // 2. Create an enrolment session for the active operator
        const enrolmentSession = await createSession(identitySql, kms, KEY_ARN, {
          userId: op.userId,
          now,
          kind: "enrolment",
        });
        const enrolRead = await readOperatorSession(identitySql, kms, KEY_ARN, {
          accessToken: enrolmentSession.accessToken,
          now,
        });
        expect(enrolRead).toBeNull();

        // 3. Verify operator session reads while grant is active
        const validRead = await readOperatorSession(identitySql, kms, KEY_ARN, {
          accessToken: opSession.accessToken,
          now,
        });
        expect(validRead).toEqual({
          userId: op.userId,
          roles: ["platform_admin"],
        });

        // 4. Operator session whose user has NO active grant (revoked)
        await directSql`
          update identity.operator_grants
          set revoked_at = ${now}
          where user_id = ${op.userId}
        `;
        const grantlessRead = await readOperatorSession(identitySql, kms, KEY_ARN, {
          accessToken: opSession.accessToken,
          now,
        });
        expect(grantlessRead).toBeNull();
      });
    });

    it("readOperatorSession returns all active roles, sorted", async () => {
      const now = new Date("2026-10-24T14:10:00.000Z");
      const op = await createActiveOperator("op-read-roles@example.test", now, [
        "platform_security",
        "platform_admin",
      ]);
      const opSession = await signInOperator(op, now);

      const read = await readOperatorSession(identitySql, kms, KEY_ARN, {
        accessToken: opSession.accessToken,
        now,
      });
      expect(read).toEqual({
        userId: op.userId,
        roles: ["platform_admin", "platform_security"],
      });

      // If an inactive grant exists (e.g. revoked), it is excluded
      await directSql`
        update identity.operator_grants
        set revoked_at = ${now}
        where user_id = ${op.userId}
          and role_key = 'platform_security'
      `;
      const readAfterRevokeOne = await readOperatorSession(identitySql, kms, KEY_ARN, {
        accessToken: opSession.accessToken,
        now,
      });
      expect(readAfterRevokeOne).toEqual({
        userId: op.userId,
        roles: ["platform_admin"],
      });
    });

    describe("pin 9: revoke vs refresh leaves no live successor", () => {
      it("a refresh racing a revoke leaves no unrevoked operator session", async () => {
        const now = new Date("2026-10-24T14:20:00.000Z");
        const op = await createActiveOperator("op-race-9@example.test", now);
        const session = await signInOperator(op, now);

        const { bound, reached, release } = pauseOnSessionInsert(identitySql);

        const revokeSql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
        const observer = createPlaintextDirectSql(runtime.productOnlyUrl);

        const refreshPromise = refreshOperatorSession(bound, kms, KEY_ARN, {
          refreshToken: session.refreshToken,
          now: new Date(now.getTime() + 60_000),
        });

        let revokeSettled = false;
        let revokePromise: Promise<void> | undefined;

        try {
          await Promise.race([
            reached,
            refreshPromise.then(() => {
              throw new Error("refresh finished without reaching session insert");
            }),
          ]);

          revokePromise = revokeOperator(revokeSql, {
            userId: op.userId,
            opsRpId: op.opsRpId,
            now: new Date(now.getTime() + 120_000),
          }).finally(() => {
            revokeSettled = true;
          });

          // Poll pg_stat_activity until revoke waits on a lock or has settled (20 ms, 5 s cap)
          const started = Date.now();
          let waiting = false;
          while (Date.now() - started < 5_000) {
            if (revokeSettled) break;
            const waitingRows = await observer<{ pid: number }[]>`
              select pid
              from pg_stat_activity
              where datname = current_database()
                and state = 'active'
                and wait_event_type = 'Lock'
                and pid <> pg_backend_pid()
            `;
            if (waitingRows.length > 0) {
              waiting = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 20));
          }
          expect(waiting || revokeSettled).toBe(true);
        } finally {
          release();
          await Promise.allSettled([refreshPromise, revokePromise]);
          await revokeSql.end({ timeout: 1 });
          await observer.end({ timeout: 1 });
        }

        const [refreshed] = await Promise.all([refreshPromise, revokePromise]);

        const [unrevoked] = await directSql<{ count: string }[]>`
          select count(*)::text as count
          from identity.sessions
          where user_id = ${op.userId}
            and revoked_at is null
        `;
        expect(Number(unrevoked?.count ?? 0)).toBe(0);

        if (refreshed) {
          const successorRead = await readOperatorSession(identitySql, kms, KEY_ARN, {
            accessToken: refreshed.accessToken,
            now: new Date(now.getTime() + 180_000),
          });
          expect(successorRead).toBeNull();

          const successorRefresh = await refreshOperatorSession(identitySql, kms, KEY_ARN, {
            refreshToken: refreshed.refreshToken,
            now: new Date(now.getTime() + 180_000),
          });
          expect(successorRefresh).toBeNull();
        }
      });

      it("after revoke, the old session neither reads nor refreshes", async () => {
        const now = new Date("2026-10-24T14:30:00.000Z");
        const op = await createActiveOperator("op-revoke-simple-9@example.test", now);
        const session = await signInOperator(op, now);

        await revokeOperator(identitySql, {
          userId: op.userId,
          opsRpId: op.opsRpId,
          now: new Date(now.getTime() + 60_000),
        });

        const readRes = await readOperatorSession(identitySql, kms, KEY_ARN, {
          accessToken: session.accessToken,
          now: new Date(now.getTime() + 120_000),
        });
        expect(readRes).toBeNull();

        const refreshRes = await refreshOperatorSession(identitySql, kms, KEY_ARN, {
          refreshToken: session.refreshToken,
          now: new Date(now.getTime() + 120_000),
        });
        expect(refreshRes).toBeNull();
      });
    });

    describe("pin 15: operator refresh refuses at or after absolute_expires_at", () => {
      it("operator refresh refuses at the absolute expiry even if the row allows it", async () => {
        const now = new Date("2026-10-24T14:40:00.000Z");
        const op = await createActiveOperator("op-abs-15@example.test", now);
        const session = await signInOperator(op, now);

        const [storedSession] = await directSql<{ id: string; absolute_expires_at: Date }[]>`
          select id, absolute_expires_at
          from identity.sessions
          where user_id = ${op.userId}
            and kind = 'operator'
          limit 1
        `;
        expect(storedSession).toBeDefined();
        const absExpiresAt = storedSession!.absolute_expires_at;

        // Set refresh_expires_at past absolute_expires_at
        await directSql`
          update identity.sessions
          set refresh_expires_at = ${absExpiresAt}::timestamptz + interval '1 day'
          where id = ${storedSession!.id}
        `;

        const [countBefore] = await directSql<{ count: string }[]>`
          select count(*)::text as count
          from identity.sessions
          where user_id = ${op.userId}
        `;

        const refreshAtAbsolute = await refreshOperatorSession(identitySql, kms, KEY_ARN, {
          refreshToken: session.refreshToken,
          now: absExpiresAt,
        });
        expect(refreshAtAbsolute).toBeNull();

        const refreshAtPlusOneSecond = await refreshOperatorSession(identitySql, kms, KEY_ARN, {
          refreshToken: session.refreshToken,
          now: new Date(absExpiresAt.getTime() + 1000),
        });
        expect(refreshAtPlusOneSecond).toBeNull();

        // Mints nothing: session count for user remains unchanged
        const [countAfter] = await directSql<{ count: string }[]>`
          select count(*)::text as count
          from identity.sessions
          where user_id = ${op.userId}
        `;
        expect(Number(countAfter?.count ?? 0)).toBe(Number(countBefore?.count ?? 0));
      });
    });

    describe("pin 16: an enrolment session never refreshes", () => {
      it("an enrolment refresh token never refreshes", async () => {
        const now = new Date("2026-10-24T14:50:00.000Z");
        const user = await insertIdentityUser(identitySql, kms, KEY_ARN, {
          email: "op-enrol-ref-16@example.test",
        });
        const enrolmentCode = "A".repeat(26);
        await grantOperator(identitySql, kms, KEY_ARN, {
          userId: user.userId,
          roleKeys: ["platform_admin"],
          enrolmentCode,
          opsRpId: "ops.example.test",
          now,
        });
        const mail = createCapturingMail();
        await startOperatorEnrolment(identitySql, kms, KEY_ARN, mail, {
          email: "op-enrol-ref-16@example.test",
          now,
        });
        const verifyRes = await verifyOperatorEnrolment(identitySql, kms, KEY_ARN, {
          email: "op-enrol-ref-16@example.test",
          emailCode: mail.sent[0]!.code,
          enrolmentCode,
          opsRpId: "ops.example.test",
          now,
        });
        const session = (verifyRes as { kind: "enrolment"; session: SessionTokens }).session;

        const opRefresh = await refreshOperatorSession(identitySql, kms, KEY_ARN, {
          refreshToken: session.refreshToken,
          now,
        });
        expect(opRefresh).toBeNull();

        const directRefresh = await refreshSession(identitySql, kms, KEY_ARN, {
          refreshToken: session.refreshToken,
          now,
          kinds: ["tenant", "operator", "enrolment"],
        });
        expect(directRefresh).toBeNull();
      });
    });

    describe("pin 17: operator refresh refuses after the grant is revoked", () => {
      it("operator refresh refuses after the grant is revoked", async () => {
        const now = new Date("2026-10-24T15:00:00.000Z");
        const op = await createActiveOperator("op-revoke-17@example.test", now);
        const session = await signInOperator(op, now);

        // Revoke the grant by direct update (sessions left unrevoked)
        await directSql`
          update identity.operator_grants
          set revoked_at = ${now}
          where user_id = ${op.userId}
        `;

        const refreshRes = await refreshOperatorSession(identitySql, kms, KEY_ARN, {
          refreshToken: session.refreshToken,
          now: new Date(now.getTime() + 60_000),
        });
        expect(refreshRes).toBeNull();

        // Presented session remains unclaimed
        const [presented] = await directSql<{ replaced_by: string | null }[]>`
          select replaced_by
          from identity.sessions
          where user_id = ${op.userId}
            and kind = 'operator'
        `;
        expect(presented?.replaced_by).toBeNull();
      });
    });

    describe("pin 21: ending a session that was just refreshed leaves no live successor", () => {
      it("ending a session that was just refreshed leaves no live successor", async () => {
        const now = new Date("2026-10-24T15:10:00.000Z");
        const op = await createActiveOperator("op-end-21@example.test", now);
        const session1 = await signInOperator(op, now);

        const session2 = await refreshOperatorSession(identitySql, kms, KEY_ARN, {
          refreshToken: session1.refreshToken,
          now: new Date(now.getTime() + 60_000),
        });
        expect(session2).not.toBeNull();

        // End with the OLD access token
        await endOperatorSession(identitySql, kms, KEY_ARN, {
          accessToken: session1.accessToken,
          now: new Date(now.getTime() + 120_000),
        });

        const successorRead = await readOperatorSession(identitySql, kms, KEY_ARN, {
          accessToken: session2!.accessToken,
          now: new Date(now.getTime() + 180_000),
        });
        expect(successorRead).toBeNull();

        const successorRefresh = await refreshOperatorSession(identitySql, kms, KEY_ARN, {
          refreshToken: session2!.refreshToken,
          now: new Date(now.getTime() + 180_000),
        });
        expect(successorRefresh).toBeNull();
      });
    });

    it("refresh 10 minutes before absolute_expires_at returns expiresIn 600", async () => {
      const t0 = new Date("2026-10-24T15:20:00.000Z");
      const op = await createActiveOperator("op-expires-in-600@example.test", t0);
      const session = await signInOperator(op, t0);

      const refreshTime = new Date(t0.getTime() + 8 * 60 * 60 * 1000 - 10 * 60 * 1000);
      const refreshed = await refreshOperatorSession(identitySql, kms, KEY_ARN, {
        refreshToken: session.refreshToken,
        now: refreshTime,
      });
      expect(refreshed).not.toBeNull();
      expect(refreshed!.expiresIn).toBe(600);
    });

    it("an ended session neither reads nor refreshes and writes signed_out", async () => {
      const now = new Date("2026-10-24T15:30:00.000Z");
      const op = await createActiveOperator("op-end-signed-out@example.test", now);
      const session = await signInOperator(op, now);
      const requestId = newId();

      const endNow = new Date(now.getTime() + 60_000);
      await endOperatorSession(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        now: endNow,
        requestId,
      });

      const read = await readOperatorSession(identitySql, kms, KEY_ARN, {
        accessToken: session.accessToken,
        now: new Date(now.getTime() + 120_000),
      });
      expect(read).toBeNull();

      const refreshed = await refreshOperatorSession(identitySql, kms, KEY_ARN, {
        refreshToken: session.refreshToken,
        now: new Date(now.getTime() + 120_000),
      });
      expect(refreshed).toBeNull();

      const [event] = await directSql<{ action: string; request_id: string; occurred_at: Date }[]>`
        select action, request_id, occurred_at
        from identity.operator_events
        where user_id = ${op.userId}
          and action = 'signed_out'
      `;
      expect(event).toBeDefined();
      expect(event!.request_id).toBe(requestId);
      expect(event!.occurred_at.toISOString()).toBe(endNow.toISOString());
    });
  });
});
