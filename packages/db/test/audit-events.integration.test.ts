import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withRequest } from "@community-hub/kernel";
import {
  defineAuditAction,
  defineAuditPurpose,
} from "@community-hub/kernel/module";
import { beforeAll, describe, expect, it } from "vitest";

import { appendAuditEvent } from "../src/audit-append.js";
import { auditEventHash } from "../src/audit-hash.js";
import { verifyAuditChain } from "../src/audit-verify.js";
import { createAppSql, createDirectSql } from "../src/connections.js";
import { newId } from "../src/ids.js";
import { applyProductMigrations } from "../src/migrate.js";
import { withOrgTransaction } from "../src/tx.js";
import { applyTestMigrations } from "./migrate-test.js";

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

const APPEND_ACTION = defineAuditAction("audit.append.recorded");
const APPEND_PURPOSE = defineAuditPurpose("audit.append.test");

describe("app.audit_events", () => {
  beforeAll(async () => {
    const runtime = loadRuntime();
    await applyProductMigrations(runtime.directUrl);
    await applyTestMigrations({ mode: "test" }, runtime.directUrl);
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

describe("appendAuditEvent", () => {
  it("throws outside withRequest and leaves no row", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    try {
      await expect(
        withOrgTransaction(sql, orgId, async (tx) => {
          await appendAuditEvent(tx, {
            actorKind: "user",
            actorId,
            action: APPEND_ACTION,
            purpose: APPEND_PURPOSE,
            targetIds: [],
          });
        }),
      ).rejects.toThrow();

      const rows = await withOrgTransaction(sql, orgId, async (tx) => {
        return tx<{ n: string }[]>`select count(*)::text as n from app.audit_events`;
      });
      expect(rows[0]?.n).toBe("0");
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rejects a non-UUID requestId", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    try {
      await expect(
        withRequest({ requestId: "not-a-uuid", idempotencyKey: "append-bad-req" }, async () => {
          await withOrgTransaction(sql, orgId, async (tx) => {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId,
              action: APPEND_ACTION,
              purpose: APPEND_PURPOSE,
              targetIds: [],
            });
          });
        }),
      ).rejects.toThrow();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rolls back a companion synthetic write when the action is unregistered", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    const syntheticId = newId();
    try {
      await expect(
        withRequest({ requestId: newId(), idempotencyKey: "append-bad-action" }, async () => {
          await withOrgTransaction(sql, orgId, async (tx) => {
            await tx`insert into app.synthetic (org_id, id) values (${orgId}, ${syntheticId})`;
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId,
              action: "audit.append.unknown_action",
              purpose: APPEND_PURPOSE,
              targetIds: [],
            });
          });
        }),
      ).rejects.toThrow();

      const rows = await withOrgTransaction(sql, orgId, async (tx) => {
        return tx<{ id: string }[]>`select id from app.synthetic where id = ${syntheticId}`;
      });
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rolls back a companion synthetic write when the purpose is unregistered", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    const syntheticId = newId();
    try {
      await expect(
        withRequest({ requestId: newId(), idempotencyKey: "append-bad-purpose" }, async () => {
          await withOrgTransaction(sql, orgId, async (tx) => {
            await tx`insert into app.synthetic (org_id, id) values (${orgId}, ${syntheticId})`;
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId,
              action: APPEND_ACTION,
              purpose: "audit.append.unknown_purpose",
              targetIds: [],
            });
          });
        }),
      ).rejects.toThrow();

      const rows = await withOrgTransaction(sql, orgId, async (tx) => {
        return tx<{ id: string }[]>`select id from app.synthetic where id = ${syntheticId}`;
      });
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rejects system with actor id and user with null actor id before insert", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    try {
      await expect(
        withRequest({ requestId: newId(), idempotencyKey: "append-system-actor" }, async () => {
          await withOrgTransaction(sql, orgId, async (tx) => {
            await appendAuditEvent(tx, {
              actorKind: "system",
              actorId,
              action: APPEND_ACTION,
              purpose: APPEND_PURPOSE,
              targetIds: [],
            });
          });
        }),
      ).rejects.toThrow();

      await expect(
        withRequest({ requestId: newId(), idempotencyKey: "append-user-null" }, async () => {
          await withOrgTransaction(sql, orgId, async (tx) => {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: null,
              action: APPEND_ACTION,
              purpose: APPEND_PURPOSE,
              targetIds: [],
            });
          });
        }),
      ).rejects.toThrow();

      const rows = await withOrgTransaction(sql, orgId, async (tx) => {
        return tx<{ n: string }[]>`select count(*)::text as n from app.audit_events`;
      });
      expect(rows[0]?.n).toBe("0");
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rejects a null entry in targetIds before insert", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    try {
      await expect(
        withRequest({ requestId: newId(), idempotencyKey: "append-null-target" }, async () => {
          await withOrgTransaction(sql, orgId, async (tx) => {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId,
              action: APPEND_ACTION,
              purpose: APPEND_PURPOSE,
              targetIds: [null as unknown as string],
            });
          });
        }),
      ).rejects.toThrow();

      const rows = await withOrgTransaction(sql, orgId, async (tx) => {
        return tx<{ n: string }[]>`select count(*)::text as n from app.audit_events`;
      });
      expect(rows[0]?.n).toBe("0");
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("refuses isolation other than read committed before insert", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    try {
      await expect(
        withRequest({ requestId: newId(), idempotencyKey: "append-rr" }, async () => {
          await sql.begin("isolation level repeatable read", async (tx) => {
            await tx`select set_config('app.org_id', ${orgId}, ${true})`;
            await appendAuditEvent(tx as Parameters<typeof appendAuditEvent>[0], {
              actorKind: "user",
              actorId,
              action: APPEND_ACTION,
              purpose: APPEND_PURPOSE,
              targetIds: [],
            });
          });
        }),
      ).rejects.toThrow();

      const rows = await withOrgTransaction(sql, orgId, async (tx) => {
        return tx<{ n: string }[]>`select count(*)::text as n from app.audit_events`;
      });
      expect(rows[0]?.n).toBe("0");
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("inserts two rows for two appends in one request with seq 1 and 2", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    const targetId = newId();
    try {
      const results = await withRequest(
        { requestId: newId(), idempotencyKey: "append-two" },
        async () => {
          return withOrgTransaction(sql, orgId, async (tx) => {
            const first = await appendAuditEvent(tx, {
              actorKind: "user",
              actorId,
              action: APPEND_ACTION,
              purpose: APPEND_PURPOSE,
              targetIds: [targetId],
            });
            const second = await appendAuditEvent(tx, {
              actorKind: "user",
              actorId,
              action: APPEND_ACTION,
              purpose: APPEND_PURPOSE,
              targetIds: [targetId],
            });
            const rows = await tx<
              { id: string; seq: string; hash: Uint8Array | Buffer | string }[]
            >`
              select id::text, seq::text, hash
              from app.audit_events
              order by seq
            `;
            return { first, second, rows };
          });
        },
      );

      expect(results.first.seq).toBe("1");
      expect(results.second.seq).toBe("2");
      expect(results.rows).toHaveLength(2);
      expect(results.rows[0]?.seq).toBe("1");
      expect(results.rows[1]?.seq).toBe("2");
      expect(toHex(asBytes(results.rows[0]!.hash))).not.toBe(toHex(asBytes(results.rows[1]!.hash)));
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

describe("verifyAuditChain", () => {
  beforeAll(async () => {
    const runtime = loadRuntime();
    await applyProductMigrations(runtime.directUrl);
    await applyTestMigrations({ mode: "test" }, runtime.directUrl);
  });

  it("resolves on an organisation with no rows", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    try {
      await expect(
        withOrgTransaction(sql, orgId, async (tx) => {
          await verifyAuditChain(tx);
        }),
      ).resolves.toBeUndefined();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("verifies a chain whose occurred_at has a non-zero microsecond part", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const actorId = newId();
    try {
      let chosen: {
        id: string;
        seq: string;
        hash: Uint8Array | Buffer | string;
        prev_hash: Uint8Array | Buffer | string;
        actor_kind: string;
        actor_id: string | null;
        action: string;
        target_ids: string[];
        purpose: string;
        request_id: string;
        occurred_at_micros: string;
        org_id: string;
        hash_version: number;
      } | null = null;

      for (let i = 0; i < 10; i += 1) {
        const requestId = newId();
        const row = await withRequest(
          { requestId, idempotencyKey: `verify-micros-${i}` },
          async () => {
            return withOrgTransaction(sql, orgId, async (tx) => {
              const appended = await appendAuditEvent(tx, {
                actorKind: "user",
                actorId,
                action: APPEND_ACTION,
                purpose: APPEND_PURPOSE,
                targetIds: [],
              });
              const rows = await tx<
                {
                  id: string;
                  seq: string;
                  hash: Uint8Array | Buffer | string;
                  prev_hash: Uint8Array | Buffer | string;
                  actor_kind: string;
                  actor_id: string | null;
                  action: string;
                  target_ids: string[];
                  purpose: string;
                  request_id: string;
                  occurred_at_micros: string;
                  org_id: string;
                  hash_version: number;
                }[]
              >`
                select
                  id::text,
                  org_id::text,
                  seq::text,
                  hash_version,
                  prev_hash,
                  hash,
                  actor_kind,
                  actor_id::text,
                  action,
                  coalesce(target_ids::text[], '{}'::text[]) as target_ids,
                  purpose,
                  request_id::text,
                  trunc(extract(epoch from occurred_at) * 1000000)::bigint::text as occurred_at_micros
                from app.audit_events
                where id = ${appended.id}::uuid
              `;
              return rows[0]!;
            });
          },
        );

        const micros = BigInt(row.occurred_at_micros);
        if (micros % 1000n !== 0n) {
          chosen = row;
          break;
        }
      }

      if (chosen === null) {
        throw new Error("ten appends were all millisecond-aligned");
      }

      await expect(
        withOrgTransaction(sql, orgId, async (tx) => {
          await verifyAuditChain(tx);
        }),
      ).resolves.toBeUndefined();

      const floored = BigInt(chosen.occurred_at_micros) - (BigInt(chosen.occurred_at_micros) % 1000n);
      const flooredHash = await auditEventHash({
        hashVersion: 1,
        orgId: chosen.org_id,
        id: chosen.id,
        seq: BigInt(chosen.seq),
        prevHash: asBytes(chosen.prev_hash),
        actorKind: chosen.actor_kind as "user" | "support" | "system",
        actorId: chosen.actor_id,
        action: chosen.action,
        targetIds: chosen.target_ids,
        purpose: chosen.purpose,
        requestId: chosen.request_id,
        occurredAtMicros: floored,
      });
      expect(toHex(flooredHash)).not.toBe(toHex(asBytes(chosen.hash)));
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("retries after a forced seq collision on hub and verify accepts the chain", async () => {
    const runtime = loadRuntime();
    const hubUrl = pooledAppUrl(runtime);
    const sql = createAppSql(hubUrl);
    const poller = createAppSql(hubUrl);
    const orgId = newId();
    const actorId = newId();

    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let signalAInserted!: () => void;
    const aInserted = new Promise<void>((resolve) => {
      signalAInserted = resolve;
    });

    try {
      const aDone = withRequest(
        { requestId: newId(), idempotencyKey: "verify-collision-a" },
        async () => {
          await withOrgTransaction(sql, orgId, async (tx) => {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId,
              action: APPEND_ACTION,
              purpose: APPEND_PURPOSE,
              targetIds: [],
            });
            signalAInserted();
            await aGate;
          });
        },
      );

      await aInserted;

      let attempts = 0;
      let resolveFirstAttempt!: () => void;
      const firstAttempt = new Promise<void>((resolve) => {
        resolveFirstAttempt = resolve;
      });

      const bDone = withRequest(
        { requestId: newId(), idempotencyKey: "verify-collision-b" },
        async () => {
          return withOrgTransaction(sql, orgId, async (tx) => {
            return appendAuditEvent(
              tx,
              {
                actorKind: "user",
                actorId,
                action: APPEND_ACTION,
                purpose: APPEND_PURPOSE,
                targetIds: [],
              },
              {
                onAttempt: () => {
                  attempts += 1;
                  if (attempts === 1) {
                    resolveFirstAttempt();
                  }
                },
              },
            );
          });
        },
      );

      await firstAttempt;

      const deadline = Date.now() + 15_000;
      let sawLockWait = false;
      while (Date.now() < deadline) {
        const rows = await poller<{ n: string }[]>`
          select count(*)::text as n
          from pg_stat_activity
          where wait_event_type = 'Lock'
            and datname = current_database()
            and usename = current_user
            and pid <> pg_backend_pid()
        `;
        if (Number(rows[0]?.n ?? "0") > 0) {
          sawLockWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(sawLockWait).toBe(true);

      releaseA();
      await aDone;
      const bResult = await bDone;

      expect(bResult.seq).toBe("2");
      expect(attempts).toBe(2);

      await expect(
        withOrgTransaction(sql, orgId, async (tx) => {
          await verifyAuditChain(tx);
        }),
      ).resolves.toBeUndefined();
    } finally {
      releaseA();
      await sql.end({ timeout: 1 });
      await poller.end({ timeout: 1 });
    }
  }, 30_000);

  it("keeps org B from selecting org A's row and verifies org B after one append", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgA = newId();
    const orgB = newId();
    const actorId = newId();
    try {
      const aId = await withRequest(
        { requestId: newId(), idempotencyKey: "verify-cross-a" },
        async () => {
          return withOrgTransaction(sql, orgA, async (tx) => {
            const row = await appendAuditEvent(tx, {
              actorKind: "user",
              actorId,
              action: APPEND_ACTION,
              purpose: APPEND_PURPOSE,
              targetIds: [],
            });
            return row.id;
          });
        },
      );

      const fromB = await withOrgTransaction(sql, orgB, async (tx) => {
        return tx<{ id: string }[]>`
          select id::text from app.audit_events where id = ${aId}::uuid
        `;
      });
      expect(fromB).toHaveLength(0);

      await withRequest({ requestId: newId(), idempotencyKey: "verify-cross-b" }, async () => {
        await withOrgTransaction(sql, orgB, async (tx) => {
          await appendAuditEvent(tx, {
            actorKind: "user",
            actorId,
            action: APPEND_ACTION,
            purpose: APPEND_PURPOSE,
            targetIds: [],
          });
        });
      });

      await expect(
        withOrgTransaction(sql, orgB, async (tx) => {
          await verifyAuditChain(tx);
        }),
      ).resolves.toBeUndefined();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rejects after a privileged one-byte hash flip with audit.chain.broken and that seq", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const direct = createDirectSql(runtime.directUrl);
    const orgId = newId();
    const actorId = newId();
    try {
      const appended = await withRequest(
        { requestId: newId(), idempotencyKey: "verify-tamper" },
        async () => {
          return withOrgTransaction(sql, orgId, async (tx) => {
            return appendAuditEvent(tx, {
              actorKind: "user",
              actorId,
              action: APPEND_ACTION,
              purpose: APPEND_PURPOSE,
              targetIds: [],
            });
          });
        },
      );

      await direct`
        update app.audit_events
        set hash = set_byte(hash, 0, get_byte(hash, 0) # 1)
        where id = ${appended.id}::uuid
      `;

      await expect(
        withOrgTransaction(sql, orgId, async (tx) => {
          await verifyAuditChain(tx);
        }),
      ).rejects.toThrow(new RegExp(`audit\\.chain\\.broken seq ${appended.seq}`));
    } finally {
      await sql.end({ timeout: 1 });
      await direct.end({ timeout: 1 });
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
