import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function readFixture(name: string, file: string): string {
  return fs.readFileSync(path.join(fixturesDir, name, file), "utf8").trim();
}

const mustFail = ["bad-branch", "missing-plan", "slug-mismatch", "draft-spec"] as const;

const mustPass = ["valid-chunk", "no-spec-chore"] as const;

describe("traceability check fixtures", () => {
  for (const name of mustFail) {
    it(`fails fixture ${name}`, () => {
      const branch = readFixture(name, "branch.txt");
      const prBody = readFixture(name, "pr-body.md");
      const result = check({ branch, prBody, root: path.join(fixturesDir, name) });
      expect(result.ok, `expected violations: ${JSON.stringify(result.violations)}`).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  }

  for (const name of mustPass) {
    it(`passes fixture ${name}`, () => {
      const branch = readFixture(name, "branch.txt");
      const prBody = readFixture(name, "pr-body.md");
      const result = check({ branch, prBody, root: path.join(fixturesDir, name) });
      expect(result.ok, `unexpected violations: ${JSON.stringify(result.violations)}`).toBe(true);
      expect(result.violations).toEqual([]);
    });
  }
});
