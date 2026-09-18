import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

import { assertMigrationPreflight } from "./migrate.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/migrate");

describe("assertMigrationPreflight", () => {
  it("fails when an unapplied journal entry is older than the latest applied created_at", () => {
    const folder = path.join(FIXTURES, "out-of-order");
    const migrations = readMigrationFiles({ migrationsFolder: folder });
    const newer = migrations.find((m) => m.folderMillis === 2000);
    expect(newer).toBeDefined();

    expect(() =>
      assertMigrationPreflight(migrations, [{ hash: newer!.hash, created_at: 2000 }]),
    ).toThrow(/unapplied journal entry .* older than the latest applied/i);
  });

  it("fails when an already-applied file's digest differs from the stored Kit hash", () => {
    const folder = path.join(FIXTURES, "checksum-changed");
    const migrations = readMigrationFiles({ migrationsFolder: folder });
    expect(migrations).toHaveLength(1);

    expect(() =>
      assertMigrationPreflight(migrations, [{ hash: "0".repeat(64), created_at: 1000 }]),
    ).toThrow(/already-applied file .* hash/i);
  });

  it("allows a newer unapplied entry when applied hashes match", () => {
    const folder = path.join(FIXTURES, "out-of-order");
    const migrations = readMigrationFiles({ migrationsFolder: folder });
    const older = migrations.find((m) => m.folderMillis === 1000);
    expect(older).toBeDefined();

    expect(() =>
      assertMigrationPreflight(migrations, [{ hash: older!.hash, created_at: 1000 }]),
    ).not.toThrow();
  });
});

describe("package exports", () => {
  it("does not export migrate-test", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(pkg.exports["./migrate-test"]).toBeUndefined();
    expect(Object.keys(pkg.exports)).toEqual(["."]);
  });
});
