import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import {
  applyProductMigrations,
  newId,
  withAppTransaction,
  type AppTransaction,
} from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import {
  addAdult,
  addMinor,
  createHousehold,
  createPerson,
  hideHousehold,
  hidePerson,
  linkGuardian,
  lockPersonForDelete,
  moveAdult,
  purgeDeletedHouseholds,
  renameHousehold,
  restorePerson,
  setHouseholdStatus,
  setPersonStatus,
  unlinkGuardian,
  updatePerson,
} from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

type Scope = { orgId: string; communityId: string };

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
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-11-01T00:00:00+11:00");
const ACTOR = "00000000-0000-4000-8000-000000000002";
const FAKE_ENCRYPTED = Buffer.from("0123456789abcdef0123456789abcdef");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

describe("hidden family writes and lock order", () => {
  let runtime: Runtime;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let migrator: ReturnType<typeof createPlaintextDirectSql>;
  const kms = createLocalKmsPort();
  let counter = 0;

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

  async function setupTenant(slugPrefix: string): Promise<Scope> {
    const orgId = newId();
    const communityId = newId();
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${orgId}, ${`${slugPrefix}-${orgId}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${orgId}, ${`${slugPrefix}-${communityId}`}, 'au')
      `;
    });
    return { orgId, communityId };
  }

  async function setupSecondCommunity(orgId: string, slugPrefix: string): Promise<string> {
    const communityId = newId();
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${orgId}, ${`${slugPrefix}-${communityId}`}, 'au')
      `;
    });
    return communityId;
  }

  function inScope<T>(scope: Scope, fn: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, fn));
  }

  async function createHouseholdRow(
    scope: Scope,
    label: string | null = "Family",
  ): Promise<{ householdId: string; version: number }> {
    return inScope(scope, async (tx) => {
      return createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label,
        actorUserId: ACTOR,
      });
    });
  }

  async function addAdultPerson(
    scope: Scope,
    householdId: string | null = null,
    givenName = "Adult",
    familyName = "Member",
  ): Promise<string> {
    counter += 1;
    const n = counter;
    return inScope(scope, async (tx) => {
      const created = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId,
        dateOfBirth: null,
        givenName,
        familyName,
        email: `hfw.${n}@example.test`,
        phone: `+61 412 555 ${String(100 + (n % 900))}`,
        actorUserId: ACTOR,
      });
      return created.personId;
    });
  }

  async function seedMinorInHousehold(scope: Scope, householdId: string): Promise<string> {
    const id = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
      await tx`
        insert into app.persons (
          id, org_id, community_id, household_id, version, is_minor, age_basis,
          date_of_birth, birthday_md, given_name_restricted, family_name_restricted
        ) values (
          ${id}, ${scope.orgId}, ${scope.communityId}, ${householdId}, 1, true, 'date_of_birth',
          '2015-05-10', '0510', ${FAKE_ENCRYPTED}, ${FAKE_ENCRYPTED}
        )
      `;
      await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
    });
    return id;
  }

  async function seedGuardianLink(
    scope: Scope,
    householdId: string,
    guardianId: string,
    childId: string,
    rights = { consent: true, pickup: false, view: true, manage: false },
  ): Promise<string> {
    const id = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.guardian_links (
          id, org_id, community_id, household_id, guardian_person_id, child_person_id,
          consent, pickup, view, manage
        ) values (
          ${id}, ${scope.orgId}, ${scope.communityId}, ${householdId},
          ${guardianId}, ${childId},
          ${rights.consent}, ${rights.pickup}, ${rights.view}, ${rights.manage}
        )
      `;
    });
    return id;
  }

  async function ageHousehold(scope: Scope, householdId: string, hours = 721): Promise<void> {
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx.unsafe("ALTER TABLE app.households DISABLE TRIGGER USER");
      await tx`
        update app.households
        set deleted_at = now() - (${hours} * interval '1 hour'),
            deleted_by = ${newId()}
        where id = ${householdId}::uuid
      `;
      await tx.unsafe("ALTER TABLE app.households ENABLE TRIGGER USER");
    });
  }

  async function runHouseholdFirstLockProbe<T>(
    scope: Scope,
    householdId: string,
    personId: string,
    runT2: (tx: AppTransaction) => Promise<T>,
  ): Promise<{ blocked: boolean; t3Succeeded: boolean; result: T }> {
    const app1 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const app2 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const app3 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const inspector = createPlaintextDirectSql(runtime.productOnlyUrl);

    let releaseT1!: () => void;
    const releaseT1Promise = new Promise<void>((resolve) => {
      releaseT1 = resolve;
    });

    let t1Ready!: () => void;
    const t1ReadyPromise = new Promise<void>((resolve) => {
      t1Ready = resolve;
    });

    let t2Pid: number | null = null;
    let t2Settled = false;
    let t3Succeeded = false;

    try {
      const t1Promise = withAppTransaction(app1, scope, async (tx) => {
        await tx`
          select id::text as id
          from app.households
          where id = ${householdId}::uuid
          for update
        `;
        t1Ready();
        await releaseT1Promise;
      }).catch((err) => {
        t1Ready();
        throw err;
      });

      await t1ReadyPromise;

      const t2Promise = withAppTransaction(app2, scope, async (tx) => {
        const [pidRow] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        t2Pid = pidRow?.pid ?? null;
        return await withRequest({ requestId: REQUEST_ID }, () => runT2(tx));
      }).finally(() => {
        t2Settled = true;
      });

      let blocked = false;
      const started = Date.now();
      while (Date.now() - started < 10_000 && !t2Settled) {
        if (t2Pid !== null) {
          const rows = await inspector<{ count: number }[]>`
            select count(*)::int as count
            from pg_locks l
            join pg_stat_activity a on a.pid = l.pid
            where l.pid = ${t2Pid}
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

      await withAppTransaction(app3, scope, async (tx) => {
        const locked = await tx<{ id: string }[]>`
          select id::text as id
          from app.persons
          where id = ${personId}::uuid
          for update nowait
        `;
        t3Succeeded = locked.length > 0;
      });

      expect(t3Succeeded).toBe(true);

      releaseT1();
      await t1Promise;

      const result = await t2Promise;
      return { blocked, t3Succeeded, result };
    } finally {
      releaseT1();
      await app1.end({ timeout: 1 });
      await app2.end({ timeout: 1 });
      await app3.end({ timeout: 1 });
      await inspector.end({ timeout: 1 });
    }
  }

  // Pin 45: add adult, add minor and move adult answer not found for a hidden family
  it("add adult, add minor and move adult answer not found for a hidden family", async () => {
    const scope = await setupTenant("pin45");
    const hh = await createHouseholdRow(scope, "Hidden Fam Pin 45");
    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hh.householdId,
        version: hh.version,
        actorUserId: ACTOR,
      });
    });

    const adultId = await addAdultPerson(scope, null, "Mover", "Adult");
    const guardianId = await addAdultPerson(scope, null, "Guardian", "Adult");

    await inScope(scope, async (tx) => {
      await expect(
        addAdult(tx, kms, KEY_ARN, {
          now: NOW,
          householdId: hh.householdId,
          givenName: "New",
          familyName: "Adult",
          email: "pin45.adult@example.test",
          phone: "+61 412 555 450",
          dateOfBirth: null,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      await expect(
        addMinor(tx, kms, KEY_ARN, {
          now: NOW,
          householdId: hh.householdId,
          givenName: "New",
          familyName: "Minor",
          dateOfBirth: "2015-05-10",
          guardianId,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      await expect(
        moveAdult(tx, {
          personId: adultId,
          version: 1,
          householdId: hh.householdId,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  // Pin 46: createPerson answers not found for a hidden family
  it("createPerson answers not found for a hidden family", async () => {
    const scope = await setupTenant("pin46");
    const hh = await createHouseholdRow(scope, "Hidden Fam Pin 46");
    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hh.householdId,
        version: hh.version,
        actorUserId: ACTOR,
      });
    });

    await inScope(scope, async (tx) => {
      await expect(
        createPerson(tx, kms, KEY_ARN, {
          now: NOW,
          declaredAdult: true,
          householdId: hh.householdId,
          dateOfBirth: null,
          givenName: "Created",
          familyName: "Person",
          email: "pin46@example.test",
          phone: "+61 412 555 460",
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  // Pin 47: move adult answers not found for a hidden target family
  it("move adult answers not found for a hidden target family", async () => {
    const scope = await setupTenant("pin47");
    const visibleHh = await createHouseholdRow(scope, "Visible Fam");
    const hiddenHh = await createHouseholdRow(scope, "Hidden Target Fam");
    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hiddenHh.householdId,
        version: hiddenHh.version,
        actorUserId: ACTOR,
      });
    });

    const adultId = await addAdultPerson(scope, visibleHh.householdId, "Adult", "Move");

    await inScope(scope, async (tx) => {
      await expect(
        moveAdult(tx, {
          personId: adultId,
          version: 1,
          householdId: hiddenHh.householdId,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    // Row unchanged
    const [personRow] = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ household_id: string; version: number }[]>`
        select household_id::text as household_id, version
        from app.persons
        where id = ${adultId}::uuid
      `;
    });
    expect(personRow?.household_id).toBe(visibleHh.householdId);
    expect(personRow?.version).toBe(1);
  });

  // Pin 48: an adult can be moved out of a hidden family
  it("an adult can be moved out of a hidden family", async () => {
    const scope = await setupTenant("pin48");
    const hiddenHh = await createHouseholdRow(scope, "Hidden Source Fam");
    const adult1 = await addAdultPerson(scope, hiddenHh.householdId, "Adult1", "Leaving");
    const adult2 = await addAdultPerson(scope, hiddenHh.householdId, "Adult2", "Transferring");

    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hiddenHh.householdId,
        version: hiddenHh.version,
        actorUserId: ACTOR,
      });
    });

    const visibleHh = await createHouseholdRow(scope, "Visible Destination Fam");

    // Move adult 1 out to null
    await inScope(scope, async (tx) => {
      await expect(
        moveAdult(tx, {
          personId: adult1,
          version: 1,
          householdId: null,
          actorUserId: ACTOR,
        }),
      ).resolves.toMatchObject({ version: 2 });
    });

    // Move adult 2 to visible family
    await inScope(scope, async (tx) => {
      await expect(
        moveAdult(tx, {
          personId: adult2,
          version: 1,
          householdId: visibleHh.householdId,
          actorUserId: ACTOR,
        }),
      ).resolves.toMatchObject({ version: 2 });
    });

    const rows = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ id: string; household_id: string | null }[]>`
        select id::text as id, household_id::text as household_id
        from app.persons
        where id in (${adult1}::uuid, ${adult2}::uuid)
        order by id asc
      `;
    });
    const m1 = rows.find((r) => r.id === adult1);
    const m2 = rows.find((r) => r.id === adult2);
    expect(m1?.household_id).toBeNull();
    expect(m2?.household_id).toBe(visibleHh.householdId);
  });

  // Pin 49: a guardian link waits on the family before it locks the guardian
  it("a guardian link waits on the family before it locks the guardian", async () => {
    const scope = await setupTenant("pin49");
    const hh = await createHouseholdRow(scope, "Link Lock Fam");
    const adultId = await addAdultPerson(scope, hh.householdId, "Adult", "Guardian");
    const childId = await seedMinorInHousehold(scope, hh.householdId);

    const probe = await runHouseholdFirstLockProbe(scope, hh.householdId, adultId, async (tx) => {
      return await linkGuardian(tx, {
        now: NOW,
        householdId: hh.householdId,
        guardianPersonId: adultId,
        childPersonId: childId,
        consent: true,
        pickup: false,
        view: true,
        manage: false,
        actorUserId: ACTOR,
      });
    });

    expect(probe.blocked).toBe(true);
    expect(probe.t3Succeeded).toBe(true);
    expect(probe.result).toMatchObject({ linkId: expect.any(String) });
  }, 20_000);

  // Pin 50: a guardian unlink waits on the family before it locks the guardian
  it("a guardian unlink waits on the family before it locks the guardian", async () => {
    const scope = await setupTenant("pin50");
    const hh = await createHouseholdRow(scope, "Unlink Lock Fam");
    const adult1 = await addAdultPerson(scope, hh.householdId, "Adult1", "Guardian");
    const adult2 = await addAdultPerson(scope, hh.householdId, "Adult2", "Guardian");
    const childId = await seedMinorInHousehold(scope, hh.householdId);

    const link1 = await seedGuardianLink(scope, hh.householdId, adult1, childId);
    await seedGuardianLink(scope, hh.householdId, adult2, childId);

    const probe = await runHouseholdFirstLockProbe(scope, hh.householdId, adult1, async (tx) => {
      await unlinkGuardian(tx, {
        now: NOW,
        householdId: hh.householdId,
        linkId: link1,
        actorUserId: ACTOR,
      });
    });

    expect(probe.blocked).toBe(true);
    expect(probe.t3Succeeded).toBe(true);
  }, 20_000);

  // Pin 51: rename answers not found for a hidden family
  it("rename answers not found for a hidden family", async () => {
    const scope = await setupTenant("pin51");
    const hh = await createHouseholdRow(scope, "Before Hide Rename");
    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hh.householdId,
        version: hh.version,
        actorUserId: ACTOR,
      });
    });

    await inScope(scope, async (tx) => {
      await expect(
        renameHousehold(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          version: hh.version,
          label: "New Name After Hide",
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  // Pin 51b: status answers not found for a hidden family
  it("status answers not found for a hidden family", async () => {
    const scope = await setupTenant("pin51b");
    const hh = await createHouseholdRow(scope, "Before Hide Status");
    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hh.householdId,
        version: hh.version,
        actorUserId: ACTOR,
      });
    });

    await inScope(scope, async (tx) => {
      await expect(
        setHouseholdStatus(tx, {
          householdId: hh.householdId,
          version: hh.version,
          status: "inactive",
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  // Pin 52: an adult in a hidden family can be edited, switched, deleted and restored and the family stays hidden
  it("an adult in a hidden family can be edited, switched, deleted and restored and the family stays hidden", async () => {
    const scope = await setupTenant("pin52");
    const hh = await createHouseholdRow(scope, "Fam Pin 52");
    const adultId = await addAdultPerson(scope, hh.householdId, "Adult", "Living");

    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hh.householdId,
        version: hh.version,
        actorUserId: ACTOR,
      });
    });

    // 1. updatePerson resolves
    await inScope(scope, async (tx) => {
      await expect(
        updatePerson(tx, kms, KEY_ARN, {
          personId: adultId,
          version: 1,
          changes: { givenName: "UpdatedName" },
          actorUserId: ACTOR,
        }),
      ).resolves.toMatchObject({ version: 2 });
    });

    // 2. setPersonStatus resolves
    await inScope(scope, async (tx) => {
      await expect(
        setPersonStatus(tx, {
          personId: adultId,
          version: 2,
          status: "inactive",
          actorUserId: ACTOR,
        }),
      ).resolves.toMatchObject({ version: 3 });
    });

    // 3. lockPersonForDelete + hidePerson resolves
    await inScope(scope, async (tx) => {
      await expect(
        lockPersonForDelete(tx, { personId: adultId, version: 3 }),
      ).resolves.toMatchObject({ version: 3 });

      await expect(
        hidePerson(tx, { personId: adultId, actorUserId: ACTOR }),
      ).resolves.toMatchObject({ version: 4 });
    });

    // 4. restorePerson resolves
    await inScope(scope, async (tx) => {
      await expect(
        restorePerson(tx, { personId: adultId, version: 4, actorUserId: ACTOR }),
      ).resolves.toMatchObject({ version: 5 });
    });

    // Verify family is still hidden
    const [hhRow] = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ deleted_at: Date | null }[]>`
        select deleted_at
        from app.households
        where id = ${hh.householdId}::uuid
      `;
    });
    expect(hhRow?.deleted_at).not.toBeNull();
  });

  // Pin 53: move adult waits on the target family before it locks the person
  it("move adult waits on the target family before it locks the person", async () => {
    const scope = await setupTenant("pin53");
    const sourceHh = await createHouseholdRow(scope, "Source Fam");
    const targetHh = await createHouseholdRow(scope, "Target Fam");
    const adultId = await addAdultPerson(scope, sourceHh.householdId, "Adult", "MoveOrder");

    const probe = await runHouseholdFirstLockProbe(
      scope,
      targetHh.householdId,
      adultId,
      async (tx) => {
        return await moveAdult(tx, {
          personId: adultId,
          version: 1,
          householdId: targetHh.householdId,
          actorUserId: ACTOR,
        });
      },
    );

    expect(probe.blocked).toBe(true);
    expect(probe.t3Succeeded).toBe(true);
    expect(probe.result).toMatchObject({ version: 2 });
  }, 20_000);

  // Link and unlink with seeded minor in hidden family answering not_found
  it("guardian link and unlink answer not found for a hidden family with a seeded child", async () => {
    const scope = await setupTenant("link-unlink-hidden");
    const hh = await createHouseholdRow(scope, "Hidden Seeded Fam");
    const adult1 = await addAdultPerson(scope, hh.householdId, "Adult1", "Parent");
    const adult2 = await addAdultPerson(scope, hh.householdId, "Adult2", "Parent");
    const adult3 = await addAdultPerson(scope, hh.householdId, "Adult3", "Prospective");

    // Hide the household first while it has no minor
    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hh.householdId,
        version: hh.version,
        actorUserId: ACTOR,
      });
    });

    // Seed child and links into the hidden household with triggers disabled
    const childId = await seedMinorInHousehold(scope, hh.householdId);
    const linkId = await seedGuardianLink(scope, hh.householdId, adult1, childId);
    await seedGuardianLink(scope, hh.householdId, adult2, childId);

    await inScope(scope, async (tx) => {
      await expect(
        linkGuardian(tx, {
          now: NOW,
          householdId: hh.householdId,
          guardianPersonId: adult3,
          childPersonId: childId,
          consent: true,
          pickup: true,
          view: true,
          manage: false,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      await expect(
        unlinkGuardian(tx, {
          now: NOW,
          householdId: hh.householdId,
          linkId,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  // Cross-tenant: two communities of one organisation and two organisations
  it("lockVisibleHousehold callers reject cross-community and cross-organisation households with not_found", async () => {
    const scope1 = await setupTenant("xt-1");
    const comm2 = await setupSecondCommunity(scope1.orgId, "xt-2");
    const scope2: Scope = { orgId: scope1.orgId, communityId: comm2 };
    const scope3 = await setupTenant("xt-3");

    const hh1 = await createHouseholdRow(scope1, "Org1 Comm1 Fam");
    const adultInScope2 = await addAdultPerson(scope2, null, "Adult", "Scope2");
    const adultInScope3 = await addAdultPerson(scope3, null, "Adult", "Scope3");

    // Scope 2 (same org, different community) calling with hh1
    await inScope(scope2, async (tx) => {
      await expect(
        addAdult(tx, kms, KEY_ARN, {
          now: NOW,
          householdId: hh1.householdId,
          givenName: "Adult",
          familyName: "Scope2",
          email: "xt.sc2@example.test",
          phone: "+61 412 555 201",
          dateOfBirth: null,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      await expect(
        moveAdult(tx, {
          personId: adultInScope2,
          version: 1,
          householdId: hh1.householdId,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      await expect(
        createPerson(tx, kms, KEY_ARN, {
          now: NOW,
          declaredAdult: true,
          householdId: hh1.householdId,
          dateOfBirth: null,
          givenName: "New",
          familyName: "Scope2",
          email: "xt.sc2b@example.test",
          phone: "+61 412 555 202",
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      await expect(
        renameHousehold(tx, kms, KEY_ARN, {
          householdId: hh1.householdId,
          version: 1,
          label: "Renamed Other Comm",
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    // Scope 3 (different org) calling with hh1
    await inScope(scope3, async (tx) => {
      await expect(
        addAdult(tx, kms, KEY_ARN, {
          now: NOW,
          householdId: hh1.householdId,
          givenName: "Adult",
          familyName: "Scope3",
          email: "xt.sc3@example.test",
          phone: "+61 412 555 301",
          dateOfBirth: null,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      await expect(
        moveAdult(tx, {
          personId: adultInScope3,
          version: 1,
          householdId: hh1.householdId,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      await expect(
        createPerson(tx, kms, KEY_ARN, {
          now: NOW,
          declaredAdult: true,
          householdId: hh1.householdId,
          dateOfBirth: null,
          givenName: "New",
          familyName: "Scope3",
          email: "xt.sc3b@example.test",
          phone: "+61 412 555 302",
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      await expect(
        renameHousehold(tx, kms, KEY_ARN, {
          householdId: hh1.householdId,
          version: 1,
          label: "Renamed Other Org",
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  // Races against hideHousehold: both orders for add-adult, add-minor, move-adult in
  it("races between hideHousehold and add-adult, add-minor, move-adult in both orders", async () => {
    const scope = await setupTenant("races-hide");
    const app1 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const app2 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const inspector = createPlaintextDirectSql(runtime.productOnlyUrl);

    try {
      // 1. Order A: hideHousehold holds FOR UPDATE, addAdult waits and answers not_found
      {
        const hh = await createHouseholdRow(scope, "Race Hide 1");
        let releaseT1: (() => void) | undefined;
        const releaseT1P = new Promise<void>((res) => {
          releaseT1 = res;
        });
        let t1Ready!: () => void;
        const t1ReadyP = new Promise<void>((res) => {
          t1Ready = res;
        });
        let t2Pid: number | null = null;
        let t2Settled = false;

        const t1P = withAppTransaction(app1, scope, async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, () =>
            hideHousehold(tx, {
              householdId: hh.householdId,
              version: hh.version,
              actorUserId: ACTOR,
            }),
          );
          t1Ready();
          await releaseT1P;
        }).catch((err) => {
          t1Ready();
          throw err;
        });
        await t1ReadyP;

        const t2P = withAppTransaction(app2, scope, async (tx) => {
          const [pidRow] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          t2Pid = pidRow?.pid ?? null;
          return await withRequest({ requestId: REQUEST_ID }, () =>
            addAdult(tx, kms, KEY_ARN, {
              now: NOW,
              householdId: hh.householdId,
              givenName: "Racer",
              familyName: "Adult",
              email: "race1@example.test",
              phone: "+61 412 555 901",
              dateOfBirth: null,
              actorUserId: ACTOR,
            }),
          );
        }).finally(() => {
          t2Settled = true;
        });

        try {
          let blocked = false;
          const started = Date.now();
          while (Date.now() - started < 10_000 && !t2Settled) {
            if (t2Pid !== null) {
              const rows = await inspector<{ count: number }[]>`
                select count(*)::int as count
                from pg_locks l
                join pg_stat_activity a on a.pid = l.pid
                where l.pid = ${t2Pid} and l.granted = false and a.query like '%app.households%'
              `;
              if ((rows[0]?.count ?? 0) > 0) {
                blocked = true;
                break;
              }
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(blocked).toBe(true);
        } finally {
          releaseT1?.();
          await Promise.allSettled([t1P, t2P]);
        }

        await expect(t2P).rejects.toMatchObject({ code: "not_found" });
      }

      // 2. Order B: addMinor holds FOR SHARE, hideHousehold waits and answers household_has_children
      {
        const hh = await createHouseholdRow(scope, "Race Hide 2");
        const guardianId = await addAdultPerson(scope, hh.householdId, "Guardian", "Racer");
        let releaseT1: (() => void) | undefined;
        const releaseT1P = new Promise<void>((res) => {
          releaseT1 = res;
        });
        let t1Ready!: () => void;
        const t1ReadyP = new Promise<void>((res) => {
          t1Ready = res;
        });
        let t2Pid: number | null = null;
        let t2Settled = false;

        const t1P = withAppTransaction(app1, scope, async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, () =>
            addMinor(tx, kms, KEY_ARN, {
              now: NOW,
              householdId: hh.householdId,
              givenName: "Child",
              familyName: "Racer",
              dateOfBirth: "2015-05-10",
              guardianId,
              actorUserId: ACTOR,
            }),
          );
          t1Ready();
          await releaseT1P;
        }).catch((err) => {
          t1Ready();
          throw err;
        });
        await t1ReadyP;

        const t2P = withAppTransaction(app2, scope, async (tx) => {
          const [pidRow] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          t2Pid = pidRow?.pid ?? null;
          return await withRequest({ requestId: REQUEST_ID }, () =>
            hideHousehold(tx, {
              householdId: hh.householdId,
              version: hh.version,
              actorUserId: ACTOR,
            }),
          );
        }).finally(() => {
          t2Settled = true;
        });

        try {
          let blocked = false;
          const started = Date.now();
          while (Date.now() - started < 10_000 && !t2Settled) {
            if (t2Pid !== null) {
              const rows = await inspector<{ count: number }[]>`
                select count(*)::int as count
                from pg_locks l
                join pg_stat_activity a on a.pid = l.pid
                where l.pid = ${t2Pid} and l.granted = false and a.query like '%app.households%'
              `;
              if ((rows[0]?.count ?? 0) > 0) {
                blocked = true;
                break;
              }
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(blocked).toBe(true);
        } finally {
          releaseT1?.();
          await Promise.allSettled([t1P, t2P]);
        }

        await expect(t2P).rejects.toMatchObject({ code: "household_has_children" });
      }

      // 3. Order A: hideHousehold holds FOR UPDATE, moveAdult waits and answers not_found
      {
        const sourceHh = await createHouseholdRow(scope, "Race Source");
        const targetHh = await createHouseholdRow(scope, "Race Target");
        const adultId = await addAdultPerson(scope, sourceHh.householdId, "Moving", "Racer");

        let releaseT1: (() => void) | undefined;
        const releaseT1P = new Promise<void>((res) => {
          releaseT1 = res;
        });
        let t1Ready!: () => void;
        const t1ReadyP = new Promise<void>((res) => {
          t1Ready = res;
        });
        let t2Pid: number | null = null;
        let t2Settled = false;

        const t1P = withAppTransaction(app1, scope, async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, () =>
            hideHousehold(tx, {
              householdId: targetHh.householdId,
              version: targetHh.version,
              actorUserId: ACTOR,
            }),
          );
          t1Ready();
          await releaseT1P;
        }).catch((err) => {
          t1Ready();
          throw err;
        });
        await t1ReadyP;

        const t2P = withAppTransaction(app2, scope, async (tx) => {
          const [pidRow] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          t2Pid = pidRow?.pid ?? null;
          return await withRequest({ requestId: REQUEST_ID }, () =>
            moveAdult(tx, {
              personId: adultId,
              version: 1,
              householdId: targetHh.householdId,
              actorUserId: ACTOR,
            }),
          );
        }).finally(() => {
          t2Settled = true;
        });

        try {
          let blocked = false;
          const started = Date.now();
          while (Date.now() - started < 10_000 && !t2Settled) {
            if (t2Pid !== null) {
              const rows = await inspector<{ count: number }[]>`
                select count(*)::int as count
                from pg_locks l
                join pg_stat_activity a on a.pid = l.pid
                where l.pid = ${t2Pid} and l.granted = false and a.query like '%app.households%'
              `;
              if ((rows[0]?.count ?? 0) > 0) {
                blocked = true;
                break;
              }
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(blocked).toBe(true);
        } finally {
          releaseT1?.();
          await Promise.allSettled([t1P, t2P]);
        }

        await expect(t2P).rejects.toMatchObject({ code: "not_found" });
      }
    } finally {
      await app1.end({ timeout: 1 });
      await app2.end({ timeout: 1 });
      await inspector.end({ timeout: 1 });
    }
  }, 30_000);

  // Races against purgeDeletedHouseholds: contact delete, move-adult out, and move-adult in finish without 40P01
  it("races against purgeDeletedHouseholds: contact delete, move-adult out, and move-adult in finish without 40P01", async () => {
    const scope = await setupTenant("purge-races");
    const app1 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const app2 = createPlaintextAppSql(roleUrl(runtime, "app"));

    try {
      // 1. Contact delete vs purgeDeletedHouseholds
      {
        const hh = await createHouseholdRow(scope, "Purge Race 1");
        const adultId = await addAdultPerson(scope, hh.householdId, "Adult", "PurgeRace1");
        await inScope(scope, async (tx) => {
          await hideHousehold(tx, {
            householdId: hh.householdId,
            version: hh.version,
            actorUserId: ACTOR,
          });
        });
        await ageHousehold(scope, hh.householdId, 725);

        let releaseT1!: () => void;
        const releaseT1P = new Promise<void>((res) => {
          releaseT1 = res;
        });
        let t1Ready!: () => void;
        const t1ReadyP = new Promise<void>((res) => {
          t1Ready = res;
        });

        // T1: contact delete holds person lock
        const t1P = withAppTransaction(app1, scope, async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await lockPersonForDelete(tx, { personId: adultId, version: 1 });
            await hidePerson(tx, { personId: adultId, actorUserId: ACTOR });
          });
          t1Ready();
          await releaseT1P;
        });
        await t1ReadyP;

        // T2: purge runs concurrently
        const t2P = withAppTransaction(app2, scope, async (tx) => {
          return await withRequest({ requestId: REQUEST_ID }, () => purgeDeletedHouseholds(tx, 50));
        });

        releaseT1();
        await t1P;
        const purged = await t2P;
        expect(purged).toContain(hh.householdId);

        // Person row has household_id null and is deleted
        const [personRow] = await withAppTransaction(migrator, scope, async (tx) => {
          return await tx<{ household_id: string | null; deleted_at: Date | null }[]>`
            select household_id::text as household_id, deleted_at
            from app.persons
            where id = ${adultId}::uuid
          `;
        });
        expect(personRow?.household_id).toBeNull();
        expect(personRow?.deleted_at).not.toBeNull();
      }

      // 2. Move-adult out vs purgeDeletedHouseholds
      {
        const hh = await createHouseholdRow(scope, "Purge Race 2");
        const adultId = await addAdultPerson(scope, hh.householdId, "Adult", "PurgeRace2");
        await inScope(scope, async (tx) => {
          await hideHousehold(tx, {
            householdId: hh.householdId,
            version: hh.version,
            actorUserId: ACTOR,
          });
        });
        await ageHousehold(scope, hh.householdId, 725);

        let releaseT1!: () => void;
        const releaseT1P = new Promise<void>((res) => {
          releaseT1 = res;
        });
        let t1Ready!: () => void;
        const t1ReadyP = new Promise<void>((res) => {
          t1Ready = res;
        });

        // T1: moveAdult out holds person lock
        const t1P = withAppTransaction(app1, scope, async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, () =>
            moveAdult(tx, {
              personId: adultId,
              version: 1,
              householdId: null,
              actorUserId: ACTOR,
            }),
          );
          t1Ready();
          await releaseT1P;
        });
        await t1ReadyP;

        const t2P = withAppTransaction(app2, scope, async (tx) => {
          return await withRequest({ requestId: REQUEST_ID }, () => purgeDeletedHouseholds(tx, 50));
        });

        releaseT1();
        await t1P;
        const purged = await t2P;
        expect(purged).toContain(hh.householdId);
      }

      // 3. Move-adult in vs purgeDeletedHouseholds
      {
        const hh = await createHouseholdRow(scope, "Purge Race 3");
        const adultId = await addAdultPerson(scope, null, "Adult", "PurgeRace3");
        await inScope(scope, async (tx) => {
          await hideHousehold(tx, {
            householdId: hh.householdId,
            version: hh.version,
            actorUserId: ACTOR,
          });
        });
        await ageHousehold(scope, hh.householdId, 725);

        // Move adult into aged household answers not_found
        await inScope(scope, async (tx) => {
          await expect(
            moveAdult(tx, {
              personId: adultId,
              version: 1,
              householdId: hh.householdId,
              actorUserId: ACTOR,
            }),
          ).rejects.toMatchObject({ code: "not_found" });
        });
      }
    } finally {
      await app1.end({ timeout: 1 });
      await app2.end({ timeout: 1 });
    }
  }, 30_000);
});
