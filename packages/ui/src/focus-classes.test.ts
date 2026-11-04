// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

export function hasOutlineConflict(classString: string): boolean {
  const tokens = classString.split(/\s+/).filter(Boolean);
  const hasOutlineNone = tokens.includes("outline-none");
  const hasFocusOutline = tokens.some(
    (token) =>
      token.startsWith("focus-visible:outline-") ||
      (token.startsWith("focus:outline-") && token !== "focus:outline-none"),
  );
  return hasOutlineNone && hasFocusOutline;
}

export function findFocusClassViolations(content: string): string[] {
  const violations: string[] = [];
  const stringPattern = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const match of content.matchAll(stringPattern)) {
    const str = match[2];
    if (hasOutlineConflict(str)) {
      violations.push(str.trim());
    }
  }
  return violations;
}

function shouldScanFile(name: string): boolean {
  if (name.includes(".test.") || name.endsWith(".test.ts") || name.endsWith(".test.tsx")) {
    return false;
  }
  return name.endsWith(".ts") || name.endsWith(".tsx");
}

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }
    if (shouldScanFile(entry)) {
      files.push(full);
    }
  }
  return files;
}

export function scanDirectoryForOutlineConflicts(dir: string): string[] {
  const files = collectSourceFiles(dir);
  const hits: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const violations = findFocusClassViolations(content);
    for (const v of violations) {
      hits.push(`${path.basename(file)}: ${v}`);
    }
  }
  return hits;
}

describe("focus classes guard test (Fix 1)", () => {
  it("detects must-fail fixture combining outline-none and focus-visible:outline", () => {
    const failingFixture = "btn outline-none focus-visible:outline-2 focus-visible:outline-ring";
    expect(hasOutlineConflict(failingFixture)).toBe(true);
  });

  it("detects must-fail fixture combining outline-none and focus:outline", () => {
    const failingFixture = "input outline-none focus:outline-2";
    expect(hasOutlineConflict(failingFixture)).toBe(true);
  });

  it("passes fixture using outline-hidden with focus outline", () => {
    const passingFixture = "btn outline-hidden focus-visible:outline-2 focus-visible:outline-ring";
    expect(hasOutlineConflict(passingFixture)).toBe(false);
  });

  it("passes fixture using outline-none alone without focus outline", () => {
    const passingFixture = "text-xl font-bold truncate outline-none";
    expect(hasOutlineConflict(passingFixture)).toBe(false);
  });

  it("finds no outline-none + focus outline conflicts in packages/ui/src and apps/admin/src", () => {
    const uiSrc = fileURLToPath(new URL(".", import.meta.url));
    const adminSrc = path.resolve(uiSrc, "../../../apps/admin/src");

    const uiHits = scanDirectoryForOutlineConflicts(uiSrc);
    const adminHits = scanDirectoryForOutlineConflicts(adminSrc);

    expect(uiHits).toEqual([]);
    expect(adminHits).toEqual([]);
  });
});
