import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DRIZZLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle",
);

function platformSql(): string {
  const files = readdirSync(DRIZZLE).filter((name) => name.endsWith(".sql"));
  const matches = files.filter((name) => {
    const text = readFileSync(path.join(DRIZZLE, name), "utf8");
    return text.includes('CREATE TABLE "platform"."organisations"');
  });
  expect(matches).toHaveLength(1);
  return readFileSync(path.join(DRIZZLE, matches[0] ?? ""), "utf8");
}

describe("platform organisation tables", () => {
  it("creates both tables without org_id or row level security", () => {
    const sql = platformSql();
    expect(sql).toContain('CREATE TABLE "platform"."organisations"');
    expect(sql).toContain('CREATE TABLE "platform"."communities"');
    expect(sql).toContain("organisations_slug_unique");
    expect(sql).toContain("communities_slug_unique");
    expect(sql).toContain("communities_organisation_id_idx");
    expect(sql).toContain("organisation_id");
    expect(sql.match(/\[a-z0-9\]\(\?:\[a-z0-9-\]\{0,61\}\[a-z0-9\]\)\?/g)).toHaveLength(2);
    expect(sql).toContain("'au'");
    expect(sql).toContain("'implicit'");
    expect(sql).toContain("'explicit'");
    expect(sql).not.toMatch(/\borg_id\b/);
    expect(sql).not.toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).not.toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).not.toContain("ON DELETE CASCADE");
    expect(sql).not.toContain("DEFAULT");
  });
});
