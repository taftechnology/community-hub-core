import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "holds-permission.ts"),
  "utf8",
);

describe("holdsPermission source", () => {
  it("does not audit, insert, or set a session variable", () => {
    expect(source).not.toContain("appendAuditEvent");
    expect(source).not.toContain("insert");
    expect(source).not.toContain("set_config");
  });

  it("pins the organisation predicate on every grant query", () => {
    const predicate = "org_id = current_setting('app.org_id')";
    expect(source).toContain(predicate);
    const occurrences = source.split(predicate).length - 1;
    expect(occurrences).toBe(3);
    expect(source).toMatch(
      /from app\.organisation_role_grants[\s\S]*?org_id = current_setting\('app\.org_id'\)/,
    );
    expect(source).toMatch(
      /from app\.community_role_grants[\s\S]*?org_id = current_setting\('app\.org_id'\)/,
    );
    expect(source).toMatch(/custom_roles\.org_id = current_setting\('app\.org_id'\)/);
  });
});
