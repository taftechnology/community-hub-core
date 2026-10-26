// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { rootOptions } from "./root-options.js";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function listSourceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listSourceFiles(full));
    } else if (entry.isFile()) {
      if (!entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
        result.push(full);
      }
    }
  }
  return result;
}

describe("logging guards", () => {
  it("src has no console call", () => {
    const files = listSourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      expect(content, `console call found in ${path.relative(srcDir, file)}`).not.toMatch(
        /\bconsole\s*\./,
      );
    }
  });

  it("main passes rootOptions to createRoot", () => {
    const mainSrc = fs.readFileSync(path.join(srcDir, "main.tsx"), "utf8");
    expect(mainSrc).toContain("createRoot(root, rootOptions)");
  });

  it("createRoot gets no-op error handlers", () => {
    expect(typeof rootOptions.onUncaughtError).toBe("function");
    expect(typeof rootOptions.onCaughtError).toBe("function");
    expect(typeof rootOptions.onRecoverableError).toBe("function");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      rootOptions.onUncaughtError?.(new Error("x"), { componentStack: "" });
      rootOptions.onCaughtError?.(new Error("x"), { componentStack: "" });
      rootOptions.onRecoverableError?.(new Error("x"), { componentStack: "" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
