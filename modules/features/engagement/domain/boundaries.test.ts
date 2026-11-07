import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = path.resolve(MODULE, "../../../infra/regions/au/env");

function typescriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...typescriptFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("engagement boundaries", () => {
  it("does not import contracts, other modules, tenancy, identity, or adapters", () => {
    const banned = [
      "@community-hub/" + "contracts",
      "@community-hub/" + "tenancy",
      "@community-hub/" + "identity",
      "@community-hub/" + "people",
      "@community-hub/" + "groups",
      "@community-hub/" + "access",
      "@community-hub/" + "billing",
      "@community-hub/" + "policy",
      "@community-hub/" + "ui",
      "@community-hub/" + "faith-church",
      "@community-hub/" + "crypto",
    ];

    const files = typescriptFiles(MODULE);
    const violations: { file: string; specifier: string }[] = [];

    for (const file of files) {
      if (file.endsWith("boundaries.test.ts")) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      for (const b of banned) {
        if (text.includes(b)) {
          violations.push({ file: path.relative(MODULE, file), specifier: b });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("production code only imports allowed workspace packages and approved libraries", () => {
    const allowedPrefixes = [
      "@community-hub/usage",
      "@community-hub/kernel",
      "@community-hub/db",
      "sanitize-html",
      "drizzle-orm",
      "postgres",
    ];

    const prodFiles = typescriptFiles(MODULE).filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.includes(`${path.sep}test${path.sep}`) &&
        !file.endsWith("vitest.config.ts"),
    );

    const importRegex = /(?:import|export)\s+.*?from\s+["']([^"']+)["']/g;
    const dynamicImportRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

    const unapprovedImports: { file: string; specifier: string }[] = [];

    for (const file of prodFiles) {
      const text = readFileSync(file, "utf8");
      const specifiers: string[] = [];

      for (const match of text.matchAll(importRegex)) {
        if (match[1]) specifiers.push(match[1]);
      }
      for (const match of text.matchAll(dynamicImportRegex)) {
        if (match[1]) specifiers.push(match[1]);
      }

      for (const specifier of specifiers) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) {
          continue;
        }
        const isAllowed = allowedPrefixes.some(
          (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
        );
        if (!isAllowed) {
          unapprovedImports.push({ file: path.relative(MODULE, file), specifier });
        }
      }
    }

    expect(unapprovedImports).toEqual([]);
  });

  it("leaves staging parked", () => {
    const staging = readFileSync(path.join(ENV, "staging.tfvars"), "utf8");
    expect(staging).toMatch(/enable_database\s*=\s*false/);
    expect(staging).toMatch(/desired_count\s*=\s*0/);
    for (const name of readdirSync(ENV)) {
      const full = path.join(ENV, name);
      if (!statSync(full).isFile()) {
        continue;
      }
      expect(readFileSync(full, "utf8")).not.toContain("service_image");
    }
  });
});
