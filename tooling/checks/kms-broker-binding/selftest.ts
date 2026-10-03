import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MULTIPLE_WRANGLER_CONFIG_MESSAGE, check } from "./check.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const mustFail: Readonly<Record<string, string>> = {
  "vpc-networks": "vpc_networks entries are not allowed",
  "cf1-network": "cf1:network bindings are not allowed",
  "env-only-vpc-services": "only apps/api may declare vpc_services",
  "remote-on-broker": 'must not include key "remote"',
  "wrangler-toml": "wrangler.toml is not allowed",
  "missing-broker": "found 0",
  "extra-vpc-service": "found 2",
  "other-worker-vpc-services": "only apps/api may declare vpc_services",
  "jsonc-and-json": MULTIPLE_WRANGLER_CONFIG_MESSAGE,
};

const mustPass = ["valid"] as const;

describe("kms-broker-binding check fixtures", () => {
  for (const [name, substring] of Object.entries(mustFail)) {
    it(`fails fixture ${name}`, () => {
      const result = check(path.join(fixturesDir, name));
      expect(result.ok, `expected violations: ${JSON.stringify(result.violations)}`).toBe(false);
      expect(
        result.violations.some((v) => v.message.includes(substring)),
        `expected a violation message containing ${JSON.stringify(substring)}: ${JSON.stringify(result.violations)}`,
      ).toBe(true);
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
