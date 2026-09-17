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
};

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

function discoverWranglerApps(root: string): { appName: string; appDir: string; wranglerPath: string }[] {
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
