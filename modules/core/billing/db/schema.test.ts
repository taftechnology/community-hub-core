import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DRIZZLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle",
);

function migration0010(): { name: string; sql: string } {
  const files = readdirSync(DRIZZLE).filter(
    (name) => name.startsWith("0010_") && name.endsWith(".sql"),
  );
  expect(files).toHaveLength(1);
  const name = files[0]!;
  const sql = readFileSync(path.join(DRIZZLE, name), "utf8");
  return { name, sql };
}

describe("0010 migration text checks", () => {
  it("enforces append-only settings, seed insert, no grants, no app tables, and breakpoints", () => {
    const { sql } = migration0010();

    // The REVOKE is present
    expect(sql).toContain(
      "REVOKE UPDATE, DELETE, TRUNCATE ON platform.billing_settings FROM platform;",
    );

    // Exactly one INSERT, into billing_settings
    const inserts = sql.match(/\bINSERT\s+INTO\b/gi) ?? [];
    expect(inserts).toHaveLength(1);
    expect(sql).toMatch(/INSERT\s+INTO\s+"?platform"?\."?billing_settings"?/i);

    // There is no GRANT
    expect(sql).not.toMatch(/\bGRANT\b/i);

    // No app. table is touched
    expect(sql).not.toMatch(/"?app"?\./i);

    // Hand-written statements each separated by a breakpoint
    const tailIndex = sql.indexOf(
      "REVOKE UPDATE, DELETE, TRUNCATE ON platform.billing_settings FROM platform;",
    );
    expect(tailIndex).toBeGreaterThan(-1);
    const tail = sql.slice(tailIndex);
    const statements = tail
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(4);
  });
});
