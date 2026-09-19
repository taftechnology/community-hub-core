import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

import { applyMigrations, assertMigrationPreflight } from "./migrate.js";

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

describe("applyMigrations folder pairing", () => {
  it("rejects drizzle-test paired with the product journal table", async () => {
    await expect(
      applyMigrations({
        url: "postgres://hub:unused@127.0.0.1:5432/hub",
        folder: path.join(FIXTURES, "drizzle-test"),
        table: "__drizzle_migrations",
      }),
    ).rejects.toThrow(/drizzle-test cannot use the product journal/i);
  });
});

describe("product snapshot", () => {
  it("records app, identity and platform so a later generate will not CREATE SCHEMA again", () => {
    const snapshot = JSON.parse(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "../drizzle/meta/0000_snapshot.json"),
        "utf8",
      ),
    ) as { schemas: Record<string, string> };
    expect(snapshot.schemas).toEqual({
      app: "app",
      identity: "identity",
      platform: "platform",
    });
  });
});
