import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TERRAFORM_CHECKS,
  runScriptInDirectory,
  terraformChecksScript,
  terraformMatrixDirs,
  touchedTerraformDirs,
} from "./gate.js";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageDir, "../../..");
const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const matrix = terraformMatrixDirs(workflow);

describe("terraform checks script", () => {
  it("matches the six lines in the real workflow", () => {
    expect(terraformChecksScript(workflow)).toBe(TERRAFORM_CHECKS);
  });

  it("rejects a script that omits -recursive", () => {
    const fixture = fs.readFileSync(
      path.join(packageDir, "fixtures/fmt-not-recursive.yml"),
      "utf8",
    );
    expect(terraformChecksScript(fixture)).not.toBe(TERRAFORM_CHECKS);
  });
});

describe("touched terraform directories", () => {
  it("selects the module and the cell for a module-only change", () => {
    expect(touchedTerraformDirs(["infra/modules/aws-budgets/main.tf"], matrix)).toEqual([
      "infra/modules/aws-budgets",
      "infra/regions/au",
    ]);
  });

  it("selects only the cell for a cell change", () => {
    expect(touchedTerraformDirs(["infra/regions/au/main.tf"], matrix)).toEqual([
      "infra/regions/au",
    ]);
  });

  it("selects only bootstrap for a bootstrap change", () => {
    expect(touchedTerraformDirs(["infra/bootstrap/main.tf"], matrix)).toEqual(["infra/bootstrap"]);
  });

  it("selects nothing for paths that do not start with a matrix directory", () => {
    expect(
      touchedTerraformDirs(
        [
          "AGENTS.md",
          ".github/workflows/ci.yml",
          "tooling/checks/gate/gate.ts",
          "package.json",
          "tooling/checks/terraform-invariants/fixtures/lock-hash-mismatch/infra/modules/one/.terraform.lock.hcl",
        ],
        matrix,
      ),
    ).toEqual([]);
  });

  it("selects both modules and the cell once", () => {
    expect(
      touchedTerraformDirs(
        ["infra/modules/aws-budgets/main.tf", "infra/modules/aws-rds/main.tf"],
        matrix,
      ),
    ).toEqual(["infra/modules/aws-budgets", "infra/modules/aws-rds", "infra/regions/au"]);
  });
});

describe("runScriptInDirectory", () => {
  it("stops before the second line when the first line is false", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
    const status = runScriptInDirectory("false\ntouch marker\n", directory);
    expect(status).not.toBe(0);
    expect(fs.existsSync(path.join(directory, "marker"))).toBe(false);
  });
});
