import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "keys.ts"),
  "utf8",
);

describe("organisation key source", () => {
  it("does not set config, cache keys, or log", () => {
    expect(source).not.toContain("set_" + "config");
    expect(source).not.toMatch(/\bSET\b/);
    expect(source).not.toContain("new Map");
    expect(source).not.toContain("console.");
    expect(source).not.toContain("logger");
  });
});
