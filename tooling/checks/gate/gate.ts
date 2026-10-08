import { spawnSync } from "node:child_process";

export const TERRAFORM_CHECKS = [
  "terraform init -backend=false -lockfile=readonly",
  "terraform fmt -check -recursive",
  "terraform validate",
  "tflint --init",
  "tflint",
  "terraform test",
].join("\n");

function jobBlock(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) {
    return "";
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[a-z0-9-]+:$/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function terraformChecksScript(workflowYaml: string): string {
  const lines = jobBlock(workflowYaml, "terraform").split("\n");
  let seenName = false;
  let runIndent = -1;
  const script: string[] = [];
  for (const line of lines) {
    if (!seenName) {
      if (line.includes("name: Terraform checks")) {
        seenName = true;
      }
      continue;
    }
    if (runIndent === -1) {
      const match = /^(\s*)run:\s*\|\s*$/.exec(line);
      if (match?.[1] !== undefined) {
        runIndent = match[1].length;
      }
      continue;
    }
    if (line.trim() === "") {
      continue;
    }
    const indent = /^( *)/.exec(line)?.[1]?.length ?? 0;
    if (indent <= runIndent) {
      break;
    }
    script.push(line.trim());
  }
  return script.join("\n");
}

export function terraformMatrixDirs(workflowYaml: string): string[] {
  const lines = jobBlock(workflowYaml, "terraform").split("\n");
  const start = lines.findIndex((line) => line.trim() === "dir:");
  if (start === -1) {
    return [];
  }
  const dirs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (match?.[1] === undefined) {
      break;
    }
    dirs.push(match[1]);
  }
  return dirs;
}

export function touchedTerraformDirs(
  changedPaths: readonly string[],
  matrix: readonly string[],
): string[] {
  const selected = new Set<string>();
  let moduleChange = false;
  for (const changed of changedPaths) {
    for (const dir of matrix) {
      if (changed === dir || changed.startsWith(`${dir}/`)) {
        selected.add(dir);
      }
    }
    if (changed === "infra/modules" || changed.startsWith("infra/modules/")) {
      moduleChange = true;
    }
  }
  const ordered = matrix.filter((dir) => selected.has(dir));
  if (
    moduleChange &&
    matrix.includes("infra/regions/au") &&
    !ordered.includes("infra/regions/au")
  ) {
    ordered.push("infra/regions/au");
  }
  return ordered;
}

export function runScriptInDirectory(
  script: string,
  directory: string,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
    cwd: directory,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
