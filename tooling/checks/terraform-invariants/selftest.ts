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
  "inline-security-group-rules",
  "inline-other-security-group",
  "dynamic-security-group-rules",
  "extra-network-security-group-rule",
  "envelope-standalone-rule",
  "region-database",
  "region-bucket",
  "region-log-group",
  "region-provider",
  "region-us-east-1",
  "region-other-variable",
  "admin-bucket-us-east-1",
  "admin-cloudfront-us-east-1",
  "region-provider-us-east-1",
  "missing-replica-prevent-destroy",
  "tf-json-file",
  "lock-hash-mismatch",
  "lock-hash-different",
] as const;

const mustPass = ["valid", "melbourne-replica", "viewer-certificate"] as const;

const regionFixtures = [
  "region-database",
  "region-bucket",
  "region-log-group",
  "region-provider",
  "region-us-east-1",
  "region-other-variable",
  "admin-bucket-us-east-1",
  "admin-cloudfront-us-east-1",
  "region-provider-us-east-1",
] as const;

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

  for (const name of regionFixtures) {
    it(`fails fixture ${name} because the region argument is not allowed`, () => {
      const result = check(path.join(fixturesDir, name));
      expect(result.ok).toBe(false);
      expect(
        result.violations.some((violation) =>
          violation.message.includes("region argument must be var.aws_region"),
        ),
      ).toBe(true);
    });
  }

  it("fails tf-json-file because JSON-syntax Terraform is not allowed", () => {
    const result = check(path.join(fixturesDir, "tf-json-file"));
    expect(result.ok).toBe(false);
    expect(
      result.violations.some(
        (violation) =>
          violation.message === "JSON-syntax Terraform files are not allowed under infra",
      ),
    ).toBe(true);
  });

  it("fails missing-replica-prevent-destroy for the replica lifecycle", () => {
    const result = check(path.join(fixturesDir, "missing-replica-prevent-destroy"));
    expect(result.ok).toBe(false);
    expect(
      result.violations.some((violation) =>
        violation.message.includes(
          "envelope replica key must set lifecycle.prevent_destroy = true",
        ),
      ),
    ).toBe(true);
  });

  it("fails lock-hash-mismatch because the hash sets differ", () => {
    const result = check(path.join(fixturesDir, "lock-hash-mismatch"));
    expect(result.ok).toBe(false);
    const message = result.violations.map((violation) => violation.message).join("\n");
    expect(message).toContain("infra/modules/one/.terraform.lock.hcl");
    expect(message).toContain("infra/modules/two/.terraform.lock.hcl");
    expect(message).toContain("registry.terraform.io/hashicorp/aws");
    expect(message).toContain("9.9.9");
  });

  it("reports a notice when no backend files exist yet", () => {
    const result = check(path.join(fixturesDir, "empty-tree"));
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.notice).toMatch(/zero/i);
  });
});
