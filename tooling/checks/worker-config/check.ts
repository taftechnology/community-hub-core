import fs from "node:fs";
import path from "node:path";

const ALLOWED_CLASSES = new Set(["global-no-pii", "regional"]);

export type WorkerConfigViolation = {
  app: string;
  message: string;
};

export type CheckResult = {
  ok: boolean;
  violations: WorkerConfigViolation[];
};

type WranglerConfig = {
  workers_dev?: boolean;
  preview_urls?: boolean;
  compatibility_flags?: string[];
};

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "test",
  "tests",
  ".turbo",
  "fixtures",
]);
const KERNEL_SPECS = new Set(["@community-hub/kernel", "@community-hub/kernel/module"]);
const ALS_FLAGS = new Set(["nodejs_als", "nodejs_compat"]);

type WorkerMeta = {
  class?: string;
};

function stripJsoncComments(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      const start = i;
      i += 1;
      while (i < input.length) {
        if (input[i] === "\\") {
          i += 2;
          continue;
        }
        if (input[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += input.slice(start, i);
      continue;
    }
    if (input[i] === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (input[i] === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += input[i];
    i += 1;
  }
  return out;
}

function parseJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf8");
  const text = filePath.endsWith(".jsonc") ? stripJsoncComments(raw) : raw;
  return JSON.parse(text) as T;
}

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
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
}

function discoverWorkerSrcFiles(appDir: string): string[] {
  const files: string[] = [];
  collectTsFiles(path.join(appDir, "src"), files);
  return files.filter((filePath) => !filePath.endsWith(".test.ts"));
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

function namedSpecifiersHaveValue(inner: string): boolean {
  for (const part of inner.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    if (/^type\s+\S/.test(trimmed)) {
      continue;
    }
    return true;
  }
  return false;
}

function clauseIsValueImport(clause: string): boolean {
  const trimmed = clause.trim();
  if (!trimmed) {
    return true;
  }
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  const before =
    braceStart >= 0 ? trimmed.slice(0, braceStart).replace(/,\s*$/, "").trim() : trimmed;
  if (before.length > 0) {
    return true;
  }
  if (braceStart >= 0 && braceEnd > braceStart) {
    return namedSpecifiersHaveValue(trimmed.slice(braceStart + 1, braceEnd));
  }
  return true;
}

function scanImportAt(text: string, importIndex: number): { valueKernel: boolean; end: number } {
  let i = skipWs(text, importIndex + "import".length);

  const sideEffect = parseQuoted(text, i);
  if (sideEffect) {
    return { valueKernel: KERNEL_SPECS.has(sideEffect.value), end: sideEffect.end };
  }

  if (text[i] === "(") {
    const inner = skipWs(text, i + 1);
    const spec = parseQuoted(text, inner);
    if (spec) {
      return { valueKernel: KERNEL_SPECS.has(spec.value), end: spec.end };
    }
    return { valueKernel: false, end: i + 1 };
  }

  let typeOnly = false;
  if (startsAtWord(text, i, "type")) {
    const afterType = skipWs(text, i + 4);
    if (!startsAtWord(text, afterType, "from")) {
      typeOnly = true;
      i = afterType;
    }
  }

  const clauseStart = i;
  let depth = 0;
  while (i < text.length) {
    const quoted = parseQuoted(text, i);
    if (quoted) {
      i = quoted.end;
      continue;
    }
    const ch = text[i];
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && startsAtWord(text, i, "from")) {
      break;
    }
    i += 1;
  }

  const clause = text.slice(clauseStart, i);
  const afterFrom = skipWs(text, i + 4);
  const spec = parseQuoted(text, afterFrom);
  if (!spec) {
    return { valueKernel: false, end: importIndex + "import".length };
  }
  if (!KERNEL_SPECS.has(spec.value) || typeOnly) {
    return { valueKernel: false, end: spec.end };
  }
  return { valueKernel: clauseIsValueImport(clause), end: spec.end };
}

function hasValueKernelImport(src: string): boolean {
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
      const scanned = scanImportAt(text, i);
      if (scanned.valueKernel) {
        return true;
      }
      i = scanned.end;
      continue;
    }
    i += 1;
  }
  return false;
}

function workerHasValueKernelImport(appDir: string): boolean {
  for (const filePath of discoverWorkerSrcFiles(appDir)) {
    if (hasValueKernelImport(fs.readFileSync(filePath, "utf8"))) {
      return true;
    }
  }
  return false;
}

function hasAlsCompatibilityFlag(flags: WranglerConfig["compatibility_flags"]): boolean {
  if (!Array.isArray(flags)) {
    return false;
  }
  return flags.some((flag) => ALS_FLAGS.has(flag));
}

function discoverWranglerApps(
  root: string,
): { appName: string; appDir: string; wranglerPath: string }[] {
  const appsDir = path.join(root, "apps");
  if (!fs.existsSync(appsDir)) {
    return [];
  }

  const found: { appName: string; appDir: string; wranglerPath: string }[] = [];
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
      found.push({ appName, appDir, wranglerPath });
    }
  }
  return found;
}

function validateWorker(
  appName: string,
  appDir: string,
  wranglerPath: string,
): WorkerConfigViolation[] {
  const violations: WorkerConfigViolation[] = [];
  const label = `apps/${appName}`;

  let wrangler: WranglerConfig;
  try {
    wrangler = parseJsonFile<WranglerConfig>(wranglerPath);
  } catch {
    violations.push({ app: label, message: "wrangler config is not valid JSON/JSONC" });
    return violations;
  }

  if (wrangler.workers_dev !== false) {
    violations.push({
      app: label,
      message: "workers_dev must be explicitly false",
    });
  }

  if (!("preview_urls" in wrangler)) {
    violations.push({
      app: label,
      message: "preview_urls must be set explicitly (true or false)",
    });
  }

  const metaPath = path.join(appDir, "worker.meta.json");
  if (!fs.existsSync(metaPath)) {
    violations.push({ app: label, message: "missing worker.meta.json" });
    return violations;
  }

  let meta: WorkerMeta;
  try {
    meta = parseJsonFile<WorkerMeta>(metaPath);
  } catch {
    violations.push({ app: label, message: "worker.meta.json is not valid JSON" });
    return violations;
  }

  if (typeof meta.class !== "string" || meta.class.length === 0) {
    violations.push({ app: label, message: "worker.meta.json must include a class field" });
    return violations;
  }

  if (!ALLOWED_CLASSES.has(meta.class)) {
    violations.push({
      app: label,
      message: `unknown worker class "${meta.class}" (allowed: global-no-pii, regional)`,
    });
    return violations;
  }

  if (meta.class === "global-no-pii" && wrangler.preview_urls !== true) {
    violations.push({
      app: label,
      message: "global-no-pii Workers must set preview_urls to true",
    });
  }

  if (meta.class === "regional" && wrangler.preview_urls !== false) {
    violations.push({
      app: label,
      message: "regional Workers must set preview_urls to false",
    });
  }

  if (
    workerHasValueKernelImport(appDir) &&
    !hasAlsCompatibilityFlag(wrangler.compatibility_flags)
  ) {
    violations.push({
      app: label,
      message:
        "value import of @community-hub/kernel requires compatibility_flags to include nodejs_als or nodejs_compat",
    });
  }

  return violations;
}

/** Scan Worker apps under `root` (defaults to `process.cwd()`). */
export function check(root: string = process.cwd()): CheckResult {
  const resolvedRoot = path.resolve(root);
  const violations: WorkerConfigViolation[] = [];

  for (const { appName, appDir, wranglerPath } of discoverWranglerApps(resolvedRoot)) {
    violations.push(...validateWorker(appName, appDir, wranglerPath));
  }

  return { ok: violations.length === 0, violations };
}
