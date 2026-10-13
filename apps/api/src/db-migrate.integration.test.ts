import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATION_LOCK_ID } from "@community-hub/db";
import { createPlaintextDirectSql } from "@community-hub/db/plaintext";
import { describe, expect, it } from "vitest";

import {
  freshDatabase,
  type FreshDatabase,
} from "../../../packages/db/test/fixtures/database-fixture.js";
import { runDbMigrate, type DbMigrateDeps, type DbMigrateResult } from "./db-migrate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PACKAGE = path.resolve(HERE, "../../../packages/db");

type Runtime = {
  directUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const runtime = JSON.parse(
  readFileSync(path.join(DB_PACKAGE, "test/.runtime.json"), "utf8"),
) as Runtime;
const journal = JSON.parse(
  readFileSync(path.join(DB_PACKAGE, "drizzle/meta/_journal.json"), "utf8"),
) as { entries: { tag: string }[] };
const TAGS = journal.entries.map((entry) => entry.tag);
const TOTAL = TAGS.length;

// The plaintext factory below ignores the bundle. It is the real one only so
// that the value has the shape of the image's PEM.
const pem = readFileSync(path.join(HERE, "../certs/rds-ap-southeast-2-bundle.pem"), "utf8");

function sourceFor(database: FreshDatabase): NodeJS.ProcessEnv {
  const master = new URL(runtime.directUrl);
  return {
    PGHOST: "127.0.0.1",
    PGPORT: "5432",
    PGDATABASE: database.name,
    PGUSER: decodeURIComponent(master.username),
    PGPASSWORD_MASTER: decodeURIComponent(master.password),
    PGPASSWORD_APP: runtime.passwords.app,
    PGPASSWORD_IDENTITY: runtime.passwords.identity,
    PGPASSWORD_PLATFORM: runtime.passwords.platform,
  };
}

const connect: DbMigrateDeps["connect"] = (target) =>
  createPlaintextDirectSql(
    `postgres://${encodeURIComponent(target.user)}:${encodeURIComponent(target.password)}@${target.host}:${target.port}/${target.database}`,
  );

function command(database: FreshDatabase): Promise<DbMigrateResult> {
  return runDbMigrate({ source: sourceFor(database), pem, connect });
}

const DONE_ALL = `done applied=${TOTAL} total=${TOTAL}\n`;
const ALL_TAGS = TAGS.map((tag) => `applied ${tag}\n`).join("");

async function withDatabase(body: (database: FreshDatabase) => Promise<void>): Promise<void> {
  const database = await freshDatabase(runtime.directUrl);
  try {
    await body(database);
  } finally {
    await database.drop();
  }
}

async function inspect<T>(
  database: FreshDatabase,
  body: (sql: ReturnType<typeof createPlaintextDirectSql>) => Promise<T>,
): Promise<T> {
  const sql = createPlaintextDirectSql(database.url);
  try {
    return await body(sql);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

describe("db-migrate on a fresh database", () => {
  it("applies every migration and leaves every app table forced", async () => {
    await withDatabase(async (database) => {
      const result = await command(database);
      expect(result).toEqual({ exitCode: 0, stdout: `${ALL_TAGS}${DONE_ALL}`, stderr: "" });

      await inspect(database, async (sql) => {
        const count = await sql<{ n: string }[]>`
          select count(*)::text as n from migrator.__drizzle_migrations
        `;
        expect(count[0]?.n).toBe(String(TOTAL));

        const tables = await sql<{ relname: string; rls: boolean; forced: boolean }[]>`
          select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relkind in ('r', 'p')
        `;
        expect(tables.length).toBeGreaterThan(0);
        for (const table of tables) {
          expect({ table: table.relname, rls: table.rls, forced: table.forced }).toEqual({
            table: table.relname,
            rls: true,
            forced: true,
          });
        }

        const owners = await sql<{ nspname: string; owner: string }[]>`
          select n.nspname, r.rolname as owner
          from pg_namespace n
          join pg_roles r on r.oid = n.nspowner
          where n.nspname in ('app', 'identity', 'platform')
          order by n.nspname
        `;
        expect(owners).toEqual([
          { nspname: "app", owner: "migrator" },
          { nspname: "identity", owner: "migrator" },
          { nspname: "platform", owner: "migrator" },
        ]);
      });
    });
  }, 30_000);

  it("applies nothing on a second run and leaves the record as it was", async () => {
    await withDatabase(async (database) => {
      expect((await command(database)).exitCode).toBe(0);
      const read = () =>
        inspect(database, (sql) =>
          sql<{ hash: string; created_at: string }[]>`
            select hash, created_at::text as created_at
            from migrator.__drizzle_migrations
            order by created_at
          `.then((rows) => rows.map((row) => ({ ...row }))),
        );
      const before = await read();
      expect(before).toHaveLength(TOTAL);

      const second = await command(database);
      expect(second).toEqual({
        exitCode: 0,
        stdout: `done applied=0 total=${TOTAL}\n`,
        stderr: "",
      });
      expect(await read()).toEqual(before);
    });
  }, 30_000);

  it("closes the migration record to every other role", async () => {
    await withDatabase(async (database) => {
      expect((await command(database)).exitCode).toBe(0);
      await inspect(database, async (sql) => {
        for (const role of ["app", "identity", "platform"]) {
          for (const privilege of ["USAGE", "CREATE"]) {
            const rows = await sql<{ allowed: boolean }[]>`
              select has_schema_privilege(${role}, 'migrator', ${privilege}) as allowed
            `;
            expect({ role, privilege, allowed: rows[0]?.allowed }).toEqual({
              role,
              privilege,
              allowed: false,
            });
          }
        }
        const everyone = await sql<{ n: string }[]>`
          select count(*)::text as n
          from pg_namespace n, aclexplode(n.nspacl) a
          where n.nspname = 'migrator' and a.grantee = 0
        `;
        expect(everyone[0]?.n).toBe("0");
      });
    });
  }, 30_000);

  it("applies once when two runs wait behind the same lock", async () => {
    await withDatabase(async (database) => {
      const holder = createPlaintextDirectSql(database.url);
      let locked = false;
      let runs: Promise<DbMigrateResult>[] = [];
      try {
        await holder`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
        locked = true;
        runs = [command(database), command(database)];

        const deadline = Date.now() + 20_000;
        for (;;) {
          // Filter by database: other suites share this cluster, and advisory
          // locks are per database, so only this test's database counts.
          const waiting = await holder<{ n: number }[]>`
            select count(*)::int as n
            from pg_locks l
            where l.locktype = 'advisory'
              and l.classid = 0
              and l.objid = ${MIGRATION_LOCK_ID}
              and not l.granted
              and l.database = (select oid from pg_database where datname = ${database.name})
          `;
          if (waiting[0]?.n === 2) {
            break;
          }
          if (Date.now() > deadline) {
            throw new Error("two runs did not queue behind the lock");
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const journalRel = await holder<{ rel: string | null }[]>`
          select to_regclass('migrator.__drizzle_migrations')::text as rel
        `;
        expect(journalRel[0]?.rel).toBeNull();

        await holder`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
        locked = false;

        const results = await Promise.all(runs);
        expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
        expect(results.map((result) => result.stderr)).toEqual(["", ""]);
        const lines = results.map((result) => result.stdout.split("\n").slice(-2)[0]).sort();
        expect(lines).toEqual(
          [`done applied=${TOTAL} total=${TOTAL}`, `done applied=0 total=${TOTAL}`].sort(),
        );

        await inspect(database, async (sql) => {
          const count = await sql<{ n: string }[]>`
            select count(*)::text as n from migrator.__drizzle_migrations
          `;
          expect(count[0]?.n).toBe(String(TOTAL));
        });
      } finally {
        if (locked) {
          await holder`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`.catch(() => undefined);
        }
        await holder.end({ timeout: 1 }).catch(() => undefined);
        await Promise.allSettled(runs);
      }
    });
  }, 60_000);

  it("rolls back the whole pending set when one migration fails", async () => {
    await withDatabase(async (database) => {
      await inspect(database, async (sql) => {
        await sql.unsafe("create schema app authorization migrator").simple();
        await sql.unsafe("create table app.outbox (id int)").simple();
      });

      const failed = await command(database);
      expect(failed).toEqual({ exitCode: 1, stdout: "", stderr: "migrate 42P07\n" });

      await inspect(database, async (sql) => {
        const schemas = await sql<{ nspname: string }[]>`
          select nspname from pg_namespace where nspname in ('identity', 'platform')
        `;
        expect(schemas).toEqual([]);
        const count = await sql<{ n: string }[]>`
          select count(*)::text as n from migrator.__drizzle_migrations
        `;
        expect(count[0]?.n).toBe("0");
        await sql.unsafe("drop table app.outbox").simple();
      });

      const again = await command(database);
      expect(again).toEqual({ exitCode: 0, stdout: `${ALL_TAGS}${DONE_ALL}`, stderr: "" });
    });
  }, 30_000);
});
