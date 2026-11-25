import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlaintextDirectSql } from "../src/plaintext.js";
import { applyMigrations } from "../src/migrate.js";
import { freshDatabase, type FreshDatabase } from "./fixtures/database-fixture.js";
import { newId } from "../src/ids.js";

type Runtime = {
  directUrl: string;
};

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE = path.join(DIR, "../drizzle");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(path.join(DIR, ".runtime.json"), "utf8")) as Runtime;
}

describe("family delete migration 0023", () => {
  let database: FreshDatabase;
  let sql: ReturnType<typeof createPlaintextDirectSql>;

  const orgId = newId();
  const commId = newId();
  const otherCommId = newId();
  const visibleHouseholdId = newId();
  const hiddenHouseholdId = newId();
  const householdWithMinorId = newId();
  const otherCommHouseholdId = newId();
  const adultId = newId();
  const minorId = newId();
  const hiddenAdultId = newId();
  const adultNoHouseholdId = newId();

  beforeAll(async () => {
    const runtime = loadRuntime();
    database = await freshDatabase(runtime.directUrl);
    sql = createPlaintextDirectSql(database.url);

    // Apply migrations up to 0023
    await applyMigrations({
      sql,
      folder: DRIZZLE,
      table: "__drizzle_migrations",
    });

    // Seed platform organisations and communities as migrator
    await sql.unsafe("set role migrator");
    await sql`
      insert into platform.organisations (id, slug, region, kind) values
        (${orgId}, ${`org-${orgId}`}, 'au', 'implicit')
    `;
    await sql`
      insert into platform.communities (id, organisation_id, slug, region) values
        (${commId}, ${orgId}, ${`comm-${commId}`}, 'au'),
        (${otherCommId}, ${orgId}, ${`comm-${otherCommId}`}, 'au')
    `;

    // Seed community data in commId inside a transaction with per-community set_config(..., true)
    await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commId}, true)`;

      // Visible household
      await tx`
        insert into app.households (id, org_id, community_id) values
          (${visibleHouseholdId}, ${orgId}, ${commId})
      `;

      // Household with minor
      await tx`
        insert into app.households (id, org_id, community_id) values
          (${householdWithMinorId}, ${orgId}, ${commId})
      `;

      // Hidden household (will be hidden below)
      await tx`
        insert into app.households (id, org_id, community_id) values
          (${hiddenHouseholdId}, ${orgId}, ${commId})
      `;

      // Adult in hidden household (inserted before household is hidden)
      await tx`
        insert into app.persons (id, org_id, community_id, household_id, version, is_minor, age_basis, given_name, family_name) values
          (${hiddenAdultId}, ${orgId}, ${commId}, ${hiddenHouseholdId}, 1, false, 'declared_adult', 'Hidden', 'Adult')
      `;

      // Now hide hidden household (aged / set deleted_at with trigger disabled)
      await tx.unsafe("ALTER TABLE app.households DISABLE TRIGGER USER");
      await tx`
        update app.households
        set deleted_at = now() - interval '10 hours',
            deleted_by = ${newId()}
        where id = ${hiddenHouseholdId}
      `;
      await tx.unsafe("ALTER TABLE app.households ENABLE TRIGGER USER");

      // Visible adult in visible household
      await tx`
        insert into app.persons (id, org_id, community_id, household_id, version, is_minor, age_basis, given_name, family_name) values
          (${adultId}, ${orgId}, ${commId}, ${visibleHouseholdId}, 1, false, 'declared_adult', 'Adult', 'One')
      `;

      // Minor in householdWithMinorId
      const fakeEncrypted = Buffer.from("0123456789abcdef0123456789abcdef");
      await tx`
        insert into app.persons (id, org_id, community_id, household_id, version, is_minor, age_basis, given_name_restricted, family_name_restricted) values
          (${minorId}, ${orgId}, ${commId}, ${householdWithMinorId}, 1, true, 'unknown', ${fakeEncrypted}, ${fakeEncrypted})
      `;

      // Adult with no household
      await tx`
        insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name) values
          (${adultNoHouseholdId}, ${orgId}, ${commId}, 1, false, 'declared_adult', 'Solo', 'Adult')
      `;
    });

    // Seed community data in otherCommId
    await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${otherCommId}, true)`;

      await tx`
        insert into app.households (id, org_id, community_id) values
          (${otherCommHouseholdId}, ${orgId}, ${otherCommId})
      `;
    });

    await sql.unsafe("reset role");
  }, 180_000);

  afterAll(async () => {
    if (sql) {
      await sql.end({ timeout: 1 });
    }
    if (database) {
      await database.drop();
    }
  }, 120_000);

  it("migration 0023: refuses a back-dated household deleted_at from app", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.households
          set deleted_at = now() - interval '1 hour',
              deleted_by = ${newId()}
          where id = ${visibleHouseholdId}
        `;
      }),
    ).rejects.toThrow(/deleted_at must be set to now/);
  });

  it("migration 0023: refuses deleted_at while a minor is in the household", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.households
          set deleted_at = now(),
              deleted_by = ${newId()}
          where id = ${householdWithMinorId}
        `;
      }),
    ).rejects.toThrow(/cannot set deleted_at while a minor is in the household/);
  });

  it("migration 0023: refuses household deleted_at without deleted_by", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.households
          set deleted_at = now(),
              deleted_by = null
          where id = ${visibleHouseholdId}
        `;
      }),
    ).rejects.toThrow(/deleted_by must be set when deleted_at is set/);
  });

  it("migration 0023: refuses moving a household deleted_at from one time to another", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.households
          set deleted_at = now()
          where id = ${hiddenHouseholdId}
        `;
      }),
    ).rejects.toThrow(/cannot change deleted_at/);
  });

  it("migration 0023: refuses a restore that leaves deleted_by set", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.households
          set deleted_at = null
          where id = ${hiddenHouseholdId}
        `;
      }),
    ).rejects.toThrow("deleted_by must be null when deleted_at is cleared");
  });

  it("migration 0023: refuses changing deleted_by on a hidden household", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.households
          set deleted_by = ${newId()}
          where id = ${hiddenHouseholdId}
        `;
      }),
    ).rejects.toThrow("cannot change deleted_by on a deleted household");
  });

  it("migration 0023: refuses deleted_by on a visible household", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.households
          set deleted_by = ${newId()}
          where id = ${visibleHouseholdId}
        `;
      }),
    ).rejects.toThrow("cannot set deleted_by when deleted_at is null");
  });

  it("migration 0023: refuses a new household inserted with deleted_at", async () => {
    const newHouseholdId = newId();
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          insert into app.households (id, org_id, community_id, deleted_at, deleted_by)
          values (${newHouseholdId}, ${orgId}, ${commId}, now(), ${newId()})
        `;
      }),
    ).rejects.toThrow(/deleted_at and deleted_by must be null on insert/);
  });

  it("migration 0023: refuses a person inserted into a hidden household", async () => {
    const newPersonId = newId();
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          insert into app.persons (id, org_id, community_id, household_id, version, is_minor, age_basis, given_name, family_name)
          values (${newPersonId}, ${orgId}, ${commId}, ${hiddenHouseholdId}, 1, false, 'declared_adult', 'New', 'Person')
        `;
      }),
    ).rejects.toThrow(/cannot place person in a deleted household/);
  });

  it("migration 0023: refuses moving an adult into a hidden household", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.persons
          set household_id = ${hiddenHouseholdId}
          where id = ${adultNoHouseholdId}
        `;
      }),
    ).rejects.toThrow(/cannot place person in a deleted household/);
  });

  it("migration 0023: an adult in a hidden household can still be updated", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.persons
          set given_name = 'StillEditable'
          where id = ${hiddenAdultId}
        `;
        const [person] = await tx<{ given_name: string }[]>`
          select given_name from app.persons where id = ${hiddenAdultId}
        `;
        expect(person?.given_name).toBe("StillEditable");
        return person?.given_name;
      }),
    ).resolves.toBe("StillEditable");
  });

  it("migration 0023: refuses a household of another community of the organisation", async () => {
    const newPersonId = newId();
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          insert into app.persons (id, org_id, community_id, household_id, version, is_minor, age_basis, given_name, family_name)
          values (${newPersonId}, ${orgId}, ${commId}, ${otherCommHouseholdId}, 1, false, 'declared_adult', 'Cross', 'Comm')
        `;
      }),
    ).rejects.toThrow(/household not found or not visible/);
  });

  it("migration 0023: a person insert waits for a hide in progress and is refused", async () => {
    const targetHouseholdId = newId();
    const newPersonId = newId();

    // Seed target household as migrator
    await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commId}, true)`;
      await tx`
        insert into app.households (id, org_id, community_id)
        values (${targetHouseholdId}, ${orgId}, ${commId})
      `;
    });

    const conn1 = createPlaintextDirectSql(database.url);
    const conn2 = createPlaintextDirectSql(database.url);
    const inspector = createPlaintextDirectSql(database.url);

    let releaseTx1!: () => void;
    const releaseTx1Promise = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    let tx1Ready!: () => void;
    const tx1ReadyPromise = new Promise<void>((resolve) => {
      tx1Ready = resolve;
    });

    let tx2Pid: number | null = null;
    let tx2Settled = false;

    try {
      const tx1Promise = conn1.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.households
          set deleted_at = now(),
              deleted_by = ${newId()}
          where id = ${targetHouseholdId}
        `;
        tx1Ready();
        await releaseTx1Promise;
      });

      await tx1ReadyPromise;

      const tx2Promise = conn2
        .begin(async (tx) => {
          await tx.unsafe("set role app");
          await tx`select set_config('app.org_id', ${orgId}, true)`;
          await tx`select set_config('app.community_id', ${commId}, true)`;
          const [pidRow] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          tx2Pid = pidRow?.pid ?? null;
          await tx`
            insert into app.persons (id, org_id, community_id, household_id, version, is_minor, age_basis, given_name, family_name)
            values (${newPersonId}, ${orgId}, ${commId}, ${targetHouseholdId}, 1, false, 'declared_adult', 'Conc', 'Person')
          `;
        })
        .finally(() => {
          tx2Settled = true;
        });

      let blocked = false;
      const started = Date.now();
      while (Date.now() - started < 10_000 && !tx2Settled) {
        if (tx2Pid !== null) {
          const rows = await inspector<{ count: number }[]>`
            select count(*)::int as count
            from pg_locks l
            join pg_stat_activity a on a.pid = l.pid
            where l.pid = ${tx2Pid}
              and l.granted = false
              and a.query like '%app.persons%'
          `;
          if ((rows[0]?.count ?? 0) > 0) {
            blocked = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(blocked).toBe(true);

      releaseTx1();
      await tx1Promise;

      await expect(tx2Promise).rejects.toThrow(/cannot place person in a deleted household/);
    } finally {
      releaseTx1();
      await conn1.end({ timeout: 1 });
      await conn2.end({ timeout: 1 });
      await inspector.end({ timeout: 1 });
    }
  }, 20_000);

  it("migration 0023: an adult move waits for a hide in progress and is refused", async () => {
    const targetHouseholdId = newId();
    const movedAdultId = newId();

    // Seed the target household and an adult with no family as migrator
    await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commId}, true)`;
      await tx`
        insert into app.households (id, org_id, community_id)
        values (${targetHouseholdId}, ${orgId}, ${commId})
      `;
      await tx`
        insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name)
        values (${movedAdultId}, ${orgId}, ${commId}, 1, false, 'declared_adult', 'Moved', 'Adult')
      `;
    });

    const conn1 = createPlaintextDirectSql(database.url);
    const conn2 = createPlaintextDirectSql(database.url);
    const inspector = createPlaintextDirectSql(database.url);

    let releaseTx1!: () => void;
    const releaseTx1Promise = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    let tx1Ready!: () => void;
    const tx1ReadyPromise = new Promise<void>((resolve) => {
      tx1Ready = resolve;
    });

    let tx2Pid: number | null = null;
    let tx2Settled = false;

    try {
      const tx1Promise = conn1.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.households
          set deleted_at = now(),
              deleted_by = ${newId()}
          where id = ${targetHouseholdId}
        `;
        tx1Ready();
        await releaseTx1Promise;
      });

      await tx1ReadyPromise;

      const tx2Promise = conn2
        .begin(async (tx) => {
          await tx.unsafe("set role app");
          await tx`select set_config('app.org_id', ${orgId}, true)`;
          await tx`select set_config('app.community_id', ${commId}, true)`;
          const [pidRow] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          tx2Pid = pidRow?.pid ?? null;
          await tx`
            update app.persons
            set household_id = ${targetHouseholdId}
            where id = ${movedAdultId}
          `;
        })
        .finally(() => {
          tx2Settled = true;
        });

      let blocked = false;
      const started = Date.now();
      while (Date.now() - started < 10_000 && !tx2Settled) {
        if (tx2Pid !== null) {
          const rows = await inspector<{ count: number }[]>`
            select count(*)::int as count
            from pg_locks l
            join pg_stat_activity a on a.pid = l.pid
            where l.pid = ${tx2Pid}
              and l.granted = false
              and a.query like '%app.persons%'
          `;
          if ((rows[0]?.count ?? 0) > 0) {
            blocked = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(blocked).toBe(true);

      releaseTx1();
      await tx1Promise;

      await expect(tx2Promise).rejects.toThrow(/cannot place person in a deleted household/);

      const [moved] = await sql.begin(async (tx) => {
        await tx.unsafe("set role migrator");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        return tx<{ household_id: string | null }[]>`
          select household_id from app.persons where id = ${movedAdultId}
        `;
      });
      expect(moved?.household_id).toBeNull();
    } finally {
      releaseTx1();
      await conn1.end({ timeout: 1 });
      await conn2.end({ timeout: 1 });
      await inspector.end({ timeout: 1 });
    }
  }, 20_000);

  it("migration 0023: a raw hide waits for an add-minor in progress and is refused", async () => {
    const targetHouseholdId = newId();
    const newMinorId = newId();
    const fakeEncrypted = Buffer.from("0123456789abcdef0123456789abcdef");

    // Seed target household as migrator
    await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commId}, true)`;
      await tx`
        insert into app.households (id, org_id, community_id)
        values (${targetHouseholdId}, ${orgId}, ${commId})
      `;
    });

    const conn1 = createPlaintextDirectSql(database.url);
    const conn2 = createPlaintextDirectSql(database.url);
    const inspector = createPlaintextDirectSql(database.url);

    let releaseTx1!: () => void;
    const releaseTx1Promise = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    let tx1Ready!: () => void;
    const tx1ReadyPromise = new Promise<void>((resolve) => {
      tx1Ready = resolve;
    });

    let tx2Pid: number | null = null;
    let tx2Settled = false;

    try {
      const tx1Promise = conn1.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          insert into app.persons (
            id, org_id, community_id, household_id, version, is_minor, age_basis,
            given_name_restricted, family_name_restricted
          ) values (
            ${newMinorId}, ${orgId}, ${commId}, ${targetHouseholdId}, 1, true, 'unknown',
            ${fakeEncrypted}, ${fakeEncrypted}
          )
        `;
        tx1Ready();
        await releaseTx1Promise;
      });

      await tx1ReadyPromise;

      const tx2Promise = conn2
        .begin(async (tx) => {
          await tx.unsafe("set role app");
          await tx`select set_config('app.org_id', ${orgId}, true)`;
          await tx`select set_config('app.community_id', ${commId}, true)`;
          const [pidRow] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          tx2Pid = pidRow?.pid ?? null;
          await tx`
            update app.households
            set deleted_at = now(),
                deleted_by = ${newId()}
            where id = ${targetHouseholdId}
          `;
        })
        .finally(() => {
          tx2Settled = true;
        });

      let blocked = false;
      const started = Date.now();
      while (Date.now() - started < 10_000 && !tx2Settled) {
        if (tx2Pid !== null) {
          const rows = await inspector<{ count: number }[]>`
            select count(*)::int as count
            from pg_locks l
            join pg_stat_activity a on a.pid = l.pid
            where l.pid = ${tx2Pid}
              and l.granted = false
              and a.query like '%app.households%'
          `;
          if ((rows[0]?.count ?? 0) > 0) {
            blocked = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(blocked).toBe(true);

      releaseTx1();
      await tx1Promise;

      await expect(tx2Promise).rejects.toThrow(
        /cannot set deleted_at while a minor is in the household/,
      );
    } finally {
      releaseTx1();
      await conn1.end({ timeout: 1 });
      await conn2.end({ timeout: 1 });
      await inspector.end({ timeout: 1 });
    }
  }, 20_000);

  it("migration 0023: refuses an unknown household status", async () => {
    const newHouseholdId = newId();
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          insert into app.households (id, org_id, community_id, status)
          values (${newHouseholdId}, ${orgId}, ${commId}, 'unknown_status')
        `;
      }),
    ).rejects.toThrow(/households_status_check/);
  });

  it("migration 0023: PUBLIC cannot execute purge_deleted_households", async () => {
    const [row] = await sql<{ has_privilege: boolean }[]>`
      select has_function_privilege('public', 'app.purge_deleted_households(integer)', 'EXECUTE') as has_privilege
    `;
    expect(row?.has_privilege).toBe(false);
  });

  it("migration 0023: purge_deleted_households pins its search_path", async () => {
    const [row] = await sql<{ proconfig: string[] | null }[]>`
      select proconfig from pg_proc
      where proname = 'purge_deleted_households'
        and pronamespace = 'app'::regnamespace
    `;
    expect(row?.proconfig).toEqual(["search_path=pg_catalog, app"]);
  });

  it("migration 0023: the household and person trigger functions are invoker, pinned and closed to PUBLIC", async () => {
    const triggerFunctions = [
      "households_before_insert",
      "households_before_update",
      "persons_before_insert",
      "persons_before_update",
    ];

    for (const fn of triggerFunctions) {
      const [proc] = await sql<{ prosecdef: boolean; proconfig: string[] | null }[]>`
        select prosecdef, proconfig
        from pg_proc
        where proname = ${fn}
          and pronamespace = 'app'::regnamespace
      `;
      expect(proc?.prosecdef).toBe(false);
      expect(proc?.proconfig).toEqual(["search_path=pg_catalog, app"]);

      const [publicPriv] = await sql<{ has_privilege: boolean }[]>`
        select has_function_privilege('public', ${`app.${fn}()`}, 'EXECUTE') as has_privilege
      `;
      expect(publicPriv?.has_privilege).toBe(false);

      const [appPriv] = await sql<{ has_privilege: boolean }[]>`
        select has_function_privilege('app', ${`app.${fn}()`}, 'EXECUTE') as has_privilege
      `;
      expect(appPriv?.has_privilege).toBe(true);
    }
  });

  it("migration 0023: purge_deleted_households is SECURITY DEFINER and app has no DELETE grant", async () => {
    const [proc] = await sql<{ prosecdef: boolean }[]>`
      select prosecdef from pg_proc
      where proname = 'purge_deleted_households'
        and pronamespace = 'app'::regnamespace
    `;
    expect(proc?.prosecdef).toBe(true);

    const [priv] = await sql<{ has_delete: boolean }[]>`
      select has_table_privilege('app', 'app.households', 'DELETE') as has_delete
    `;
    expect(priv?.has_delete).toBe(false);

    const result = await sql.begin(async (tx) => {
      await tx.unsafe("set role app");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commId}, true)`;
      return tx`select * from app.purge_deleted_households(50)`;
    });
    expect(result).toEqual([]);
  });

  it("migration 0023: family purge raises when the tenant scope is unset or empty", async () => {
    // Unset org scope
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', '', true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`select * from app.purge_deleted_households(50)`;
      }),
    ).rejects.toThrow(/tenant scope required/);

    // Unset community scope
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', '', true)`;
        await tx`select * from app.purge_deleted_households(50)`;
      }),
    ).rejects.toThrow(/tenant scope required/);

    // Both unset
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select * from app.purge_deleted_households(50)`;
      }),
    ).rejects.toThrow(/tenant scope required/);
  });

  it("migration 0023: family purge raises on a limit outside 1 to 50", async () => {
    for (const limit of [null, 0, 51]) {
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe("set role app");
          await tx`select set_config('app.org_id', ${orgId}, true)`;
          await tx`select set_config('app.community_id', ${commId}, true)`;
          await tx`select * from app.purge_deleted_households(${limit})`;
        }),
      ).rejects.toThrow(/limit must be between 1 and 50/);
    }
  });
});
