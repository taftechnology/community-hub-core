import fs from "node:fs";
import path from "node:path";

const CATALOG_REL = "packages/residency/src/catalog.json" as const;

const ZERO_INPUT_NOTICE =
  "residency-cell: zero Terraform cell roots, zero enabled catalog cells, or zero Wrangler apps";

const KNOWN_WORKER_CLASSES = new Set(["global-no-pii", "regional"]);
const COMMUNITY_HUB_PREFIX = "@community-hub/";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "test",
  "tests",
  ".turbo",
  "fixtures",
]);

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
  regionalOnlyPackages?: string[];
};

type WorkerMeta = {
  class?: string;
};

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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

/** Strip //, block, and preserve quoted strings (from worker-config). */
function stripTsComments(src: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "sq" | "dq" | "tmpl" = "code";
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (state !== "code") {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (state === "sq" && ch === "'") {
        state = "code";
      } else if (state === "dq" && ch === '"') {
        state = "code";
      } else if (state === "tmpl" && ch === "`") {
        state = "code";
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      state = "sq";
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "dq";
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "`") {
      state = "tmpl";
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
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

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

function startsAtWord(text: string, index: number, word: string): boolean {
  if (!text.startsWith(word, index)) {
    return false;
  }
  if (isWordChar(text[index - 1]) || isWordChar(text[index + word.length])) {
    return false;
  }
  return true;
}

function skipWs(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i] ?? "")) {
    i += 1;
  }
  return i;
}

function parseQuoted(text: string, index: number): { value: string; end: number } | null {
  const quote = text[index];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  let i = index + 1;
  let value = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\\" && next !== undefined) {
      value += next;
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { value, end: i + 1 };
    }
    value += ch;
    i += 1;
  }
  return null;
}

function collectTsFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      collectTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
}

function readPackageJson(dir: string): PackageJson {
  const filePath = path.join(dir, "package.json");
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as PackageJson;
  } catch {
    return {};
  }
}

function resolveCommunityHubPackageDir(root: string, pkgName: string): string | null {
  if (!pkgName.startsWith(COMMUNITY_HUB_PREFIX)) {
    return null;
  }
  const short = pkgName.slice(COMMUNITY_HUB_PREFIX.length);
  for (const base of ["packages", "apps"] as const) {
    const dir = path.join(root, base, short);
    if (!fs.existsSync(path.join(dir, "package.json"))) {
      continue;
    }
    const { name } = readPackageJson(dir);
    if (name === pkgName) {
      return dir;
    }
  }
  return null;
}

function communityHubPackageNameFromSpecifier(specifier: string): string | null {
  if (!specifier.startsWith(COMMUNITY_HUB_PREFIX)) {
    return null;
  }
  const rest = specifier.slice(COMMUNITY_HUB_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    return `${COMMUNITY_HUB_PREFIX}${rest}`;
  }
  return `${COMMUNITY_HUB_PREFIX}${rest.slice(0, slash)}`;
}

function workspacePackageFromSpecifier(root: string, specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  const pkgName = communityHubPackageNameFromSpecifier(specifier);
  if (!pkgName) {
    return null;
  }
  return resolveCommunityHubPackageDir(root, pkgName);
}

function stripImportQuery(specifier: string): string {
  const q = specifier.indexOf("?");
  return q === -1 ? specifier : specifier.slice(0, q);
}

function isPathInsideRegionalDir(absDir: string, targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const rel = path.relative(absDir, resolved);
  if (rel === "") {
    return true;
  }
  if (path.isAbsolute(rel)) {
    return false;
  }
  return !rel.startsWith("..");
}

function collectWorkspaceDependencyNames(pkgDir: string): string[] {
  const pkg = readPackageJson(pkgDir);
  const names: string[] = [];
  for (const field of ["dependencies", "peerDependencies"] as const) {
    const deps = pkg[field];
    if (!deps) {
      continue;
    }
    for (const [name, version] of Object.entries(deps)) {
      if (version.startsWith("workspace:")) {
        names.push(name);
      }
    }
  }
  return names;
}

function extractModuleSpecifiers(src: string): string[] {
  const text = stripTsComments(src);
  const specs: string[] = [];
  let i = 0;
  let state: "code" | "sq" | "dq" | "tmpl" = "code";

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state !== "code") {
      if (ch === "\\" && next !== undefined) {
        i += 2;
        continue;
      }
      if (state === "sq" && ch === "'") {
        state = "code";
      } else if (state === "dq" && ch === '"') {
        state = "code";
      } else if (state === "tmpl" && ch === "`") {
        state = "code";
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      state = "sq";
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "dq";
      i += 1;
      continue;
    }
    if (ch === "`") {
      state = "tmpl";
      i += 1;
      continue;
    }

    if (startsAtWord(text, i, "import")) {
      let j = skipWs(text, i + "import".length);
      const sideEffect = parseQuoted(text, j);
      if (sideEffect) {
        specs.push(sideEffect.value);
        i = sideEffect.end;
        continue;
      }
      if (text[j] === "(") {
        const inner = skipWs(text, j + 1);
        const dynamic = parseQuoted(text, inner);
        if (dynamic) {
          specs.push(dynamic.value);
          i = dynamic.end;
        } else {
          i = j + 1;
        }
        continue;
      }
      let foundFrom = false;
      while (j < text.length) {
        const quoted = parseQuoted(text, j);
        if (quoted) {
          j = quoted.end;
          continue;
        }
        if (startsAtWord(text, j, "from")) {
          const afterFrom = skipWs(text, j + 4);
          const spec = parseQuoted(text, afterFrom);
          if (spec) {
            specs.push(spec.value);
            i = spec.end;
          } else {
            i = j + 4;
          }
          foundFrom = true;
          break;
        }
        j += 1;
      }
      if (!foundFrom) {
        i += "import".length;
      }
      continue;
    }

    if (startsAtWord(text, i, "export")) {
      let j = skipWs(text, i + "export".length);
      let foundFrom = false;
      while (j < text.length) {
        const quoted = parseQuoted(text, j);
        if (quoted) {
          j = quoted.end;
          continue;
        }
        if (startsAtWord(text, j, "from")) {
          const afterFrom = skipWs(text, j + 4);
          const spec = parseQuoted(text, afterFrom);
          if (spec) {
            specs.push(spec.value);
            i = spec.end;
          } else {
            i = j + 4;
          }
          foundFrom = true;
          break;
        }
        j += 1;
      }
      if (!foundFrom) {
        i += "export".length;
      }
      continue;
    }

    i += 1;
  }

  return specs;
}

function hasNonLiteralDynamicImport(src: string): boolean {
  const text = stripTsComments(src);
  let i = 0;
  let state: "code" | "sq" | "dq" | "tmpl" = "code";

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state !== "code") {
      if (ch === "\\" && next !== undefined) {
        i += 2;
        continue;
      }
      if (state === "sq" && ch === "'") {
        state = "code";
      } else if (state === "dq" && ch === '"') {
        state = "code";
      } else if (state === "tmpl" && ch === "`") {
        state = "code";
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      state = "sq";
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "dq";
      i += 1;
      continue;
    }
    if (ch === "`") {
      state = "tmpl";
      i += 1;
      continue;
    }
    if (startsAtWord(text, i, "import")) {
      const afterImport = skipWs(text, i + "import".length);
      if (text[afterImport] === "(") {
        const afterParen = skipWs(text, afterImport + 1);
        const literal = parseQuoted(text, afterParen);
        if (!literal) {
          return true;
        }
        i = literal.end;
        continue;
      }
    }
    i += 1;
  }
  return false;
}

function checkSpecifierAgainstRegional(
  root: string,
  filePath: string,
  rawSpecifier: string,
  regionalNames: Set<string>,
  regionalDirs: Map<string, string>,
  violations: ResidencyCellViolation[],
): void {
  const relFile = posixRel(root, filePath);
  const specifier = stripImportQuery(rawSpecifier);

  for (const name of regionalNames) {
    if (specifier === name) {
      violations.push({
        file: relFile,
        message: `global-no-pii Worker must not import regional-only package "${name}"`,
      });
      return;
    }
    if (specifier.startsWith(`${name}/`)) {
      violations.push({
        file: relFile,
        message: `global-no-pii Worker must not import regional-only package path "${specifier}"`,
      });
      return;
    }
  }

  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(filePath), specifier);
    for (const [name, absDir] of regionalDirs) {
      if (isPathInsideRegionalDir(absDir, resolved)) {
        violations.push({
          file: relFile,
          message: `global-no-pii Worker must not reach regional-only package "${name}" via relative import`,
        });
        return;
      }
    }
  }
}

function scanTsFilesForRegionalReach(
  root: string,
  dir: string,
  regionalNames: Set<string>,
  regionalDirs: Map<string, string>,
  violations: ResidencyCellViolation[],
  workspaceSeen: Set<string>,
): void {
  const files: string[] = [];
  collectTsFiles(dir, files);
  for (const filePath of files) {
    const src = fs.readFileSync(filePath, "utf8");
    const relFile = posixRel(root, filePath);
    if (hasNonLiteralDynamicImport(src)) {
      violations.push({
        file: relFile,
        message: "global-no-pii Worker must not use non-literal dynamic import()",
      });
    }
    for (const spec of extractModuleSpecifiers(src)) {
      checkSpecifierAgainstRegional(root, filePath, spec, regionalNames, regionalDirs, violations);
      const pkgDir = workspacePackageFromSpecifier(root, spec);
      if (pkgDir) {
        workspaceSeen.add(pkgDir);
      }
    }
  }
}

function walkTransitiveWorkspaceGraph(
  root: string,
  seedDirs: Set<string>,
  regionalNames: Set<string>,
  regionalDirs: Map<string, string>,
  violations: ResidencyCellViolation[],
): void {
  const visited = new Set<string>();
  const queue = [...seedDirs];

  while (queue.length > 0) {
    const pkgDir = queue.pop();
    if (!pkgDir || visited.has(pkgDir)) {
      continue;
    }
    visited.add(pkgDir);

    const { name } = readPackageJson(pkgDir);
    const relPkg = posixRel(root, pkgDir);
    if (name && regionalNames.has(name)) {
      violations.push({
        file: `${relPkg}/package.json`,
        message: `global-no-pii Worker reaches regional-only package "${name}" via workspace dependency graph`,
      });
    }

    for (const depName of collectWorkspaceDependencyNames(pkgDir)) {
      if (regionalNames.has(depName)) {
        violations.push({
          file: `${relPkg}/package.json`,
          message: `global-no-pii Worker reaches regional-only package "${depName}" via workspace dependency graph`,
        });
      }
      const depDir = resolveCommunityHubPackageDir(root, depName);
      if (depDir && !visited.has(depDir)) {
        queue.push(depDir);
      }
    }

    const importSeeds = new Set<string>();
    scanTsFilesForRegionalReach(root, pkgDir, regionalNames, regionalDirs, violations, importSeeds);
    for (const dir of importSeeds) {
      if (!visited.has(dir)) {
        queue.push(dir);
      }
    }
  }
}

function validateGlobalWorkerImportGraph(
  root: string,
  appDir: string,
  regionalNames: Set<string>,
  regionalDirs: Map<string, string>,
  violations: ResidencyCellViolation[],
): void {
  const workspaceSeeds = new Set<string>();
  scanTsFilesForRegionalReach(root, appDir, regionalNames, regionalDirs, violations, workspaceSeeds);
  walkTransitiveWorkspaceGraph(root, workspaceSeeds, regionalNames, regionalDirs, violations);
}

function readWorkerMeta(root: string, appDir: string): WorkerMeta | null {
  const metaPath = path.join(appDir, "worker.meta.json");
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8")) as WorkerMeta;
  } catch {
    return {};
  }
}

function validateImportGraph(root: string, catalog: Catalog, violations: ResidencyCellViolation[]): void {
  const regionalOnly = catalog.regionalOnlyPackages ?? [];
  const regionalNames = new Set(regionalOnly);
  const regionalDirs = new Map<string, string>();

  for (const name of regionalOnly) {
    const dir = resolveCommunityHubPackageDir(root, name);
    if (!dir) {
      violations.push({
        file: CATALOG_REL,
        message: `regional-only package "${name}" is not resolvable under repository root`,
      });
      continue;
    }
    regionalDirs.set(name, dir);
  }

  const appsDir = path.join(root, "apps");
  if (!fs.existsSync(appsDir)) {
    return;
  }

  for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const appDir = path.join(appsDir, entry.name);
    const jsoncPath = path.join(appDir, "wrangler.jsonc");
    const jsonPath = path.join(appDir, "wrangler.json");
    const wranglerPath = fs.existsSync(jsoncPath)
      ? jsoncPath
      : fs.existsSync(jsonPath)
        ? jsonPath
        : null;
    if (!wranglerPath) {
      continue;
    }

    const appRel = posixRel(root, appDir);
    const metaPath = path.join(appDir, "worker.meta.json");
    if (!fs.existsSync(metaPath)) {
      violations.push({
        file: appRel,
        message: "Wrangler app is missing worker.meta.json",
      });
      continue;
    }

    const meta = readWorkerMeta(root, appDir);
    const workerClass = meta?.class;
    if (!workerClass) {
      violations.push({
        file: posixRel(root, metaPath),
        message: "worker.meta.json is missing class",
      });
      continue;
    }
    if (!KNOWN_WORKER_CLASSES.has(workerClass)) {
      violations.push({
        file: posixRel(root, metaPath),
        message: `worker.meta.json class "${workerClass}" is unknown`,
      });
      continue;
    }

    if (workerClass === "regional") {
      continue;
    }

    validateGlobalWorkerImportGraph(root, appDir, regionalNames, regionalDirs, violations);
  }
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

  if (zeroInput) {
    return {
      ok: false,
      violations,
      notice: ZERO_INPUT_NOTICE,
    };
  }

  validateImportGraph(resolvedRoot, catalog, violations);

  return {
    ok: violations.length === 0,
    violations,
  };
}
