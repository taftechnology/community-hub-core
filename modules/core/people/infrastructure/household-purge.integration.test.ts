import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { openHouseholdLabel } from "./household.js";
import { createHousehold, purgeDeletedHouseholds } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const FAKE_ENCRYPTED = Buffer.from("0123456789abcdef0123456789abcdef");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

describe("purgeDeletedHouseholds", () => {
  let runtime: Runtime;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let migrator: ReturnType<typeof createPlaintextDirectSql>;
  const kms = createLocalKmsPort();

  beforeAll(async () => {
    runtime = loadRuntime();
    migrator = createPlaintextDirectSql(runtime.productOnlyUrl);
    await applyProductMigrations(migrator);
    platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    app = createPlaintextAppSql(roleUrl(runtime, "app"));
  });

  afterAll(async () => {
    await app.end({ timeout: 1 });
    await platform.end({ timeout: 1 });
    await migrator.end({ timeout: 1 });
  });

  async function setupTenant(slugPrefix = "h-purge") {
    const organisationId = newId();
    const communityId = newId();
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${organisationId}, ${`${slugPrefix}-${organisationId}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${organisationId}, ${`${slugPrefix}-${communityId}`}, 'au')
      `;
    });
    return { orgId: organisationId, communityId };
  }

  async function insertHousehold(scope: { orgId: string; communityId: string }): Promise<string> {
    const id = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.households (id, org_id, community_id)
        values (${id}, ${scope.orgId}, ${scope.communityId})
      `;
    });
    return id;
  }

  async function ageHousehold(
    scope: { orgId: string; communityId: string },
    householdId: string,
    hours = 721,
    deletedBy = newId(),
  ): Promise<void> {
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx.unsafe("ALTER TABLE app.households DISABLE TRIGGER USER");
      await tx`
        update app.households
        set deleted_at = now() - (${hours} * interval '1 hour'),
            deleted_by = ${deletedBy}
        where id = ${householdId}
      `;
      await tx.unsafe("ALTER TABLE app.households ENABLE TRIGGER USER");
    });
  }

  async function insertAdult(
    scope: { orgId: string; communityId: string },
    householdId: string | null = null,
    givenName = "Adult",
    familyName = "Test",
  ): Promise<string> {
    const id = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.persons (id, org_id, community_id, household_id, version, is_minor, age_basis, given_name, family_name)
        values (${id}, ${scope.orgId}, ${scope.communityId}, ${householdId}, 1, false, 'declared_adult', ${givenName}, ${familyName})
      `;
    });
    return id;
  }

  async function agePerson(
    scope: { orgId: string; communityId: string },
    personId: string,
    hours = 10,
    deletedBy = newId(),
  ): Promise<void> {
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
      await tx`
        update app.persons
        set deleted_at = now() - (${hours} * interval '1 hour'),
            deleted_by = ${deletedBy}
        where id = ${personId}
      `;
      await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
    });
  }

  async function insertMinor(
    scope: { orgId: string; communityId: string },
    householdId: string,
  ): Promise<string> {
    const minorId = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.persons (id, org_id, community_id, household_id, version, is_minor, age_basis, given_name_restricted, family_name_restricted)
        values (${minorId}, ${scope.orgId}, ${scope.communityId}, ${householdId}, 1, true, 'unknown', ${FAKE_ENCRYPTED}, ${FAKE_ENCRYPTED})
      `;
    });
    return minorId;
  }

  async function getHousehold(
    scope: { orgId: string; communityId: string },
    householdId: string,
  ): Promise<{ id: string; deleted_at: Date | null } | undefined> {
    return withAppTransaction(migrator, scope, async (tx) => {
      const [row] = await tx<{ id: string; deleted_at: Date | null }[]>`
        select id::text as id, deleted_at
        from app.households
        where id = ${householdId}
      `;
      return row;
    });
  }

  async function getHouseholdKey(
    scope: { orgId: string; communityId: string },
    householdId: string,
  ): Promise<{ id: string } | undefined> {
    return withAppTransaction(migrator, scope, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select id::text as id
        from app.household_keys
        where household_id = ${householdId}
      `;
      return row;
    });
  }

  async function getPerson(
    scope: { orgId: string; communityId: string },
    personId: string,
  ): Promise<
    | {
        id: string;
        household_id: string | null;
        version: number;
        deleted_at: Date | null;
      }
    | undefined
  > {
    return withAppTransaction(migrator, scope, async (tx) => {
      const [row] = await tx<
        {
          id: string;
          household_id: string | null;
          version: number;
          deleted_at: Date | null;
        }[]
      >`
        select id::text as id, household_id::text as household_id, version, deleted_at
        from app.persons
        where id = ${personId}
      `;
      return row;
    });
  }

  async function getFkReferencingHouseholds(sqlClient: Sql | TransactionSql): Promise<string[]> {
    const rows = await sqlClient<{ table_name: string }[]>`
      select distinct c_rel.relname as table_name
      from pg_constraint c
      join pg_class c_rel on c_rel.oid = c.conrelid
      join pg_namespace c_ns on c_ns.oid = c_rel.relnamespace
      join pg_class f_rel on f_rel.oid = c.confrelid
      join pg_namespace f_ns on f_ns.oid = f_rel.relnamespace
      where c.contype = 'f'
        and f_ns.nspname = 'app'
        and f_rel.relname = 'households'
    `;
    return rows.map((r) => r.table_name);
  }

  async function getHandledTablesFromFunctionDef(
    sqlClient: Sql | TransactionSql,
  ): Promise<Set<string>> {
    const [proc] = await sqlClient<{ def: string }[]>`
      select pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and p.proname = 'purge_deleted_households'
    `;
    if (!proc?.def) {
      return new Set();
    }
    const cleanDef = proc.def.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

    const handled = new Set<string>();
    const deleteMatches = cleanDef.matchAll(/delete\s+from\s+app\.([a-z0-9_]+)/gi);
    for (const m of deleteMatches) {
      if (m[1]) {
        handled.add(m[1].toLowerCase());
      }
    }
    const updateMatches = cleanDef.matchAll(/update\s+app\.([a-z0-9_]+)/gi);
    for (const m of updateMatches) {
      if (m[1]) {
        handled.add(m[1].toLowerCase());
      }
    }
    return handled;
  }

  it("app can purge a family through the function without a DELETE grant", async () => {
    const [proc] = await migrator<{ prosecdef: boolean }[]>`
      select prosecdef from pg_proc
      where proname = 'purge_deleted_households'
        and pronamespace = 'app'::regnamespace
    `;
    expect(proc?.prosecdef).toBe(true);

    const [priv] = await migrator<{ has_delete: boolean }[]>`
      select has_table_privilege('app', 'app.households', 'DELETE') as has_delete
    `;
    expect(priv?.has_delete).toBe(false);

    const scope = await setupTenant("p17");
    const household = await insertHousehold(scope);
    await ageHousehold(scope, household, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 50)).resolves.toEqual([household]);
      }),
    );

    const purged = await getHousehold(scope, household);
    expect(purged).toBeUndefined();
  });

  it("family purge leaves a family hidden 719 hours", async () => {
    const scope = await setupTenant("p20");
    const h719 = await insertHousehold(scope);
    const h721 = await insertHousehold(scope);
    const hVisible = await insertHousehold(scope);

    await ageHousehold(scope, h719, 719);
    await ageHousehold(scope, h721, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 50)).resolves.toEqual([h721]);
      }),
    );

    const survivor719 = await getHousehold(scope, h719);
    expect(survivor719).toBeDefined();
    expect(survivor719?.deleted_at).not.toBeNull();

    const survivorVisible = await getHousehold(scope, hVisible);
    expect(survivorVisible).toBeDefined();
    expect(survivorVisible?.deleted_at).toBeNull();

    const purged721 = await getHousehold(scope, h721);
    expect(purged721).toBeUndefined();
  });

  it("family purge leaves a visible family", async () => {
    const scope = await setupTenant("p21");
    const hVisible = await insertHousehold(scope);
    const h721 = await insertHousehold(scope);
    await ageHousehold(scope, h721, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 50)).resolves.toEqual([h721]);
      }),
    );

    const survivor = await getHousehold(scope, hVisible);
    expect(survivor).toBeDefined();
    expect(survivor?.deleted_at).toBeNull();

    const purged = await getHousehold(scope, h721);
    expect(purged).toBeUndefined();
  });

  it("family purge never erases a family with a minor in it", async () => {
    const scope = await setupTenant("p22");
    const hEligible = await insertHousehold(scope);
    await insertAdult(scope, hEligible, "Eligible", "Adult");
    await ageHousehold(scope, hEligible, 721);

    const hWithMinor = await insertHousehold(scope);
    await insertMinor(scope, hWithMinor);
    await ageHousehold(scope, hWithMinor, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 50)).resolves.toEqual([hEligible]);
      }),
    );

    const survivorMinorHousehold = await getHousehold(scope, hWithMinor);
    expect(survivorMinorHousehold).toBeDefined();
    expect(survivorMinorHousehold?.deleted_at).not.toBeNull();

    const purged = await getHousehold(scope, hEligible);
    expect(purged).toBeUndefined();
  });

  it("family purge erases only the scoped community's families", async () => {
    const orgId = newId();
    const comm1Id = newId();
    const comm2Id = newId();

    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${orgId}, ${`scoped-${orgId}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${comm1Id}, ${orgId}, ${`scoped-1-${comm1Id}`}, 'au'),
               (${comm2Id}, ${orgId}, ${`scoped-2-${comm2Id}`}, 'au')
      `;
    });

    const h1 = await insertHousehold({ orgId, communityId: comm1Id });
    await ageHousehold({ orgId, communityId: comm1Id }, h1, 721);

    const h2 = await insertHousehold({ orgId, communityId: comm2Id });
    await ageHousehold({ orgId, communityId: comm2Id }, h2, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId, communityId: comm1Id }, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 50)).resolves.toEqual([h1]);
      }),
    );

    const survivor = await getHousehold({ orgId, communityId: comm2Id }, h2);
    expect(survivor).toBeDefined();

    const purged = await getHousehold({ orgId, communityId: comm1Id }, h1);
    expect(purged).toBeUndefined();
  });

  it("family purge leaves another organisation's families untouched", async () => {
    const scope1 = await setupTenant("org1");
    const scope2 = await setupTenant("org2");

    const h1 = await insertHousehold(scope1);
    await ageHousehold(scope1, h1, 721);

    const h2 = await insertHousehold(scope2);
    await ageHousehold(scope2, h2, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope1, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 50)).resolves.toEqual([h1]);
      }),
    );

    const survivor = await getHousehold(scope2, h2);
    expect(survivor).toBeDefined();

    const purged = await getHousehold(scope1, h1);
    expect(purged).toBeUndefined();
  });

  it("family purge clears household_id on hidden contacts too", async () => {
    const scope = await setupTenant("p25");
    const household = await insertHousehold(scope);

    const visibleAdult = await insertAdult(scope, household, "Visible", "Adult");
    const hiddenAdult = await insertAdult(scope, household, "Hidden", "Adult");
    await agePerson(scope, hiddenAdult, 10);
    await ageHousehold(scope, household, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 50)).resolves.toEqual([household]);
      }),
    );

    const purged = await getHousehold(scope, household);
    expect(purged).toBeUndefined();

    const survivorVisible = await getPerson(scope, visibleAdult);
    expect(survivorVisible).toBeDefined();
    expect(survivorVisible?.household_id).toBeNull();
    expect(survivorVisible?.version).toBe(2);

    const survivorHidden = await getPerson(scope, hiddenAdult);
    expect(survivorHidden).toBeDefined();
    expect(survivorHidden?.household_id).toBeNull();
    expect(survivorHidden?.version).toBe(2);
    expect(survivorHidden?.deleted_at).not.toBeNull();
  });

  it("family purge keeps the adults as contacts and bumps their version", async () => {
    const scope = await setupTenant("p26");
    const household = await insertHousehold(scope);
    const adult = await insertAdult(scope, household, "Staying", "Adult");
    await ageHousehold(scope, household, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 50)).resolves.toEqual([household]);
      }),
    );

    const purged = await getHousehold(scope, household);
    expect(purged).toBeUndefined();

    const survivingAdult = await getPerson(scope, adult);
    expect(survivingAdult).toBeDefined();
    expect(survivingAdult?.household_id).toBeNull();
    expect(survivingAdult?.version).toBe(2);
  });

  it("family purge erases the household key and the household row", async () => {
    const scope = await setupTenant("p27");
    const { householdId } = await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        return createHousehold(tx, kms, KEY_ARN, {
          now: new Date(),
          label: "AgedFamily",
          actorUserId: null,
        });
      }),
    );

    // Verify label opens before purge and key exists
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        const opened = await openHouseholdLabel(tx, kms, KEY_ARN, householdId);
        expect(opened).toEqual({ householdId, label: "AgedFamily" });
      }),
    );

    const keyBefore = await getHouseholdKey(scope, householdId);
    expect(keyBefore).toBeDefined();

    await ageHousehold(scope, householdId, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 50)).resolves.toEqual([householdId]);
      }),
    );

    const purgedHousehold = await getHousehold(scope, householdId);
    expect(purgedHousehold).toBeUndefined();

    const purgedKey = await getHouseholdKey(scope, householdId);
    expect(purgedKey).toBeUndefined();

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        const opened = await openHouseholdLabel(tx, kms, KEY_ARN, householdId);
        expect(opened).toBeNull();
      }),
    );
  });

  it("family purge skips a family another transaction has locked", async () => {
    const scope = await setupTenant("p28");
    const hLocked = await insertHousehold(scope);
    await ageHousehold(scope, hLocked, 721);

    const hUnlocked = await insertHousehold(scope);
    await ageHousehold(scope, hUnlocked, 721);

    const app2 = createPlaintextAppSql(roleUrl(runtime, "app"));
    let releaseLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      void withAppTransaction(app, scope, async (tx1) => {
        await tx1`select id from app.households where id = ${hLocked} for update`;
        resolve();
        await new Promise<void>((done) => {
          releaseLock = done;
        });
      });
    });

    await lockHeld;

    try {
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app2, scope, async (tx2) => {
          await tx2.unsafe("set local lock_timeout = '1s'");
          await expect(purgeDeletedHouseholds(tx2, 50)).resolves.toEqual([hUnlocked]);
        }),
      );
    } finally {
      releaseLock?.();
      await app2.end({ timeout: 1 });
    }

    const survivor = await getHousehold(scope, hLocked);
    expect(survivor).toBeDefined();

    const purged = await getHousehold(scope, hUnlocked);
    expect(purged).toBeUndefined();
  });

  it("family purge writes one people.household.purged event with all purged ids", async () => {
    const scope = await setupTenant("p29");
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(newId());
    }

    const deletedBy = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      for (const id of ids) {
        await tx`
          insert into app.households (id, org_id, community_id)
          values (${id}, ${scope.orgId}, ${scope.communityId})
        `;
      }
      await tx.unsafe("ALTER TABLE app.households DISABLE TRIGGER USER");
      await tx`
        update app.households
        set deleted_at = now() - interval '721 hours',
            deleted_by = ${deletedBy}
        where id = any(${ids}::uuid[])
      `;
      await tx.unsafe("ALTER TABLE app.households ENABLE TRIGGER USER");
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 50)).resolves.toEqual(expect.arrayContaining(ids));
      }),
    );

    const events = await withAppTransaction(migrator, scope, async (tx) => {
      return tx<{ actor_kind: string; actor_id: string | null; target_ids: string[] }[]>`
        select actor_kind, actor_id, target_ids
        from app.audit_events
        where action = 'people.household.purged'
          and org_id = ${scope.orgId}
      `;
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.actor_kind).toBe("system");
    expect(events[0]?.actor_id).toBeNull();
    expect(events[0]?.target_ids.slice().sort()).toEqual(ids.slice().sort());
  });

  it("family purge takes the oldest families up to the limit", async () => {
    const scope = await setupTenant("p-order");
    const h723 = await insertHousehold(scope);
    const h721 = await insertHousehold(scope);
    const h722 = await insertHousehold(scope);
    await ageHousehold(scope, h723, 723);
    await ageHousehold(scope, h721, 721);
    await ageHousehold(scope, h722, 722);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 2)).resolves.toEqual([h723, h722]);
      }),
    );

    expect(await getHousehold(scope, h723)).toBeUndefined();
    expect(await getHousehold(scope, h722)).toBeUndefined();
    const survivor = await getHousehold(scope, h721);
    expect(survivor).toBeDefined();
    expect(survivor?.deleted_at).not.toBeNull();
  });

  it("family purge writes no event when nothing is eligible", async () => {
    const scope = await setupTenant("p-no-event");
    const tooRecent = await insertHousehold(scope);
    await ageHousehold(scope, tooRecent, 719);
    await insertHousehold(scope);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(purgeDeletedHouseholds(tx, 50)).resolves.toEqual([]);
      }),
    );

    const events = await withAppTransaction(migrator, scope, async (tx) => {
      return tx<{ id: string }[]>`
        select id::text as id
        from app.audit_events
        where action = 'people.household.purged'
          and org_id = ${scope.orgId}
      `;
    });
    expect(events).toHaveLength(0);
  });

  it("every foreign key to app.households is handled by the family purge", async () => {
    const fkTables = await getFkReferencingHouseholds(migrator);
    const handled = await getHandledTablesFromFunctionDef(migrator);
    const unhandled = fkTables.filter((t) => !handled.has(t));
    expect(unhandled).toEqual([]);
  });

  it("reports an unhandled foreign key to app.households in probe table", async () => {
    await migrator.begin(async (tx) => {
      await tx.unsafe(`
        create table app.zz_probe_hh (
          org_id uuid not null,
          id uuid not null,
          household_id uuid not null,
          constraint zz_probe_hh_fk foreign key (org_id, household_id) references app.households(org_id, id)
        )
      `);
      try {
        const fkTables = await getFkReferencingHouseholds(tx);
        const handled = await getHandledTablesFromFunctionDef(tx);
        const unhandled = fkTables.filter((t) => !handled.has(t));
        expect(unhandled).toContain("zz_probe_hh");
      } finally {
        await tx.unsafe("drop table app.zz_probe_hh");
      }
    });
  });
});
