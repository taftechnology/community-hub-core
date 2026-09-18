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

export type AppliedMigration = {
  hash: string;
  created_at: number;
};

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
      throw new Error(
        `already-applied file ${row.created_at} hash does not match Kit digest`,
      );
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

export async function applyProductMigrations(directSql: Sql): Promise<void> {
  try {
    await applyProductMigrationsOnConnection(directSql);
  } finally {
    await directSql.end({ timeout: 1 });
  }
}

async function applyProductMigrationsOnConnection(sql: Sql): Promise<void> {
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    await runBootstrap(sql);
    await sql.unsafe("set role migrator");
    await preflightFromDb(sql, PRODUCT_FOLDER, PRODUCT_TABLE);
    const db = drizzle(sql);
    await migrate(db, {
      migrationsFolder: PRODUCT_FOLDER,
      migrationsSchema: "migrator",
      migrationsTable: PRODUCT_TABLE,
    });
  } finally {
    await sql.unsafe("reset role").catch(() => undefined);
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`.catch(() => undefined);
  }
}

async function preflightFromDb(
  sql: Sql,
  migrationsFolder: string,
  migrationsTable: string,
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const qualified = `migrator.${migrationsTable}`;
  const relRows = await sql<{ rel: string | null }[]>`
    select to_regclass(${qualified})::text as rel
  `;
  if (relRows[0]?.rel == null) {
    assertMigrationPreflight(migrations, []);
    return;
  }
  const rows = await sql.unsafe<{ hash: string; created_at: string | number | bigint }[]>(
    `select hash, created_at from migrator.${migrationsTable}`,
  );
  const applied: AppliedMigration[] = rows.map((row) => ({
    hash: row.hash,
    created_at: Number(row.created_at),
  }));
  assertMigrationPreflight(migrations, applied);
}
