import fs from "node:fs";
import path from "node:path";

export const EVENT_NAME_SEARCH_PARENTS = ["packages", "apps"] as const;
export const EVENT_NAME_SEARCH_TREES = ["modules"] as const;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "test",
  "tests",
  ".turbo",
  "fixtures",
]);

/** Keep in sync with `AUDIT_NAME_RE` in `@community-hub/kernel/module` (selftest asserts `.source`). */
export const AUDIT_NAME_RE =
  /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

const EMPTY_NOTICE =
  "event-names: zero defineModule/defineEvent declarations found under packages/*/src, apps/*/src, modules/**";

export type EventNameViolation = {
  file: string;
  message: string;
};

export type CheckResult = {
  ok: boolean;
  violations: EventNameViolation[];
  declarationCount: number;
  notice?: string;
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

function discoverTsFiles(root: string): string[] {
  const files: string[] = [];
  for (const parent of EVENT_NAME_SEARCH_PARENTS) {
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
  for (const tree of EVENT_NAME_SEARCH_TREES) {
    collectFiles(path.join(root, tree), ".ts", files);
  }
  return files.filter((filePath) => !filePath.endsWith(".test.ts"));
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

function matchingDelim(text: string, openIndex: number, open: string, close: string): number {
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
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function skipWs(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i] ?? "")) {
    i += 1;
  }
  return i;
}

function parseObjectProps(objectText: string): Map<string, string> | null {
  const trimmed = objectText.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  const close = matchingDelim(trimmed, 0, "{", "}");
  if (close < 0) {
    return null;
  }
  const inner = trimmed.slice(1, close);
  const props = new Map<string, string>();
  let i = 0;
  while (i < inner.length) {
    i = skipWs(inner, i);
    if (i >= inner.length) {
      break;
    }
    if (inner[i] === ",") {
      i += 1;
      continue;
    }
    const keyMatch = /^[A-Za-z_$][\w$]*/.exec(inner.slice(i));
    if (!keyMatch) {
      return null;
    }
    const key = keyMatch[0];
    i += key.length;
    i = skipWs(inner, i);
    if (inner[i] !== ":") {
      return null;
    }
    i += 1;
    i = skipWs(inner, i);
    const valueStart = i;
    let parens = 0;
    let braces = 0;
    let brackets = 0;
    let state: "code" | "sq" | "dq" | "tmpl" = "code";
    while (i < inner.length) {
      const ch = inner[i];
      const next = inner[i + 1];
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
      if (ch === "(") {
        parens += 1;
      } else if (ch === ")") {
        parens -= 1;
      } else if (ch === "{") {
        braces += 1;
      } else if (ch === "}") {
        braces -= 1;
      } else if (ch === "[") {
        brackets += 1;
      } else if (ch === "]") {
        brackets -= 1;
      } else if (ch === "," && parens === 0 && braces === 0 && brackets === 0) {
        break;
      }
      i += 1;
    }
    props.set(key, inner.slice(valueStart, i).trim());
  }
  return props;
}

function parseStringLiteral(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return null;
  }
  const quote = trimmed[0];
  if (quote !== "'" && quote !== '"') {
    return null;
  }
  if (trimmed[trimmed.length - 1] !== quote) {
    return null;
  }
  return trimmed.slice(1, -1);
}

function splitTopLevelArgs(inner: string): string[] {
  const args: string[] = [];
  let current = "";
  let parens = 0;
  let braces = 0;
  let brackets = 0;
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
      parens += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      parens -= 1;
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
    if (ch === "[") {
      brackets += 1;
      current += ch;
      continue;
    }
    if (ch === "]") {
      brackets -= 1;
      current += ch;
      continue;
    }
    if (ch === "," && parens === 0 && braces === 0 && brackets === 0) {
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

function parseStringLiteralArray(value: string): string[] | "unreadable" {
  const trimmed = value.trim().replace(/\s+as\s+const\s*$/, "");
  if (!trimmed.startsWith("[")) {
    return "unreadable";
  }
  const close = matchingDelim(trimmed, 0, "[", "]");
  if (close < 0) {
    return "unreadable";
  }
  const inner = trimmed.slice(1, close).trim();
  if (inner === "") {
    return [];
  }
  const parts = splitTopLevelArgs(inner);
  const names: string[] = [];
  for (const part of parts) {
    const lit = parseStringLiteral(part);
    if (lit === null) {
      return "unreadable";
    }
    names.push(lit);
  }
  return names;
}

type FileScan = {
  names: Set<string>;
  auditActions: Set<string>;
  auditPurposes: Set<string>;
  declarationCount: number;
  violations: EventNameViolation[];
};

function isCalleeFunctionDefinition(text: string, calleeIndex: number): boolean {
  const prefix = text.slice(Math.max(0, calleeIndex - 48), calleeIndex);
  return /(?:declare\s+)?(?:export\s+)?function\s*$/.test(prefix);
}

function forEachStringLiteralCall(
  text: string,
  callee: string,
  onCall: (literal: string | null, unclosed: boolean) => void,
): void {
  const re = new RegExp(`\\b${callee}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const calleeIndex = match.index ?? 0;
    if (isCalleeFunctionDefinition(text, calleeIndex)) {
      continue;
    }
    const open = calleeIndex + match[0].length - 1;
    const close = matchingDelim(text, open, "(", ")");
    if (close < 0) {
      onCall(null, true);
      break;
    }
    const inner = text.slice(open + 1, close).trim();
    re.lastIndex = close + 1;
    const args = splitTopLevelArgs(inner);
    const first = args[0];
    if (first === undefined) {
      onCall(null, false);
      continue;
    }
    onCall(parseStringLiteral(first), false);
  }
}

function forEachObjectCall(
  text: string,
  callee: string,
  onCall: (objectLiteral: string, unclosed: boolean) => void,
): void {
  const re = new RegExp(`\\b${callee}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingDelim(text, open, "(", ")");
    if (close < 0) {
      onCall("", true);
      break;
    }
    const inner = text.slice(open + 1, close).trim();
    re.lastIndex = close + 1;
    if (!inner.startsWith("{")) {
      continue;
    }
    onCall(inner, false);
  }
}

function scanAuditDefine(
  relFile: string,
  text: string,
  callee: "defineAuditAction" | "defineAuditPurpose",
  auditNames: Set<string>,
  violations: EventNameViolation[],
): void {
  forEachStringLiteralCall(text, callee, (lit, unclosed) => {
    if (unclosed || lit === null) {
      violations.push({
        file: relFile,
        message: `${callee} name is not a string literal`,
      });
      return;
    }
    if (!AUDIT_NAME_RE.test(lit)) {
      violations.push({
        file: relFile,
        message: `${callee} name "${lit}" is invalid`,
      });
      return;
    }
    auditNames.add(lit);
  });
}

function scanFile(relFile: string, raw: string): FileScan {
  const text = stripTsComments(raw);
  const names = new Set<string>();
  const auditActions = new Set<string>();
  const auditPurposes = new Set<string>();
  const violations: EventNameViolation[] = [];
  let declarationCount = 0;

  forEachObjectCall(text, "defineEvent", (objectLiteral, unclosed) => {
    declarationCount += 1;
    if (unclosed) {
      violations.push({
        file: relFile,
        message: "defineEvent name is not a string literal",
      });
      return;
    }
    const props = parseObjectProps(objectLiteral);
    const nameValue = props?.get("name");
    const lit = nameValue === undefined ? null : parseStringLiteral(nameValue);
    if (lit === null) {
      violations.push({
        file: relFile,
        message: "defineEvent name is not a string literal",
      });
      return;
    }
    names.add(lit);
  });

  forEachObjectCall(text, "defineModule", (objectLiteral, unclosed) => {
    declarationCount += 1;
    if (unclosed) {
      violations.push({
        file: relFile,
        message: "publishes contains a name that is not a string literal",
      });
      return;
    }
    const props = parseObjectProps(objectLiteral);
    if (props === null) {
      violations.push({
        file: relFile,
        message: "publishes contains a name that is not a string literal",
      });
      return;
    }
    const publishesValue = props.get("publishes");
    if (publishesValue === undefined) {
      return;
    }
    const parsed = parseStringLiteralArray(publishesValue);
    if (parsed === "unreadable") {
      violations.push({
        file: relFile,
        message: "publishes contains a name that is not a string literal",
      });
      return;
    }
    for (const name of parsed) {
      names.add(name);
    }
  });

  scanAuditDefine(relFile, text, "defineAuditAction", auditActions, violations);
  scanAuditDefine(relFile, text, "defineAuditPurpose", auditPurposes, violations);

  return { names, auditActions, auditPurposes, declarationCount, violations };
}

/** Scan `defineEvent` / `defineModule` under `root` (defaults to `process.cwd()`). */
export function check(root: string = process.cwd()): CheckResult {
  const resolvedRoot = path.resolve(root);
  const files = discoverTsFiles(resolvedRoot);
  const violations: EventNameViolation[] = [];
  const namesToFiles = new Map<string, string[]>();
  const auditActionsToFiles = new Map<string, string[]>();
  const auditPurposesToFiles = new Map<string, string[]>();
  let declarationCount = 0;

  for (const filePath of files) {
    const rel = posixRel(resolvedRoot, filePath);
    const scan = scanFile(rel, fs.readFileSync(filePath, "utf8"));
    declarationCount += scan.declarationCount;
    violations.push(...scan.violations);
    for (const name of scan.names) {
      const holders = namesToFiles.get(name) ?? [];
      holders.push(rel);
      namesToFiles.set(name, holders);
    }
    for (const name of scan.auditActions) {
      const holders = auditActionsToFiles.get(name) ?? [];
      holders.push(rel);
      auditActionsToFiles.set(name, holders);
    }
    for (const name of scan.auditPurposes) {
      const holders = auditPurposesToFiles.get(name) ?? [];
      holders.push(rel);
      auditPurposesToFiles.set(name, holders);
    }
  }

  for (const [name, holders] of namesToFiles) {
    if (holders.length < 2) {
      continue;
    }
    for (const file of holders) {
      violations.push({
        file,
        message: `duplicate event name "${name}"`,
      });
    }
  }

  for (const [name, holders] of auditActionsToFiles) {
    if (holders.length < 2) {
      continue;
    }
    for (const file of holders) {
      violations.push({
        file,
        message: `duplicate audit action name "${name}"`,
      });
    }
  }

  for (const [name, holders] of auditPurposesToFiles) {
    if (holders.length < 2) {
      continue;
    }
    for (const file of holders) {
      violations.push({
        file,
        message: `duplicate audit purpose name "${name}"`,
      });
    }
  }

  if (declarationCount === 0) {
    return {
      ok: false,
      violations,
      declarationCount,
      notice: EMPTY_NOTICE,
    };
  }

  return {
    ok: violations.length === 0,
    violations,
    declarationCount,
  };
}
