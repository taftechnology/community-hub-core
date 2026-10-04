import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const mustFail = [
  "wrong-region",
  "encrypt-false",
  "missing-kms",
  "missing-lockfile",
  "commented-region",
  "missing-prevent-destroy",
  "missing-envelope-prevent-destroy",
] as const;

const mustPass = ["valid"] as const;

describe("terraform-invariants check fixtures", () => {
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

  it("reports a notice when no backend files exist yet", () => {
    const result = check(path.join(fixturesDir, "empty-tree"));
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.notice).toMatch(/zero/i);
  });
});
