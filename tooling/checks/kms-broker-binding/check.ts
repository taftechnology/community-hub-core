import fs from "node:fs";
import path from "node:path";

export type KmsBrokerBindingViolation = {
  app: string;
  message: string;
};

export type CheckResult = {
  ok: boolean;
  violations: KmsBrokerBindingViolation[];
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

function parseWranglerConfig(appDir: string): unknown {
  const jsoncPath = path.join(appDir, "wrangler.jsonc");
  const jsonPath = path.join(appDir, "wrangler.json");
  const filePath = fs.existsSync(jsoncPath) ? jsoncPath : fs.existsSync(jsonPath) ? jsonPath : null;
  if (!filePath) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const text = filePath.endsWith(".jsonc") ? stripJsoncComments(raw) : raw;
  return JSON.parse(text) as unknown;
}

function walkStrings(value: unknown, onString: (s: string) => void): void {
  if (typeof value === "string") {
    onString(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkStrings(item, onString);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      walkStrings(v, onString);
    }
  }
}

function configScopes(config: Record<string, unknown>): Record<string, unknown>[] {
  const scopes: Record<string, unknown>[] = [config];
  const env = config.env;
  if (env !== null && typeof env === "object" && !Array.isArray(env)) {
    for (const block of Object.values(env as Record<string, unknown>)) {
      if (block !== null && typeof block === "object" && !Array.isArray(block)) {
        scopes.push(block as Record<string, unknown>);
      }
    }
  }
  return scopes;
}

function validateBrokerEntry(entry: unknown): { ok: true } | { ok: false; message: string } {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, message: "vpc_services entry must be an object" };
  }
  const obj = entry as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const key of keys) {
    if (key !== "binding" && key !== "service_id") {
      return { ok: false, message: `vpc_services entry must not include key "${key}"` };
    }
  }
  if (obj.binding !== "KMS_BROKER") {
    return { ok: false, message: 'vpc_services binding must be "KMS_BROKER"' };
  }
  if (typeof obj.service_id !== "string" || obj.service_id.length === 0) {
    return { ok: false, message: "vpc_services service_id must be a non-empty string" };
  }
  return { ok: true };
}

export function check(root?: string): CheckResult {
  const repoRoot = root ?? process.cwd();
  const appsDir = path.join(repoRoot, "apps");
  const violations: KmsBrokerBindingViolation[] = [];
  const apiVpcEntries: unknown[] = [];

  if (!fs.existsSync(appsDir)) {
    violations.push({ app: "apps", message: "missing apps directory" });
    return { ok: false, violations };
  }

  for (const dirent of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const appName = dirent.name;
    const appDir = path.join(appsDir, appName);
    const appKey = `apps/${appName}`;

    const tomlPath = path.join(appDir, "wrangler.toml");
    if (fs.existsSync(tomlPath)) {
      violations.push({
        app: appKey,
        message: "wrangler.toml is not allowed; use wrangler.jsonc or wrangler.json",
      });
      continue;
    }

    const config = parseWranglerConfig(appDir);
    if (config === null) {
      continue;
    }
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      violations.push({ app: appKey, message: "wrangler config must be a JSON object" });
      continue;
    }
    const configObj = config as Record<string, unknown>;

    walkStrings(configObj, (s) => {
      if (s === "cf1:network") {
        violations.push({
          app: appKey,
          message: "cf1:network bindings are not allowed",
        });
      }
    });

    for (const scope of configScopes(configObj)) {
      if ("vpc_networks" in scope) {
        const vpcNetworks = scope.vpc_networks;
        if (!Array.isArray(vpcNetworks)) {
          violations.push({
            app: appKey,
            message: "vpc_networks must be an array when present",
          });
        } else if (vpcNetworks.length > 0) {
          violations.push({
            app: appKey,
            message: "vpc_networks entries are not allowed",
          });
        }
      }

      if ("vpc_services" in scope) {
        const vpcServices = scope.vpc_services;
        if (!Array.isArray(vpcServices)) {
          violations.push({
            app: appKey,
            message: "vpc_services must be an array when present",
          });
          continue;
        }
        for (const entry of vpcServices) {
          if (appName === "api") {
            apiVpcEntries.push(entry);
          } else {
            violations.push({
              app: appKey,
              message: "only apps/api may declare vpc_services",
            });
          }
        }
      }
    }
  }

  if (apiVpcEntries.length !== 1) {
    violations.push({
      app: "apps/api",
      message: `apps/api must declare exactly one KMS_BROKER vpc_services entry (found ${String(apiVpcEntries.length)})`,
    });
  } else {
    const validated = validateBrokerEntry(apiVpcEntries[0]);
    if (!validated.ok) {
      violations.push({ app: "apps/api", message: validated.message });
    }
  }

  return { ok: violations.length === 0, violations };
}
