import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Static checks over the repository's own source files (not tests, not dist). They keep the
// "admin" view of a child's presence from being passed by accident: the only code that may pass
// childView "admin" is the code that has just asked isCommunityAdmin.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCAN_ROOTS = ["apps", "modules", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".turbo", "drizzle"]);

// Pin 42. The files allowed to pass childView "admin" (or a variable that can hold "admin").
// Each entry names the call it is there for. A task that adds a call site adds its file here,
// in the same commit.
const ADMIN_VIEW_ALLOW_LIST: Record<string, string> = {
  "apps/api/src/people-routes.ts": "the minors list (Community Admin only)",
  "apps/api/src/access-routes.ts": "the users list (the minor flag)",
  "apps/api/src/life-event-routes.ts": "the life-event list",
  "apps/api/src/household-routes.ts": "the household read (children as ids and labels)",
};

type Violation = string;

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (isFunctionLike(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

// Visits the nodes of a function's own body, without entering a nested function.
function walkOwnBody(fn: ts.Node, visit: (node: ts.Node) => void): void {
  const go = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, (child) => {
      if (!isFunctionLike(child)) {
        go(child);
      }
    });
  };
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (body !== undefined) {
    go(body);
  }
}

function strip(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

type ConstDeclaration = { name: string; init: ts.Expression; pos: number };

function ownConsts(fn: ts.Node): ConstDeclaration[] {
  const found: ConstDeclaration[] = [];
  walkOwnBody(fn, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0
    ) {
      found.push({ name: node.name.text, init: node.initializer, pos: node.pos });
    }
  });
  return found;
}

function isCommunityAdminCall(expr: ts.Expression): boolean {
  const inner = strip(expr);
  return (
    ts.isCallExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "isCommunityAdmin"
  );
}

function identifiersIn(expr: ts.Node, into: Set<string>): Set<string> {
  if (ts.isIdentifier(expr)) {
    into.add(expr.text);
  }
  ts.forEachChild(expr, (child) => {
    identifiersIn(child, into);
  });
  return into;
}

// Follows one level of `const name = ...` so a variable that holds "admin" is judged by its value.
function resolveValue(expr: ts.Expression, consts: ConstDeclaration[], beforePos: number) {
  let current = strip(expr);
  for (let depth = 0; depth < 4 && ts.isIdentifier(current); depth += 1) {
    const name = current.text;
    const declared = consts.find((c) => c.name === name && c.pos < beforePos);
    if (declared === undefined) {
      return current;
    }
    current = strip(declared.init);
  }
  return current;
}

function mayBeAdmin(expr: ts.Expression, consts: ConstDeclaration[], beforePos: number): boolean {
  const value = resolveValue(expr, consts, beforePos);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text === "admin";
  }
  if (ts.isConditionalExpression(value)) {
    return (
      mayBeAdmin(value.whenTrue, consts, beforePos) ||
      mayBeAdmin(value.whenFalse, consts, beforePos)
    );
  }
  // Forwarding a view the caller passed in (`input.childView`) cannot raise it.
  if (ts.isPropertyAccessExpression(value) && value.name.text === "childView") {
    return false;
  }
  // Anything else (a parameter, a call, a property) is unknown, so it may be "admin".
  return true;
}

// `if (!name) { ... return | throw ... }` before the call.
function hasGuard(fn: ts.Node, name: string, beforePos: number): boolean {
  let guarded = false;
  walkOwnBody(fn, (node) => {
    if (
      guarded ||
      node.pos >= beforePos ||
      !ts.isIfStatement(node) ||
      !ts.isPrefixUnaryExpression(node.expression) ||
      node.expression.operator !== ts.SyntaxKind.ExclamationToken ||
      !ts.isIdentifier(node.expression.operand) ||
      node.expression.operand.text !== name
    ) {
      return;
    }
    let exits = false;
    const scan = (inner: ts.Node): void => {
      if (ts.isReturnStatement(inner) || ts.isThrowStatement(inner)) {
        exits = true;
      }
      ts.forEachChild(inner, (child) => {
        if (!isFunctionLike(child)) {
          scan(child);
        }
      });
    };
    scan(node.thenStatement);
    guarded = exits;
  });
  return guarded;
}

function propertyName(prop: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
    return undefined;
  }
  const { name } = prop;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return undefined;
}

// Returns the problems in one source file. `relPath` is the repository-relative path.
export function auditChildViewAdmin(
  relPath: string,
  text: string,
  allowList: Record<string, string> = ADMIN_VIEW_ALLOW_LIST,
): { problems: Violation[]; passesAdmin: boolean } {
  const problems: Violation[] = [];
  let passesAdmin = false;
  if (!text.includes("childView")) {
    return { problems, passesAdmin };
  }
  const kind = relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind);

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (propertyName(prop) !== "childView") {
          continue;
        }
        const value = ts.isPropertyAssignment(prop)
          ? prop.initializer
          : (prop as ts.ShorthandPropertyAssignment).name;
        const fn = enclosingFunction(prop);
        const consts = fn === undefined ? [] : ownConsts(fn);
        if (!mayBeAdmin(value, consts, prop.pos)) {
          continue;
        }
        passesAdmin = true;
        const line = source.getLineAndCharacterOfPosition(prop.getStart(source)).line + 1;
        const where = `${relPath}:${line}`;
        if (!(relPath in allowList)) {
          problems.push(`${where}: passes childView "admin" from a file that is not on the list`);
          continue;
        }
        const adminConsts = consts.filter((c) => c.pos < prop.pos && isCommunityAdminCall(c.init));
        if (fn === undefined || adminConsts.length === 0) {
          problems.push(
            `${where}: childView "admin" has no const set from isCommunityAdmin( earlier in the same function`,
          );
          continue;
        }
        const resolved = resolveValue(value, consts, prop.pos);
        const used = identifiersIn(resolved, new Set<string>());
        const derived = adminConsts.some((c) => used.has(c.name));
        const literalAdmin = ts.isStringLiteral(resolved) && resolved.text === "admin";
        const guarded = adminConsts.some((c) => hasGuard(fn, c.name, prop.pos));
        if (!derived && !(literalAdmin && guarded)) {
          problems.push(
            `${where}: childView "admin" does not come from the isCommunityAdmin( result, and no guard refuses a non-admin first`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { problems, passesAdmin };
}

function sourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, into);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      into.push(full);
    }
  }
  return into;
}

describe("childView admin call sites (pin 42)", () => {
  it('pin 42: only the listed files pass childView "admin", each from a const set by isCommunityAdmin(', () => {
    const problems: Violation[] = [];
    const passing: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
        const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
        const result = auditChildViewAdmin(rel, readFileSync(file, "utf8"));
        problems.push(...result.problems);
        if (result.passesAdmin) {
          passing.push(rel);
        }
      }
    }
    expect(problems).toEqual([]);
    // A listed file that no longer passes "admin" is a stale entry: remove it.
    expect(passing.sort()).toEqual(Object.keys(ADMIN_VIEW_ALLOW_LIST).sort());
  });

  describe("the check itself (must-fail fixtures)", () => {
    const LISTED = "apps/api/src/people-routes.ts";

    it('refuses childView "admin" from a file that is not on the list', () => {
      const result = auditChildViewAdmin(
        "apps/api/src/unlisted-routes.ts",
        `async function f(tx) { const isAdmin = await isCommunityAdmin(tx, u); return listPersons(tx, k, a, { childView: isAdmin ? "admin" : "presence" }); }`,
      );
      expect(result.problems).toHaveLength(1);
    });

    it('refuses a variable that holds "admin" in an unlisted file', () => {
      const result = auditChildViewAdmin(
        "apps/api/src/other-routes.ts",
        `async function f(tx) { const view = "admin"; return readLinkedContacts(tx, k, a, { childView: view }); }`,
      );
      expect(result.problems).toHaveLength(1);
    });

    it("refuses a call with no isCommunityAdmin( in the function", () => {
      const result = auditChildViewAdmin(
        LISTED,
        `async function f(tx) { return listPersons(tx, k, a, { childView: "admin" }); }`,
      );
      expect(result.problems).toHaveLength(1);
    });

    it("refuses a flag that is not set from isCommunityAdmin(", () => {
      const result = auditChildViewAdmin(
        LISTED,
        `async function f(tx) { const isAdmin = true; return listPersons(tx, k, a, { childView: isAdmin ? "admin" : "presence" }); }`,
      );
      expect(result.problems).toHaveLength(1);
    });

    it("refuses an isCommunityAdmin( that comes after the call", () => {
      const result = auditChildViewAdmin(
        LISTED,
        `async function f(tx) { await listPersons(tx, k, a, { childView: "admin" }); const isAdmin = await isCommunityAdmin(tx, u); return isAdmin; }`,
      );
      expect(result.problems).toHaveLength(1);
    });

    it('refuses a literal "admin" with no guard that stops a non-admin', () => {
      const result = auditChildViewAdmin(
        LISTED,
        `async function f(tx) { const isAdmin = await isCommunityAdmin(tx, u); return listPersons(tx, k, a, { childView: "admin" }); }`,
      );
      expect(result.problems).toHaveLength(1);
    });

    it("refuses an isCommunityAdmin( that sits in a different function", () => {
      const result = auditChildViewAdmin(
        LISTED,
        `async function other(tx) { const isAdmin = await isCommunityAdmin(tx, u); return isAdmin; } async function f(tx) { return listPersons(tx, k, a, { childView: "admin" }); }`,
      );
      expect(result.problems).toHaveLength(1);
    });

    it("accepts a value derived from the isCommunityAdmin( result", () => {
      const result = auditChildViewAdmin(
        LISTED,
        `async function f(tx) { const isAdmin = await isCommunityAdmin(tx, u); const childView = isAdmin ? "admin" : "presence"; return readLinkedContacts(tx, k, a, { childView }); }`,
      );
      expect(result.problems).toEqual([]);
      expect(result.passesAdmin).toBe(true);
    });

    it('accepts a literal "admin" after a guard that returns for a non-admin', () => {
      const result = auditChildViewAdmin(
        LISTED,
        `async function f(tx) { const isAdmin = await isCommunityAdmin(tx, u); if (!isAdmin) { return denied(); } return listPersons(tx, k, a, { childView: "admin" }); }`,
      );
      expect(result.problems).toEqual([]);
      expect(result.passesAdmin).toBe(true);
    });

    it('accepts "presence" anywhere', () => {
      const result = auditChildViewAdmin(
        "apps/api/src/anything.ts",
        `async function f(tx) { return readLinkedContacts(tx, k, a, { childView: "presence" }); }`,
      );
      expect(result.problems).toEqual([]);
      expect(result.passesAdmin).toBe(false);
    });
  });
});

// Pin 41. openMinorField is the one function that opens a child's field, and only the Community
// Admin's View service may use it (ADR 0017, plan P1). Every other non-test file is refused if it
// names it, or imports the module that defines it, so the one reader cannot gain a second caller
// without this test failing.
const OPEN_MINOR_FIELD = "openMinorField";
const MINOR_FIELD_MODULE = /(^|\/)minor-field(\.js|\.ts)?$/;
// Where it is defined, where @community-hub/people re-exports it, and the one file that uses it:
// the Community Admin's View service.
const OPEN_MINOR_FIELD_FILES = new Set([
  "modules/core/people/infrastructure/minor-field.ts",
  "modules/core/people/public/index.ts",
  "modules/core/access/infrastructure/minor-view.ts",
]);

// Returns the problems in one source file. `relPath` is the repository-relative path.
export function auditOpenMinorFieldUses(
  relPath: string,
  text: string,
  allowed: ReadonlySet<string> = OPEN_MINOR_FIELD_FILES,
): { problems: Violation[]; mentions: boolean } {
  const problems: Violation[] = [];
  const mentionsName = text.includes(OPEN_MINOR_FIELD);
  const mentionsModule = text.includes("minor-field");
  if (!mentionsName && !mentionsModule) {
    return { problems, mentions: false };
  }
  const kind = relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind);
  let mentions = false;

  const flag = (node: ts.Node, what: string): void => {
    mentions = true;
    if (allowed.has(relPath)) {
      return;
    }
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    problems.push(`${relPath}:${line}: ${what}; only minor-view.ts may use openMinorField`);
  };

  const visit = (node: ts.Node): void => {
    // The name, as an identifier (an import, a property access, a destructuring) or a string.
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === OPEN_MINOR_FIELD) {
      flag(node, "names openMinorField");
    }
    // The module that defines it, by import, re-export or dynamic import.
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      MINOR_FIELD_MODULE.test(node.moduleSpecifier.text)
    ) {
      flag(node, "imports the minor-field module");
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      MINOR_FIELD_MODULE.test(node.arguments[0].text)
    ) {
      flag(node, "dynamically imports the minor-field module");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { problems, mentions };
}

describe("openMinorField import allow-list (pin 41)", () => {
  it("pin 41: only minor-view.ts imports openMinorField", () => {
    const problems: Violation[] = [];
    const mentioning: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
        const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
        const result = auditOpenMinorFieldUses(rel, readFileSync(file, "utf8"));
        problems.push(...result.problems);
        if (result.mentions) {
          mentioning.push(rel);
        }
      }
    }
    expect(problems).toEqual([]);
    // The scan can see the real mentions: the definition, the re-export and the View service are
    // found, and nothing else is.
    const outsideTheListed = mentioning.filter((rel) => !OPEN_MINOR_FIELD_FILES.has(rel));
    expect(outsideTheListed).toEqual([]);
    expect(mentioning).toContain("modules/core/people/infrastructure/minor-field.ts");
    expect(mentioning).toContain("modules/core/people/public/index.ts");
    expect(mentioning).toContain("modules/core/access/infrastructure/minor-view.ts");
  });

  describe("the check itself (must-fail fixtures)", () => {
    it("refuses an import of openMinorField from another file", () => {
      const result = auditOpenMinorFieldUses(
        "modules/core/access/infrastructure/community-admin.ts",
        `import { openMinorField } from "@community-hub/people";`,
      );
      expect(result.problems).toHaveLength(1);
    });

    it("refuses an aliased import, a namespace access and a destructuring", () => {
      for (const text of [
        `import { openMinorField as open } from "@community-hub/people";`,
        `import * as people from "@community-hub/people"; people.openMinorField(tx);`,
        `import * as people from "@community-hub/people"; const { openMinorField: f } = people;`,
        `const f = people["openMinorField"];`,
      ]) {
        const result = auditOpenMinorFieldUses("apps/api/src/some-routes.ts", text);
        expect(result.problems.length, text).toBeGreaterThan(0);
      }
    });

    it("refuses an import of the module that defines it, by path", () => {
      for (const text of [
        `import { x } from "./minor-field.js";`,
        `export { x } from "../infrastructure/minor-field.js";`,
        `const m = await import("./minor-field.js");`,
      ]) {
        const result = auditOpenMinorFieldUses(
          "modules/core/people/infrastructure/person.ts",
          text,
        );
        expect(result.problems.length, text).toBeGreaterThan(0);
      }
    });

    it("accepts the View service, the definition and the re-export", () => {
      for (const rel of OPEN_MINOR_FIELD_FILES) {
        const result = auditOpenMinorFieldUses(
          rel,
          `import { openMinorField } from "@community-hub/people"; export { openMinorField } from "../infrastructure/minor-field.js";`,
        );
        expect(result.problems).toEqual([]);
        expect(result.mentions).toBe(true);
      }
    });

    it("accepts a comment that names it, and a file that does not", () => {
      const comment = auditOpenMinorFieldUses(
        "modules/core/people/infrastructure/person-keys.ts",
        `// the View opens a field with openMinorField, one at a time\nexport const x = 1;`,
      );
      expect(comment.problems).toEqual([]);
      expect(comment.mentions).toBe(false);
      const none = auditOpenMinorFieldUses("apps/api/src/other.ts", `export const y = 2;`);
      expect(none.problems).toEqual([]);
    });
  });
});
