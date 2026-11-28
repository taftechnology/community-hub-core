import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// A support operator never reads a person (ADR 0017 point 4). No operator route reads people today,
// and this keeps it that way: no source file of the ops surface imports the people or groups
// modules. A support read, when it is built, goes through the same rule as every other reader.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);
const FORBIDDEN_PACKAGES = ["@community-hub/people", "@community-hub/groups"];
// The same modules reached by a relative path instead of the package name.
const FORBIDDEN_PATHS = /(^|\/)(core\/people|features\/groups)(\/|$)/;

function sourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, into);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      into.push(full);
    }
  }
  return into;
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

// The ops surface: the API's ops-* files, the ops app, and any ops* file or folder of a module.
function opsFiles(): string[] {
  const api = sourceFiles(path.join(REPO_ROOT, "apps/api/src"))
    .map(relative)
    .filter((rel) => /^apps\/api\/src\/ops-[^/]+$/.test(rel));
  const app = sourceFiles(path.join(REPO_ROOT, "apps/ops/src")).map(relative);
  const modules = sourceFiles(path.join(REPO_ROOT, "modules"))
    .map(relative)
    .filter((rel) =>
      rel
        .split("/")
        .slice(1)
        .some((segment) => segment.startsWith("ops")),
    );
  return [...api, ...app, ...modules].sort();
}

// Every module specifier a file names: import, export from, import(), require() and import types.
function importedSpecifiers(relPath: string, text: string): string[] {
  const kind = relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const take = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) {
      found.push(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      take(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      take(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      take(node.argument.literal);
    } else if (ts.isExternalModuleReference(node)) {
      take(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function forbiddenImports(relPath: string, text: string): string[] {
  return importedSpecifiers(relPath, text)
    .filter(
      (specifier) =>
        FORBIDDEN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`)) ||
        FORBIDDEN_PATHS.test(specifier),
    )
    .map((specifier) => `${relPath} imports ${specifier}`);
}

describe("the ops surface and people records (pin 82)", () => {
  it("pin 82: no ops file imports people or groups", () => {
    const files = opsFiles();
    // The scan did read the surface.
    expect(files).toContain("apps/api/src/ops-routes.ts");
    expect(files).toContain("apps/api/src/ops-operator.ts");
    expect(files).toContain("apps/ops/src/main.tsx");
    expect(files.filter((file) => /\.test\.tsx?$/.test(file))).toEqual([]);

    const problems = files.flatMap((file) =>
      forbiddenImports(file, readFileSync(path.join(REPO_ROOT, file), "utf8")),
    );
    expect(problems).toEqual([]);
  });

  describe("the check itself (must-fail fixtures)", () => {
    it("finds every way of importing the people or groups modules", () => {
      for (const text of [
        `import { readPerson } from "@community-hub/people";`,
        `import type { ChildView } from "@community-hub/people";`,
        `import * as groups from "@community-hub/groups";`,
        `export { listMembers } from "@community-hub/groups";`,
        `const people = await import("@community-hub/people");`,
        `const people = require("@community-hub/people");`,
        `type Reader = import("@community-hub/people").ChildView;`,
        `import people = require("@community-hub/people");`,
        `import { x } from "../../../modules/core/people/public/index.js";`,
        `import { x } from "../../../modules/features/groups/public/index.js";`,
        `import "@community-hub/people/anything";`,
      ]) {
        expect(forbiddenImports("apps/api/src/ops-routes.ts", text), text).toHaveLength(1);
      }
    });

    it("accepts other imports, and a name in a comment or a string", () => {
      const text = `
        // @community-hub/people is never imported here
        import { listDirectory } from "@community-hub/tenancy";
        import { x } from "@community-hub/people-shaped";
        export const note = "@community-hub/people";
      `;
      expect(forbiddenImports("apps/api/src/ops-routes.ts", text)).toEqual([]);
    });
  });
});
