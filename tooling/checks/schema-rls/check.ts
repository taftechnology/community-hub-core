import fs from "node:fs";
import path from "node:path";

/** Provisional until `packages/db` lands — see README.md */
export const SQL_SEARCH_DIRS = ["packages/db/migrations", "packages/db/schema"] as const;

export type SchemaRlsViolation = {
  file: string;
  table: string;
  message: string;
};

export type CheckResult = {
  ok: boolean;
  violations: SchemaRlsViolation[];
  appTableCount: number;
  /** Set when `appTableCount` is zero so live runs are not a silent no-op. */
  notice?: string;
};

const CREATE_APP_TABLE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:ONLY\s+)?(?:app|"app")\.("?[A-Za-z_][\w$]*"?)\s*\(/gi;

function unquoteIdent(ident: string): string {
  return ident.startsWith('"') && ident.endsWith('"') ? ident.slice(1, -1) : ident;
}

function discoverSqlFiles(root: string): string[] {
  const files: string[] = [];
  for (const relDir of SQL_SEARCH_DIRS) {
    collectSqlUnder(path.join(root, relDir), files);
  }
  return files;
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

function extractCreateTableBody(sql: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return sql.slice(openParenIndex + 1, i);
      }
    }
  }
  return "";
}

function tableHasOrgId(columnList: string): boolean {
  return /\borg_id\b/i.test(columnList);
}

function tableRefPattern(tableName: string): RegExp {
  const escaped = tableName.replace(/"/g, "");
  return new RegExp(
    String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?(?:app\.${escaped}|"app"\."${escaped}")\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b`,
    "i",
  );
}

function findAppTables(sql: string): { table: string; columnList: string }[] {
  const tables: { table: string; columnList: string }[] = [];
  CREATE_APP_TABLE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREATE_APP_TABLE.exec(sql)) !== null) {
    const rawName = match[1];
    if (rawName === undefined) {
      continue;
    }
    const table = unquoteIdent(rawName);
    const openParen = match.index + match[0].length - 1;
    const columnList = extractCreateTableBody(sql, openParen);
    tables.push({ table, columnList });
  }
  return tables;
}

function validateSqlFile(filePath: string, root: string, sql: string): SchemaRlsViolation[] {
  const relFile = path.relative(root, filePath);
  const violations: SchemaRlsViolation[] = [];

  for (const { table, columnList } of findAppTables(sql)) {
    if (!tableHasOrgId(columnList)) {
      violations.push({
        file: relFile,
        table,
        message: "app-schema table must define org_id",
      });
    }
    if (!tableRefPattern(table).test(sql)) {
      violations.push({
        file: relFile,
        table,
        message: "app-schema table must have FORCE ROW LEVEL SECURITY",
      });
    }
  }

  return violations;
}

/** Scan provisional SQL globs under `root` (defaults to `process.cwd()`). */
export function check(root: string = process.cwd()): CheckResult {
  const resolvedRoot = path.resolve(root);
  const sqlFiles = discoverSqlFiles(resolvedRoot);
  const violations: SchemaRlsViolation[] = [];
  let appTableCount = 0;

  for (const filePath of sqlFiles) {
    const sql = fs.readFileSync(filePath, "utf8");
    appTableCount += findAppTables(sql).length;
    violations.push(...validateSqlFile(filePath, resolvedRoot, sql));
  }

  const base = {
    ok: violations.length === 0,
    violations,
    appTableCount,
  };

  if (appTableCount === 0) {
    return {
      ...base,
      notice: `schema-rls: zero app-schema tables found under ${SQL_SEARCH_DIRS.join(", ")} (provisional glob)`,
    };
  }

  return base;
}
