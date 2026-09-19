import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const mustFail = ["no-org-id", "rls-not-forced"] as const;
const mustPass = ["valid"] as const;

describe("schema-rls check fixtures", () => {
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

  it("reports zero app-schema tables when no SQL is present under the glob", () => {
    const result = check(path.join(fixturesDir, "empty-tree"));
    expect(result.ok).toBe(true);
    expect(result.appTableCount).toBe(0);
    expect(result.notice).toMatch(/zero/i);
    expect(result.notice).not.toMatch(/provisional/i);
  });

  it("finds app.synthetic in the repository drizzle trees and passes", () => {
    const result = check(repoRoot);
    expect(result.ok, `unexpected violations: ${JSON.stringify(result.violations)}`).toBe(true);
    expect(result.appTableCount).toBeGreaterThan(0);
    expect(result.notice).toBeUndefined();
  });
});
