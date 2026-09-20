import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const mustFail = [
  "empty-tree",
  "missing-catalog",
  "aws-mismatch",
  "tfvars-backend-disagree",
  "enabled-without-root",
  "unknown-root",
] as const;

const mustPass = ["valid-au", "disabled-with-root"] as const;

describe("residency-cell check fixtures", () => {
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
      expect(result.notice).toBeUndefined();
    });
  }

  it("fails the empty tree with an honest notice, not a silent pass", () => {
    const result = check(path.join(fixturesDir, "empty-tree"));
    expect(result.ok).toBe(false);
    expect(result.notice).toMatch(/zero/i);
    expect(result.violations.some((v) => v.message === "missing catalog.json")).toBe(false);
  });

  it("reports missing catalog without a notice", () => {
    const result = check(path.join(fixturesDir, "missing-catalog"));
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({
      file: "packages/residency/src/catalog.json",
      message: "missing catalog.json",
    });
    expect(result.notice).toBeUndefined();
  });
});
