import fs from "node:fs";
import path from "node:path";

export const INFRA_DIR = "infra" as const;
export const REQUIRED_BACKEND_REGION = "ap-southeast-2" as const;

export type TerraformInvariantViolation = {
  file: string;
  message: string;
};

export type CheckResult = {
  ok: boolean;
  violations: TerraformInvariantViolation[];
  /** Set when no backend files exist so live runs are not a silent no-op. */
  notice?: string;
};

const SKIP_DIRS = new Set([".git", ".terraform", "node_modules", "dist", ".turbo"]);

function collectFiles(dir: string, predicate: (name: string) => boolean, out: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      collectFiles(full, predicate, out);
      continue;
    }
    if (entry.isFile() && predicate(entry.name)) {
      out.push(full);
    }
  }
}

/** Strip hash, //, and block comments. Quoted strings are left intact. */
export function stripHclComments(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < input.length) {
        out += input[i];
        if (input[i] === "\\") {
          i += 1;
          if (i < input.length) {
            out += input[i];
          }
          i += 1;
          continue;
        }
        if (input[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "#") {
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function extractBraceBody(source: string, openBraceIndex: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, i);
      }
    }
  }
  return null;
}

type HclResource = {
  type: string;
  name: string;
  body: string;
};

function findResources(hcl: string): HclResource[] {
  const resources: HclResource[] = [];
  const pattern = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(hcl)) !== null) {
    const type = match[1];
    const name = match[2];
    if (type === undefined || name === undefined) {
      continue;
    }
    const openBrace = match.index + match[0].length - 1;
    const body = extractBraceBody(hcl, openBrace);
    if (body === null) {
      continue;
    }
    resources.push({ type, name, body });
  }
  return resources;
}

function isBackendFile(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  return parts.includes("backend") && filePath.endsWith(".hcl");
}

function assignmentValue(hcl: string, key: string): string[] {
  const pattern = new RegExp("^\\s*" + key + "\\s*=\\s*(.+?)\\s*$", "gm");
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(hcl)) !== null) {
    const raw = match[1];
    if (raw !== undefined) {
      values.push(raw);
    }
  }
  return values;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function validateBackendFile(
  filePath: string,
  root: string,
  hcl: string,
): TerraformInvariantViolation[] {
  const relFile = path.relative(root, filePath);
  const violations: TerraformInvariantViolation[] = [];
  const regions = assignmentValue(hcl, "region").map(unquote);
  const encrypts = assignmentValue(hcl, "encrypt").map(unquote);
  const kmsKeys = assignmentValue(hcl, "kms_key_id");
  const lockfiles = assignmentValue(hcl, "use_lockfile").map(unquote);

  if (regions.length === 0 || regions.some((region) => region !== REQUIRED_BACKEND_REGION)) {
    violations.push({
      file: relFile,
      message: `backend region must be ${REQUIRED_BACKEND_REGION}`,
    });
  }

  if (encrypts.length === 0 || encrypts.some((value) => value !== "true")) {
    violations.push({
      file: relFile,
      message: "backend encrypt must be true",
    });
  }

  if (kmsKeys.length === 0) {
    violations.push({
      file: relFile,
      message: "backend must set kms_key_id",
    });
  }

  if (lockfiles.length === 0 || lockfiles.some((value) => value !== "true")) {
    violations.push({
      file: relFile,
      message: "backend must set use_lockfile = true",
    });
  }

  return violations;
}

function validateBootstrapFile(
  filePath: string,
  root: string,
  hcl: string,
): TerraformInvariantViolation[] {
  const relFile = path.relative(root, filePath);
  const violations: TerraformInvariantViolation[] = [];

  for (const resource of findResources(hcl)) {
    if (resource.type !== "aws_s3_bucket" && resource.type !== "aws_kms_key") {
      continue;
    }
    if (!/prevent_destroy\s*=\s*true\b/.test(resource.body)) {
      violations.push({
        file: relFile,
        message: `bootstrap ${resource.type}.${resource.name} must set lifecycle.prevent_destroy = true`,
      });
    }
  }

  return violations;
}

const INLINE_RULE_GROUPS = new Set(["task", "rds"]);

function hasInlineRuleArgument(body: string): boolean {
  return /^\s*(?:ingress|egress)\s*(?:=|\{)/m.test(body);
}

function validateTaskAndRdsSecurityGroups(
  filePath: string,
  root: string,
  hcl: string,
): TerraformInvariantViolation[] {
  const relFile = path.relative(root, filePath);
  const violations: TerraformInvariantViolation[] = [];

  for (const resource of findResources(hcl)) {
    if (resource.type !== "aws_security_group" || !INLINE_RULE_GROUPS.has(resource.name)) {
      continue;
    }
    if (hasInlineRuleArgument(resource.body)) {
      violations.push({
        file: relFile,
        message: `aws_security_group.${resource.name} must not set inline ingress or egress`,
      });
    }
  }

  return violations;
}

function validateEnvelopeStandaloneRules(
  filePath: string,
  root: string,
  hcl: string,
): TerraformInvariantViolation[] {
  const relFile = path.relative(root, filePath);
  const violations: TerraformInvariantViolation[] = [];

  for (const resource of findResources(hcl)) {
    if (
      resource.type !== "aws_vpc_security_group_ingress_rule" &&
      resource.type !== "aws_vpc_security_group_egress_rule"
    ) {
      continue;
    }
    violations.push({
      file: relFile,
      message: `envelope module must not declare ${resource.type}.${resource.name}`,
    });
  }

  return violations;
}

function validateEnvelopeKeyFile(
  filePath: string,
  root: string,
  hcl: string,
): TerraformInvariantViolation[] {
  const relFile = path.relative(root, filePath);
  const violations: TerraformInvariantViolation[] = [];

  for (const resource of findResources(hcl)) {
    if (resource.type === "aws_kms_key" && resource.name === "envelope") {
      if (!/prevent_destroy\s*=\s*true\b/.test(resource.body)) {
        violations.push({
          file: relFile,
          message: "envelope KMS key must set lifecycle.prevent_destroy = true",
        });
      }
    }
  }

  return violations;
}

function isUnder(filePath: string, root: string, relDir: string): boolean {
  const prefix = path.resolve(root, relDir) + path.sep;
  return (filePath + path.sep).startsWith(prefix) || filePath === path.resolve(root, relDir);
}

/** Scan Terraform under `root` (defaults to `process.cwd()`). */
export function check(root: string = process.cwd()): CheckResult {
  const resolvedRoot = path.resolve(root);
  const infraRoot = path.join(resolvedRoot, INFRA_DIR);
  const allHcl: string[] = [];
  const allTf: string[] = [];
  collectFiles(infraRoot, (name) => name.endsWith(".hcl"), allHcl);
  collectFiles(infraRoot, (name) => name.endsWith(".tf"), allTf);

  const backendFiles = allHcl.filter((filePath) => isBackendFile(filePath));
  const violations: TerraformInvariantViolation[] = [];

  for (const filePath of backendFiles) {
    const hcl = stripHclComments(fs.readFileSync(filePath, "utf8"));
    violations.push(...validateBackendFile(filePath, resolvedRoot, hcl));
  }

  for (const filePath of allTf) {
    const hcl = stripHclComments(fs.readFileSync(filePath, "utf8"));
    if (isUnder(filePath, resolvedRoot, path.join(INFRA_DIR, "bootstrap"))) {
      violations.push(...validateBootstrapFile(filePath, resolvedRoot, hcl));
    }
    violations.push(...validateTaskAndRdsSecurityGroups(filePath, resolvedRoot, hcl));
    if (isUnder(filePath, resolvedRoot, path.join(INFRA_DIR, "modules", "aws-kms-envelope"))) {
      violations.push(...validateEnvelopeKeyFile(filePath, resolvedRoot, hcl));
      violations.push(...validateEnvelopeStandaloneRules(filePath, resolvedRoot, hcl));
    }
  }

  const base = {
    ok: violations.length === 0,
    violations,
  };

  if (backendFiles.length === 0) {
    return {
      ...base,
      notice: `terraform-invariants: zero backend files found under ${INFRA_DIR}/`,
    };
  }

  return base;
}
