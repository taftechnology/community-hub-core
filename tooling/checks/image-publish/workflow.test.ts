import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkBuildAdminScript, checkWorkflow } from "./workflow-check.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const workflowPath = path.join(here, "../../../.github/workflows/ci.yml");
const rootPackagePath = path.join(here, "../../../package.json");

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
  ["admin-build-missing", "admin-build"],
  ["admin-build-no-pr-if", "admin-build"],
  ["admin-build-bare-filter", "admin-build"],
  ["admin-build-id-token", "admin-build"],
  ["admin-build-secrets", "admin-build"],
  ["admin-build-secrets-tojson", "admin-build"],
  ["admin-build-aws", "admin-build"],
  ["admin-publish-bare-filter", "admin-publish-build"],
  ["admin-publish-no-build", "admin-publish-build"],
  ["admin-publish-both-lines", "admin-publish-build"],
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

  it("fails a build:admin script that does not build the dependencies first", () => {
    const bare = JSON.stringify({
      scripts: { "build:admin": "pnpm --filter @community-hub/admin build" },
    });
    expect(checkBuildAdminScript(bare).violations).toEqual(["build-admin-script"]);
    expect(checkBuildAdminScript(JSON.stringify({ scripts: {} })).violations).toEqual([
      "build-admin-script",
    ]);
  });

  it("fails a build:admin script that runs lint instead of build", () => {
    const lintScript = JSON.stringify({
      scripts: { "build:admin": 'pnpm --filter "@community-hub/admin..." lint' },
    });
    expect(checkBuildAdminScript(lintScript).violations).toEqual(["build-admin-script"]);
  });

  it("fails a build:admin script with trailing extra commands or sub-commands", () => {
    const subCommand = JSON.stringify({
      scripts: { "build:admin": 'pnpm --filter "@community-hub/admin..." build:foo' },
    });
    expect(checkBuildAdminScript(subCommand).violations).toEqual(["build-admin-script"]);
    const trailingExtra = JSON.stringify({
      scripts: { "build:admin": 'pnpm --filter "@community-hub/admin..." build && echo extra' },
    });
    expect(checkBuildAdminScript(trailingExtra).violations).toEqual(["build-admin-script"]);
  });

  it("fails a build:admin script with a leading command", () => {
    const script = JSON.stringify({
      scripts: { "build:admin": 'echo hi && pnpm --filter "@community-hub/admin..." build' },
    });
    expect(checkBuildAdminScript(script).violations).toEqual(["build-admin-script"]);
  });

  it("fails a build:admin script for another package", () => {
    const script = JSON.stringify({
      scripts: { "build:admin": 'pnpm --filter "@community-hub/api..." build' },
    });
    expect(checkBuildAdminScript(script).violations).toEqual(["build-admin-script"]);
  });

  it("fails a build:admin script with an unclosed quote", () => {
    const script = JSON.stringify({
      scripts: { "build:admin": 'pnpm --filter "@community-hub/admin... build' },
    });
    expect(checkBuildAdminScript(script).violations).toEqual(["build-admin-script"]);
  });

  it("passes the real build:admin script", () => {
    const result = checkBuildAdminScript(fs.readFileSync(rootPackagePath, "utf8"));
    expect(result.violations).toEqual([]);
  });

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
