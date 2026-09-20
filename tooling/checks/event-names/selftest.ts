import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const mustFail = ["duplicate-publishes", "unreadable-publishes"] as const;
const mustPass = ["unique-name", "same-file-claim"] as const;

describe("event-names check fixtures", () => {
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
    expect(result.declarationCount).toBe(0);
    expect(result.notice).toMatch(/zero/i);
  });

  it("attributes duplicate publishes to both modules", () => {
    const result = check(path.join(fixturesDir, "duplicate-publishes"));
    const files = result.violations.map((v) => v.file.replaceAll("\\", "/")).sort();
    expect(files).toEqual(["packages/alpha/src/module.ts", "packages/beta/src/module.ts"]);
  });

  it("passes the live repository because the health module is a real declaration", () => {
    const result = check(repoRoot);
    expect(result.ok, `unexpected violations: ${JSON.stringify(result.violations)}`).toBe(true);
    expect(result.declarationCount).toBeGreaterThan(0);
    expect(result.notice).toBeUndefined();
  });
});
