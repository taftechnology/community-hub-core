import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(pkgRoot, "dist");

describe("production packaging", () => {
  it("package.json exports map is only the root entry", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports)).toEqual(["."]);
    expect(JSON.stringify(pkg.exports)).not.toContain("testing");
  });

  it.skipIf(!existsSync(distDir))("does not emit testing.js after tsc --build", () => {
    expect(existsSync(join(distDir, "testing.js"))).toBe(false);
    expect(existsSync(join(distDir, "testing.d.ts"))).toBe(false);
  });
});
