import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { auditEventHash } from "../src/audit-hash.js";
import { createAppSql, createDirectSql } from "../src/connections.js";
import { newId } from "../src/ids.js";
import { applyProductMigrations } from "../src/migrate.js";
import { withOrgTransaction } from "../src/tx.js";

type Runtime = {
  directUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE = path.join(DIR, "../drizzle");

const FROZEN_DIGEST_HEX = "7a29119e629b70f9d9ff4ef69ebc874303ee4315a745f306cbddb802c129b5ad";
const FROZEN_ORG = "00000000-0000-7000-8000-000000000001";
const FROZEN_ID = "00000000-0000-7000-8000-000000000002";
const FROZEN_ACTOR = "00000000-0000-7000-8000-000000000003";
const FROZEN_REQUEST = "00000000-0000-7000-8000-000000000004";
const FROZEN_OCCURRED_AT = "2026-01-01 00:00:00+00";

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(path.join(DIR, ".runtime.json"), "utf8")) as Runtime;
}

function pooledAppUrl(runtime: Runtime): string {
  return `postgres://app:${encodeURIComponent(runtime.passwords.app)}@127.0.0.1:6432/hub`;
}

function productSql(): string {
  return readdirSync(DRIZZLE)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => readFileSync(path.join(DRIZZLE, name), "utf8"))
    .join("\n");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function asBytes(value: Uint8Array | Buffer | string): Uint8Array {
  if (typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

describe("app.audit_events", () => {
  beforeAll(async () => {
    const runtime = loadRuntime();
    await applyProductMigrations(runtime.directUrl);
  });

  it("journal SQL contains revoke, policies, force RLS, CASE WHEN, sha256, search_path, and grant", () => {
    const sql = productSql();
    expect(sql).toMatch(/REVOKE/);
    expect(sql).toMatch(/audit_events_select/);
    expect(sql).toMatch(/audit_events_insert/);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CASE WHEN/);
    expect(sql).toMatch(/sha256\(/);
    expect(sql).toMatch(/SET search_path = pg_catalog, app/);
    expect(sql).toMatch(/GRANT EXECUTE[\s\S]*app\.audit_event_hash[\s\S]*TO app/i);
    expect(sql).not.toMatch(/pgcrypto/i);
    expect(sql).not.toMatch(/IF prev IS NOT NULL AND/);
  });

  it("app.audit_event_hash throws when hash_version is not 1", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    try {
      await expect(
        sql`
          select app.audit_event_hash(
            2::smallint,
            ${FROZEN_ORG}::uuid,
            ${FROZEN_ID}::uuid,
            1::bigint,
            decode(repeat('00', 32), 'hex'),
            'user',
            ${FROZEN_ACTOR}::uuid,
            'audit.chain.recorded',
            '{}'::uuid[],
            'audit.chain.test',
            ${FROZEN_REQUEST}::uuid,
            ${FROZEN_OCCURRED_AT}::timestamptz
          )
        `,
      ).rejects.toThrow(/hash_version/i);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("app.audit_event_hash of the frozen inputs returns the spec digest", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    try {
      const rows = await sql<{ digest: string }[]>`
        select encode(
          app.audit_event_hash(
            1::smallint,
            ${FROZEN_ORG}::uuid,
            ${FROZEN_ID}::uuid,
            1::bigint,
            decode(repeat('00', 32), 'hex'),
            'user',
            ${FROZEN_ACTOR}::uuid,
            'audit.chain.recorded',
            '{}'::uuid[],
            'audit.chain.test',
            ${FROZEN_REQUEST}::uuid,
            ${FROZEN_OCCURRED_AT}::timestamptz
          ),
          'hex'
        ) as digest
      `;
      expect(rows[0]?.digest).toBe(FROZEN_DIGEST_HEX);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("BEFORE INSERT trigger overwrites chain fields and keeps the chosen id", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const foreignOrg = newId();
    const chosenId = newId();
    const actorId = newId();
    const requestId = newId();
    const wrongPrev = Buffer.alloc(32, 0xab);
    const wrongHash = Buffer.alloc(32, 0xcd);
    try {
      const stored = await withOrgTransaction(sql, orgId, async (tx) => {
        const [{ tx_start }] = await tx<{ tx_start: Date }[]>`
          select transaction_timestamp() as tx_start
        `;
        await new Promise((resolve) => setTimeout(resolve, 50));
        await tx`
          insert into app.audit_events (
            id, org_id, seq, hash_version, prev_hash, hash,
            actor_kind, actor_id, action, target_ids, purpose, request_id, occurred_at
          ) values (
            ${chosenId}::uuid,
            ${foreignOrg}::uuid,
            99,
            9,
            ${wrongPrev},
            ${wrongHash},
            'user',
            ${actorId}::uuid,
            'audit.chain.recorded',
            '{}'::uuid[],
            'audit.chain.test',
            ${requestId}::uuid,
            '2000-01-01'::timestamptz
          )
        `;
        const rows = await tx<
          {
            id: string;
            org_id: string;
            seq: string;
            hash_version: number;
            prev_hash: Uint8Array | Buffer | string;
            hash: Uint8Array | Buffer | string;
            occurred_at: Date;
            occurred_at_micros: string;
          }[]
        >`
          select
            id::text,
            org_id::text,
            seq::text,
            hash_version,
            prev_hash,
            hash,
            occurred_at,
            trunc(extract(epoch from occurred_at) * 1000000)::bigint::text as occurred_at_micros
          from app.audit_events
          where id = ${chosenId}::uuid
        `;
        return { row: rows[0]!, tx_start: tx_start! };
      });

      expect(stored.row.id).toBe(chosenId);
      expect(stored.row.org_id).toBe(orgId);
      expect(stored.row.seq).toBe("1");
      expect(stored.row.hash_version).toBe(1);
      expect(toHex(asBytes(stored.row.prev_hash))).toBe("00".repeat(32));
      expect(stored.row.occurred_at.getTime()).toBeGreaterThan(stored.tx_start.getTime());

      const expected = await auditEventHash({
        hashVersion: 1,
        orgId,
        id: chosenId,
        seq: 1n,
        prevHash: new Uint8Array(32),
        actorKind: "user",
        actorId,
        action: "audit.chain.recorded",
        targetIds: [],
        purpose: "audit.chain.test",
        requestId,
        occurredAtMicros: BigInt(stored.row.occurred_at_micros),
      });
      expect(toHex(asBytes(stored.row.hash))).toBe(toHex(expected));
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("first row of a second organisation is also seq 1 with a zero prev_hash", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgA = newId();
    const orgB = newId();
    const actorId = newId();
    const requestId = newId();

    async function insertFirst(orgId: string) {
      return withOrgTransaction(sql, orgId, async (tx) => {
        await tx`
          insert into app.audit_events (
            id, org_id, seq, hash_version, prev_hash, hash,
            actor_kind, actor_id, action, target_ids, purpose, request_id, occurred_at
          ) values (
            ${newId()}::uuid,
            ${orgId}::uuid,
            1,
            1,
            decode(repeat('00', 32), 'hex'),
            decode(repeat('11', 32), 'hex'),
            'user',
            ${actorId}::uuid,
            'audit.chain.recorded',
            '{}'::uuid[],
            'audit.chain.test',
            ${requestId}::uuid,
            clock_timestamp()
          )
        `;
        const rows = await tx<{ seq: string; prev_hash: Uint8Array | Buffer | string }[]>`
          select seq::text, prev_hash from app.audit_events
        `;
        return rows[0]!;
      });
    }

    try {
      const a = await insertFirst(orgA);
      const b = await insertFirst(orgB);
      expect(a.seq).toBe("1");
      expect(toHex(asBytes(a.prev_hash))).toBe("00".repeat(32));
      expect(b.seq).toBe("1");
      expect(toHex(asBytes(b.prev_hash))).toBe("00".repeat(32));
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("UPDATE, DELETE, and TRUNCATE as app throw", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    const requestId = newId();
    try {
      await withOrgTransaction(sql, orgId, async (tx) => {
        await tx`
          insert into app.audit_events (
            id, org_id, seq, hash_version, prev_hash, hash,
            actor_kind, actor_id, action, target_ids, purpose, request_id, occurred_at
          ) values (
            ${newId()}::uuid,
            ${orgId}::uuid,
            1,
            1,
            decode(repeat('00', 32), 'hex'),
            decode(repeat('11', 32), 'hex'),
            'user',
            ${actorId}::uuid,
            'audit.chain.recorded',
            '{}'::uuid[],
            'audit.chain.test',
            ${requestId}::uuid,
            clock_timestamp()
          )
        `;
      });

      await expect(
        withOrgTransaction(sql, orgId, async (tx) => {
          await tx`update app.audit_events set purpose = 'audit.chain.tampered'`;
        }),
      ).rejects.toThrow();

      await expect(
        withOrgTransaction(sql, orgId, async (tx) => {
          await tx`delete from app.audit_events`;
        }),
      ).rejects.toThrow();

      await expect(
        withOrgTransaction(sql, orgId, async (tx) => {
          await tx`truncate app.audit_events`;
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rejects null target element and two-dimensional uuid[] with audit_events_target_ids", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    const requestId = newId();

    async function insertTargets(targetSql: string) {
      return withOrgTransaction(sql, orgId, async (tx) => {
        await tx.unsafe(`
          insert into app.audit_events (
            id, org_id, seq, hash_version, prev_hash, hash,
            actor_kind, actor_id, action, target_ids, purpose, request_id, occurred_at
          ) values (
            '${newId()}'::uuid,
            '${orgId}'::uuid,
            1,
            1,
            decode(repeat('00', 32), 'hex'),
            decode(repeat('11', 32), 'hex'),
            'user',
            '${actorId}'::uuid,
            'audit.chain.recorded',
            ${targetSql},
            'audit.chain.test',
            '${requestId}'::uuid,
            clock_timestamp()
          )
        `);
      });
    }

    try {
      try {
        await insertTargets("ARRAY[NULL::uuid]");
        expect.unreachable("null element should fail");
      } catch (error) {
        const err = error as { code?: string; constraint_name?: string; message?: string };
        expect(err.code).toBe("23514");
        expect(err.constraint_name).toBe("audit_events_target_ids");
      }

      try {
        await insertTargets(`ARRAY[ARRAY['${newId()}'::uuid]]`);
        expect.unreachable("two-dimensional array should fail");
      } catch (error) {
        const err = error as { code?: string; constraint_name?: string; message?: string };
        expect(err.code).toBe("23514");
        expect(err.constraint_name).toBe("audit_events_target_ids");
        expect(err.message ?? "").not.toMatch(/searching for elements in multidimensional arrays/i);
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("declared CHECK rejects null element and 2D uuid[] when the trigger is bypassed", async () => {
    const runtime = loadRuntime();
    const sql = createDirectSql(runtime.directUrl);
    const orgId = newId();
    const actorId = newId();
    const requestId = newId();

    async function insertWithTriggerBypassed(targetSql: string) {
      return sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL session_replication_role = replica");
        await tx.unsafe(`
          insert into app.audit_events (
            id, org_id, seq, hash_version, prev_hash, hash,
            actor_kind, actor_id, action, target_ids, purpose, request_id, occurred_at
          ) values (
            '${newId()}'::uuid,
            '${orgId}'::uuid,
            1,
            1,
            decode(repeat('00', 32), 'hex'),
            decode(repeat('11', 32), 'hex'),
            'user',
            '${actorId}'::uuid,
            'audit.chain.recorded',
            ${targetSql},
            'audit.chain.test',
            '${requestId}'::uuid,
            clock_timestamp()
          )
        `);
      });
    }

    try {
      try {
        await insertWithTriggerBypassed("ARRAY[NULL::uuid]");
        expect.unreachable("null element should fail the CHECK");
      } catch (error) {
        const err = error as { code?: string; constraint_name?: string; message?: string };
        expect(err.code).toBe("23514");
        expect(err.constraint_name).toBe("audit_events_target_ids");
      }

      try {
        await insertWithTriggerBypassed(`ARRAY[ARRAY['${newId()}'::uuid]]`);
        expect.unreachable("two-dimensional array should fail the CHECK");
      } catch (error) {
        const err = error as { code?: string; constraint_name?: string; message?: string };
        expect(err.code).toBe("23514");
        expect(err.constraint_name).toBe("audit_events_target_ids");
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("app.audit_event_hash raises on null target element and two-dimensional uuid[]", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    try {
      await expect(
        sql`
          select app.audit_event_hash(
            1::smallint,
            ${FROZEN_ORG}::uuid,
            ${FROZEN_ID}::uuid,
            1::bigint,
            decode(repeat('00', 32), 'hex'),
            'user',
            ${FROZEN_ACTOR}::uuid,
            'audit.chain.recorded',
            ARRAY[NULL::uuid],
            'audit.chain.test',
            ${FROZEN_REQUEST}::uuid,
            ${FROZEN_OCCURRED_AT}::timestamptz
          )
        `,
      ).rejects.toThrow(/target_ids/i);

      await expect(
        sql.unsafe(`
          select app.audit_event_hash(
            1::smallint,
            '${FROZEN_ORG}'::uuid,
            '${FROZEN_ID}'::uuid,
            1::bigint,
            decode(repeat('00', 32), 'hex'),
            'user',
            '${FROZEN_ACTOR}'::uuid,
            'audit.chain.recorded',
            ARRAY[ARRAY['${FROZEN_ID}'::uuid]],
            'audit.chain.test',
            '${FROZEN_REQUEST}'::uuid,
            '${FROZEN_OCCURRED_AT}'::timestamptz
          )
        `),
      ).rejects.toThrow(/target_ids/i);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rejects system with actor_id and user with null actor_id", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    const requestId = newId();
    try {
      await expect(
        withOrgTransaction(sql, orgId, async (tx) => {
          await tx`
            insert into app.audit_events (
              id, org_id, seq, hash_version, prev_hash, hash,
              actor_kind, actor_id, action, target_ids, purpose, request_id, occurred_at
            ) values (
              ${newId()}::uuid,
              ${orgId}::uuid,
              1,
              1,
              decode(repeat('00', 32), 'hex'),
              decode(repeat('11', 32), 'hex'),
              'system',
              ${actorId}::uuid,
              'audit.chain.recorded',
              '{}'::uuid[],
              'audit.chain.test',
              ${requestId}::uuid,
              clock_timestamp()
            )
          `;
        }),
      ).rejects.toThrow();

      await expect(
        withOrgTransaction(sql, orgId, async (tx) => {
          await tx`
            insert into app.audit_events (
              id, org_id, seq, hash_version, prev_hash, hash,
              actor_kind, actor_id, action, target_ids, purpose, request_id, occurred_at
            ) values (
              ${newId()}::uuid,
              ${orgId}::uuid,
              1,
              1,
              decode(repeat('00', 32), 'hex'),
              decode(repeat('11', 32), 'hex'),
              'user',
              null,
              'audit.chain.recorded',
              '{}'::uuid[],
              'audit.chain.test',
              ${requestId}::uuid,
              clock_timestamp()
            )
          `;
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

describe("schema-rls sees audit_events", () => {
  it("product journal includes FORCE RLS for audit_events", () => {
    const sql = productSql();
    expect(sql).toMatch(/CREATE TABLE ["']?app["']?\.\s*["']?audit_events["']?/i);
    expect(sql).toMatch(/ALTER TABLE ["']?app["']?\.\s*["']?audit_events["']? FORCE ROW LEVEL SECURITY/i);
  });
});
