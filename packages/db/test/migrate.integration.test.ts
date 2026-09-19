import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createDirectSql } from "../src/connections.js";
import { applyMigrations, applyProductMigrations } from "../src/migrate.js";

type Runtime = {
  directUrl: string;
  productOnlyUrl: string;
};

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE = path.join(DIR, "../drizzle");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(path.join(DIR, ".runtime.json"), "utf8")) as Runtime;
}

describe("applyProductMigrations", () => {
  it("applies the product journal and is a no-op on the second run", async () => {
    const runtime = loadRuntime();
    await applyProductMigrations(runtime.productOnlyUrl);
    await applyProductMigrations(runtime.productOnlyUrl);

    const sql = createDirectSql(runtime.productOnlyUrl);
    try {
      const schemas = await sql<{ nspname: string; owner: string }[]>`
        select n.nspname, r.rolname as owner
        from pg_namespace n
        join pg_roles r on r.oid = n.nspowner
        where n.nspname in ('app', 'identity', 'platform')
        order by n.nspname
      `;
      expect(schemas).toEqual([
        { nspname: "app", owner: "migrator" },
        { nspname: "identity", owner: "migrator" },
        { nspname: "platform", owner: "migrator" },
      ]);

      const [{ n }] = await sql<{ n: string }[]>`
        select count(*)::text as n from migrator.__drizzle_migrations
      `;
      expect(n).toBe("1");

      const [{ rel }] = await sql<{ rel: string | null }[]>`
        select to_regclass('migrator.__drizzle_migrations_test')::text as rel
      `;
      expect(rel).toBeNull();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("fails a changed hash before applying a newer sabotaged file", async () => {
    const runtime = loadRuntime();
    await applyProductMigrations(runtime.directUrl);

    const folder = mkdtempSync(path.join(tmpdir(), "hub-db-migrate-"));
    try {
      cpSync(DRIZZLE, folder, { recursive: true });
      const base = readdirSync(folder).find((name) => name.startsWith("0000_") && name.endsWith(".sql"));
      expect(base).toBeDefined();
      writeFileSync(
        path.join(folder, base!),
        `${readFileSync(path.join(folder, base!), "utf8")}\n-- sabotaged\n`,
      );
      writeFileSync(path.join(folder, "0001_pwn.sql"), "create table app.pwn (id int);\n");
      const journalPath = path.join(folder, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
      };
      journal.entries.push({
        idx: 1,
        version: "7",
        when: 9_999_999_999_999,
        tag: "0001_pwn",
        breakpoints: true,
      });
      writeFileSync(journalPath, JSON.stringify(journal));

      await expect(
        applyMigrations({
          url: runtime.directUrl,
          folder,
          table: "__drizzle_migrations",
        }),
      ).rejects.toThrow(/already-applied file .* hash/i);

      const sql = createDirectSql(runtime.directUrl);
      try {
        const [{ rel }] = await sql<{ rel: string | null }[]>`
          select to_regclass('app.pwn')::text as rel
        `;
        expect(rel).toBeNull();
      } finally {
        await sql.end({ timeout: 1 });
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
