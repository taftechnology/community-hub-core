import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOURNAL_DIR = path.join(PACKAGE_ROOT, "drizzle");
const DRIZZLE_KIT = path.join(PACKAGE_ROOT, "node_modules", ".bin", "drizzle-kit");

// Every file under a directory, as relative path -> content, so a stray new file or an
// edited snapshot both show up as a difference.
function snapshotOf(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, snapshotOf(dir, relative));
    } else {
      files[relative] = readFileSync(path.join(dir, relative), "utf8");
    }
  }
  return files;
}

describe("drizzle-kit generate", () => {
  const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), "ch-generate-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("loads the real schema entry and finds no change against the committed journal", () => {
    const out = path.join(scratch, "drizzle");
    cpSync(JOURNAL_DIR, out, { recursive: true });
    const before = snapshotOf(out);
    expect(Object.keys(before)).toContain(path.join("meta", "_journal.json"));

    // Same config, same schema entry and same command as `pnpm exec drizzle-kit generate`,
    // except the output directory is the scratch copy so nothing is written to the repo.
    const result = spawnSync(DRIZZLE_KIT, ["generate"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      timeout: 50_000,
      env: { ...process.env, DRIZZLE_GENERATE_OUT: path.relative(PACKAGE_ROOT, out) },
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/No schema changes/i);
    expect(snapshotOf(out)).toEqual(before);
  }, 60_000);
});
