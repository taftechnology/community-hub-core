import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TERRAFORM_CHECKS,
  changedPaths,
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

describe("changedPaths", () => {
  it("returns an untracked file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gate-paths-"));
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Gate Test",
      GIT_AUTHOR_EMAIL: "gate-test@example.com",
      GIT_COMMITTER_NAME: "Gate Test",
      GIT_COMMITTER_EMAIL: "gate-test@example.com",
    };
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8", env: gitEnv });
      if ((result.status ?? 1) !== 0) {
        throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
      }
      return result.stdout.trim();
    };
    git(["init", "-b", "main"]);
    fs.writeFileSync(path.join(directory, "tracked.txt"), "tracked\n");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "initial"]);
    fs.writeFileSync(path.join(directory, "untracked.txt"), "untracked\n");
    const base = git(["rev-parse", "HEAD"]);
    expect(changedPaths(directory, base)).toEqual(["untracked.txt"]);
  });
});

describe("runScriptInDirectory", () => {
  it("stops before the second line when the first line is false", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
    const result = runScriptInDirectory("false\ntouch marker\n", directory);
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(directory, "marker"))).toBe(false);
  });

  it("returns the word a script echoes", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
    const result = runScriptInDirectory("echo gate-visible-word", directory);
    expect(result.stdout).toContain("gate-visible-word");
  });
});
