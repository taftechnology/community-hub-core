import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindPublisher, defineEvent, defineModule } from "@community-hub/kernel/module";
import { withRequest } from "@community-hub/kernel";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createAppSql, createDirectSql } from "../src/connections.js";
import { newId } from "../src/ids.js";
import { applyProductMigrations } from "../src/migrate.js";
import { createOutbox } from "../src/outbox-adapter.js";
import { withOrgTransaction } from "../src/tx.js";
import { applyTestMigrations } from "./migrate-test.js";

type Runtime = {
  directUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE = path.join(DIR, "../drizzle");
const COLUMNS = [
  "id",
  "org_id",
  "event_name",
  "payload",
  "occurred_at",
  "idempotency_key",
] as const;

const recorded = defineEvent({
  name: "kernel.outbox.recorded.v1",
  payload: z.object({ recordId: z.uuid() }),
});

const confirmed = defineEvent({
  name: "kernel.outbox.confirmed.v1",
  payload: z.object({ recordId: z.uuid() }),
});

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

function outboxCreateBody(): string {
  const match = productSql().match(/CREATE TABLE "app"\."outbox" \(([\s\S]*?)\);/);
  expect(match?.[1]).toEqual(expect.any(String));
  return match![1]!;
}

function adapterConstraintName(): string {
  const src = readFileSync(path.join(DIR, "../src/outbox-adapter.ts"), "utf8");
  const match = src.match(/ON CONFLICT ON CONSTRAINT ([A-Za-z_][\w$]*)/);
  expect(match?.[1]).toEqual(expect.any(String));
  return match![1]!;
}

function testModule(publishes: string[]) {
  return defineModule({
    key: "kernel_outbox_test",
    version: 1,
    requires: [],
    publishes,
    subscribes: [],
    ports: [],
  });
}

function publisher() {
  return bindPublisher(testModule([recorded.name, confirmed.name]), createOutbox());
}

describe("app.outbox", () => {
  beforeAll(async () => {
    const runtime = loadRuntime();
    await applyProductMigrations(runtime.directUrl);
    await applyTestMigrations({ mode: "test" }, runtime.directUrl);
  });

  it("declares all six columns NOT NULL in generated SQL", () => {
    const body = outboxCreateBody();
    for (const column of COLUMNS) {
      expect(body, column).toMatch(new RegExp(`"${column}"[^\\n]+NOT NULL`));
    }
    expect(body).not.toMatch(/community_id/);
  });

  it("has primary key (org_id, id) and unique (org_id, event_name, idempotency_key)", async () => {
    const runtime = loadRuntime();
    const sql = createDirectSql(runtime.directUrl);
    try {
      const rows = await sql<{ contype: string; def: string }[]>`
        select c.contype::text as contype, pg_get_constraintdef(c.oid) as def
        from pg_constraint c
        join pg_class rel on rel.oid = c.conrelid
        join pg_namespace n on n.oid = rel.relnamespace
        where n.nspname = 'app' and rel.relname = 'outbox' and c.contype in ('p', 'u')
        order by c.contype
      `;
      const pk = rows.find((row) => row.contype === "p");
      const unique = rows.find((row) => row.contype === "u");
      expect(pk?.def).toMatch(/PRIMARY KEY \(org_id, id\)/);
      expect(unique?.def).toMatch(/UNIQUE \(org_id, event_name, idempotency_key\)/);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("forces row level security and the policy uses app.org_id only", async () => {
    const runtime = loadRuntime();
    const sql = createDirectSql(runtime.directUrl);
    try {
      const [rel] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'outbox'
      `;
      expect(rel).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect(productSql()).toMatch(/ALTER TABLE "app"\."outbox" FORCE ROW LEVEL SECURITY/);

      const policies = await sql<{ using_expr: string; check_expr: string | null }[]>`
        select pg_get_expr(p.polqual, p.polrelid) as using_expr,
               pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
        from pg_policy p
        join pg_class rel on rel.oid = p.polrelid
        join pg_namespace n on n.oid = rel.relnamespace
        where n.nspname = 'app' and rel.relname = 'outbox'
      `;
      expect(policies.length).toBeGreaterThan(0);
      for (const policy of policies) {
        expect(policy.using_expr).toMatch(/current_setting\('app\.org_id'/);
        expect(policy.using_expr).not.toMatch(/community_id/);
        if (policy.check_expr !== null) {
          expect(policy.check_expr).toMatch(/current_setting\('app\.org_id'/);
          expect(policy.check_expr).not.toMatch(/community_id/);
        }
      }

      await sql.unsafe("set role migrator");
      await expect(sql`select * from app.outbox`).rejects.toThrow(
        /unrecognized configuration parameter "app\.org_id"/i,
      );
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("locks the unique constraint name to the adapter ON CONFLICT identifier", async () => {
    const runtime = loadRuntime();
    const sql = createDirectSql(runtime.directUrl);
    const expected = adapterConstraintName();
    try {
      const rows = await sql<{ conname: string }[]>`
        select c.conname
        from pg_constraint c
        join pg_class rel on rel.oid = c.conrelid
        join pg_namespace n on n.oid = rel.relnamespace
        where n.nspname = 'app' and rel.relname = 'outbox' and c.contype = 'u'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.conname).toBe(expected);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("refuses a cross-tenant insert and hides the row from another organisation", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgA = newId();
    const orgB = newId();
    const { publish } = publisher();
    const recordId = newId();
    try {
      await withRequest({ requestId: newId(), idempotencyKey: `cross-${orgA}` }, async () => {
        await withOrgTransaction(sql, orgA, async (tx) => {
          await publish(tx, recorded, { recordId });
        });
      });

      await withOrgTransaction(sql, orgB, async (tx) => {
        const hidden = await tx<{ id: string }[]>`select id from app.outbox`;
        expect(hidden).toHaveLength(0);
      });

      await expect(
        withOrgTransaction(sql, orgB, async (tx) => {
          await tx`
            insert into app.outbox (id, org_id, event_name, payload, idempotency_key)
            values (
              ${newId()},
              ${orgA}::uuid,
              ${recorded.name},
              ${JSON.stringify({ recordId: newId() })}::jsonb,
              ${"cross-tenant"}
            )
          `;
        }),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("returns the same id and keeps one row when the same event is published twice under one key", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const { publish } = publisher();
    const recordId = newId();
    const idempotencyKey = `retry-${orgId}`;
    try {
      const ids = await withRequest({ requestId: newId(), idempotencyKey }, async () => {
        return withOrgTransaction(sql, orgId, async (tx) => {
          const first = await publish(tx, recorded, { recordId });
          const second = await publish(tx, recorded, { recordId });
          return { first, second };
        });
      });
      expect(ids.first.id).toBe(ids.second.id);

      await withOrgTransaction(sql, orgId, async (tx) => {
        const rows = await tx<{ id: string; occurred_at: Date }[]>`
          select id, occurred_at from app.outbox
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(ids.first.id);
        expect(rows[0]?.occurred_at).toEqual(expect.any(Date));
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("inserts two rows when two events share a request key", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const { publish } = publisher();
    const idempotencyKey = `two-events-${orgId}`;
    try {
      await withRequest({ requestId: newId(), idempotencyKey }, async () => {
        await withOrgTransaction(sql, orgId, async (tx) => {
          await publish(tx, recorded, { recordId: newId() });
          await publish(tx, confirmed, { recordId: newId() });
        });
      });

      await withOrgTransaction(sql, orgId, async (tx) => {
        const rows = await tx<{ event_name: string }[]>`
          select event_name from app.outbox order by event_name
        `;
        expect(rows.map((row) => row.event_name)).toEqual([confirmed.name, recorded.name]);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("rolls back the outbox row together with the domain change", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const domainId = newId();
    const { publish } = publisher();
    try {
      await expect(
        withRequest({ requestId: newId(), idempotencyKey: `rollback-${orgId}` }, async () => {
          await withOrgTransaction(sql, orgId, async (tx) => {
            await publish(tx, recorded, { recordId: newId() });
            await tx`
              insert into app.synthetic (org_id, id)
              values (current_setting('app.org_id')::uuid, ${domainId})
            `;
            throw new Error("force rollback");
          });
        }),
      ).rejects.toThrow("force rollback");

      await withOrgTransaction(sql, orgId, async (tx) => {
        const outbox = await tx<{ n: string }[]>`select count(*)::text as n from app.outbox`;
        const domain = await tx<{ n: string }[]>`
          select count(*)::text as n from app.synthetic where id = ${domainId}
        `;
        expect(outbox[0]?.n).toBe("0");
        expect(domain[0]?.n).toBe("0");
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("commits the outbox row and the domain change together", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const domainId = newId();
    const { publish } = publisher();
    try {
      const published = await withRequest(
        { requestId: newId(), idempotencyKey: `commit-${orgId}` },
        async () => {
          return withOrgTransaction(sql, orgId, async (tx) => {
            const row = await publish(tx, recorded, { recordId: newId() });
            await tx`
              insert into app.synthetic (org_id, id)
              values (current_setting('app.org_id')::uuid, ${domainId})
            `;
            return row;
          });
        },
      );

      await withOrgTransaction(sql, orgId, async (tx) => {
        const outbox = await tx<{ id: string }[]>`select id from app.outbox`;
        const domain = await tx<{ id: string }[]>`
          select id from app.synthetic where id = ${domainId}
        `;
        expect(outbox).toEqual([{ id: published.id }]);
        expect(domain).toEqual([{ id: domainId }]);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("leaves no outbox row when the payload fails Zod parse", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const { publish } = publisher();
    try {
      await withRequest({ requestId: newId(), idempotencyKey: `zod-${orgId}` }, async () => {
        await withOrgTransaction(sql, orgId, async (tx) => {
          await expect(publish(tx, recorded, { recordId: "not-a-uuid" })).rejects.toThrow();
        });
      });

      await withOrgTransaction(sql, orgId, async (tx) => {
        const rows = await tx<{ n: string }[]>`select count(*)::text as n from app.outbox`;
        expect(rows[0]?.n).toBe("0");
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
