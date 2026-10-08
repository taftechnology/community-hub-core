import { spawnSync } from "node:child_process";
import fs from "node:fs";
import {
  runScriptInDirectory,
  terraformChecksScript,
  terraformMatrixDirs,
  touchedTerraformDirs,
} from "./gate.js";

function git(args: string[]): { status: number; stdout: string } {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

const pnpmCommands = ["format", "lint", "typecheck", "test", "check:boundaries"] as const;
for (const command of pnpmCommands) {
  const result = spawnSync("pnpm", [command], { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

const base = git(["merge-base", "HEAD", "origin/main"]);
if (base.status !== 0) {
  console.error("origin/main could not be resolved");
  process.exit(base.status);
}

const paths = new Set<string>();
const diffs = [
  ["diff", "--name-only", base.stdout.trim()],
  ["diff", "--name-only"],
  ["diff", "--name-only", "--cached"],
];
for (const args of diffs) {
  const diff = git(args);
  if (diff.status !== 0) {
    process.exit(diff.status);
  }
  for (const line of diff.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      paths.add(trimmed);
    }
  }
}

const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
const dirs = touchedTerraformDirs([...paths], terraformMatrixDirs(workflow));
if (dirs.length === 0) {
  console.log("terraform: none");
  process.exit(0);
}

const script = terraformChecksScript(workflow);
for (const dir of dirs) {
  console.log(`terraform: ${dir}`);
  const result = runScriptInDirectory(script, dir);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status);
  }
}
