import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DRIZZLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle",
);

const SCHEMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schema.ts");

function journalSql(): string {
  const files = readdirSync(DRIZZLE).filter(
    (name) => name.startsWith("0009_") && name.endsWith(".sql"),
  );
  expect(files).toHaveLength(1);
  const sql = readFileSync(path.join(DRIZZLE, files[0] ?? ""), "utf8");
  expect(sql).toContain('CREATE TABLE "platform"."plans"');
  expect(sql).not.toContain('CREATE TABLE "platform"."organisations"');
  expect(sql).not.toContain('"app".');
  expect(sql).not.toContain('"identity".');
  return sql;
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** True when SQL grants platform objects or default privileges to app or identity. */
function hasForbiddenPlatformGrant(sql: string): boolean {
  const text = stripSqlComments(sql);
  const schemaGrant =
    /\bGRANT\b[^;]*\bON\s+SCHEMA\s+platform\b[^;]*\bTO\b[^;]*\b(?:app|identity)\b/i;
  const allInSchemaGrant =
    /\bGRANT\b[^;]*\bON\s+ALL\s+(?:TABLES|SEQUENCES|FUNCTIONS)\s+IN\s+SCHEMA\s+platform\b[^;]*\bTO\b[^;]*\b(?:app|identity)\b/i;
  const objectGrant =
    /\bGRANT\b[^;]*\bON\s+(?:TABLE\s+)?(?:"platform"\.|platform\.)[^;]*\bTO\b[^;]*\b(?:app|identity)\b/i;
  const defaultGrant =
    /\bALTER\s+DEFAULT\s+PRIVILEGES\b[^;]*\bIN\s+SCHEMA\s+platform\b[^;]*\bTO\b[^;]*\b(?:app|identity)\b/i;
  return (
    schemaGrant.test(text) ||
    allInSchemaGrant.test(text) ||
    objectGrant.test(text) ||
    defaultGrant.test(text)
  );
}

describe("entitlement platform tables", () => {
  it("adds tables without org_id, row level security, or inserts", () => {
    const sql = journalSql();
    expect(sql).not.toMatch(/org_id/);
    expect(sql).not.toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).not.toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).not.toMatch(/insert/i);
    expect(sql).toContain("NULLS NOT DISTINCT");
    expect(sql).toMatch(/on delete restrict/i);
    expect(sql).toMatch(/"enabled" = false/);
  });

  it("does not declare the platform schema itself", () => {
    expect(readFileSync(SCHEMA, "utf8")).not.toContain("pgSchema");
  });

  it("fails on a platform grant to app or identity", () => {
    const files = readdirSync(DRIZZLE).filter((name) => name.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const sql = readFileSync(path.join(DRIZZLE, name), "utf8");
      expect(hasForbiddenPlatformGrant(sql), name).toBe(false);
    }

    const reported = [
      "GRANT ALL ON ALL TABLES IN SCHEMA platform TO app;",
      "GRANT SELECT ON ALL SEQUENCES IN SCHEMA platform TO identity;",
      "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA platform TO app;",
      "GRANT SELECT ON TABLE platform.plans TO app;",
      "GRANT SELECT ON TABLE platform.plans\nTO identity;",
      "GRANT SELECT ON TABLE platform.plans TO identity, app;",
      "ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT SELECT ON TABLES TO app;",
      "GRANT USAGE ON SCHEMA platform TO app;",
    ];
    for (const sql of reported) {
      expect(hasForbiddenPlatformGrant(sql), sql).toBe(true);
    }

    const ignored = [
      "GRANT ALL ON ALL TABLES IN SCHEMA platform TO platform;",
      "GRANT USAGE ON SCHEMA app TO app;",
      "GRANT SELECT ON TABLE app.persons TO app;",
      "-- GRANT ALL ON ALL TABLES IN SCHEMA platform TO app;",
      "/* GRANT SELECT ON TABLE platform.plans TO identity */\nSELECT 1;",
    ];
    for (const sql of ignored) {
      expect(hasForbiddenPlatformGrant(sql), sql).toBe(false);
    }
  });
});
