import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const mustFail = [
  "password-in-sql",
  "set-session",
  "reset-app",
  "set-role-in-sql",
  "set-role-in-src-ts",
  "set-config-role",
  "set-session-authorization",
  "set-local",
  "set-app-equals",
  "set-app-to",
  "set-role-in-modules",
] as const;
const mustPass = ["valid", "set-local-in-comment"] as const;

describe("sql-session-ban check fixtures", () => {
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

  it("attributes set-role-in-src-ts to the production file, not the test", () => {
    const result = check(path.join(fixturesDir, "set-role-in-src-ts"));
    expect(result.violations.map((v) => v.file.replaceAll("\\", "/"))).toEqual([
      "packages/db/src/foo.ts",
    ]);
  });

  it("flags SET app.org_id = in both SQL and TypeScript", () => {
    const result = check(path.join(fixturesDir, "set-app-equals"));
    expect(result.violations.map((v) => v.file.replaceAll("\\", "/")).sort()).toEqual([
      "packages/db/sql/bad.sql",
      "packages/db/src/bad.ts",
    ]);
  });

  it("flags SET app.org_id TO, including quoted app, in both trees", () => {
    const result = check(path.join(fixturesDir, "set-app-to"));
    expect(result.violations.map((v) => v.file.replaceAll("\\", "/")).sort()).toEqual([
      "packages/db/sql/bad.sql",
      "packages/db/src/bad.ts",
    ]);
  });

  it("flags SET ROLE under modules", () => {
    const result = check(path.join(fixturesDir, "set-role-in-modules"));
    expect(result.violations.map((v) => v.file.replaceAll("\\", "/"))).toEqual([
      "modules/features/giving/infrastructure/repo.ts",
    ]);
  });

  it("passes the repository production TypeScript and SQL trees", () => {
    const result = check(repoRoot);
    expect(result.ok, `unexpected violations: ${JSON.stringify(result.violations)}`).toBe(true);
    expect(result.scannedFileCount).toBeGreaterThan(0);
  });
});
