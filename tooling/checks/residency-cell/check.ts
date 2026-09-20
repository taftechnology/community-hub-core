import fs from "node:fs";
import path from "node:path";

const CATALOG_REL = "packages/residency/src/catalog.json" as const;

const ZERO_INPUT_NOTICE =
  "residency-cell: zero Terraform cell roots, zero enabled catalog cells, or zero Wrangler apps";

export type ResidencyCellViolation = { file: string; message: string };

export type CheckResult = {
  ok: boolean;
  violations: ResidencyCellViolation[];
  notice?: string;
};

type CatalogCell = {
  enabled: boolean;
  cloudflareRegionalServices: string;
  awsRegion: string;
};

type Catalog = {
  cells: Record<string, CatalogCell>;
};

function posixRel(root: string, filePath: string): string {
  return path.relative(root, filePath).replaceAll("\\", "/");
}

/** Strip hash, //, and block comments. Quoted strings are left intact. */
function stripHclComments(input: string): string {
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
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
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

function discoverWranglerApps(root: string): { appName: string; wranglerPath: string }[] {
  const appsDir = path.join(root, "apps");
  if (!fs.existsSync(appsDir)) {
    return [];
  }

  const found: { appName: string; wranglerPath: string }[] = [];
  for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const appName = entry.name;
    const appDir = path.join(appsDir, appName);
    const jsoncPath = path.join(appDir, "wrangler.jsonc");
    const jsonPath = path.join(appDir, "wrangler.json");
    const wranglerPath = fs.existsSync(jsoncPath)
      ? jsoncPath
      : fs.existsSync(jsonPath)
        ? jsonPath
        : null;
    if (wranglerPath) {
      found.push({ appName, wranglerPath });
    }
  }
  return found;
}

function discoverTerraformCellIds(root: string): string[] {
  const regionsDir = path.join(root, "infra", "regions");
  if (!fs.existsSync(regionsDir)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of fs.readdirSync(regionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const regionRoot = path.join(regionsDir, entry.name);
    const hasBackend = fs.existsSync(path.join(regionRoot, "backend"));
    const hasEnv = fs.existsSync(path.join(regionRoot, "env"));
    if (hasBackend || hasEnv) {
      ids.push(entry.name);
    }
  }
  return ids.sort();
}

function listEnvTfvars(regionRoot: string): string[] {
  const envDir = path.join(regionRoot, "env");
  if (!fs.existsSync(envDir)) {
    return [];
  }
  return fs
    .readdirSync(envDir)
    .filter((name) => name.endsWith(".tfvars"))
    .map((name) => path.join(envDir, name))
    .sort();
}

function listBackendHcl(regionRoot: string): string[] {
  const backendDir = path.join(regionRoot, "backend");
  if (!fs.existsSync(backendDir)) {
    return [];
  }
  return fs
    .readdirSync(backendDir)
    .filter((name) => name.endsWith(".hcl"))
    .map((name) => path.join(backendDir, name))
    .sort();
}

function collectAwsRegionsFromTfvars(files: string[]): string[] {
  const regions: string[] = [];
  for (const file of files) {
    const hcl = stripHclComments(fs.readFileSync(file, "utf8"));
    for (const value of assignmentValue(hcl, "aws_region")) {
      regions.push(unquote(value));
    }
  }
  return regions;
}

function collectBackendRegions(files: string[]): string[] {
  const regions: string[] = [];
  for (const file of files) {
    const hcl = stripHclComments(fs.readFileSync(file, "utf8"));
    for (const value of assignmentValue(hcl, "region")) {
      regions.push(unquote(value));
    }
  }
  return regions;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function validateEnabledCell(
  root: string,
  cellId: string,
  awsRegion: string,
  violations: ResidencyCellViolation[],
): void {
  const regionRoot = path.join(root, "infra", "regions", cellId);
  const regionRel = posixRel(root, regionRoot);
  const hasBackend = fs.existsSync(path.join(regionRoot, "backend"));
  const hasEnv = fs.existsSync(path.join(regionRoot, "env"));
  if (!hasBackend && !hasEnv) {
    violations.push({
      file: CATALOG_REL,
      message: `enabled cell "${cellId}" has no infra/regions/${cellId}/ root`,
    });
    return;
  }

  const tfvarsFiles = listEnvTfvars(regionRoot);
  const backendFiles = listBackendHcl(regionRoot);

  if (tfvarsFiles.length === 0) {
    violations.push({
      file: regionRel,
      message: `enabled cell "${cellId}" has no env/*.tfvars`,
    });
  }
  if (backendFiles.length === 0) {
    violations.push({
      file: regionRel,
      message: `enabled cell "${cellId}" has no backend/*.hcl`,
    });
  }

  const tfvarsRegions = collectAwsRegionsFromTfvars(tfvarsFiles);
  const backendRegions = collectBackendRegions(backendFiles);

  for (const file of tfvarsFiles) {
    const hcl = stripHclComments(fs.readFileSync(file, "utf8"));
    const rel = posixRel(root, file);
    for (const value of assignmentValue(hcl, "aws_region")) {
      const region = unquote(value);
      if (region !== awsRegion) {
        violations.push({
          file: rel,
          message: `aws_region "${region}" does not match catalog awsRegion "${awsRegion}" for enabled cell "${cellId}"`,
        });
      }
    }
  }

  for (const file of backendFiles) {
    const hcl = stripHclComments(fs.readFileSync(file, "utf8"));
    const rel = posixRel(root, file);
    for (const value of assignmentValue(hcl, "region")) {
      const region = unquote(value);
      if (region !== awsRegion) {
        violations.push({
          file: rel,
          message: `backend region "${region}" does not match catalog awsRegion "${awsRegion}" for enabled cell "${cellId}"`,
        });
      }
    }
  }

  const tfvarsUnique = uniqueSorted(tfvarsRegions);
  const backendUnique = uniqueSorted(backendRegions);

  if (tfvarsUnique.length > 1) {
    violations.push({
      file: regionRel,
      message: `enabled cell "${cellId}" env/*.tfvars aws_region values disagree: ${tfvarsUnique.join(", ")}`,
    });
  }
  if (backendUnique.length > 1) {
    violations.push({
      file: regionRel,
      message: `enabled cell "${cellId}" backend/*.hcl region values disagree: ${backendUnique.join(", ")}`,
    });
  }
  if (
    tfvarsUnique.length === 1 &&
    backendUnique.length === 1 &&
    tfvarsUnique[0] !== backendUnique[0]
  ) {
    violations.push({
      file: regionRel,
      message: `enabled cell "${cellId}" env aws_region (${tfvarsUnique[0]}) and backend region (${backendUnique[0]}) disagree`,
    });
  }
}

/** Cross-check residency catalog cells against Terraform region roots under `root`. */
export function check(root: string = process.cwd()): CheckResult {
  const resolvedRoot = path.resolve(root);
  const catalogPath = path.join(resolvedRoot, CATALOG_REL);

  if (!fs.existsSync(catalogPath)) {
    return {
      ok: false,
      violations: [{ file: CATALOG_REL, message: "missing catalog.json" }],
    };
  }

  let catalog: Catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Catalog;
  } catch {
    return {
      ok: false,
      violations: [{ file: CATALOG_REL, message: "catalog.json is not valid JSON" }],
    };
  }

  const cellIds = Object.keys(catalog.cells ?? {});
  const enabledCellIds = cellIds.filter((id) => catalog.cells[id]?.enabled === true);
  const terraformCellIds = discoverTerraformCellIds(resolvedRoot);
  const wranglerAppCount = discoverWranglerApps(resolvedRoot).length;

  const zeroInput =
    terraformCellIds.length === 0 || enabledCellIds.length === 0 || wranglerAppCount === 0;

  const violations: ResidencyCellViolation[] = [];

  for (const cellId of enabledCellIds) {
    const cell = catalog.cells[cellId];
    if (!cell) {
      continue;
    }
    validateEnabledCell(resolvedRoot, cellId, cell.awsRegion, violations);
  }

  for (const regionId of terraformCellIds) {
    if (!(regionId in catalog.cells)) {
      violations.push({
        file: posixRel(resolvedRoot, path.join(resolvedRoot, "infra", "regions", regionId)),
        message: `infra/regions/${regionId}/ has no matching catalog.cells key`,
      });
    }
  }

  return {
    ok: !zeroInput && violations.length === 0,
    violations,
    ...(zeroInput ? { notice: ZERO_INPUT_NOTICE } : {}),
  };
}
