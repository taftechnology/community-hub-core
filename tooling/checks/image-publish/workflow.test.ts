import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkWorkflow } from "./workflow-check.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const workflowPath = path.join(here, "../../../.github/workflows/ci.yml");

const mustFail = [
  ["workflow-id-token", "workflow-id-token"],
  ["cancel-true", "cancel-true"],
  ["preview-push", "preview-push"],
  ["missing-attestation", "missing-attestation"],
  ["account-id", "account-id"],
  ["publish-without-main", "publish-without-main"],
  ["publish-floating-uses", "publish-floating-uses"],
  ["publish-without-needs", "publish-without-needs"],
  ["workflow-cancel", "workflow-cancel"],
  ["publish-concurrency", "publish-concurrency"],
  ["publish-scan", "publish-scan"],
  ["preview-id-token", "preview-id-token"],
  ["publish-floating-uses-name", "publish-floating-uses"],
  ["publish-if-extra", "publish-without-main"],
  ["preview-image-tests", "preview-image-tests"],
  ["publish-image-test", "publish-image-test"],
  ["admin-publish-without-needs", "admin-publish-without-needs"],
  ["admin-publish-floating-uses", "admin-publish-floating-uses"],
  ["admin-publish-concurrency", "admin-publish-concurrency"],
  ["admin-publish-sync", "admin-publish-sync"],
  ["admin-publish-query", "admin-publish-query"],
  ["admin-publish-without-main", "admin-publish-without-main"],
  ["admin-publish-if-extra", "admin-publish-without-main"],
  ["admin-publish-query-and", "admin-publish-query"],
] as const;

describe("workflow check fixtures", () => {
  for (const [file, rule] of mustFail) {
    it(`fails fixture ${file} for ${rule} only`, () => {
      const text = fs.readFileSync(path.join(fixturesDir, `${file}.yml`), "utf8");
      const result = checkWorkflow(text);
      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([rule]);
    });
  }

  it("passes the real workflow", () => {
    const text = fs.readFileSync(workflowPath, "utf8");
    expect(text).toContain("command -v aws >/dev/null");
    expect(text).toMatch(/aws sts assume-role-with-web-identity \\\n(?:.*\\\n)*\s+--query/);
    const testJob = text.slice(text.indexOf("\n  test:"), text.indexOf("\n  terraform:"));
    expect(testJob).not.toContain("ADMIN_PUBLISH_ROLE_ARN");
    expect(testJob).not.toContain("assume-role-with-web-identity");
    const result = checkWorkflow(text);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
