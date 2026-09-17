import fs from "node:fs";
import path from "node:path";

/** Provisional until `packages/db` lands — see README.md */
export const CLASSIFICATION_MAP_REL = "packages/db/column-classifications.json" as const;
export const QUERY_SQL_DIR = "packages/db/queries" as const;

/** Field-encrypted classes per architecture §12.1 — not used in SQL filters/sorts/aggregates. */
export const ENCRYPTED_CLASSES = new Set(["confidential", "restricted"]);

export type EncryptedQueryViolation = {
  file: string;
  column: string;
  classification: string;
  context: "WHERE" | "ORDER BY" | "GROUP BY" | "aggregate";
  message: string;
};

export type CheckResult = {
  ok: boolean;
  violations: EncryptedQueryViolation[];
  queryFileCount: number;
  notice?: string;
};

type ColumnRef = {
  schema?: string;
  table?: string;
  column: string;
};

function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      out += quote;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i - 1] !== "\\") {
          out += sql[i];
          i += 1;
          break;
        }
        out += sql[i];
        i += 1;
      }
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

function collectSqlUnder(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSqlUnder(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".sql")) {
      out.push(full);
    }
  }
}

function discoverQuerySqlFiles(root: string): string[] {
  const files: string[] = [];
  collectSqlUnder(path.join(root, QUERY_SQL_DIR), files);
  return files;
}

function loadClassificationMap(root: string): Record<string, string> | null {
  const mapPath = path.join(root, CLASSIFICATION_MAP_REL);
  if (!fs.existsSync(mapPath)) {
    return null;
  }
  const raw = fs.readFileSync(mapPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CLASSIFICATION_MAP_REL} must be a JSON object`);
  }
  return parsed as Record<string, string>;
}

function parseColumnRef(token: string): ColumnRef | null {
  const cleaned = token
    .replace(/\s+(ASC|DESC)(\s+NULLS\s+(FIRST|LAST))?/gi, "")
    .trim();
  if (cleaned.length === 0) {
    return null;
  }
  if (/^(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(cleaned)) {
    return null;
  }
  const identPart = cleaned.split(/\s+/)[0] ?? cleaned;
  const parts = identPart.split(".").map((p) => p.replace(/^"|"$/g, ""));
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    return { schema: parts[0], table: parts[1], column: parts[2] };
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { table: parts[0], column: parts[1] };
  }
  if (parts.length === 1 && parts[0]) {
    return { column: parts[0] };
  }
  return null;
}

function resolveClassification(
  ref: ColumnRef,
  map: Record<string, string>,
): { key: string; classification: string } | null {
  if (ref.schema && ref.table) {
    const key = `${ref.schema}.${ref.table}.${ref.column}`;
    const classification = map[key];
    return classification !== undefined ? { key, classification } : null;
  }
  if (ref.table) {
    const key = Object.keys(map).find((k) => {
      const segments = k.split(".");
      return segments[1] === ref.table && segments[2] === ref.column;
    });
    if (key && map[key] !== undefined) {
      return { key, classification: map[key] };
    }
    return null;
  }
  const matches = Object.keys(map).filter((k) => k.endsWith(`.${ref.column}`));
  const key = matches[0];
  if (matches.length === 1 && key !== undefined) {
    const classification = map[key];
    if (classification !== undefined) {
      return { key, classification };
    }
  }
  return null;
}

function clauseBody(sql: string, clause: string): string | null {
  const re = new RegExp(
    String.raw`\b${clause}\s+([\s\S]+?)(?=\b(GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|FETCH|FOR|;\s*$|\)\s*;?\s*$)|$)`,
    "i",
  );
  const match = re.exec(sql);
  return match?.[1]?.trim() ?? null;
}

function tokensFromList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function refsFromWhere(whereBody: string): ColumnRef[] {
  const refs: ColumnRef[] = [];
  const chunks = whereBody.split(/\b(AND|OR)\b/i);
  for (const chunk of chunks) {
    if (/^(AND|OR)$/i.test(chunk.trim())) {
      continue;
    }
    const cond = chunk.trim();
    const lhs = cond.split(/\s*(=|<>|!=|<|>|<=|>=|LIKE|ILIKE|IN|IS)\s/i)[0]?.trim();
    if (!lhs) {
      continue;
    }
    const ref = parseColumnRef(lhs);
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
}

function refsFromAggregate(sql: string): ColumnRef[] {
  const refs: ColumnRef[] = [];
  const re = /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(\s*(DISTINCT\s+)?([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const arg = match[3]?.trim();
    if (!arg || arg === "*") {
      continue;
    }
    const ref = parseColumnRef(arg);
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
}

function scanSqlFile(
  filePath: string,
  root: string,
  sql: string,
  map: Record<string, string>,
): EncryptedQueryViolation[] {
  const relFile = path.relative(root, filePath);
  const normalized = stripSqlComments(sql);
  const violations: EncryptedQueryViolation[] = [];
  const seen = new Set<string>();

  function record(ref: ColumnRef, context: EncryptedQueryViolation["context"]): void {
    const resolved = resolveClassification(ref, map);
    if (!resolved) {
      return;
    }
    if (!ENCRYPTED_CLASSES.has(resolved.classification)) {
      return;
    }
    const dedupe = `${relFile}:${resolved.key}:${context}`;
    if (seen.has(dedupe)) {
      return;
    }
    seen.add(dedupe);
    violations.push({
      file: relFile,
      column: resolved.key,
      classification: resolved.classification,
      context,
      message: `encrypted column must not appear in ${context}`,
    });
  }

  const whereBody = clauseBody(normalized, "WHERE");
  if (whereBody) {
    for (const ref of refsFromWhere(whereBody)) {
      record(ref, "WHERE");
    }
  }

  const groupBody = clauseBody(normalized, "GROUP BY");
  if (groupBody) {
    for (const token of tokensFromList(groupBody)) {
      const ref = parseColumnRef(token);
      if (ref) {
        record(ref, "GROUP BY");
      }
    }
  }

  const orderBody = clauseBody(normalized, "ORDER BY");
  if (orderBody) {
    for (const token of tokensFromList(orderBody)) {
      const ref = parseColumnRef(token);
      if (ref) {
        record(ref, "ORDER BY");
      }
    }
  }

  for (const ref of refsFromAggregate(normalized)) {
    record(ref, "aggregate");
  }

  return violations;
}

/** Scan provisional query SQL and classification map under `root` (defaults to `process.cwd()`). */
export function check(root: string = process.cwd()): CheckResult {
  const resolvedRoot = path.resolve(root);
  const queryFiles = discoverQuerySqlFiles(resolvedRoot);
  const map = loadClassificationMap(resolvedRoot);
  const classifications = map ?? {};
  const violations: EncryptedQueryViolation[] = [];

  for (const filePath of queryFiles) {
    const sql = fs.readFileSync(filePath, "utf8");
    violations.push(...scanSqlFile(filePath, resolvedRoot, sql, classifications));
  }

  const base = {
    ok: violations.length === 0,
    violations,
    queryFileCount: queryFiles.length,
  };

  if (queryFiles.length === 0) {
    return {
      ...base,
      notice: `encrypted-query: zero SQL query files found under ${QUERY_SQL_DIR} (provisional glob)`,
    };
  }

  return base;
}
