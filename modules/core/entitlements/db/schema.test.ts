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
    const schemaGrant = /\bGRANT\b[^;]*\bON\s+SCHEMA\s+platform\b[^;]*\bTO\s+(?:app|identity)\b/i;
    const objectGrant =
      /\bGRANT\b[^;]*\bON\s+(?:TABLE\s+)?(?:"platform"\.|platform\.)[^;]*\bTO\s+(?:app|identity)\b/i;
    const defaultGrant =
      /\bALTER\s+DEFAULT\s+PRIVILEGES\b[^;]*\bIN\s+SCHEMA\s+platform\b[^;]*\bTO\s+(?:app|identity)\b/i;
    for (const name of files) {
      const sql = readFileSync(path.join(DRIZZLE, name), "utf8");
      expect(sql, name).not.toMatch(schemaGrant);
      expect(sql, name).not.toMatch(objectGrant);
      expect(sql, name).not.toMatch(defaultGrant);
    }
  });
});
