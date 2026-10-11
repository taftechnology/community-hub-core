import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fileNames(dir: string): string[] {
  const names: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      names.push(...fileNames(full));
    } else {
      names.push(name);
    }
  }
  return names;
}

describe("identity build", () => {
  it("writes the typescript build info outside dist", () => {
    rmSync(path.join(root, "dist"), { recursive: true, force: true });
    execFileSync("pnpm", ["exec", "tsc", "--build", "--force", "--pretty", "false"], {
      cwd: root,
      stdio: "pipe",
    });
    const names = fileNames(path.join(root, "dist"));
    expect(names.filter((name) => name.startsWith("tsconfig"))).toEqual([]);
  });
});
