import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const mustFail = ["order-by-encrypted", "where-encrypted"] as const;
const mustPass = ["valid"] as const;

describe("encrypted-query check fixtures", () => {
  for (const name of mustFail) {
    it(`fails fixture ${name}`, () => {
      const result = check(path.join(fixturesDir, name));
      expect(result.ok, `expected violations: ${JSON.stringify(result.violations)}`).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  }

  for (const name of mustPass) {
    it(`passes fixture ${name}`, () => {
      const result = check(path.join(fixturesDir, name));
      expect(result.ok, `unexpected violations: ${JSON.stringify(result.violations)}`).toBe(true);
      expect(result.violations).toEqual([]);
    });
  }

  it("reports zero query SQL files when none are present under the provisional glob", () => {
    const result = check(path.join(fixturesDir, "empty-tree"));
    expect(result.ok).toBe(true);
    expect(result.queryFileCount).toBe(0);
    expect(result.notice).toMatch(/zero/i);
  });
});
