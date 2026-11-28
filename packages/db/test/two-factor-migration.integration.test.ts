import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "../src/ids.js";
import { applyMigrations, applyProductMigrations } from "../src/migrate.js";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "../src/plaintext.js";
import { freshDatabase, type FreshDatabase } from "./fixtures/database-fixture.js";

type Runtime = {
  directUrl: string;
  passwords: {
    app: string;
    identity: string;
    platform: string;
  };
};

type Journal = {
  entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[];
};

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE = path.join(DIR, "../drizzle");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(path.join(DIR, ".runtime.json"), "utf8")) as Runtime;
}

function identityDatabaseUrl(directDbUrl: string, password: string): string {
  const url = new URL(directDbUrl);
  url.username = "identity";
  url.password = password;
  return url.toString();
}

function bytes32(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

describe("two-factor migration 0024", () => {
  let database: FreshDatabase;
  let sql: ReturnType<typeof createPlaintextDirectSql>;
  let identitySql: ReturnType<typeof createPlaintextIdentitySql>;
  let folder: string;

  const userId = newId();
  const otherUserId = newId();
  const thirdUserId = newId();
  const existingPasskeyId = newId();

  beforeAll(async () => {
    const runtime = loadRuntime();
    database = await freshDatabase(runtime.directUrl);
    sql = createPlaintextDirectSql(database.url);
    identitySql = createPlaintextIdentitySql(
      identityDatabaseUrl(database.url, runtime.passwords.identity),
    );
    folder = mkdtempSync(path.join(tmpdir(), "hub-db-two-factor-"));

    // Apply migrations 0000..0023 first so pre-0024 passkey rows exist before 0024 runs.
    cpSync(DRIZZLE, folder, { recursive: true });
    const journalPath = path.join(folder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    journal.entries = journal.entries.filter((entry) => entry.idx <= 23);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));

    await applyMigrations({
      sql,
      folder,
      table: "__drizzle_migrations",
    });

    await identitySql`
      insert into identity.users (id, region, email, email_bidx) values
        (${userId}, 'au', ${bytes32()}, ${bytes32()}),
        (${otherUserId}, 'au', ${bytes32()}, ${bytes32()}),
        (${thirdUserId}, 'au', ${bytes32()}, ${bytes32()})
    `;

    await identitySql`
      insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count, rp_id)
      values (${existingPasskeyId}, ${userId}, ${bytes32()}, ${bytes32()}, ${0}, ${"auth.example.test"})
    `;

    await applyProductMigrations(sql);
  }, 180_000);

  afterAll(async () => {
    if (identitySql) {
      await identitySql.end({ timeout: 1 });
    }
    if (sql) {
      await sql.end({ timeout: 1 });
    }
    if (folder) {
      rmSync(folder, { recursive: true, force: true });
    }
    if (database) {
      await database.drop();
    }
  }, 120_000);

  // Pin 1
  it("refuses a session kind outside the four", async () => {
    const sessionId = newId();
    const now = new Date("2026-11-26T00:00:00.000Z");
    const accessExpiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const refreshExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await expect(
      identitySql`
        insert into identity.sessions (
          id, user_id, refresh_family, access_hash, refresh_hash,
          access_expires_at, refresh_expires_at, kind, absolute_expires_at
        )
        values (
          ${sessionId}, ${userId}, ${newId()}, ${bytes32()}, ${bytes32()},
          ${accessExpiresAt}::timestamptz, ${refreshExpiresAt}::timestamptz, 'bogus', null
        )
      `,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "sessions_kind_v2" });

    const rows = await identitySql<{ id: string }[]>`
      select id from identity.sessions where id = ${sessionId}
    `;
    expect(rows).toEqual([]);
  });

  // Pin 2
  it("refuses second_factor_attempts above five", async () => {
    const sessionId = newId();
    const now = new Date("2026-11-26T00:00:00.000Z");
    const accessExpiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

    await expect(
      identitySql`
        insert into identity.sessions (
          id, user_id, refresh_family, access_hash, refresh_hash,
          access_expires_at, refresh_expires_at, kind, second_factor_attempts
        )
        values (
          ${sessionId}, ${userId}, ${newId()}, ${bytes32()}, ${bytes32()},
          ${accessExpiresAt}::timestamptz, ${accessExpiresAt}::timestamptz, 'tenant', ${6}
        )
      `,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "sessions_second_factor_attempts" });

    const rows = await identitySql<{ id: string }[]>`
      select id from identity.sessions where id = ${sessionId}
    `;
    expect(rows).toEqual([]);
  });

  // Pin 3
  it("refuses an unknown factor value", async () => {
    const sessionId = newId();
    const now = new Date("2026-11-26T00:00:00.000Z");
    const accessExpiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

    await expect(
      identitySql`
        insert into identity.sessions (
          id, user_id, refresh_family, access_hash, refresh_hash,
          access_expires_at, refresh_expires_at, kind, factor
        )
        values (
          ${sessionId}, ${userId}, ${newId()}, ${bytes32()}, ${bytes32()},
          ${accessExpiresAt}::timestamptz, ${accessExpiresAt}::timestamptz, 'tenant', 'email_otp'
        )
      `,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "sessions_factor" });

    const rows = await identitySql<{ id: string }[]>`
      select id from identity.sessions where id = ${sessionId}
    `;
    expect(rows).toEqual([]);
  });

  // Pin 4
  it("the identity role cannot update or delete second factor events", async () => {
    const eventId = newId();
    const occurredAt = new Date("2026-11-26T00:00:00.000Z").toISOString();

    await expect(
      identitySql`
        insert into identity.second_factor_events (id, user_id, event, occurred_at)
        values (${eventId}, ${userId}, 'totp_enrolled', ${occurredAt}::timestamptz)
      `,
    ).resolves.toBeDefined();

    await expect(
      identitySql`
        update identity.second_factor_events set event = 'totp_removed' where id = ${eventId}
      `,
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      identitySql`
        delete from identity.second_factor_events where id = ${eventId}
      `,
    ).rejects.toMatchObject({ code: "42501" });

    const [priv] = await sql<{ can_truncate: boolean }[]>`
      select has_table_privilege('identity', 'identity.second_factor_events', 'TRUNCATE') as can_truncate
    `;
    expect(priv?.can_truncate).toBe(false);

    const [row] = await identitySql<{ event: string }[]>`
      select event from identity.second_factor_events where id = ${eventId}
    `;
    expect(row?.event).toBe("totp_enrolled");
  });

  // Pin 5
  it("refuses a second TOTP row for one user", async () => {
    const totpUserId = newId();
    const createdAt = new Date("2026-11-26T00:00:00.000Z").toISOString();

    await identitySql`
      insert into identity.users (id, region, email, email_bidx)
      values (${totpUserId}, 'au', ${bytes32()}, ${bytes32()})
    `;

    await expect(
      identitySql`
        insert into identity.totp_credentials (id, user_id, secret, created_at)
        values (${newId()}, ${totpUserId}, ${bytes32()}, ${createdAt}::timestamptz)
      `,
    ).resolves.toBeDefined();

    await expect(
      identitySql`
        insert into identity.totp_credentials (id, user_id, secret, created_at)
        values (${newId()}, ${totpUserId}, ${bytes32()}, ${createdAt}::timestamptz)
      `,
    ).rejects.toMatchObject({ code: "23505", constraint_name: "totp_credentials_user_id_unique" });

    const [counted] = await identitySql<{ count: number }[]>`
      select count(*)::int as count from identity.totp_credentials where user_id = ${totpUserId}
    `;
    expect(counted?.count).toBe(1);
  });

  // Pin 6
  it("refuses a duplicate backup code hash for one user", async () => {
    const backupUserId = newId();
    const codeHash = bytes32();
    const createdAt = new Date("2026-11-26T00:00:00.000Z").toISOString();

    await identitySql`
      insert into identity.users (id, region, email, email_bidx)
      values (${backupUserId}, 'au', ${bytes32()}, ${bytes32()})
    `;

    await expect(
      identitySql`
        insert into identity.backup_codes (id, user_id, code_hash, created_at)
        values (${newId()}, ${backupUserId}, ${codeHash}, ${createdAt}::timestamptz)
      `,
    ).resolves.toBeDefined();

    await expect(
      identitySql`
        insert into identity.backup_codes (id, user_id, code_hash, created_at)
        values (${newId()}, ${backupUserId}, ${codeHash}, ${createdAt}::timestamptz)
      `,
    ).rejects.toMatchObject({
      code: "23505",
      constraint_name: "backup_codes_user_id_code_hash_unique",
    });

    const [counted] = await identitySql<{ count: number }[]>`
      select count(*)::int as count
      from identity.backup_codes
      where user_id = ${backupUserId} and code_hash = ${codeHash}
    `;
    expect(counted?.count).toBe(1);
  });

  // Pin 7 (spec test 19)
  it("the session, refresh and passkey inserts on main still succeed", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const accessExpiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    const refreshExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Copied from modules/core/identity/infrastructure/session.ts:428-459 on main
    const input = {
      id: newId(),
      userId,
      refreshFamily: newId(),
      accessHash: bytes32(),
      refreshHash: bytes32(),
      accessExpiresAt,
      refreshExpiresAt,
      kind: "tenant",
      absoluteExpiresAt: null as Date | null,
    };

    await expect(
      identitySql`
        insert into identity.sessions (
          id, user_id, refresh_family, access_hash, refresh_hash,
          access_expires_at, refresh_expires_at, kind, absolute_expires_at
        )
        values (
          ${input.id},
          ${input.userId},
          ${input.refreshFamily},
          ${input.accessHash},
          ${input.refreshHash},
          ${input.accessExpiresAt.toISOString()}::timestamptz,
          ${input.refreshExpiresAt.toISOString()}::timestamptz,
          ${input.kind},
          ${input.absoluteExpiresAt ? input.absoluteExpiresAt.toISOString() : null}::timestamptz
        )
      `,
    ).resolves.toBeDefined();

    // Copied from modules/core/identity/infrastructure/session.ts:316-330 on main
    const successorId = newId();
    const row = {
      user_id: input.userId,
      refresh_family: input.refreshFamily,
      kind: "tenant",
      absolute_expires_at: null as Date | null,
    };
    const minted = {
      accessHash: bytes32(),
      refreshHash: bytes32(),
    };

    await expect(
      identitySql.begin(
        (tx) => tx`
          insert into identity.sessions (
            id, user_id, refresh_family, access_hash, refresh_hash,
            access_expires_at, refresh_expires_at, kind, absolute_expires_at
          )
          values (
            ${successorId},
            ${row.user_id},
            ${row.refresh_family},
            ${minted.accessHash},
            ${minted.refreshHash},
            ${accessExpiresAt.toISOString()}::timestamptz,
            ${refreshExpiresAt.toISOString()}::timestamptz,
            ${row.kind},
            ${row.absolute_expires_at ? row.absolute_expires_at.toISOString() : null}::timestamptz
          )
        `,
      ),
    ).resolves.toBeDefined();

    // Copied from modules/core/identity/infrastructure/passkey.ts:172-182 on main
    const passkeyId = newId();
    const passkeyInput = { userId, rpId: "auth.example.test" };
    const credentialId = bytes32();
    const coseKey = bytes32();
    const auth = { signCount: 0 };

    await expect(
      identitySql.begin(
        (tx) => tx`
          insert into identity.passkey_credentials (id, user_id, credential_id, cose_key, sign_count, rp_id)
          values (
            ${passkeyId},
            ${passkeyInput.userId},
            ${credentialId},
            ${coseKey},
            ${auth.signCount},
            ${passkeyInput.rpId}
          )
        `,
      ),
    ).resolves.toBeDefined();

    const [sessionRow] = await identitySql<
      {
        factor: string | null;
        fresh_factor_at: Date | null;
        recovery_until: Date | null;
        second_factor_attempts: number;
      }[]
    >`
      select factor, fresh_factor_at, recovery_until, second_factor_attempts
      from identity.sessions
      where id = ${successorId}
    `;
    expect(sessionRow).toEqual({
      factor: null,
      fresh_factor_at: null,
      recovery_until: null,
      second_factor_attempts: 0,
    });

    const [passkeyRow] = await identitySql<{ user_verified: boolean; created_at: Date | null }[]>`
      select user_verified, created_at
      from identity.passkey_credentials
      where id = ${passkeyId}
    `;
    expect(passkeyRow).toEqual({
      user_verified: false,
      created_at: null,
    });
  });

  // Pin 8
  it("an existing passkey row reads user_verified false", async () => {
    const rows = await identitySql<{ user_verified: boolean; created_at: Date | null }[]>`
      select user_verified, created_at
      from identity.passkey_credentials
      where id = ${existingPasskeyId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_verified).toBe(false);
    expect(rows[0]?.created_at).toBeNull();
  });

  // Pin 9
  it("refuses an unknown second factor event", async () => {
    const eventId = newId();
    const occurredAt = new Date("2026-11-26T00:00:00.000Z").toISOString();

    await expect(
      identitySql`
        insert into identity.second_factor_events (id, user_id, event, occurred_at)
        values (${eventId}, ${userId}, 'unknown_event', ${occurredAt}::timestamptz)
      `,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "second_factor_events_event" });

    const rows = await identitySql<{ id: string }[]>`
      select id from identity.second_factor_events where id = ${eventId}
    `;
    expect(rows).toEqual([]);
  });

  it("creates totp_credentials, backup_codes and second_factor_events without org_id or RLS", async () => {
    const tables = await sql<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'identity'
        and c.relkind = 'r'
        and c.relname in ('totp_credentials', 'backup_codes', 'second_factor_events')
      order by c.relname
    `;
    expect(tables).toEqual([
      { relname: "backup_codes", relrowsecurity: false, relforcerowsecurity: false },
      { relname: "second_factor_events", relrowsecurity: false, relforcerowsecurity: false },
      { relname: "totp_credentials", relrowsecurity: false, relforcerowsecurity: false },
    ]);

    const orgIdCols = await sql<{ table_name: string }[]>`
      select table_name
      from information_schema.columns
      where table_schema = 'identity'
        and column_name = 'org_id'
    `;
    expect(orgIdCols).toEqual([]);

    for (const table of ["totp_credentials", "backup_codes", "second_factor_events"]) {
      for (const role of ["app", "platform"]) {
        const [priv] = await sql<{ has_select: boolean; has_insert: boolean }[]>`
          select
            has_table_privilege(${role}, ${`identity.${table}`}, 'SELECT') as has_select,
            has_table_privilege(${role}, ${`identity.${table}`}, 'INSERT') as has_insert
        `;
        expect(priv).toEqual({ has_select: false, has_insert: false });
      }
    }
  });

  it("creates the expected columns, defaults, foreign keys and index", async () => {
    const columns = await sql<
      { table_name: string; column_name: string; data_type: string; is_nullable: string }[]
    >`
      select table_name, column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'identity'
        and table_name in (
          'totp_credentials',
          'backup_codes',
          'second_factor_events',
          'sessions',
          'passkey_credentials'
        )
      order by table_name, ordinal_position
    `;

    const byTable = new Map<
      string,
      { column_name: string; data_type: string; is_nullable: string }[]
    >();
    for (const col of columns) {
      const list = byTable.get(col.table_name) ?? [];
      list.push({
        column_name: col.column_name,
        data_type: col.data_type,
        is_nullable: col.is_nullable,
      });
      byTable.set(col.table_name, list);
    }

    expect(byTable.get("totp_credentials")).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "user_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "secret", data_type: "bytea", is_nullable: "NO" },
      { column_name: "pending_secret", data_type: "bytea", is_nullable: "YES" },
      { column_name: "last_used_step", data_type: "bigint", is_nullable: "YES" },
      { column_name: "confirmed_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ]);

    expect(byTable.get("backup_codes")).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "user_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "code_hash", data_type: "bytea", is_nullable: "NO" },
      { column_name: "used_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ]);

    expect(byTable.get("second_factor_events")).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "user_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "event", data_type: "text", is_nullable: "NO" },
      { column_name: "occurred_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ]);

    expect(byTable.get("sessions")).toEqual(
      expect.arrayContaining([
        { column_name: "factor", data_type: "text", is_nullable: "YES" },
        {
          column_name: "fresh_factor_at",
          data_type: "timestamp with time zone",
          is_nullable: "YES",
        },
        {
          column_name: "recovery_until",
          data_type: "timestamp with time zone",
          is_nullable: "YES",
        },
        { column_name: "second_factor_attempts", data_type: "integer", is_nullable: "NO" },
      ]),
    );

    expect(byTable.get("passkey_credentials")).toEqual(
      expect.arrayContaining([
        { column_name: "user_verified", data_type: "boolean", is_nullable: "NO" },
        { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      ]),
    );

    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'identity'
        and tablename = 'second_factor_events'
    `;
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          indexname: "second_factor_events_user_id_occurred_at_idx",
          indexdef: expect.stringContaining("(user_id, occurred_at)"),
        }),
      ]),
    );

    const oldConstraint = await sql<{ conname: string }[]>`
      select conname
      from pg_constraint
      where conrelid = 'identity.sessions'::regclass
        and conname in ('sessions_kind', 'sessions_kind_v2')
      order by conname
    `;
    expect(oldConstraint).toEqual([{ conname: "sessions_kind_v2" }]);
  });

  it("accepts all four session kinds and enforces absolute_expires_at", async () => {
    const now = new Date("2026-11-26T00:00:00.000Z");
    const accessExpiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const abs = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();

    for (const row of [
      { kind: "tenant", abs: null },
      { kind: "operator", abs },
      { kind: "enrolment", abs: null },
      { kind: "second_factor", abs: null },
    ]) {
      await expect(
        identitySql`
          insert into identity.sessions (
            id, user_id, refresh_family, access_hash, refresh_hash,
            access_expires_at, refresh_expires_at, kind, absolute_expires_at
          )
          values (
            ${newId()}, ${userId}, ${newId()}, ${bytes32()}, ${bytes32()},
            ${accessExpiresAt}::timestamptz, ${accessExpiresAt}::timestamptz,
            ${row.kind}, ${row.abs}::timestamptz
          )
        `,
      ).resolves.toBeDefined();
    }

    const rejectedId = newId();
    await expect(
      identitySql`
        insert into identity.sessions (
          id, user_id, refresh_family, access_hash, refresh_hash,
          access_expires_at, refresh_expires_at, kind, absolute_expires_at
        )
        values (
          ${rejectedId}, ${userId}, ${newId()}, ${bytes32()}, ${bytes32()},
          ${accessExpiresAt}::timestamptz, ${accessExpiresAt}::timestamptz,
          'second_factor', ${abs}::timestamptz
        )
      `,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "sessions_absolute_expiry" });

    const found = await identitySql<{ id: string }[]>`
      select id from identity.sessions where id = ${rejectedId}
    `;
    expect(found).toEqual([]);
  });

  it("accepts all four factor values and null", async () => {
    const accessExpiresAt = new Date("2026-11-26T00:15:00.000Z").toISOString();

    for (const factor of [null, "passkey_uv", "otp_totp", "otp_passkey", "otp_backup_code"]) {
      await expect(
        identitySql`
          insert into identity.sessions (
            id, user_id, refresh_family, access_hash, refresh_hash,
            access_expires_at, refresh_expires_at, kind, factor
          )
          values (
            ${newId()}, ${userId}, ${newId()}, ${bytes32()}, ${bytes32()},
            ${accessExpiresAt}::timestamptz, ${accessExpiresAt}::timestamptz,
            'tenant', ${factor}
          )
        `,
      ).resolves.toBeDefined();
    }
  });

  it("accepts second_factor_attempts from zero to five and refuses negative", async () => {
    const accessExpiresAt = new Date("2026-11-26T00:15:00.000Z").toISOString();

    for (const attempts of [0, 5]) {
      const id = newId();
      await expect(
        identitySql`
          insert into identity.sessions (
            id, user_id, refresh_family, access_hash, refresh_hash,
            access_expires_at, refresh_expires_at, kind, second_factor_attempts
          )
          values (
            ${id}, ${userId}, ${newId()}, ${bytes32()}, ${bytes32()},
            ${accessExpiresAt}::timestamptz, ${accessExpiresAt}::timestamptz,
            'second_factor', ${attempts}
          )
        `,
      ).resolves.toBeDefined();
    }

    const negId = newId();
    await expect(
      identitySql`
        insert into identity.sessions (
          id, user_id, refresh_family, access_hash, refresh_hash,
          access_expires_at, refresh_expires_at, kind, second_factor_attempts
        )
        values (
          ${negId}, ${userId}, ${newId()}, ${bytes32()}, ${bytes32()},
          ${accessExpiresAt}::timestamptz, ${accessExpiresAt}::timestamptz,
          'second_factor', ${-1}
        )
      `,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "sessions_second_factor_attempts" });

    const found = await identitySql<{ id: string }[]>`
      select id from identity.sessions where id = ${negId}
    `;
    expect(found).toEqual([]);
  });

  it("stores totp_credentials with nullable fields, bigint last_used_step, and enforces users FK", async () => {
    const createdAt = new Date("2026-11-26T00:00:00.000Z").toISOString();
    const confirmedAt = new Date("2026-11-26T00:02:00.000Z").toISOString();
    const totpId = newId();
    const bigStep = 60_000_000_000;

    await expect(
      identitySql`
        insert into identity.totp_credentials (id, user_id, secret, created_at)
        values (${totpId}, ${otherUserId}, ${bytes32()}, ${createdAt}::timestamptz)
      `,
    ).resolves.toBeDefined();

    await expect(
      identitySql`
        update identity.totp_credentials
        set pending_secret = ${bytes32()},
            last_used_step = ${bigStep},
            confirmed_at = ${confirmedAt}::timestamptz
        where id = ${totpId}
      `,
    ).resolves.toBeDefined();

    const [row] = await identitySql<
      {
        pending_secret: Uint8Array | null;
        last_used_step: string | null;
        confirmed_at: Date | null;
      }[]
    >`
      select pending_secret, last_used_step, confirmed_at
      from identity.totp_credentials
      where id = ${totpId}
    `;
    expect(row?.pending_secret).not.toBeNull();
    expect(Number(row?.last_used_step)).toBe(bigStep);
    expect(row?.confirmed_at).toEqual(new Date(confirmedAt));

    const missingUserId = newId();
    await expect(
      identitySql`
        insert into identity.totp_credentials (id, user_id, secret, created_at)
        values (${newId()}, ${missingUserId}, ${bytes32()}, ${createdAt}::timestamptz)
      `,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("stores backup_codes across users, allows distinct codes per user, and enforces users FK", async () => {
    const createdAt = new Date("2026-11-26T00:00:00.000Z").toISOString();
    const sharedHash = bytes32();
    const otherHash = bytes32();

    await expect(
      identitySql`
        insert into identity.backup_codes (id, user_id, code_hash, created_at) values
          (${newId()}, ${otherUserId}, ${sharedHash}, ${createdAt}::timestamptz),
          (${newId()}, ${otherUserId}, ${otherHash}, ${createdAt}::timestamptz),
          (${newId()}, ${thirdUserId}, ${sharedHash}, ${createdAt}::timestamptz)
      `,
    ).resolves.toBeDefined();

    await expect(
      identitySql`
        insert into identity.backup_codes (id, user_id, code_hash, created_at)
        values (${newId()}, ${newId()}, ${bytes32()}, ${createdAt}::timestamptz)
      `,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("accepts all seven second_factor_events values", async () => {
    const occurredAt = new Date("2026-11-26T00:00:00.000Z").toISOString();
    const events = [
      "totp_enrolled",
      "totp_removed",
      "passkey_enrolled",
      "passkey_removed",
      "backup_codes_generated",
      "backup_code_used",
      "verify_failed",
    ];

    for (const event of events) {
      await expect(
        identitySql`
          insert into identity.second_factor_events (id, user_id, event, occurred_at)
          values (${newId()}, ${otherUserId}, ${event}, ${occurredAt}::timestamptz)
        `,
      ).resolves.toBeDefined();
    }
  });

  it("stores passkey_credentials with user_verified true and created_at set", async () => {
    const id = newId();
    const createdAt = new Date("2026-11-26T00:00:00.000Z").toISOString();

    await expect(
      identitySql`
        insert into identity.passkey_credentials (
          id, user_id, credential_id, cose_key, sign_count, rp_id, user_verified, created_at
        )
        values (
          ${id}, ${otherUserId}, ${bytes32()}, ${bytes32()}, ${1},
          ${"admin.example.test"}, ${true}, ${createdAt}::timestamptz
        )
      `,
    ).resolves.toBeDefined();

    const [row] = await identitySql<{ user_verified: boolean; created_at: Date | null }[]>`
      select user_verified, created_at from identity.passkey_credentials where id = ${id}
    `;
    expect(row).toEqual({
      user_verified: true,
      created_at: new Date(createdAt),
    });
  });

  it("expands existing session rows without rewriting data", async () => {
    const runtime = loadRuntime();
    const expandDb = await freshDatabase(runtime.directUrl);
    const expandSql = createPlaintextDirectSql(expandDb.url);
    const expandFolder = mkdtempSync(path.join(tmpdir(), "hub-db-expand-"));

    try {
      cpSync(DRIZZLE, expandFolder, { recursive: true });
      const journalPath = path.join(expandFolder, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
      journal.entries = journal.entries.filter((entry) => entry.idx <= 23);
      writeFileSync(journalPath, JSON.stringify(journal, null, 2));

      await applyMigrations({
        sql: expandSql,
        folder: expandFolder,
        table: "__drizzle_migrations",
      });

      const preUserId = newId();
      const preSessionId = newId();
      const prePasskeyId = newId();
      const accessExpiresAt = new Date("2026-11-26T00:15:00.000Z").toISOString();
      const refreshExpiresAt = new Date("2026-12-26T00:00:00.000Z").toISOString();

      await expandSql.unsafe("set role identity");
      await expandSql`
        insert into identity.users (id, region, email, email_bidx)
        values (${preUserId}, 'au', ${bytes32()}, ${bytes32()})
      `;
      await expandSql`
        insert into identity.sessions (
          id, user_id, refresh_family, access_hash, refresh_hash,
          access_expires_at, refresh_expires_at, kind, absolute_expires_at
        )
        values (
          ${preSessionId}, ${preUserId}, ${newId()}, ${bytes32()}, ${bytes32()},
          ${accessExpiresAt}::timestamptz, ${refreshExpiresAt}::timestamptz, 'tenant', null
        )
      `;
      await expandSql`
        insert into identity.passkey_credentials (
          id, user_id, credential_id, cose_key, sign_count, rp_id
        )
        values (${prePasskeyId}, ${preUserId}, ${bytes32()}, ${bytes32()}, ${2}, ${"auth.example.test"})
      `;
      await expandSql.unsafe("reset role");

      await applyProductMigrations(expandSql);

      const [sess] = await expandSql<
        {
          kind: string;
          factor: string | null;
          fresh_factor_at: Date | null;
          recovery_until: Date | null;
          second_factor_attempts: number;
        }[]
      >`
        select kind, factor, fresh_factor_at, recovery_until, second_factor_attempts
        from identity.sessions
        where id = ${preSessionId}
      `;
      expect(sess).toEqual({
        kind: "tenant",
        factor: null,
        fresh_factor_at: null,
        recovery_until: null,
        second_factor_attempts: 0,
      });

      const [pk] = await expandSql<{ user_verified: boolean; created_at: Date | null }[]>`
        select user_verified, created_at
        from identity.passkey_credentials
        where id = ${prePasskeyId}
      `;
      expect(pk).toEqual({
        user_verified: false,
        created_at: null,
      });
    } finally {
      await expandSql.end({ timeout: 1 });
      rmSync(expandFolder, { recursive: true, force: true });
      await expandDb.drop();
    }
  }, 180_000);
});
