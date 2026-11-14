import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      entry.name !== "testing.ts"
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("organisation lock pin", () => {
  it("has exactly one advisory lock site in membership.ts, imported by grants.ts", () => {
    const hits: { file: string; line: number; text: string }[] = [];
    for (const file of sourceFiles(MODULE)) {
      const relative = path.relative(MODULE, file).replaceAll("\\", "/");
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes("pg_advisory_xact_lock")) {
          hits.push({ file: relative, line: i + 1, text: lines[i]!.trim() });
        }
      }
    }

    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe("infrastructure/membership.ts");
    expect(hits[0]?.text).toContain("pg_advisory_xact_lock(");

    const grantsContent = readFileSync(path.join(MODULE, "infrastructure/grants.ts"), "utf8");
    expect(grantsContent).toMatch(
      /import\s*\{[^}]*lockOrganisation[^}]*\}\s*from\s*["']\.\/membership(?:\.js)?["']/,
    );
  });
});
