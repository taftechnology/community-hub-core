import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, withAppTransaction } from "@community-hub/db";
import { createPlaintextAppSql, createPlaintextDirectSql } from "@community-hub/db/plaintext";

import { createSyntheticScopes } from "../test/fixtures/scopes.js";

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

type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE";

async function privilege(
  sql: ReturnType<typeof createPlaintextDirectSql>,
  role: "app" | "identity" | "platform",
  table: string,
  kind: Privilege,
): Promise<boolean> {
  const rows = await sql<{ granted: boolean }[]>`
    select has_table_privilege(${role}, ${`app.${table}`}, ${kind}) as granted
  `;
  return rows[0]?.granted ?? false;
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

describe("usage_facts_daily schema and privileges", () => {
  it("forces row level security", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const [rel] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'usage_facts_daily'
      `;
      expect(rel).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("pins the live constraints and policy after every migration", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const constraints = await sql<{ conname: string; def: string }[]>`
        select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
        where conrelid = 'app.usage_facts_daily'::regclass
        order by conname
      `;
      const policies = await sql<
        {
          policyname: string;
          permissive: string;
          roles: string[];
          cmd: string;
          qual: string;
          with_check: string;
        }[]
      >`
        select policyname, permissive, roles, cmd, qual, with_check
        from pg_policies
        where schemaname = 'app' and tablename = 'usage_facts_daily'
      `;
      expect(constraints).toEqual([
        {
          conname: "usage_facts_daily_feature_key",
          def: "CHECK ((((char_length(feature_key) >= 1) AND (char_length(feature_key) <= 64)) AND (feature_key ~ '^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$'::text)))",
        },
        {
          conname: "usage_facts_daily_org_id_community_id_feature_key_day_pk",
          def: "PRIMARY KEY (org_id, community_id, feature_key, day)",
        },
        {
          conname: "usage_facts_daily_success_count",
          def: "CHECK ((success_count >= 1))",
        },
      ]);
      expect(policies).toEqual([
        {
          policyname: "community_isolation",
          permissive: "PERMISSIVE",
          roles: ["public"],
          cmd: "ALL",
          qual: "((org_id = (current_setting('app.org_id'::text))::uuid) AND (community_id = (current_setting('app.community_id'::text))::uuid))",
          with_check:
            "((org_id = (current_setting('app.org_id'::text))::uuid) AND (community_id = (current_setting('app.community_id'::text))::uuid))",
        },
      ]);
      expect(policies[0]?.with_check).toBe(policies[0]?.qual);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("the app role cannot delete usage facts", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const scopes = createSyntheticScopes();
    try {
      await expect(
        withAppTransaction(appSql, scopes.orgA.community1, async (tx) => {
          await tx`delete from app.usage_facts_daily`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await appSql.end({ timeout: 1 });
    }
  });

  it("gives app select, insert and update, but takes delete and truncate", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      expect(await privilege(sql, "app", "usage_facts_daily", "SELECT")).toBe(true);
      expect(await privilege(sql, "app", "usage_facts_daily", "INSERT")).toBe(true);
      expect(await privilege(sql, "app", "usage_facts_daily", "UPDATE")).toBe(true);
      expect(await privilege(sql, "app", "usage_facts_daily", "DELETE")).toBe(false);
      expect(await privilege(sql, "app", "usage_facts_daily", "TRUNCATE")).toBe(false);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("gives identity and platform no privileges on usage_facts_daily", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      for (const role of ["identity", "platform"] as const) {
        for (const kind of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const) {
          expect(await privilege(sql, role, "usage_facts_daily", kind), `${role} ${kind}`).toBe(
            false,
          );
        }
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("allows select and insert under a tenant scope", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scopes = createSyntheticScopes();
    const scope = scopes.orgA.community1;
    try {
      await withAppTransaction(appSql, scope, async (tx) => {
        await tx`
          insert into app.usage_facts_daily (org_id, community_id, feature_key, day, success_count)
          values (current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid, 'people.directory', '2026-10-28', 1)
        `;
        const rows = await tx<{ feature_key: string; success_count: number }[]>`
          select feature_key, success_count from app.usage_facts_daily
        `;
        expect(rows).toEqual([{ feature_key: "people.directory", success_count: 1 }]);
      });
    } finally {
      try {
        await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`;
      } finally {
        await directSql.end({ timeout: 1 });
        await appSql.end({ timeout: 1 });
      }
    }
  });
});
