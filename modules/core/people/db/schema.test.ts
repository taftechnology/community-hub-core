import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DRIZZLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle",
);

const TABLES = [
  "organisation_keys",
  "community_keys",
  "household_keys",
  "households",
  "persons",
  "guardian_links",
  "person_tags",
  "person_tag_links",
  "person_activity",
] as const;

const CIPHERTEXT = new Set([
  "given_name_restricted",
  "family_name_restricted",
  "date_of_birth",
  "email",
  "phone",
  "label",
]);

function peopleSql(): string {
  const files = readdirSync(DRIZZLE).filter((name) => name.endsWith(".sql"));
  const matches = files.filter((name) => {
    const text = readFileSync(path.join(DRIZZLE, name), "utf8");
    return text.includes('CREATE TABLE "app"."persons"');
  });
  expect(matches).toHaveLength(1);
  return readFileSync(path.join(DRIZZLE, matches[0] ?? ""), "utf8");
}

function createBody(sql: string, table: string): string {
  const marker = `CREATE TABLE "app"."${table}"`;
  const start = sql.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
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

function indexedColumns(statement: string): string[] {
  const on = statement.match(/ON\s+"app"\."[^"]+"\s+(?:USING\s+\w+\s+)?\(([^)]*)\)/i);
  if (on?.[1] === undefined) {
    return [];
  }
  return [...on[1].matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("people app tables", () => {
  it("forces row level security and keeps organisation keys free of community_id", () => {
    const sql = peopleSql();
    for (const table of TABLES) {
      expect(sql).toContain(`CREATE TABLE "app"."${table}"`);
    }
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(TABLES.length);
    expect(sql).toContain("current_setting('app.org_id')");
    expect(sql).toContain("current_setting('app.community_id')");
    const communityPolicies = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.includes('CREATE POLICY "community_isolation"'));
    expect(communityPolicies).toHaveLength(TABLES.length - 1);
    for (const statement of communityPolicies) {
      const splitAt = statement.indexOf(" WITH CHECK ");
      expect(splitAt).toBeGreaterThan(0);
      const using = statement.slice(0, splitAt);
      const check = statement.slice(splitAt + " WITH CHECK ".length);
      expect(using).toContain("USING (");
      for (const clause of [using, check]) {
        expect(clause).toContain(`"org_id" = current_setting('app.org_id')`);
        expect(clause).toContain(`"community_id" = current_setting('app.community_id')`);
      }
    }
    expect(createBody(sql, "organisation_keys")).not.toContain("community_id");
    for (const table of TABLES) {
      if (table === "organisation_keys") {
        continue;
      }
      expect(createBody(sql, table)).toContain("community_id");
    }
    expect(sql).toContain("app.community_id");
    expect(sql).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app\.persons FROM app/);
    expect(sql).not.toContain("ON DELETE CASCADE");
    expect(sql).not.toContain("DEFAULT");

    const indexes = sql
      .split("--> statement-breakpoint")
      .filter((statement) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(statement));
    for (const statement of indexes) {
      for (const column of indexedColumns(statement)) {
        expect(CIPHERTEXT.has(column)).toBe(false);
      }
    }
  });
});
