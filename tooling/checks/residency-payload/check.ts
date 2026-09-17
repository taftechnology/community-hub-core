import fs from "node:fs";
import path from "node:path";

/** Provisional until queue/workflow payload schemas land — see README.md */
export const PAYLOAD_SEARCH_DIRS = [
  "apps/jobs/queue-payloads",
  "apps/jobs/workflow-payloads",
] as const;

/** Personal-data field names that must not appear in queue or workflow payloads (architecture §7.3 rule 2). */
export const PERSONAL_DATA_KEYS = new Set(["name", "email"]);

export type ResidencyPayloadViolation = {
  file: string;
  key: string;
  message: string;
};

export type CheckResult = {
  ok: boolean;
  violations: ResidencyPayloadViolation[];
  payloadFileCount: number;
  /** Set when `payloadFileCount` is zero so live runs are not a silent no-op. */
  notice?: string;
};

function collectJsonUnder(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonUnder(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
}

function discoverPayloadJsonFiles(root: string): string[] {
  const files: string[] = [];
  for (const relDir of PAYLOAD_SEARCH_DIRS) {
    collectJsonUnder(path.join(root, relDir), files);
  }
  return files;
}

function findPersonalDataKeys(
  value: unknown,
  pathKeys: string[],
  out: string[],
): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      findPersonalDataKeys(item, pathKeys, out);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PERSONAL_DATA_KEYS.has(key)) {
      const dotted = [...pathKeys, key].join(".");
      out.push(dotted.length > 0 ? dotted : key);
    }
    findPersonalDataKeys(nested, [...pathKeys, key], out);
  }
}

function scanPayloadFile(filePath: string, root: string): ResidencyPayloadViolation[] {
  const relFile = path.relative(root, filePath);
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [
      {
        file: relFile,
        key: "(file)",
        message: "payload must be valid JSON",
      },
    ];
  }

  const keys: string[] = [];
  findPersonalDataKeys(parsed, [], keys);
  const unique = [...new Set(keys)];

  return unique.map((key) => ({
    file: relFile,
    key,
    message: "queue and workflow payloads must not contain personal data fields (IDs in, status out)",
  }));
}

/** Scan provisional queue/workflow payload JSON under `root` (defaults to `process.cwd()`). */
export function check(root: string = process.cwd()): CheckResult {
  const resolvedRoot = path.resolve(root);
  const payloadFiles = discoverPayloadJsonFiles(resolvedRoot);
  const violations: ResidencyPayloadViolation[] = [];

  for (const filePath of payloadFiles) {
    violations.push(...scanPayloadFile(filePath, resolvedRoot));
  }

  const base = {
    ok: violations.length === 0,
    violations,
    payloadFileCount: payloadFiles.length,
  };

  if (payloadFiles.length === 0) {
    return {
      ...base,
      notice: `residency-payload: zero payload JSON files found under ${PAYLOAD_SEARCH_DIRS.join(", ")} (provisional glob)`,
    };
  }

  return base;
}
