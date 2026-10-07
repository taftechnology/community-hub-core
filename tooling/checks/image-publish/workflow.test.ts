import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkWorkflow } from "./workflow-check.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");
const workflowPath = path.join(here, "../../../.github/workflows/ci.yml");

const mustFail = [
  "workflow-id-token",
  "cancel-true",
  "preview-push",
  "missing-attestation",
  "account-id",
  "publish-without-main",
  "publish-floating-uses",
  "publish-without-needs",
] as const;

describe("workflow check fixtures", () => {
  for (const name of mustFail) {
    it(`fails fixture ${name} for that rule only`, () => {
      const text = fs.readFileSync(path.join(fixturesDir, `${name}.yml`), "utf8");
      const result = checkWorkflow(text);
      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([name]);
    });
  }

  it("passes the real workflow", () => {
    const text = fs.readFileSync(workflowPath, "utf8");
    const result = checkWorkflow(text);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
