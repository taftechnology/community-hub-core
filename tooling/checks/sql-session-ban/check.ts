import fs from "node:fs";
import path from "node:path";

export const SQL_SEARCH_DIRS = [
  "packages/db/sql",
  "packages/db/drizzle",
  "packages/db/drizzle-test",
] as const;
export const TS_SRC_PARENTS = ["packages", "apps"] as const;
export const TS_TREE_DIRS = ["modules"] as const;
export const MIGRATE_ALLOWLIST = "packages/db/src/migrate.ts";

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "test", "tests", ".turbo"]);

export type SqlSessionBanViolation = {
  file: string;
  message: string;
};

export type CheckResult = {
  ok: boolean;
  violations: SqlSessionBanViolation[];
  scannedFileCount: number;
};

function posixRel(root: string, filePath: string): string {
  return path.relative(root, filePath).replaceAll("\\", "/");
}

function collectFiles(dir: string, suffix: string, out: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      collectFiles(full, suffix, out);
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(full);
    }
  }
}

function discoverSqlFiles(root: string): string[] {
  const files: string[] = [];
  for (const relDir of SQL_SEARCH_DIRS) {
    collectFiles(path.join(root, relDir), ".sql", files);
  }
  return files;
}

function discoverTsFiles(root: string): string[] {
  const files: string[] = [];
  for (const parent of TS_SRC_PARENTS) {
    const parentDir = path.join(root, parent);
    if (!fs.existsSync(parentDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
        continue;
      }
      collectFiles(path.join(parentDir, entry.name, "src"), ".ts", files);
    }
  }
  for (const tree of TS_TREE_DIRS) {
    collectFiles(path.join(root, tree), ".ts", files);
  }
  return files.filter((filePath) => !filePath.endsWith(".test.ts"));
}

function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inSingle) {
      out += ch;
      if (ch === "'" && next === "'") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === "'") {
        inSingle = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
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
      while (i < src.length && !sqlStarSlash(src, i)) {
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

function sqlStarSlash(src: string, i: number): boolean {
  return src[i] === "*" && src[i + 1] === "/";
}

function matchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let state: "code" | "sq" | "dq" | "tmpl" = "code";
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (state !== "code") {
      if (ch === "\\" && next !== undefined) {
        i += 1;
        continue;
      }
      if (state === "sq" && ch === "'") {
        state = "code";
      } else if (state === "dq" && ch === '"') {
        state = "code";
      } else if (state === "tmpl" && ch === "`") {
        state = "code";
      }
      continue;
    }
    if (ch === "'") {
      state = "sq";
      continue;
    }
    if (ch === '"') {
      state = "dq";
      continue;
    }
    if (ch === "`") {
      state = "tmpl";
      continue;
    }
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function splitTopLevelArgs(inner: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let braces = 0;
  let state: "code" | "sq" | "dq" | "tmpl" = "code";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    const next = inner[i + 1];
    if (state !== "code") {
      current += ch;
      if (ch === "\\" && next !== undefined) {
        current += next;
        i += 1;
        continue;
      }
      if (state === "sq" && ch === "'") {
        state = "code";
      } else if (state === "dq" && ch === '"') {
        state = "code";
      } else if (state === "tmpl" && ch === "`") {
        state = "code";
      }
      continue;
    }
    if (ch === "'") {
      state = "sq";
      current += ch;
      continue;
    }
    if (ch === '"') {
      state = "dq";
      current += ch;
      continue;
    }
    if (ch === "`") {
      state = "tmpl";
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === "{") {
      braces += 1;
      current += ch;
      continue;
    }
    if (ch === "}") {
      braces -= 1;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0 && braces === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    args.push(current.trim());
  }
  return args;
}

function setConfigCalls(text: string): string[][] {
  const calls: string[][] = [];
  const re = /set_config\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingParen(text, open);
    if (close < 0) {
      continue;
    }
    calls.push(splitTopLevelArgs(text.slice(open + 1, close)));
    re.lastIndex = close + 1;
  }
  return calls;
}

function isFalseLocal(arg: string): boolean {
  return /^(?:\$\{\s*)?false(?:\s*\})?$/i.test(arg.trim());
}

function isRoleName(arg: string): boolean {
  return /^(['"])role\1$/i.test(arg.trim());
}

/** Session SET of a GUC: first word of a statement, then name = or name TO. */
const STATEMENT_SET_SETTING =
  /(?:^|;)\s*SET\s+(?!ROLE\b|SESSION\b|LOCAL\b)(?!(?:app\.|"app"\s*\.))(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))*\s*(?:=|\bTO\b)/gi;

function skipTemplateExpression(src: string, from: number): number {
  let depth = 1;
  let state: "code" | "sq" | "dq" | "tmpl" = "code";
  let i = from;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    const next = src[i + 1];
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
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
    }
    i += 1;
  }
  return i;
}

function extractTsStringContents(src: string): string[] {
  const contents: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      let body = "";
      while (i < src.length) {
        const cur = src[i];
        const next = src[i + 1];
        if (cur === "\\" && next !== undefined) {
          body += cur + next;
          i += 2;
          continue;
        }
        if (cur === quote) {
          i += 1;
          break;
        }
        body += cur;
        i += 1;
      }
      contents.push(body);
      continue;
    }
    if (ch === "`") {
      i += 1;
      let body = "";
      while (i < src.length) {
        const cur = src[i];
        const next = src[i + 1];
        if (cur === "\\" && next !== undefined) {
          body += cur + next;
          i += 2;
          continue;
        }
        if (cur === "`") {
          i += 1;
          break;
        }
        if (cur === "$" && next === "{") {
          const end = skipTemplateExpression(src, i + 2);
          body += src.slice(i, end);
          i = end;
          continue;
        }
        body += cur;
        i += 1;
      }
      contents.push(body);
      continue;
    }
    i += 1;
  }
  return contents;
}

function hasStatementSetSetting(text: string): boolean {
  STATEMENT_SET_SETTING.lastIndex = 0;
  return STATEMENT_SET_SETTING.test(text);
}

function pushIfMatch(
  violations: SqlSessionBanViolation[],
  file: string,
  text: string,
  pattern: RegExp,
  message: string,
): void {
  pattern.lastIndex = 0;
  if (pattern.test(text)) {
    violations.push({ file, message });
  }
}

function scanSql(file: string, raw: string, violations: SqlSessionBanViolation[]): void {
  const text = stripSqlComments(raw);
  pushIfMatch(violations, file, text, /\bPASSWORD\b/i, "PASSWORD is forbidden in SQL");
  scanShared(file, text, violations, false);
  if (hasStatementSetSetting(text)) {
    violations.push({
      file,
      message: `session SET of a setting is forbidden outside ${MIGRATE_ALLOWLIST}`,
    });
  }
}

function scanTs(
  file: string,
  raw: string,
  violations: SqlSessionBanViolation[],
  allowRoleSwitch: boolean,
): void {
  const text = stripTsComments(raw);
  scanShared(file, text, violations, allowRoleSwitch);
  if (!allowRoleSwitch && extractTsStringContents(text).some(hasStatementSetSetting)) {
    violations.push({
      file,
      message: `session SET of a setting is forbidden outside ${MIGRATE_ALLOWLIST}`,
    });
  }
}

function scanShared(
  file: string,
  text: string,
  violations: SqlSessionBanViolation[],
  allowRoleSwitch: boolean,
): void {
  pushIfMatch(
    violations,
    file,
    text,
    /\bSET\s+SESSION\s+AUTHORIZATION\b/i,
    "SET SESSION AUTHORIZATION is forbidden",
  );
  pushIfMatch(
    violations,
    file,
    text,
    /\bSET\s+SESSION(?!\s+AUTHORIZATION)\b/i,
    "SET SESSION is forbidden",
  );
  pushIfMatch(violations, file, text, /\bSET\s+LOCAL\b/i, "SET LOCAL is forbidden");
  pushIfMatch(
    violations,
    file,
    text,
    /\bSET\s+(?:(?:LOCAL|SESSION)\s+)?(?:app\.|"app"\s*\.)/i,
    "SET of app.* is forbidden",
  );
  pushIfMatch(
    violations,
    file,
    text,
    /\bRESET\s+(?:app\.|"app"\s*\.)/i,
    "RESET of app.* is forbidden",
  );

  if (!allowRoleSwitch) {
    pushIfMatch(
      violations,
      file,
      text,
      /\bSET\s+ROLE\b/i,
      `SET ROLE is forbidden outside ${MIGRATE_ALLOWLIST}`,
    );
  }

  for (const args of setConfigCalls(text)) {
    const first = args[0];
    const third = args[2];
    if (first !== undefined && isRoleName(first) && !allowRoleSwitch) {
      violations.push({
        file,
        message: `set_config('role', ...) is forbidden outside ${MIGRATE_ALLOWLIST}`,
      });
    }
    if (third !== undefined && isFalseLocal(third)) {
      violations.push({
        file,
        message: "set_config(..., false) is forbidden",
      });
    }
  }
}

/** Scan SQL and production TypeScript under `root` (defaults to `process.cwd()`). */
export function check(root: string = process.cwd()): CheckResult {
  const resolvedRoot = path.resolve(root);
  const sqlFiles = discoverSqlFiles(resolvedRoot);
  const tsFiles = discoverTsFiles(resolvedRoot);
  const violations: SqlSessionBanViolation[] = [];

  for (const filePath of sqlFiles) {
    scanSql(posixRel(resolvedRoot, filePath), fs.readFileSync(filePath, "utf8"), violations);
  }

  for (const filePath of tsFiles) {
    const rel = posixRel(resolvedRoot, filePath);
    scanTs(rel, fs.readFileSync(filePath, "utf8"), violations, rel === MIGRATE_ALLOWLIST);
  }

  return {
    ok: violations.length === 0,
    violations,
    scannedFileCount: sqlFiles.length + tsFiles.length,
  };
}
