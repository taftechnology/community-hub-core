import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIRNAME, "../../../..");
const FAITH_CHURCH_PKG = "@community-hub/" + "faith-church";

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage", ".superpowers", ".git"]);

export interface ScannedFile {
  path: string;
  text?: string;
  kind: "content" | "name";
}

export interface LabelViolation {
  path: string;
  kind: "content" | "name";
  reason: string;
  match?: string;
}

export function extractExportedIdentifiers(text: string): string[] {
  const names: string[] = [];
  // export (async )?(function|const|let|var|class|type|interface|enum) <name>
  const declRegex =
    /export\s+(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/g;
  for (const match of text.matchAll(declRegex)) {
    if (match[1]) {
      names.push(match[1]);
    }
  }

  // export { ... }
  const braceRegex = /export\s*\{([^}]+)\}/g;
  for (const match of text.matchAll(braceRegex)) {
    const block = match[1];
    if (!block) continue;
    const parts = block.split(",");
    for (const rawPart of parts) {
      const part = rawPart.trim().replace(/^type\s+/, "");
      if (!part) continue;
      if (/\s+as\s+/.test(part)) {
        const [orig, alias] = part.split(/\s+as\s+/);
        if (alias) names.push(alias.trim());
        if (orig) names.push(orig.trim());
      } else {
        names.push(part.trim());
      }
    }
  }
  return names;
}

export function findLabelViolations(files: ScannedFile[]): LabelViolation[] {
  const violations: LabelViolation[] = [];

  for (const file of files) {
    const normPath = file.path.replace(/\\/g, "/");

    // Exempt: everything under modules/verticals/**
    if (normPath.includes("modules/verticals/") || normPath.startsWith("modules/verticals")) {
      continue;
    }

    const baseName = normPath.split("/").pop() ?? "";
    const isTestOrFixture =
      normPath.includes(".test.") || normPath.includes("/test/") || baseName.includes("fixtures");

    // Check path for case-insensitive "mass"
    if (normPath.toLowerCase().includes("mass")) {
      violations.push({
        path: file.path,
        kind: file.kind,
        reason: "path contains 'mass'",
        match: normPath,
      });
    }

    // String literals inside test or fixture files are exempt
    if (isTestOrFixture) {
      continue;
    }

    if (!file.text) {
      continue;
    }

    if (file.kind === "content") {
      if (file.text.toLowerCase().includes("mass")) {
        violations.push({
          path: file.path,
          kind: file.kind,
          reason: "content contains 'mass'",
        });
      }
    } else if (file.kind === "name") {
      const exportedNames = extractExportedIdentifiers(file.text);
      for (const name of exportedNames) {
        if (name.toLowerCase().includes("mass")) {
          violations.push({
            path: file.path,
            kind: file.kind,
            reason: `exported identifier '${name}' contains 'mass'`,
            match: name,
          });
        }
      }
    }
  }

  return violations;
}

export function findFaithChurchViolations(files: Array<{ path: string; text: string }>): string[] {
  const violations: string[] = [];

  for (const file of files) {
    const normPath = file.path.replace(/\\/g, "/");

    // Modules/verticals/faith-church package itself is exempt
    if (
      normPath.startsWith("modules/verticals/faith-church/") ||
      normPath === "modules/verticals/faith-church"
    ) {
      continue;
    }

    // apps/admin is the only allowed external importer
    if (normPath.startsWith("apps/admin/")) {
      continue;
    }

    const baseName = normPath.split("/").pop() ?? "";
    const isTestOrFixture =
      normPath.includes(".test.") || normPath.includes("/test/") || baseName.includes("fixtures");

    if (isTestOrFixture) {
      continue;
    }

    if (normPath.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(file.text) as Record<string, unknown>;
        const depBuckets = [
          pkg.dependencies,
          pkg.devDependencies,
          pkg.peerDependencies,
          pkg.optionalDependencies,
        ];
        for (const bucket of depBuckets) {
          if (bucket && typeof bucket === "object" && FAITH_CHURCH_PKG in bucket) {
            violations.push(`${normPath} declares dependency on ${FAITH_CHURCH_PKG}`);
            break;
          }
        }
      } catch {
        // Fallback to substring if not valid JSON
        if (file.text.includes(FAITH_CHURCH_PKG)) {
          violations.push(`${normPath} references ${FAITH_CHURCH_PKG}`);
        }
      }
    } else if (normPath.endsWith("Dockerfile") || normPath.includes("Dockerfile")) {
      if (file.text.includes(FAITH_CHURCH_PKG)) {
        violations.push(`${normPath} references ${FAITH_CHURCH_PKG}`);
      }
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(normPath)) {
      const importRegex = new RegExp(
        "(?:from|import\\s*\\(|require\\s*\\()\\s*[\"']" +
          FAITH_CHURCH_PKG.replace("/", "\\/") +
          "(?:\\/[^\"']*)?[\"']",
      );
      if (importRegex.test(file.text)) {
        violations.push(`${normPath} imports ${FAITH_CHURCH_PKG}`);
      }
    }
  }

  return violations;
}

function walkFiles(
  dir: string,
  predicate: (relPath: string) => boolean,
  baseDir: string = dir,
): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, predicate, baseDir));
    } else if (predicate(relPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("label boundary and faith-church import rules", () => {
  it("proves findLabelViolations fires on must-fail fixtures", () => {
    const exportedIdFixture: ScannedFile = {
      path: "apps/admin/src/service-times.tsx",
      text: "export const massTimes = 1;",
      kind: "name",
    };
    const routePatternFixture: ScannedFile = {
      path: "apps/api/src/engagement-routes.ts",
      text: 'router.post("/v1/engagement/mass-times/get");',
      kind: "content",
    };
    const manifestKeyFixture: ScannedFile = {
      path: "modules/features/engagement/module.manifest.ts",
      text: 'collections: ["engagement.mass_times"]',
      kind: "content",
    };
    const sqlNameFixture: ScannedFile = {
      path: "packages/db/drizzle/0018_test.sql",
      text: 'CREATE TABLE "app"."mass_times" (id uuid);',
      kind: "content",
    };
    const filePathFixture: ScannedFile = {
      path: "modules/features/engagement/mass-times.ts",
      text: "export const ok = 1;",
      kind: "content",
    };

    // Each individual synthetic violation fires
    expect(findLabelViolations([exportedIdFixture])).toHaveLength(1);
    expect(findLabelViolations([routePatternFixture])).toHaveLength(1);
    expect(findLabelViolations([manifestKeyFixture])).toHaveLength(1);
    expect(findLabelViolations([sqlNameFixture])).toHaveLength(1);
    expect(findLabelViolations([filePathFixture])).toHaveLength(1);

    // All combined produce 5 violations
    const allViolations = findLabelViolations([
      exportedIdFixture,
      routePatternFixture,
      manifestKeyFixture,
      sqlNameFixture,
      filePathFixture,
    ]);
    expect(allViolations).toHaveLength(5);

    // Synthetic set with "Sunday Mass" inside *.test.* or fixtures file produces 0 violations
    const exemptTestAndFixtures: ScannedFile[] = [
      {
        path: "modules/features/engagement/domain/service.test.ts",
        text: 'const label = "Sunday Mass";',
        kind: "content",
      },
      {
        path: "modules/features/engagement/domain/fixtures.ts",
        text: 'export const fixture = "Sunday Mass at 10:00 AM";',
        kind: "content",
      },
      {
        path: "modules/features/engagement/test/fixtures/service-fixtures.ts",
        text: 'export const data = "Sunday Mass";',
        kind: "content",
      },
      {
        path: "modules/verticals/faith-church/src/terminology.ts",
        text: 'export const singular = "Mass Time";',
        kind: "content",
      },
    ];
    expect(findLabelViolations(exemptTestAndFixtures)).toEqual([]);
  });

  it("scans real repository files for label violations and finds none", () => {
    const scannedFiles: ScannedFile[] = [];

    // Scope 1: modules/features/engagement/** (non-test, non-fixture *.ts, *.tsx, *.sql, *.json)
    const engagementDir = path.join(REPO_ROOT, "modules/features/engagement");
    const engagementFiles = walkFiles(engagementDir, (rel) => {
      if (!/\.(ts|tsx|sql|json)$/.test(rel)) return false;
      const base = path.basename(rel);
      if (rel.includes(".test.") || rel.includes("/test/") || base.includes("fixtures")) {
        return false;
      }
      return true;
    });

    for (const file of engagementFiles) {
      const relPath = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      scannedFiles.push({
        path: relPath,
        text: readFileSync(file, "utf8"),
        kind: "content",
      });
    }

    // Scope 2: packages/contracts/src/service-times.ts (path and text)
    const contractsFile = path.join(REPO_ROOT, "packages/contracts/src/service-times.ts");
    if (existsSync(contractsFile)) {
      scannedFiles.push({
        path: "packages/contracts/src/service-times.ts",
        text: readFileSync(contractsFile, "utf8"),
        kind: "content",
      });
    }

    // Scope 3: apps/api/src/engagement-routes*.ts (non-test)
    const apiSrcDir = path.join(REPO_ROOT, "apps/api/src");
    if (existsSync(apiSrcDir)) {
      const apiFiles = walkFiles(apiSrcDir, (rel) => {
        if (!rel.startsWith("engagement-routes")) return false;
        if (!/\.(ts|tsx)$/.test(rel)) return false;
        if (rel.includes(".test.")) return false;
        return true;
      });
      for (const file of apiFiles) {
        const relPath = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
        scannedFiles.push({
          path: relPath,
          text: readFileSync(file, "utf8"),
          kind: "content",
        });
      }
    }

    // Scope 4: packages/db/drizzle/0018_*.sql (path and text)
    const drizzleDir = path.join(REPO_ROOT, "packages/db/drizzle");
    if (existsSync(drizzleDir)) {
      const migrationFiles = walkFiles(drizzleDir, (rel) =>
        /^0018_.*\.sql$/.test(path.basename(rel)),
      );
      for (const file of migrationFiles) {
        const relPath = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
        scannedFiles.push({
          path: relPath,
          text: readFileSync(file, "utf8"),
          kind: "content",
        });
      }
    }

    // Scope 5: apps/admin/src/** and packages/ui/src/** (non-test, kind: "name")
    for (const sub of ["apps/admin/src", "packages/ui/src"]) {
      const subDir = path.join(REPO_ROOT, sub);
      if (!existsSync(subDir)) continue;
      const files = walkFiles(subDir, (rel) => {
        if (!/\.(ts|tsx)$/.test(rel)) return false;
        if (rel.includes(".test.") || rel.includes("/test/")) return false;
        return true;
      });
      for (const file of files) {
        const relPath = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
        scannedFiles.push({
          path: relPath,
          text: readFileSync(file, "utf8"),
          kind: "name",
        });
      }
    }

    // Scanner is wired assertion: includes contracts file, engagement files, 0018 migration
    expect(
      scannedFiles.some((f) => f.path.includes("packages/contracts/src/service-times.ts")),
    ).toBe(true);
    expect(
      scannedFiles.some((f) => f.path.includes("modules/features/engagement/module.manifest.ts")),
    ).toBe(true);
    expect(
      scannedFiles.some((f) =>
        f.path.includes("modules/features/engagement/infrastructure/service-times.ts"),
      ),
    ).toBe(true);
    expect(
      scannedFiles.some((f) => f.path.includes("packages/db/drizzle/") && f.path.includes("0018_")),
    ).toBe(true);

    const violations = findLabelViolations(scannedFiles);
    expect(violations).toEqual([]);
  });

  it("proves findFaithChurchViolations flags synthetic importers outside apps/admin", () => {
    const syntheticApiSource = {
      path: "apps/api/src/server.ts",
      text: `import { terminology } from "${FAITH_CHURCH_PKG}";`,
    };
    const syntheticApiPackageJson = {
      path: "apps/api/package.json",
      text: JSON.stringify({
        dependencies: { [FAITH_CHURCH_PKG]: "workspace:*" },
      }),
    };
    const syntheticApiDockerfile = {
      path: "apps/api/Dockerfile",
      text: `RUN pnpm --filter ${FAITH_CHURCH_PKG} build`,
    };
    const syntheticCoreModule = {
      path: "modules/core/people/domain/person.ts",
      text: `import { terminology } from "${FAITH_CHURCH_PKG}";`,
    };

    expect(findFaithChurchViolations([syntheticApiSource])).toHaveLength(1);
    expect(findFaithChurchViolations([syntheticApiPackageJson])).toHaveLength(1);
    expect(findFaithChurchViolations([syntheticApiDockerfile])).toHaveLength(1);
    expect(findFaithChurchViolations([syntheticCoreModule])).toHaveLength(1);

    // Allowed synthetic importers: apps/admin and the pack itself
    const allowed = [
      {
        path: "apps/admin/package.json",
        text: JSON.stringify({
          dependencies: { [FAITH_CHURCH_PKG]: "workspace:*" },
        }),
      },
      {
        path: "apps/admin/src/nav.tsx",
        text: `import { terminology } from "${FAITH_CHURCH_PKG}";`,
      },
      {
        path: "modules/verticals/faith-church/public/index.ts",
        text: 'export * from "../src/terminology.js";',
      },
    ];
    expect(findFaithChurchViolations(allowed)).toEqual([]);
  });

  it("confirms faith-church pack is not imported outside apps/admin or present in apps/api", () => {
    const candidateFiles: Array<{ path: string; text: string }> = [];

    for (const folder of ["apps", "packages", "modules", "tooling"]) {
      const folderDir = path.join(REPO_ROOT, folder);
      if (!existsSync(folderDir)) continue;

      const files = walkFiles(folderDir, (rel) => {
        const fullRel = `${folder}/${rel}`;
        if (fullRel.startsWith("modules/verticals/faith-church/")) return false;
        if (rel.endsWith("package.json") || rel.endsWith("Dockerfile")) return true;
        if (/\.(ts|tsx|js|mjs|cjs)$/.test(rel)) {
          const base = path.basename(rel);
          if (rel.includes(".test.") || rel.includes("/test/") || base.includes("fixtures")) {
            return false;
          }
          return true;
        }
        return false;
      });

      for (const file of files) {
        const relPath = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
        candidateFiles.push({
          path: relPath,
          text: readFileSync(file, "utf8"),
        });
      }
    }

    const violations = findFaithChurchViolations(candidateFiles);
    expect(violations).toEqual([]);

    // Explicitly assert it must not appear in apps/api/package.json or apps/api/Dockerfile
    const apiPkgPath = path.join(REPO_ROOT, "apps/api/package.json");
    const apiDockerPath = path.join(REPO_ROOT, "apps/api/Dockerfile");

    expect(existsSync(apiPkgPath)).toBe(true);
    expect(readFileSync(apiPkgPath, "utf8")).not.toContain(FAITH_CHURCH_PKG);

    expect(existsSync(apiDockerPath)).toBe(true);
    expect(readFileSync(apiDockerPath, "utf8")).not.toContain(FAITH_CHURCH_PKG);
  });
});
