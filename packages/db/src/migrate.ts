import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql } from "postgres";

import { runBootstrap } from "./bootstrap.js";

/** Session advisory lock taken as the privileged login before bootstrap. */
export const MIGRATION_LOCK_ID = 1_667_788_130;

const PRODUCT_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const PRODUCT_TABLE = "__drizzle_migrations";
const JOURNAL_TABLE = /^__drizzle_migrations(?:_test)?$/;
const TEST_FOLDER_NAME = "drizzle-test";

export type AppliedMigration = {
  hash: string;
  created_at: number;
};

/** What a run did: the journal tags it applied, in journal order, and the journal length. */
export type MigrationReport = {
  applied: string[];
  total: number;
};

type JournalEntry = { tag: string; when: number };

function readJournal(folder: string): JournalEntry[] {
  const parsed = JSON.parse(readFileSync(path.join(folder, "meta/_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return parsed.entries.map((entry) => ({ tag: entry.tag, when: entry.when }));
}

export function assertMigrationPreflight(
  migrations: MigrationMeta[],
  applied: AppliedMigration[],
): void {
  if (applied.length === 0) {
    return;
  }

  const latestApplied = Math.max(...applied.map((row) => row.created_at));

  for (const row of applied) {
    const match = migrations.find((migration) => migration.folderMillis === row.created_at);
    if (!match) {
      throw new Error(
        `already-applied migration created_at=${row.created_at} is missing from the journal`,
      );
    }
    if (match.hash !== row.hash) {
      throw new Error(`already-applied file ${row.created_at} hash does not match Kit digest`);
    }
  }

  for (const migration of migrations) {
    const isApplied = applied.some((row) => row.created_at === migration.folderMillis);
    if (!isApplied && migration.folderMillis < latestApplied) {
      throw new Error(
        `unapplied journal entry ${migration.folderMillis} is older than the latest applied ${latestApplied}`,
      );
    }
  }
}

/**
 * Direct connection only — never PgBouncer. The runner takes an advisory
 * lock, SET ROLE, and migrate() on the Sql the caller opened.
 */
export async function applyProductMigrations(sql: Sql): Promise<MigrationReport> {
  return applyMigrations({
    sql,
    folder: PRODUCT_FOLDER,
    table: PRODUCT_TABLE,
  });
}

/** Not in package `exports`. Tests and `applyTestMigrations` pass a folder and table. */
export async function applyMigrations(opts: {
  sql: Sql;
  folder: string;
  table: string;
}): Promise<MigrationReport> {
  if (
    path.basename(path.resolve(opts.folder)) === TEST_FOLDER_NAME &&
    opts.table === PRODUCT_TABLE
  ) {
    throw new Error("drizzle-test cannot use the product journal table");
  }
  if (!JOURNAL_TABLE.test(opts.table)) {
    throw new Error(`unsupported migrations table ${opts.table}`);
  }
  const sql = opts.sql;
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    const lockRows = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const lockPid = Number(lockRows[0]?.pid);
    await runBootstrap(sql);
    await sql.unsafe("set role migrator");
    const before = await preflightFromDb(sql, opts.folder, opts.table);
    const session = await sql<{ pid: number; usr: string }[]>`
      select pg_backend_pid() as pid, current_user as usr
    `;
    if (Number(session[0]?.pid) !== lockPid) {
      throw new Error("migration runner lost the session; pass a direct connection, not a pooler");
    }
    if (session[0]?.usr !== "migrator") {
      throw new Error("migration runner is not SET ROLE migrator");
    }
    const db = drizzle(sql);
    await migrate(db, {
      migrationsFolder: opts.folder,
      migrationsSchema: "migrator",
      migrationsTable: opts.table,
    });
    const rows = await sql.unsafe<{ created_at: string | number | bigint }[]>(
      `select created_at from migrator.${opts.table}`,
    );
    const after = new Set(rows.map((row) => Number(row.created_at)));
    const known = new Set(before.map((row) => row.created_at));
    const journal = readJournal(opts.folder);
    return {
      applied: journal
        .filter((entry) => after.has(entry.when) && !known.has(entry.when))
        .map((entry) => entry.tag),
      total: journal.length,
    };
  } finally {
    await sql.unsafe("reset role").catch(() => undefined);
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`.catch(() => undefined);
  }
}

async function preflightFromDb(
  sql: Sql,
  migrationsFolder: string,
  migrationsTable: string,
): Promise<AppliedMigration[]> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const qualified = `migrator.${migrationsTable}`;
  const relRows = await sql<{ rel: string | null }[]>`
    select to_regclass(${qualified})::text as rel
  `;
  if (relRows[0]?.rel == null) {
    assertMigrationPreflight(migrations, []);
    return [];
  }
  const rows = await sql.unsafe<{ hash: string; created_at: string | number | bigint }[]>(
    `select hash, created_at from migrator.${migrationsTable}`,
  );
  const applied: AppliedMigration[] = rows.map((row) => ({
    hash: row.hash,
    created_at: Number(row.created_at),
  }));
  assertMigrationPreflight(migrations, applied);
  return applied;
}
