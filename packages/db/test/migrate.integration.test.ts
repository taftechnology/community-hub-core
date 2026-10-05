import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createPlaintextDirectSql } from "../src/plaintext.js";
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
    const first = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await applyProductMigrations(first);
    } finally {
      await first.end({ timeout: 1 });
    }
    const second = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await applyProductMigrations(second);
    } finally {
      await second.end({ timeout: 1 });
    }

    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
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
      const journal = JSON.parse(
        readFileSync(path.join(DRIZZLE, "meta/_journal.json"), "utf8"),
      ) as { entries: unknown[] };
      expect(n).toBe(String(journal.entries.length));

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
    const migration = createPlaintextDirectSql(runtime.directUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }

    const folder = mkdtempSync(path.join(tmpdir(), "hub-db-migrate-"));
    try {
      cpSync(DRIZZLE, folder, { recursive: true });
      const base = readdirSync(folder).find(
        (name) => name.startsWith("0000_") && name.endsWith(".sql"),
      );
      expect(base).toBeDefined();
      writeFileSync(
        path.join(folder, base!),
        `${readFileSync(path.join(folder, base!), "utf8")}\n-- sabotaged\n`,
      );
      writeFileSync(path.join(folder, "0001_pwn.sql"), "create table app.pwn (id int);\n");
      const journalPath = path.join(folder, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: {
          idx: number;
          version: string;
          when: number;
          tag: string;
          breakpoints: boolean;
        }[];
      };
      journal.entries.push({
        idx: 1,
        version: "7",
        when: 9_999_999_999_999,
        tag: "0001_pwn",
        breakpoints: true,
      });
      writeFileSync(journalPath, JSON.stringify(journal));

      const sabotage = createPlaintextDirectSql(runtime.directUrl);
      try {
        await expect(
          applyMigrations({
            sql: sabotage,
            folder,
            table: "__drizzle_migrations",
          }),
        ).rejects.toThrow(/already-applied file .* hash/i);
      } finally {
        await sabotage.end({ timeout: 1 });
      }

      const sql = createPlaintextDirectSql(runtime.directUrl);
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
