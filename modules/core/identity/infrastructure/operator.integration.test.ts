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

import { IdentityError } from "../domain/error.js";
import { type OtpMail, OtpMailUnavailable, rejectingOtpMail } from "../domain/otp-mail.js";
import { deriveIdentityEmailKeys, emailBlindIndex } from "./email-lookup.js";
import { startEmailOtp, verifyEmailOtp } from "./email-otp.js";
import { insertIdentityUser } from "./identity-user.js";
import {
  grantOperator,
  recoverOperator,
  revokeOperator,
  startOperatorEnrolment,
  verifyOperatorEnrolment,
  type VerifyOperatorEnrolmentResult,
} from "./operator.js";
import { readSession, readSessionWithKind, refreshSession } from "./session.js";

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
});
