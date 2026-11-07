import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { pgSchema } from "drizzle-orm/pg-core";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, withAppTransaction } from "@community-hub/db";
import { createPlaintextAppSql, createPlaintextDirectSql } from "@community-hub/db/plaintext";

import { engagementTables } from "./schema.js";

const DRIZZLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle",
);

const SCHEMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schema.ts");

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "identity" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

function engagementMigrationSql(): string {
  const files = readdirSync(DRIZZLE).filter((name) => name.endsWith(".sql"));
  const matches = files.filter((name) => {
    const text = readFileSync(path.join(DRIZZLE, name), "utf8");
    return text.includes('CREATE TABLE "app"."service_times"');
  });
  expect(matches).toHaveLength(1);
  return readFileSync(path.join(DRIZZLE, matches[0] ?? ""), "utf8");
}

function createBody(sql: string, table: string): string {
  const marker = `CREATE TABLE "app"."${table}"`;
  const start = sql.indexOf(marker);
  expect(start, table).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("(", start);
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === "(") {
      depth += 1;
    } else if (sql[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return sql.slice(open + 1, i);
      }
    }
  }
  throw new Error(`unclosed create table ${table}`);
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function policyStatements(sql: string, table: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => normalise(statement))
    .filter(
      (statement) =>
        statement.startsWith(`CREATE POLICY `) && statement.includes(` ON "app"."${table}" `),
    );
}

const DB_PACKAGE_NAME = "@community-hub/" + "db";

export function hasDbImportOrExport(
  source: string,
  packageName: string = DB_PACKAGE_NAME,
): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b(?:import|export)\\s+(?!type\\b)(?:(?!\\bfrom\\b)[^;'"])*?\\bfrom\\s+['"]${escaped}(?:\\/[^'"]*)?['"]|\\bimport\\s+['"]${escaped}(?:\\/[^'"]*)?['"]`,
    "m",
  );
  return pattern.test(source);
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

describe("engagement service_times schema and privileges", () => {
  it("has exact column list for service_times with expected types (pin 13)", () => {
    const tables = engagementTables(pgSchema("app"));
    const serviceTimesCols = Object.values(getTableColumns(tables.serviceTimes)).map((c) => c.name);
    expect(serviceTimesCols).toEqual([
      "org_id",
      "community_id",
      "content_html",
      "version",
      "created_at",
      "updated_at",
    ]);

    const sql = engagementMigrationSql();
    const serviceTimesBody = createBody(sql, "service_times");
    const sqlCols = serviceTimesBody
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"') && !line.startsWith("CONSTRAINT"))
      .map((line) => line.match(/^"([^"]+)"/)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(sqlCols).toEqual(serviceTimesCols);
  });

  it("pins primary key (org_id, community_id) starting with org_id", () => {
    const sql = engagementMigrationSql();
    expect(sql).toContain(
      'CONSTRAINT "service_times_org_id_community_id_pk" PRIMARY KEY("org_id","community_id")',
    );
  });

  it("pins the CHECK constraint for content_html length <= 20000", () => {
    const sql = engagementMigrationSql();
    expect(sql).toMatch(
      /CONSTRAINT "service_times_content_html_len" CHECK \(char_length\("app"\."service_times"\."content_html"\) <= 20000\)/,
    );
  });

  it("pins the policy text (pin 13)", () => {
    const sql = engagementMigrationSql();
    const statements = policyStatements(sql, "service_times");
    expect(statements).toHaveLength(1);
    const match = (statements[0] ?? "").match(
      new RegExp(
        `^CREATE POLICY "community_isolation" ON "app"\\."service_times" AS PERMISSIVE FOR ALL TO public USING \\((.*?)\\) WITH CHECK \\((.*)\\);?$`,
      ),
    );
    expect(match, "service_times policy shape").not.toBeNull();
    const expected = `"app"."service_times"."org_id" = current_setting('app.org_id')::uuid and "app"."service_times"."community_id" = current_setting('app.community_id')::uuid`;
    expect(match?.[1], "service_times USING").toBe(expected);
    expect(match?.[2], "service_times WITH CHECK").toBe(expected);
    expect(match?.[1]).toBe(match?.[2]);
  });

  it("has FORCE ROW LEVEL SECURITY in migration and relforcerowsecurity true on live table (pin 13)", async () => {
    const sql = engagementMigrationSql();
    expect(sql).toContain('ALTER TABLE "app"."service_times" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "app"."service_times" FORCE ROW LEVEL SECURITY;');

    const runtime = loadRuntime();
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const [rel] = await directSql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'service_times'
      `;
      expect(rel, "service_times RLS").toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    } finally {
      await directSql.end({ timeout: 1 });
    }
  });

  it("contains the three literal grant statements in migration SQL (pins 14 and 15)", () => {
    const sql = engagementMigrationSql();
    expect(sql).toContain("REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app.service_times FROM app;");
    expect(sql).toContain("GRANT SELECT, INSERT ON app.service_times TO app;");
    expect(sql).toContain(
      "GRANT UPDATE (content_html, version, updated_at) ON app.service_times TO app;",
    );
  });

  it("against live test DB: app cannot TRUNCATE or DELETE FROM service_times (pin 15)", async () => {
    const runtime = loadRuntime();
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      expect(await privilege(directSql, "app", "service_times", "TRUNCATE")).toBe(false);
      expect(await privilege(directSql, "app", "service_times", "DELETE")).toBe(false);
      expect(await privilege(directSql, "app", "service_times", "SELECT")).toBe(true);
      expect(await privilege(directSql, "app", "service_times", "INSERT")).toBe(true);
    } finally {
      await directSql.end({ timeout: 1 });
    }
  });

  it("against live test DB: UPDATE works only on content_html, version, updated_at (pin 14)", async () => {
    const runtime = loadRuntime();
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const updatable = ["content_html", "version", "updated_at"] as const;
      const nonUpdatable = ["org_id", "community_id", "created_at"] as const;

      for (const col of updatable) {
        const [row] = await directSql<{ granted: boolean }[]>`
          select has_column_privilege('app', 'app.service_times', ${col}, 'UPDATE') as granted
        `;
        expect(row?.granted, `expected column ${col} to be updatable by app`).toBe(true);
      }

      for (const col of nonUpdatable) {
        const [row] = await directSql<{ granted: boolean }[]>`
          select has_column_privilege('app', 'app.service_times', ${col}, 'UPDATE') as granted
        `;
        expect(row?.granted, `expected column ${col} NOT to be updatable by app`).toBe(false);
      }

      const updatableRows = await directSql<{ attname: string }[]>`
        select attname
        from pg_attribute
        where attrelid = 'app.service_times'::regclass
          and attnum > 0
          and not attisdropped
          and has_column_privilege('app', 'app.service_times', attname, 'UPDATE')
        order by attname
      `;
      expect(updatableRows.map((r) => r.attname).sort()).toEqual([...updatable].sort());
    } finally {
      await directSql.end({ timeout: 1 });
    }
  });

  it("against live test DB: identity and platform have no privileges on service_times", async () => {
    const runtime = loadRuntime();
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      for (const role of ["identity", "platform"] as const) {
        for (const kind of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const) {
          expect(
            await privilege(directSql, role, "service_times", kind),
            `${role} ${kind} on service_times`,
          ).toBe(false);
        }
      }
    } finally {
      await directSql.end({ timeout: 1 });
    }
  });

  it("enforces content_html length check (<= 20000) at the database level", async () => {
    const runtime = loadRuntime();
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const orgId = "44444444-4444-4444-8444-444444444444";
    const commId = "55555555-5555-4555-8555-555555555555";
    try {
      await directSql`insert into platform.organisations (id, slug, region, kind) values (${orgId}, 'len-check-org', 'au', 'implicit') on conflict do nothing`;
      await directSql`insert into platform.communities (id, organisation_id, slug, region) values (${commId}, ${orgId}, 'len-check-comm', 'au') on conflict do nothing`;

      // 20000 characters should succeed
      const okText = "x".repeat(20000);
      await directSql`
        insert into app.service_times (org_id, community_id, content_html, created_at, updated_at)
        values (${orgId}, ${commId}, ${okText}, now(), now())
      `;

      // 20001 characters should fail with check constraint violation (code 23514)
      const tooLongText = "x".repeat(20001);
      const commId2 = "66666666-6666-4666-8666-666666666666";
      await directSql`insert into platform.communities (id, organisation_id, slug, region) values (${commId2}, ${orgId}, 'len-check-comm-2', 'au') on conflict do nothing`;

      await expect(
        directSql`
          insert into app.service_times (org_id, community_id, content_html, created_at, updated_at)
          values (${orgId}, ${commId2}, ${tooLongText}, now(), now())
        `,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await directSql`delete from app.service_times where org_id = ${orgId}`.catch(() => {});
      await directSql`delete from platform.communities where organisation_id = ${orgId}`.catch(
        () => {},
      );
      await directSql`delete from platform.organisations where id = ${orgId}`.catch(() => {});
      await directSql.end({ timeout: 1 });
    }
  });

  it("enforces tenant isolation across organisations and communities (pin 13)", async () => {
    const runtime = loadRuntime();
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));

    const org1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const org1Comm1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const org1Comm2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    const org2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const org2Comm1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    try {
      await directSql`insert into platform.organisations (id, slug, region, kind) values (${org1}, 'iso-org-1', 'au', 'implicit') on conflict do nothing`;
      await directSql`insert into platform.communities (id, organisation_id, slug, region) values (${org1Comm1}, ${org1}, 'iso-comm-1-1', 'au') on conflict do nothing`;
      await directSql`insert into platform.communities (id, organisation_id, slug, region) values (${org1Comm2}, ${org1}, 'iso-comm-1-2', 'au') on conflict do nothing`;

      await directSql`insert into platform.organisations (id, slug, region, kind) values (${org2}, 'iso-org-2', 'au', 'implicit') on conflict do nothing`;
      await directSql`insert into platform.communities (id, organisation_id, slug, region) values (${org2Comm1}, ${org2}, 'iso-comm-2-1', 'au') on conflict do nothing`;

      // Scope 1: org1, comm1 inserts row
      await withAppTransaction(appSql, { orgId: org1, communityId: org1Comm1 }, async (tx) => {
        await tx`
          insert into app.service_times (org_id, community_id, content_html, created_at, updated_at)
          values (current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid, 'org1-comm1 content', now(), now())
        `;
      });

      // Scope 2: org1, comm2 (same org, different community) cannot see or update org1, comm1 row
      await withAppTransaction(appSql, { orgId: org1, communityId: org1Comm2 }, async (tx) => {
        const rows = await tx<
          { content_html: string }[]
        >`select content_html from app.service_times`;
        expect(rows).toHaveLength(0);

        const updated = await tx<{ org_id: string }[]>`
          update app.service_times set content_html = 'hacked' where org_id = ${org1}::uuid returning org_id
        `;
        expect(updated).toHaveLength(0);
      });

      // Scope 3: org2, comm1 (different org) cannot see or update org1, comm1 row
      await withAppTransaction(appSql, { orgId: org2, communityId: org2Comm1 }, async (tx) => {
        const rows = await tx<
          { content_html: string }[]
        >`select content_html from app.service_times`;
        expect(rows).toHaveLength(0);

        const updated = await tx<{ org_id: string }[]>`
          update app.service_times set content_html = 'hacked' where org_id = ${org1}::uuid returning org_id
        `;
        expect(updated).toHaveLength(0);
      });

      // Verify org1, comm1 content remains intact
      await withAppTransaction(appSql, { orgId: org1, communityId: org1Comm1 }, async (tx) => {
        const rows = await tx<
          { content_html: string }[]
        >`select content_html from app.service_times`;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.content_html).toBe("org1-comm1 content");
      });
    } finally {
      await directSql`delete from app.service_times where org_id in (${org1}, ${org2})`.catch(
        () => {},
      );
      await directSql`delete from platform.communities where organisation_id in (${org1}, ${org2})`.catch(
        () => {},
      );
      await directSql`delete from platform.organisations where id in (${org1}, ${org2})`.catch(
        () => {},
      );
      await appSql.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("has no pgSchema and no db import in the schema source (pin 27)", () => {
    const text = readFileSync(SCHEMA, "utf8");
    expect(text).not.toContain("pgSchema(");
    expect(hasDbImportOrExport(text)).toBe(false);
  });
});
