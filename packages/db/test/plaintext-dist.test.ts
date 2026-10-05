import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listing(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      found.push(path.relative(dir, full));
    }
  };
  walk(dir);
  found.sort();
  return found;
}

describe("plaintext build exclude", () => {
  it("emits no plaintext module from a temporary tsc build", () => {
    const dist = path.join(ROOT, "dist");
    const before = listing(dist);
    const tmp = mkdtempSync(path.join(tmpdir(), "hub-db-dist-"));
    const outDir = path.join(tmp, "out");
    const tsconfig = path.join(tmp, "tsconfig.json");
    writeFileSync(
      tsconfig,
      JSON.stringify(
        {
          extends: path.join(ROOT, "tsconfig.json"),
          compilerOptions: {
            outDir,
            composite: true,
            tsBuildInfoFile: path.join(tmp, "tsconfig.tsbuildinfo"),
            typeRoots: [path.join(ROOT, "node_modules/@types")],
          },
        },
        null,
        2,
      ),
    );
    try {
      execFileSync("pnpm", ["exec", "tsc", "--build", tsconfig], {
        cwd: ROOT,
        stdio: "pipe",
      });
      const emitted = listing(outDir);
      expect(emitted.some((file) => path.basename(file) === "plaintext.js")).toBe(false);
      for (const file of emitted) {
        expect(readFileSync(path.join(outDir, file), "utf8")).not.toContain(
          "createPlaintextDirectSql",
        );
      }
      expect(listing(dist)).toEqual(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
