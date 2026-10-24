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

import { insertIdentityUser } from "./identity-user.js";
import { grantOperator, recoverOperator, revokeOperator } from "./operator.js";

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
