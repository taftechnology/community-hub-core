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
});
