import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(srcDir, "../fixtures");

function isTestFile(name: string): boolean {
  return name.endsWith(".test.ts") || name.endsWith(".test.tsx");
}

export function fileCallsFetch(filePath: string): boolean {
  return fs.readFileSync(filePath, "utf8").includes("fetch(");
}

const allowedFetch = new Set(["sign-in.tsx", "users-roles.tsx", "module-toggles.tsx"]);

function scanSource(dir: string): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...scanSource(full));
      continue;
    }
    if (!entry.isFile() || isTestFile(entry.name)) {
      continue;
    }
    const relative = path.relative(srcDir, full).split(path.sep).join("/");
    if (fileCallsFetch(full) && !allowedFetch.has(relative)) {
      hits.push(relative);
    }
  }
  return hits;
}

it("allows fetch only on sign-in, users and roles, and module toggles", () => {
  expect(scanSource(srcDir)).toEqual([]);
  expect(fileCallsFetch(path.join(srcDir, "shell.tsx"))).toBe(false);
  expect(fileCallsFetch(path.join(srcDir, "nav.tsx"))).toBe(false);
});

it("fails the fixture that calls fetch", () => {
  expect(fileCallsFetch(path.join(fixturesDir, "calls-fetch.ts"))).toBe(true);
});

it("passes the fixture that does not call fetch", () => {
  expect(fileCallsFetch(path.join(fixturesDir, "no-fetch.ts"))).toBe(false);
});

it("imports tailwind, tokens, then the ui theme", () => {
  const css = fs.readFileSync(path.join(srcDir, "index.css"), "utf8");
  expect(css).toBe(
    '@import "tailwindcss";\n@import "@community-hub/tokens/tokens.css";\n@import "@community-hub/ui/theme.css";\n',
  );
});
