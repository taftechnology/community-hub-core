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

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function expectedPredicate(table: string): string {
  const org = `"app"."${table}"."org_id" = current_setting('app.org_id')::uuid`;
  if (table === "organisation_keys") {
    return org;
  }
  return `${org} and "app"."${table}"."community_id" = current_setting('app.community_id')::uuid`;
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

function hasDbImportOrExport(source: string, packageName: string = DB_PACKAGE_NAME): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b(?:import|export)\\s+(?!type\\b)(?:(?!\\bfrom\\b)[^;'"])*?\\bfrom\\s+['"]${escaped}(?:\\/[^'"]*)?['"]|\\bimport\\s+['"]${escaped}(?:\\/[^'"]*)?['"]`,
    "m",
  );
  return pattern.test(source);
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

  it("pins every policy's USING and WITH CHECK to the exact tenant predicate", () => {
    const sql = peopleSql();
    const allPolicies = sql
      .split("--> statement-breakpoint")
      .map((statement) => normalise(statement))
      .filter((statement) => statement.startsWith("CREATE POLICY "));
    expect(allPolicies).toHaveLength(TABLES.length);
    for (const table of TABLES) {
      const statements = policyStatements(sql, table);
      expect(statements, table).toHaveLength(1);
      const name = table === "organisation_keys" ? "tenant_isolation" : "community_isolation";
      const match = (statements[0] ?? "").match(
        new RegExp(
          `^CREATE POLICY "${name}" ON "app"\\."${table}" AS PERMISSIVE FOR ALL TO public USING \\((.*?)\\) WITH CHECK \\((.*)\\);?$`,
        ),
      );
      expect(match, `${table} policy shape`).not.toBeNull();
      expect(match?.[1], `${table} USING`).toBe(expectedPredicate(table));
      expect(match?.[2], `${table} WITH CHECK`).toBe(expectedPredicate(table));
    }
  });

  it("defines persons.version as integer not null default 1 in schema and 0015 migration", () => {
    const schemaSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schema.ts"),
      "utf8",
    );
    expect(schemaSource).toMatch(
      /version:\s*integer\(["']version["']\)\.notNull\(\)\.default\(1\)/,
    );

    const files = readdirSync(DRIZZLE).filter(
      (name) => name.startsWith("0015_") && name.endsWith(".sql"),
    );
    expect(files).toHaveLength(1);
    const sql = readFileSync(path.join(DRIZZLE, files[0] ?? ""), "utf8");
    expect(sql).toMatch(
      /ALTER TABLE "app"\."persons" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;/,
    );
  });

  it("defines households.version as integer not null default 1 in schema and 0016 migration", () => {
    const schemaSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schema.ts"),
      "utf8",
    );
    expect(schemaSource).toMatch(
      /const households = app[\s\S]*?version:\s*integer\(["']version["']\)\.notNull\(\)\.default\(1\)/,
    );

    const files = readdirSync(DRIZZLE).filter(
      (name) => name.startsWith("0016_") && name.endsWith(".sql"),
    );
    expect(files).toHaveLength(1);
    const sql = readFileSync(path.join(DRIZZLE, files[0] ?? ""), "utf8");
    expect(sql).toMatch(
      /ALTER TABLE "app"\."households" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;/,
    );
  });

  it("has no pgSchema and no db value import in schema.ts (Pin 18)", () => {
    const schemaSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schema.ts"),
      "utf8",
    );
    expect(schemaSource).not.toContain("pgSchema(");
    expect(hasDbImportOrExport(schemaSource)).toBe(false);
  });

  it("defines life_events in schema and 0017 migration (Pin 1, 2)", () => {
    const schemaSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schema.ts"),
      "utf8",
    );
    expect(schemaSource).toMatch(/const lifeEvents = app[\s\S]*?table\(\s*["']life_events["']/);

    const files = readdirSync(DRIZZLE).filter(
      (name) => name.startsWith("0017_") && name.endsWith(".sql"),
    );
    expect(files).toHaveLength(1);
    const sql = readFileSync(path.join(DRIZZLE, files[0] ?? ""), "utf8");
    expect(sql).toContain('CREATE TABLE "app"."life_events"');
    expect(sql).toMatch(/ALTER TABLE "app"\."life_events" FORCE ROW LEVEL SECURITY;/);
    expect(sql).toContain('CONSTRAINT "life_events_org_id_id_pk" PRIMARY KEY("org_id","id")');
    expect(sql).toMatch(
      /CREATE INDEX "life_events_person_idx" ON "app"\."life_events" USING btree \("org_id","person_id"\);/,
    );
    expect(sql).toContain("GRANT SELECT, INSERT ON app.life_events TO app;");
    expect(sql).toContain(
      "GRANT UPDATE (event_type, event_date, place, notes, version) ON app.life_events TO app;",
    );
    expect(sql).not.toContain("GRANT DELETE ON app.life_events TO app");
  });
});
