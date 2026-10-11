import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "implicit-organisation.ts"),
  "utf8",
);

describe("implicit organisation source", () => {
  it("does not set a session variable", () => {
    expect(source).not.toMatch(/set_config/);
    expect(source).not.toMatch(/\bSET\b/);
  });
});
