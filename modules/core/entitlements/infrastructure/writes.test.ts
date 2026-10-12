import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "writes.ts"),
  "utf8",
);

describe("plan write source", () => {
  it("does not set a session variable, audit, or touch the app schema", () => {
    expect(source).not.toContain("set_config");
    expect(source).not.toContain("appendAuditEvent");
    expect(source).not.toContain("app.");
  });
});
