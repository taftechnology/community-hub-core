import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const mustFail = [
  "vpc-networks",
  "cf1-network",
  "env-only-vpc-services",
  "remote-on-broker",
  "wrangler-toml",
  "missing-broker",
  "extra-vpc-service",
  "other-worker-vpc-services",
] as const;

const mustPass = ["valid"] as const;

describe("kms-broker-binding check fixtures", () => {
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

  it("passes the live repository", () => {
    const result = check(repoRoot);
    expect(result.ok, `unexpected violations: ${JSON.stringify(result.violations)}`).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
