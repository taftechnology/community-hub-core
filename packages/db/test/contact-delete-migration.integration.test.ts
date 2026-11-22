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

describe("contact delete migration 0022", () => {
  let database: FreshDatabase;
  let sql: ReturnType<typeof createPlaintextDirectSql>;

  const orgId = newId();
  const commId = newId();
  const customRoleId = newId();
  const householdId = newId();
  const adultId = newId();
  const minorId = newId();
  const hiddenAdultId = newId();

  beforeAll(async () => {
    const runtime = loadRuntime();
    database = await freshDatabase(runtime.directUrl);
    sql = createPlaintextDirectSql(database.url);

    // Apply migrations up to 0022
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
        (${commId}, ${orgId}, ${`comm-${commId}`}, 'au')
    `;

    // Seed community data inside a transaction with per-community set_config(..., true)
    await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commId}, true)`;

      // Custom role
      await tx`
        insert into app.custom_roles (id, org_id, community_id, key) values
          (${customRoleId}, ${orgId}, ${commId}, 'custom_test_role')
      `;

      // Household for minor
      await tx`
        insert into app.households (id, org_id, community_id) values
          (${householdId}, ${orgId}, ${commId})
      `;

      // Visible adult
      await tx`
        insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name) values
          (${adultId}, ${orgId}, ${commId}, 1, false, 'declared_adult', 'Adult', 'One')
      `;

      // Minor
      const fakeEncrypted = Buffer.from("0123456789abcdef0123456789abcdef");
      await tx`
        insert into app.persons (id, org_id, community_id, household_id, version, is_minor, age_basis, given_name_restricted, family_name_restricted) values
          (${minorId}, ${orgId}, ${commId}, ${householdId}, 1, true, 'unknown', ${fakeEncrypted}, ${fakeEncrypted})
      `;

      // Hidden adult
      await tx`
        insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name) values
          (${hiddenAdultId}, ${orgId}, ${commId}, 1, false, 'declared_adult', 'Hidden', 'Adult')
      `;
      await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
      await tx`
        update app.persons
        set deleted_at = now() - interval '10 hours',
            deleted_by = ${newId()}
        where id = ${hiddenAdultId}
      `;
      await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
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

  it("migration 0022: refuses a back-dated deleted_at from app", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.persons
          set deleted_at = now() - interval '1 hour',
              deleted_by = ${newId()}
          where id = ${adultId}
        `;
      }),
    ).rejects.toThrow(/deleted_at must be set to now/);
  });

  it("migration 0022: refuses deleted_at on a minor", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.persons
          set deleted_at = now(),
              deleted_by = ${newId()}
          where id = ${minorId}
        `;
      }),
    ).rejects.toThrow(/cannot set deleted_at on a minor/);
  });

  it("migration 0022: refuses deleted_at without deleted_by", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.persons
          set deleted_at = now(),
              deleted_by = null
          where id = ${adultId}
        `;
      }),
    ).rejects.toThrow(/deleted_by must be set when deleted_at is set/);
  });

  it("migration 0022: refuses moving deleted_at from one time to another", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          update app.persons
          set deleted_at = now()
          where id = ${hiddenAdultId}
        `;
      }),
    ).rejects.toThrow(/cannot change deleted_at/);
  });

  it("migration 0022: refuses a new contact inserted with deleted_at", async () => {
    const newPersonId = newId();
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name, deleted_at, deleted_by)
          values (${newPersonId}, ${orgId}, ${commId}, 1, false, 'declared_adult', 'New', 'Person', now(), ${newId()})
        `;
      }),
    ).rejects.toThrow(/deleted_at and deleted_by must be null on insert/);
  });

  it("migration 0022: PUBLIC cannot execute purge_deleted_persons", async () => {
    const [row] = await sql<{ has_privilege: boolean }[]>`
      select has_function_privilege('public', 'app.purge_deleted_persons(integer)', 'EXECUTE') as has_privilege
    `;
    expect(row?.has_privilege).toBe(false);
  });

  it("migration 0022: purge_deleted_persons pins its search_path", async () => {
    const [row] = await sql<{ proconfig: string[] | null }[]>`
      select proconfig from pg_proc
      where proname = 'purge_deleted_persons'
        and pronamespace = 'app'::regnamespace
    `;
    expect(row?.proconfig).toEqual(["search_path=pg_catalog, app"]);
  });

  it("migration 0022: app can purge through the function without a DELETE grant", async () => {
    const [proc] = await sql<{ prosecdef: boolean }[]>`
      select prosecdef from pg_proc
      where proname = 'purge_deleted_persons'
        and pronamespace = 'app'::regnamespace
    `;
    expect(proc?.prosecdef).toBe(true);

    const [priv] = await sql<{ has_delete: boolean }[]>`
      select has_table_privilege('app', 'app.persons', 'DELETE') as has_delete
    `;
    expect(priv?.has_delete).toBe(false);

    const result = await sql.begin(async (tx) => {
      await tx.unsafe("set role app");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commId}, true)`;
      return tx`select * from app.purge_deleted_persons(50)`;
    });
    expect(result).toEqual([]);
  });

  it("migration 0022: purge raises when the tenant scope is unset or empty", async () => {
    // Unset org scope
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', '', true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`select * from app.purge_deleted_persons(50)`;
      }),
    ).rejects.toThrow(/tenant scope required/);

    // Unset community scope
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', '', true)`;
        await tx`select * from app.purge_deleted_persons(50)`;
      }),
    ).rejects.toThrow(/tenant scope required/);

    // Both unset
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role app");
        await tx`select * from app.purge_deleted_persons(50)`;
      }),
    ).rejects.toThrow(/tenant scope required/);
  });

  it("migration 0022: purge raises on a limit outside 1 to 50", async () => {
    for (const limit of [null, 0, 51]) {
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe("set role app");
          await tx`select set_config('app.org_id', ${orgId}, true)`;
          await tx`select set_config('app.community_id', ${commId}, true)`;
          await tx`select * from app.purge_deleted_persons(${limit})`;
        }),
      ).rejects.toThrow(/limit must be between 1 and 50/);
    }
  });

  it("migration 0022: a custom role may hold people.delete", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("set role migrator");
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.community_id', ${commId}, true)`;
      await tx`
        insert into app.custom_role_permissions (org_id, community_id, custom_role_id, permission)
        values (${orgId}, ${commId}, ${customRoleId}, 'people.delete')
      `;
    });

    // Verify unknown permission rejected by check constraint
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set role migrator");
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.community_id', ${commId}, true)`;
        await tx`
          insert into app.custom_role_permissions (org_id, community_id, custom_role_id, permission)
          values (${orgId}, ${commId}, ${customRoleId}, 'bogus.permission')
        `;
      }),
    ).rejects.toThrow();
  });
});
