import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { hideHousehold, moveAdult, restoreHousehold, setHouseholdStatus } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const FAKE_ENCRYPTED = Buffer.from("0123456789abcdef0123456789abcdef");
const ACTOR = "00000000-0000-4000-8000-000000000002";

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

describe("household-delete and household-status", () => {
  let runtime: Runtime;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let migrator: ReturnType<typeof createPlaintextDirectSql>;

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

  async function setupTenant(slugPrefix = "hdel") {
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

  async function insertHousehold(
    scope: { orgId: string; communityId: string },
    status = "active",
  ): Promise<string> {
    const id = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.households (id, org_id, community_id, status)
        values (${id}, ${scope.orgId}, ${scope.communityId}, ${status})
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
    status = "active",
  ): Promise<string> {
    const id = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.persons (
          id, org_id, community_id, household_id, version, is_minor, age_basis,
          given_name, family_name, status
        )
        values (
          ${id}, ${scope.orgId}, ${scope.communityId}, ${householdId}, 1, false, 'declared_adult',
          ${givenName}, ${familyName}, ${status}
        )
      `;
    });
    return id;
  }

  async function insertMinor(
    scope: { orgId: string; communityId: string },
    householdId: string,
    ageBasis: "date_of_birth" | "unknown" = "date_of_birth",
  ): Promise<string> {
    const id = newId();
    const dateOfBirth = ageBasis === "date_of_birth" ? "2015-05-10" : null;
    const birthdayMd = ageBasis === "date_of_birth" ? "0510" : null;
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.persons (
          id, org_id, community_id, household_id, version, is_minor, age_basis,
          date_of_birth, birthday_md, given_name_restricted, family_name_restricted
        )
        values (
          ${id}, ${scope.orgId}, ${scope.communityId}, ${householdId}, 1, true, ${ageBasis},
          ${dateOfBirth}, ${birthdayMd}, ${FAKE_ENCRYPTED}, ${FAKE_ENCRYPTED}
        )
      `;
    });
    return id;
  }

  async function getHousehold(scope: { orgId: string; communityId: string }, householdId: string) {
    const rows = await withAppTransaction(migrator, scope, async (tx) => {
      return tx<
        {
          id: string;
          version: number;
          status: string;
          deleted_at: Date | null;
          deleted_by: string | null;
        }[]
      >`
        select
          id::text as id,
          version,
          status,
          deleted_at,
          deleted_by::text as deleted_by
        from app.households
        where id = ${householdId}
      `;
    });
    return rows[0];
  }

  async function getPerson(scope: { orgId: string; communityId: string }, personId: string) {
    const rows = await withAppTransaction(migrator, scope, async (tx) => {
      return tx<
        {
          id: string;
          version: number;
          status: string;
          household_id: string | null;
          deleted_at: Date | null;
        }[]
      >`
        select
          id::text as id,
          version,
          status,
          household_id::text as household_id,
          deleted_at
        from app.persons
        where id = ${personId}
      `;
    });
    return rows[0];
  }

  // Pin 31: Hide locks the household FOR UPDATE and checks for a child after it
  it("a delete waits for an add-minor in progress, answers household_has_children and leaves the family visible", async () => {
    const scope = await setupTenant("p31");
    const targetHouseholdId = await insertHousehold(scope);
    const newMinorId = newId();

    const app1 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const app2 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const inspector = createPlaintextDirectSql(runtime.productOnlyUrl);

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
      const tx1Promise = withAppTransaction(app1, scope, async (tx) => {
        await tx`
          insert into app.persons (
            id, org_id, community_id, household_id, version, is_minor, age_basis,
            date_of_birth, birthday_md, given_name_restricted, family_name_restricted
          ) values (
            ${newMinorId}, ${scope.orgId}, ${scope.communityId}, ${targetHouseholdId}, 1, true, 'date_of_birth',
            '2015-05-10', '0510', ${FAKE_ENCRYPTED}, ${FAKE_ENCRYPTED}
          )
        `;
        tx1Ready();
        await releaseTx1Promise;
      }).catch((err) => {
        tx1Ready();
        throw err;
      });

      await tx1ReadyPromise;

      const tx2Promise = withAppTransaction(app2, scope, async (tx) => {
        const [pidRow] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        tx2Pid = pidRow?.pid ?? null;
        await withRequest({ requestId: REQUEST_ID }, () =>
          hideHousehold(tx, {
            householdId: targetHouseholdId,
            version: 1,
            actorUserId: ACTOR,
          }),
        );
      }).finally(() => {
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

      await expect(tx2Promise).rejects.toMatchObject({
        code: "household_has_children",
      });

      const household = await getHousehold(scope, targetHouseholdId);
      expect(household).toBeDefined();
      expect(household?.deleted_at).toBeNull();
      expect(household?.version).toBe(1);
    } finally {
      releaseTx1();
      await app1.end({ timeout: 1 });
      await app2.end({ timeout: 1 });
      await inspector.end({ timeout: 1 });
    }
  }, 20_000);

  it("an add-minor waits for a delete in progress and is refused", async () => {
    const scope = await setupTenant("p31b");
    const targetHouseholdId = await insertHousehold(scope);
    const newMinorId = newId();

    const app1 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const app2 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const inspector = createPlaintextDirectSql(runtime.productOnlyUrl);

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
      const tx1Promise = withAppTransaction(app1, scope, async (tx) => {
        await withRequest({ requestId: REQUEST_ID }, () =>
          hideHousehold(tx, {
            householdId: targetHouseholdId,
            version: 1,
            actorUserId: ACTOR,
          }),
        );
        tx1Ready();
        await releaseTx1Promise;
      }).catch((err) => {
        tx1Ready();
        throw err;
      });

      await tx1ReadyPromise;

      const tx2Promise = withAppTransaction(app2, scope, async (tx) => {
        const [pidRow] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        tx2Pid = pidRow?.pid ?? null;
        await tx`
          insert into app.persons (
            id, org_id, community_id, household_id, version, is_minor, age_basis,
            date_of_birth, birthday_md, given_name_restricted, family_name_restricted
          ) values (
            ${newMinorId}, ${scope.orgId}, ${scope.communityId}, ${targetHouseholdId}, 1, true, 'date_of_birth',
            '2015-05-10', '0510', ${FAKE_ENCRYPTED}, ${FAKE_ENCRYPTED}
          )
        `;
      }).finally(() => {
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
      await app1.end({ timeout: 1 });
      await app2.end({ timeout: 1 });
      await inspector.end({ timeout: 1 });
    }
  }, 20_000);

  // Pin 32: Restore only within 720 hours
  it("restore answers not found at 721 hours", async () => {
    const scope = await setupTenant("p32");
    const householdId = await insertHousehold(scope);
    await ageHousehold(scope, householdId, 721);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          restoreHousehold(tx, {
            householdId,
            version: 1,
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "not_found" });
      }),
    );

    const household = await getHousehold(scope, householdId);
    expect(household).toBeDefined();
    expect(household?.deleted_at).not.toBeNull();
    expect(household?.version).toBe(1);
  });

  it("restore resolves for a family hidden 719 hours", async () => {
    const scope = await setupTenant("p32b");
    const householdId = await insertHousehold(scope);
    await ageHousehold(scope, householdId, 719);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          restoreHousehold(tx, {
            householdId,
            version: 1,
            actorUserId: ACTOR,
          }),
        ).resolves.toEqual({
          householdId,
          version: 2,
        });
      }),
    );

    const household = await getHousehold(scope, householdId);
    expect(household).toBeDefined();
    expect(household?.deleted_at).toBeNull();
    expect(household?.deleted_by).toBeNull();
    expect(household?.version).toBe(2);
  });

  // Pin 33: household_has_children for a minor and for age_basis unknown
  it("delete refuses a family with a minor and with a minor of unknown age", async () => {
    const scope = await setupTenant("p33");
    const h1 = await insertHousehold(scope);
    await insertMinor(scope, h1, "date_of_birth");

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          hideHousehold(tx, {
            householdId: h1,
            version: 1,
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "household_has_children" });
      }),
    );

    const afterH1 = await getHousehold(scope, h1);
    expect(afterH1?.deleted_at).toBeNull();
    expect(afterH1?.version).toBe(1);

    const h2 = await insertHousehold(scope);
    await insertMinor(scope, h2, "unknown");

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          hideHousehold(tx, {
            householdId: h2,
            version: 1,
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "household_has_children" });
      }),
    );

    const afterH2 = await getHousehold(scope, h2);
    expect(afterH2?.deleted_at).toBeNull();
    expect(afterH2?.version).toBe(1);
  });

  // Pin 34: Version compare on delete
  it("a stale version on family delete or restore answers conflict and changes nothing", async () => {
    const scope = await setupTenant("p34");
    const householdId = await insertHousehold(scope);

    // Stale version on delete
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          hideHousehold(tx, {
            householdId,
            version: 999,
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
      }),
    );

    let household = await getHousehold(scope, householdId);
    expect(household?.deleted_at).toBeNull();
    expect(household?.version).toBe(1);

    // Delete with correct version
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          hideHousehold(tx, {
            householdId,
            version: 1,
            actorUserId: ACTOR,
          }),
        ).resolves.toMatchObject({
          householdId,
          version: 2,
        });
      }),
    );

    household = await getHousehold(scope, householdId);
    expect(household?.deleted_at).not.toBeNull();
    expect(household?.version).toBe(2);

    // Stale version on restore
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          restoreHousehold(tx, {
            householdId,
            version: 999,
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
      }),
    );

    household = await getHousehold(scope, householdId);
    expect(household?.deleted_at).not.toBeNull();
    expect(household?.version).toBe(2);
  });

  // Pin 34b: Version before the child check
  it("a stale version with a child present answers conflict", async () => {
    const scope = await setupTenant("p34b");
    const householdId = await insertHousehold(scope);
    await insertMinor(scope, householdId, "date_of_birth");

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          hideHousehold(tx, {
            householdId,
            version: 999,
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
      }),
    );

    const household = await getHousehold(scope, householdId);
    expect(household?.deleted_at).toBeNull();
    expect(household?.version).toBe(1);
  });

  // Pin 35: Deleted and restored events, ids only
  it("family delete and restore each write one event with the household id only", async () => {
    const scope = await setupTenant("p35");
    const householdId = await insertHousehold(scope);

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await hideHousehold(tx, {
          householdId,
          version: 1,
          actorUserId: ACTOR,
        });
      }),
    );

    const deleteEvents = await withAppTransaction(migrator, scope, async (tx) => {
      return tx<
        {
          action: string;
          purpose: string;
          target_ids: string[];
        }[]
      >`
        select action, purpose, target_ids::text[] as target_ids
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and action = 'people.household.deleted'
      `;
    });
    expect(deleteEvents).toHaveLength(1);
    expect(deleteEvents[0]).toEqual({
      action: "people.household.deleted",
      purpose: "people.household.deleted",
      target_ids: [householdId],
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await restoreHousehold(tx, {
          householdId,
          version: 2,
          actorUserId: ACTOR,
        });
      }),
    );

    const restoreEvents = await withAppTransaction(migrator, scope, async (tx) => {
      return tx<
        {
          action: string;
          purpose: string;
          target_ids: string[];
        }[]
      >`
        select action, purpose, target_ids::text[] as target_ids
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and action = 'people.household.restored'
      `;
    });
    expect(restoreEvents).toHaveLength(1);
    expect(restoreEvents[0]).toEqual({
      action: "people.household.restored",
      purpose: "people.household.restored",
      target_ids: [householdId],
    });
  });

  // Pin 36: Version compare on status
  it("a stale version on family status answers conflict and changes nothing", async () => {
    const scope = await setupTenant("p36");
    const householdId = await insertHousehold(scope, "active");

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          setHouseholdStatus(tx, {
            householdId,
            version: 999,
            status: "inactive",
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
      }),
    );

    const household = await getHousehold(scope, householdId);
    expect(household?.status).toBe("active");
    expect(household?.version).toBe(1);
  });

  // Pin 84: Status changes nothing else
  it("family status leaves its adults' status unchanged", async () => {
    const scope = await setupTenant("p84");
    const householdId = await insertHousehold(scope, "active");
    const adult1 = await insertAdult(scope, householdId, "Adult1", "Test", "active");
    const adult2 = await insertAdult(scope, householdId, "Adult2", "Test", "active");

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          setHouseholdStatus(tx, {
            householdId,
            version: 1,
            status: "inactive",
            actorUserId: ACTOR,
          }),
        ).resolves.toMatchObject({
          householdId,
          version: 2,
          status: "inactive",
        });
      }),
    );

    const household = await getHousehold(scope, householdId);
    expect(household?.status).toBe("inactive");
    expect(household?.version).toBe(2);

    const a1 = await getPerson(scope, adult1);
    expect(a1?.status).toBe("active");
    expect(a1?.version).toBe(1);

    const a2 = await getPerson(scope, adult2);
    expect(a2?.status).toBe("active");
    expect(a2?.version).toBe(1);
  });

  it("setHouseholdStatus sets active and inactive, bumps version and writes status_changed event", async () => {
    const scope = await setupTenant("status-transitions");
    const householdId = await insertHousehold(scope, "active");

    // Change to inactive
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          setHouseholdStatus(tx, {
            householdId,
            version: 1,
            status: "inactive",
            actorUserId: ACTOR,
          }),
        ).resolves.toEqual({
          householdId,
          version: 2,
          status: "inactive",
        });
      }),
    );

    let household = await getHousehold(scope, householdId);
    expect(household?.status).toBe("inactive");
    expect(household?.version).toBe(2);

    // Change back to active
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await expect(
          setHouseholdStatus(tx, {
            householdId,
            version: 2,
            status: "active",
            actorUserId: ACTOR,
          }),
        ).resolves.toEqual({
          householdId,
          version: 3,
          status: "active",
        });
      }),
    );

    household = await getHousehold(scope, householdId);
    expect(household?.status).toBe("active");
    expect(household?.version).toBe(3);

    const events = await withAppTransaction(migrator, scope, async (tx) => {
      return tx<
        {
          action: string;
          purpose: string;
          target_ids: string[];
        }[]
      >`
        select action, purpose, target_ids::text[] as target_ids
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and action = 'people.household.status_changed'
        order by seq asc
      `;
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      action: "people.household.status_changed",
      purpose: "people.household.status_changed",
      target_ids: [householdId],
    });
    expect(events[1]).toEqual({
      action: "people.household.status_changed",
      purpose: "people.household.status_changed",
      target_ids: [householdId],
    });
  });

  it("an adult moved out while the family was hidden does not come back on restore", async () => {
    const scope = await setupTenant("adult-moved-out");
    const householdId = await insertHousehold(scope);
    const adult1 = await insertAdult(scope, householdId, "Adult1", "Test");
    const adult2 = await insertAdult(scope, householdId, "Adult2", "Test");

    // Hide household
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await hideHousehold(tx, {
          householdId,
          version: 1,
          actorUserId: ACTOR,
        });
      }),
    );

    // Move adult2 out (householdId: null)
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await moveAdult(tx, {
          personId: adult2,
          version: 1,
          householdId: null,
          actorUserId: ACTOR,
        });
      }),
    );

    // Restore household
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await restoreHousehold(tx, {
          householdId,
          version: 2,
          actorUserId: ACTOR,
        });
      }),
    );

    const a1 = await getPerson(scope, adult1);
    expect(a1?.household_id).toBe(householdId);

    const a2 = await getPerson(scope, adult2);
    expect(a2?.household_id).toBeNull();
  });

  it("not found cases leave rows unchanged: unknown id, hidden family, visible family, other community, other organisation", async () => {
    const scopeA = await setupTenant("nf-a");
    const scopeB = await setupTenant("nf-b");
    const communityA2 = newId();
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityA2}, ${scopeA.orgId}, ${`nf-a2-${communityA2}`}, 'au')
      `;
    });
    const scopeA2 = { orgId: scopeA.orgId, communityId: communityA2 };

    const unknownId = newId();
    const visibleH = await insertHousehold(scopeA);
    const hiddenH = await insertHousehold(scopeA);
    await ageHousehold(scopeA, hiddenH, 10);

    // 1. Unknown id
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeA, async (tx) => {
        await expect(
          hideHousehold(tx, { householdId: unknownId, version: 1, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "not_found" });

        await expect(
          restoreHousehold(tx, { householdId: unknownId, version: 1, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "not_found" });

        await expect(
          setHouseholdStatus(tx, {
            householdId: unknownId,
            version: 1,
            status: "inactive",
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "not_found" });
      }),
    );

    // 2. Hidden family
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeA, async (tx) => {
        await expect(
          hideHousehold(tx, { householdId: hiddenH, version: 1, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "not_found" });

        await expect(
          setHouseholdStatus(tx, {
            householdId: hiddenH,
            version: 1,
            status: "inactive",
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "not_found" });
      }),
    );

    // 3. Visible family on restore
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeA, async (tx) => {
        await expect(
          restoreHousehold(tx, { householdId: visibleH, version: 1, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "not_found" });
      }),
    );

    // 4. Other community of same organisation
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeA2, async (tx) => {
        await expect(
          hideHousehold(tx, { householdId: visibleH, version: 1, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "not_found" });

        await expect(
          restoreHousehold(tx, { householdId: hiddenH, version: 1, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "not_found" });

        await expect(
          setHouseholdStatus(tx, {
            householdId: visibleH,
            version: 1,
            status: "inactive",
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "not_found" });
      }),
    );

    // 5. Other organisation
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeB, async (tx) => {
        await expect(
          hideHousehold(tx, { householdId: visibleH, version: 1, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "not_found" });

        await expect(
          restoreHousehold(tx, { householdId: hiddenH, version: 1, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "not_found" });

        await expect(
          setHouseholdStatus(tx, {
            householdId: visibleH,
            version: 1,
            status: "inactive",
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "not_found" });
      }),
    );

    // Verify rows unchanged
    const vCheck = await getHousehold(scopeA, visibleH);
    expect(vCheck?.deleted_at).toBeNull();
    expect(vCheck?.version).toBe(1);

    const hCheck = await getHousehold(scopeA, hiddenH);
    expect(hCheck?.deleted_at).not.toBeNull();
    expect(hCheck?.version).toBe(1);
  });

  it("validates input: invalid uuid, non-positive integer version, invalid status", async () => {
    const scope = await setupTenant("val");
    const validId = newId();

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        // hideHousehold
        await expect(
          hideHousehold(tx, { householdId: "not-a-uuid", version: 1, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "invalid_input" });

        await expect(
          hideHousehold(tx, { householdId: validId, version: 0, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "invalid_input" });

        await expect(
          hideHousehold(tx, { householdId: validId, version: 1.5, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "invalid_input" });

        await expect(
          hideHousehold(tx, { householdId: validId, version: 1, actorUserId: "not-uuid" }),
        ).rejects.toMatchObject({ code: "invalid_input" });

        // restoreHousehold
        await expect(
          restoreHousehold(tx, { householdId: "not-a-uuid", version: 1, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "invalid_input" });

        await expect(
          restoreHousehold(tx, { householdId: validId, version: 0, actorUserId: ACTOR }),
        ).rejects.toMatchObject({ code: "invalid_input" });

        await expect(
          restoreHousehold(tx, { householdId: validId, version: 1, actorUserId: "not-uuid" }),
        ).rejects.toMatchObject({ code: "invalid_input" });

        // setHouseholdStatus
        await expect(
          setHouseholdStatus(tx, {
            householdId: "not-a-uuid",
            version: 1,
            status: "active",
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });

        await expect(
          setHouseholdStatus(tx, {
            householdId: validId,
            version: 0,
            status: "active",
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });

        await expect(
          setHouseholdStatus(tx, {
            householdId: validId,
            version: 1,
            status: "invalid_status" as never,
            actorUserId: ACTOR,
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });

        await expect(
          setHouseholdStatus(tx, {
            householdId: validId,
            version: 1,
            status: "active",
            actorUserId: "not-uuid",
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });
      }),
    );
  });
});
