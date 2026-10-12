import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "grants.ts"),
  "utf8",
);

describe("loadActor", () => {
  it("reads community grants for the current community only", () => {
    const start = source.indexOf("from app.community_role_grants");
    expect(start).toBeGreaterThanOrEqual(0);
    const query = source.slice(start, source.indexOf("`;", start));
    expect(query).toContain("and community_id = current_setting('app.community_id')::uuid");
    expect(query).not.toContain("custom_role_permissions");
  });
});
