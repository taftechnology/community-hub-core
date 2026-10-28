import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { pgSchema } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { usageTables } from "./schema.js";

const DRIZZLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle",
);

const SCHEMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schema.ts");

function usageSql(): string {
  const files = readdirSync(DRIZZLE).filter((name) => name.endsWith(".sql"));
  const matches = files.filter((name) => {
    const text = readFileSync(path.join(DRIZZLE, name), "utf8");
    return text.includes('CREATE TABLE "app"."usage_facts_daily"');
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

describe("usage_facts_daily schema", () => {
  it("exact column list", () => {
    const table = usageTables(pgSchema("app")).usageFactsDaily;
    const columnNames = Object.values(getTableColumns(table)).map((c) => c.name);
    expect(columnNames).toEqual(["org_id", "community_id", "feature_key", "day", "success_count"]);

    const sql = usageSql();
    const body = createBody(sql, "usage_facts_daily");
    const sqlColumns = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"') && !line.startsWith("CONSTRAINT"))
      .map((line) => line.match(/^"([^"]+)"/)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(sqlColumns).toEqual(["org_id", "community_id", "feature_key", "day", "success_count"]);
  });

  it("defines the primary key in exact order starting with org_id", () => {
    const sql = usageSql();
    expect(sql).toContain(
      'CONSTRAINT "usage_facts_daily_org_id_community_id_feature_key_day_pk" PRIMARY KEY("org_id","community_id","feature_key","day")',
    );
  });

  it("pins the policy text", () => {
    const sql = usageSql();
    const statements = policyStatements(sql, "usage_facts_daily");
    expect(statements).toHaveLength(1);
    const match = (statements[0] ?? "").match(
      /^CREATE POLICY "community_isolation" ON "app"\."usage_facts_daily" AS PERMISSIVE FOR ALL TO public USING \((.*?)\) WITH CHECK \((.*)\);?$/,
    );
    expect(match, "usage_facts_daily policy shape").not.toBeNull();
    const expectedPredicate = `"app"."usage_facts_daily"."org_id" = current_setting('app.org_id')::uuid and "app"."usage_facts_daily"."community_id" = current_setting('app.community_id')::uuid`;
    expect(match?.[1], "usage_facts_daily USING").toBe(expectedPredicate);
    expect(match?.[2], "usage_facts_daily WITH CHECK").toBe(expectedPredicate);
  });

  it("pins the CHECK constraints", () => {
    const sql = usageSql();
    expect(sql).toContain(
      'CONSTRAINT "usage_facts_daily_feature_key" CHECK (char_length("app"."usage_facts_daily"."feature_key") between 1 and 64 and "app"."usage_facts_daily"."feature_key" ~ \'^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$\')',
    );
    expect(sql).toContain(
      'CONSTRAINT "usage_facts_daily_success_count" CHECK ("app"."usage_facts_daily"."success_count" >= 1)',
    );
  });

  it("forces row level security and revokes DELETE and TRUNCATE from app", () => {
    const sql = usageSql();
    expect(sql).toContain('ALTER TABLE "app"."usage_facts_daily" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "app"."usage_facts_daily" FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain("REVOKE DELETE, TRUNCATE ON TABLE app.usage_facts_daily FROM app;");
  });

  it("does not declare the app schema itself", () => {
    expect(readFileSync(SCHEMA, "utf8")).not.toContain("pgSchema(");
  });
});
