import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { check } from "./check.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("bundle-no-zod", () => {
  it("passes a clean bundle", () => {
    const result = check(path.join(fixturesDir, "clean"));
    expect(result.ok, JSON.stringify(result.violations)).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("fails a bundle containing ZodError", () => {
    const result = check(path.join(fixturesDir, "zod-error"));
    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.message === "bundle contains zod")).toBe(
      true,
    );
  });

  it("fails when a file cannot be read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-zod-"));
    const blocked = path.join(dir, "blocked.js");
    fs.writeFileSync(path.join(dir, "worker.js"), "export const ready = true;\n");
    fs.writeFileSync(blocked, "export const hidden = true;\n");
    fs.chmodSync(blocked, 0);
    try {
      const result = check(dir);
      expect(result.ok).toBe(false);
      expect(result.violations).toContainEqual({
        file: blocked,
        message: "bundle file is unreadable",
      });
    } finally {
      fs.chmodSync(blocked, 0o644);
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("fails an empty directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-zod-"));
    try {
      const result = check(dir);
      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([
        { file: dir, message: "output directory has no .js file" },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
