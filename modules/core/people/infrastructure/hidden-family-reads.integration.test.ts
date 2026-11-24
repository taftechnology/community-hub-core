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
  createHousehold,
  createPerson,
  hideHousehold,
  listDeletedHouseholds,
  listHouseholds,
  openHouseholdLabel,
  readHousehold,
  readHouseholdDetail,
  readPerson,
  setHouseholdStatus,
  type HouseholdStatus,
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
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-11-01T00:00:00+11:00");
const ACTOR = "00000000-0000-4000-8000-000000000002";

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

describe("hidden family reads", () => {
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
        email: `family-reads.${n}@example.test`,
        phone: `+61 411 555 ${String(100 + (n % 900))}`,
        actorUserId: ACTOR,
      });
      return created.personId;
    });
  }

  async function setHouseholdDeletedAt(
    scope: Scope,
    rows: { householdId: string; micros: number }[],
  ): Promise<void> {
    const deletedBy = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx.unsafe("ALTER TABLE app.households DISABLE TRIGGER USER");
      for (const row of rows) {
        await tx`
          update app.households
          set deleted_at = date_trunc('millisecond', now() - interval '2 hours')
                + (${row.micros} * interval '1 microsecond'),
              deleted_by = ${deletedBy}
          where id = ${row.householdId}::uuid
        `;
      }
      await tx.unsafe("ALTER TABLE app.households ENABLE TRIGGER USER");
    });
  }

  async function listedDeletedHouseholdEvents(scope: Scope): Promise<string[][]> {
    const rows = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and action = 'people.household.listed_deleted'
        order by id asc
      `;
    });
    return rows.map((r) => r.target_ids);
  }

  it("the family list leaves out a hidden family", async () => {
    const scope1 = await setupTenant("fr-list-1");
    const comm2Id = await setupSecondCommunity(scope1.orgId, "fr-list-2");
    const scope2: Scope = { orgId: scope1.orgId, communityId: comm2Id };
    const scope3 = await setupTenant("fr-list-3");

    // Community 1: 1 visible, 1 hidden
    const visible1 = await createHouseholdRow(scope1, "Visible Fam 1");
    const hidden1 = await createHouseholdRow(scope1, "Hidden Fam 1");
    await inScope(scope1, async (tx) => {
      await hideHousehold(tx, {
        householdId: hidden1.householdId,
        version: hidden1.version,
        actorUserId: ACTOR,
      });
    });

    // Community 2 (same org): 1 visible
    const visible2 = await createHouseholdRow(scope2, "Visible Fam 2");

    // Org 2: 1 visible
    const visible3 = await createHouseholdRow(scope3, "Visible Fam 3");

    // Check community 1 list
    await inScope(scope1, async (tx) => {
      const res = await listHouseholds(tx, kms, KEY_ARN, {
        includeRestricted: true,
        actorUserId: ACTOR,
      });
      const ids = res.items.map((i) => i.householdId);
      expect(ids).toContain(visible1.householdId);
      expect(ids).not.toContain(hidden1.householdId);
      expect(ids).not.toContain(visible2.householdId);
      expect(ids).not.toContain(visible3.householdId);
    });
  });

  it("family detail answers null for a hidden family and writes no read event", async () => {
    const scope1 = await setupTenant("fr-det-1");
    const comm2Id = await setupSecondCommunity(scope1.orgId, "fr-det-2");
    const scope2: Scope = { orgId: scope1.orgId, communityId: comm2Id };
    const scope3 = await setupTenant("fr-det-3");

    const hidden = await createHouseholdRow(scope1, "Hidden Detail");
    await inScope(scope1, async (tx) => {
      await hideHousehold(tx, {
        householdId: hidden.householdId,
        version: hidden.version,
        actorUserId: ACTOR,
      });
    });

    const otherCommHh = await createHouseholdRow(scope2, "Other Comm");
    const otherOrgHh = await createHouseholdRow(scope3, "Other Org");

    // Count audit events before
    const countReadEvents = async (s: Scope) => {
      const rows = await withAppTransaction(migrator, s, async (tx) => {
        return await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.audit_events
          where org_id = ${s.orgId}::uuid
            and action = 'people.household.read'
        `;
      });
      return rows[0]!.count;
    };

    const beforeCount = await countReadEvents(scope1);

    await inScope(scope1, async (tx) => {
      await expect(
        readHouseholdDetail(tx, kms, KEY_ARN, {
          householdId: hidden.householdId,
          includeRestricted: true,
          actorUserId: ACTOR,
        }),
      ).resolves.toBeNull();

      // Cross-tenant in scope 1
      await expect(
        readHouseholdDetail(tx, kms, KEY_ARN, {
          householdId: otherCommHh.householdId,
          includeRestricted: true,
          actorUserId: ACTOR,
        }),
      ).resolves.toBeNull();

      await expect(
        readHouseholdDetail(tx, kms, KEY_ARN, {
          householdId: otherOrgHh.householdId,
          includeRestricted: true,
          actorUserId: ACTOR,
        }),
      ).resolves.toBeNull();
    });

    const afterCount = await countReadEvents(scope1);
    expect(afterCount).toBe(beforeCount);
  });

  it("openHouseholdLabel answers null for a hidden family", async () => {
    const scope1 = await setupTenant("fr-lbl-1");
    const comm2Id = await setupSecondCommunity(scope1.orgId, "fr-lbl-2");
    const scope2: Scope = { orgId: scope1.orgId, communityId: comm2Id };
    const scope3 = await setupTenant("fr-lbl-3");

    const hidden = await createHouseholdRow(scope1, "Hidden Label");
    await inScope(scope1, async (tx) => {
      await hideHousehold(tx, {
        householdId: hidden.householdId,
        version: hidden.version,
        actorUserId: ACTOR,
      });
    });

    const otherCommHh = await createHouseholdRow(scope2, "Other Comm");
    const otherOrgHh = await createHouseholdRow(scope3, "Other Org");

    await inScope(scope1, async (tx) => {
      await expect(openHouseholdLabel(tx, kms, KEY_ARN, hidden.householdId)).resolves.toBeNull();

      await expect(
        readHousehold(tx, kms, KEY_ARN, {
          householdId: hidden.householdId,
          actorUserId: ACTOR,
        }),
      ).resolves.toBeNull();

      // Cross-tenant
      await expect(
        openHouseholdLabel(tx, kms, KEY_ARN, otherCommHh.householdId),
      ).resolves.toBeNull();

      await expect(
        openHouseholdLabel(tx, kms, KEY_ARN, otherOrgHh.householdId),
      ).resolves.toBeNull();
    });
  });

  it("readPerson returns no household for an adult in a hidden family", async () => {
    const scope1 = await setupTenant("fr-pers-1");
    const comm2Id = await setupSecondCommunity(scope1.orgId, "fr-pers-2");
    const scope2: Scope = { orgId: scope1.orgId, communityId: comm2Id };
    const scope3 = await setupTenant("fr-pers-3");

    const visibleHh = await createHouseholdRow(scope1, "Visible Fam");
    const hiddenHh = await createHouseholdRow(scope1, "Hidden Fam");

    const adultInVisible = await addAdultPerson(scope1, visibleHh.householdId, "Alice", "Smith");
    const adultInHidden = await addAdultPerson(scope1, hiddenHh.householdId, "Bob", "Jones");

    await inScope(scope1, async (tx) => {
      await hideHousehold(tx, {
        householdId: hiddenHh.householdId,
        version: hiddenHh.version,
        actorUserId: ACTOR,
      });
    });

    const otherCommPerson = await addAdultPerson(scope2, null, "Charlie", "Brown");
    const otherOrgPerson = await addAdultPerson(scope3, null, "David", "Miller");

    await inScope(scope1, async (tx) => {
      const readHiddenAdult = await readPerson(tx, kms, KEY_ARN, {
        personId: adultInHidden,
        actorUserId: ACTOR,
      });
      expect(readHiddenAdult).not.toBeNull();
      expect(readHiddenAdult!.householdId).toBeNull();
      expect(readHiddenAdult!.personId).toBe(adultInHidden);

      const readVisibleAdult = await readPerson(tx, kms, KEY_ARN, {
        personId: adultInVisible,
        actorUserId: ACTOR,
      });
      expect(readVisibleAdult).not.toBeNull();
      expect(readVisibleAdult!.householdId).toBe(visibleHh.householdId);

      // Cross tenant
      await expect(
        readPerson(tx, kms, KEY_ARN, {
          personId: otherCommPerson,
          actorUserId: ACTOR,
        }),
      ).resolves.toBeNull();

      await expect(
        readPerson(tx, kms, KEY_ARN, {
          personId: otherOrgPerson,
          actorUserId: ACTOR,
        }),
      ).resolves.toBeNull();
    });
  });

  it("the family list filters by status", async () => {
    const scope = await setupTenant("fr-status-1");

    const activeHh = await createHouseholdRow(scope, "Active Household");
    const inactiveHh = await createHouseholdRow(scope, "Inactive Household");
    await inScope(scope, async (tx) => {
      await setHouseholdStatus(tx, {
        householdId: inactiveHh.householdId,
        version: inactiveHh.version,
        status: "inactive",
        actorUserId: ACTOR,
      });
    });

    const hiddenHh = await createHouseholdRow(scope, "Hidden Household");
    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hiddenHh.householdId,
        version: hiddenHh.version,
        actorUserId: ACTOR,
      });
    });

    await inScope(scope, async (tx) => {
      // Filter active
      const activeList = await listHouseholds(tx, kms, KEY_ARN, {
        includeRestricted: true,
        actorUserId: ACTOR,
        status: "active",
      });
      expect(activeList.items.map((i) => i.householdId)).toEqual([activeHh.householdId]);
      expect(activeList.items[0]?.status).toBe("active");

      // Filter inactive
      const inactiveList = await listHouseholds(tx, kms, KEY_ARN, {
        includeRestricted: true,
        actorUserId: ACTOR,
        status: "inactive",
      });
      expect(inactiveList.items.map((i) => i.householdId)).toEqual([inactiveHh.householdId]);
      expect(inactiveList.items[0]?.status).toBe("inactive");

      // No status filter: returns both active and inactive, but not hidden
      const allList = await listHouseholds(tx, kms, KEY_ARN, {
        includeRestricted: true,
        actorUserId: ACTOR,
      });
      const allIds = allList.items.map((i) => i.householdId);
      expect(allIds).toContain(activeHh.householdId);
      expect(allIds).toContain(inactiveHh.householdId);
      expect(allIds).not.toContain(hiddenHh.householdId);

      // Invalid status throws invalid_input
      await expect(
        listHouseholds(tx, kms, KEY_ARN, {
          includeRestricted: true,
          actorUserId: ACTOR,
          status: "deleted" as unknown as HouseholdStatus,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  it("the deleted family list returns hidden families only", async () => {
    const scope1 = await setupTenant("fr-del-1");
    const comm2Id = await setupSecondCommunity(scope1.orgId, "fr-del-2");
    const scope2: Scope = { orgId: scope1.orgId, communityId: comm2Id };
    const scope3 = await setupTenant("fr-del-3");

    const visibleHh = await createHouseholdRow(scope1, "Visible Fam");
    const hiddenHh = await createHouseholdRow(scope1, "Hidden Fam");
    const otherCommHh = await createHouseholdRow(scope2, "Other Comm Fam");
    const otherOrgHh = await createHouseholdRow(scope3, "Other Org Fam");

    // Add adult to hidden family
    await addAdultPerson(scope1, hiddenHh.householdId, "Adult", "One");

    await inScope(scope1, async (tx) => {
      await hideHousehold(tx, {
        householdId: hiddenHh.householdId,
        version: hiddenHh.version,
        actorUserId: ACTOR,
      });
    });
    await inScope(scope2, async (tx) => {
      await hideHousehold(tx, {
        householdId: otherCommHh.householdId,
        version: otherCommHh.version,
        actorUserId: ACTOR,
      });
    });
    await inScope(scope3, async (tx) => {
      await hideHousehold(tx, {
        householdId: otherOrgHh.householdId,
        version: otherOrgHh.version,
        actorUserId: ACTOR,
      });
    });

    await inScope(scope1, async (tx) => {
      const res = await listDeletedHouseholds(tx, kms, KEY_ARN, {
        actorUserId: ACTOR,
      });
      expect(res.items.map((i) => i.householdId)).toEqual([hiddenHh.householdId]);
      expect(res.items.map((i) => i.householdId)).not.toContain(visibleHh.householdId);
      expect(res.items[0]?.householdId).toBe(hiddenHh.householdId);
      expect(res.items[0]?.label).toBe("Hidden Fam");
      expect(res.items[0]?.adultCount).toBe(1);
      expect(res.items[0]?.version).toBe(hiddenHh.version + 1);
      expect(typeof res.items[0]?.deletedAt).toBe("string");
      expect(typeof res.items[0]?.purgeAfter).toBe("string");
      expect(res.nextCursor).toBeNull();
    });
  });

  it("the deleted family list pages rows that share a millisecond without repeats or gaps", async () => {
    const scope = await setupTenant("fr-page-1");

    // Create three households
    const hh1 = await createHouseholdRow(scope, "Fam 1");
    const hh2 = await createHouseholdRow(scope, "Fam 2");
    const hh3 = await createHouseholdRow(scope, "Fam 3");

    // Sort IDs so we can assign deterministic deleted_at
    const sorted = [hh1.householdId, hh2.householdId, hh3.householdId].sort();
    const idB = sorted[0]!;
    const idC = sorted[1]!;
    const idA = sorted[2]!;

    // idB and idC share 200 microseconds (exact same time); idA gets 100 microseconds
    await setHouseholdDeletedAt(scope, [
      { householdId: idA, micros: 100 },
      { householdId: idB, micros: 200 },
      { householdId: idC, micros: 200 },
    ]);

    // Expected order: deleted_at desc, id asc
    // 200 micros > 100 micros, so idB and idC come first, sorted by id asc (idB < idC).
    // Followed by idA (100 micros).
    const expectedOrder = [idB, idC, idA];

    await inScope(scope, async (tx) => {
      // Paging with page size 1
      const p1 = await listDeletedHouseholds(tx, kms, KEY_ARN, {
        actorUserId: ACTOR,
        limit: 1,
      });
      expect(p1.items).toHaveLength(1);
      expect(p1.items[0]?.householdId).toBe(expectedOrder[0]);
      expect(p1.nextCursor).not.toBeNull();

      const p2 = await listDeletedHouseholds(tx, kms, KEY_ARN, {
        actorUserId: ACTOR,
        limit: 1,
        cursor: p1.nextCursor,
      });
      expect(p2.items).toHaveLength(1);
      expect(p2.items[0]?.householdId).toBe(expectedOrder[1]);
      expect(p2.nextCursor).not.toBeNull();

      const p3 = await listDeletedHouseholds(tx, kms, KEY_ARN, {
        actorUserId: ACTOR,
        limit: 1,
        cursor: p2.nextCursor,
      });
      expect(p3.items).toHaveLength(1);
      expect(p3.items[0]?.householdId).toBe(expectedOrder[2]);
      expect(p3.nextCursor).toBeNull();

      const collected1 = [
        p1.items[0]!.householdId,
        p2.items[0]!.householdId,
        p3.items[0]!.householdId,
      ];
      expect(collected1).toEqual(expectedOrder);

      // Paging with page size 2
      const q1 = await listDeletedHouseholds(tx, kms, KEY_ARN, {
        actorUserId: ACTOR,
        limit: 2,
      });
      expect(q1.items).toHaveLength(2);
      expect(q1.items.map((i) => i.householdId)).toEqual([expectedOrder[0], expectedOrder[1]]);
      expect(q1.nextCursor).not.toBeNull();

      const q2 = await listDeletedHouseholds(tx, kms, KEY_ARN, {
        actorUserId: ACTOR,
        limit: 2,
        cursor: q1.nextCursor,
      });
      expect(q2.items).toHaveLength(1);
      expect(q2.items[0]?.householdId).toBe(expectedOrder[2]);
      expect(q2.nextCursor).toBeNull();

      const collected2 = [
        ...q1.items.map((i) => i.householdId),
        ...q2.items.map((i) => i.householdId),
      ];
      expect(collected2).toEqual(expectedOrder);
    });
  });

  it("the deleted family list audits each call once, an empty page too", async () => {
    const scope = await setupTenant("fr-audit-1");

    // Empty community listDeletedHouseholds call
    await inScope(scope, async (tx) => {
      const empty = await listDeletedHouseholds(tx, kms, KEY_ARN, {
        actorUserId: ACTOR,
      });
      expect(empty.items).toEqual([]);
      expect(empty.nextCursor).toBeNull();
    });

    const eventsAfterEmpty = await listedDeletedHouseholdEvents(scope);
    expect(eventsAfterEmpty).toHaveLength(1);
    expect(eventsAfterEmpty[0]).toEqual([]);

    // Add 1 hidden family
    const hh = await createHouseholdRow(scope, "Hidden Audit");
    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hh.householdId,
        version: hh.version,
        actorUserId: ACTOR,
      });
    });

    await inScope(scope, async (tx) => {
      const one = await listDeletedHouseholds(tx, kms, KEY_ARN, {
        actorUserId: ACTOR,
        limit: 1,
      });
      expect(one.items).toHaveLength(1);
      expect(one.items[0]?.householdId).toBe(hh.householdId);
    });

    const eventsAfterOne = await listedDeletedHouseholdEvents(scope);
    expect(eventsAfterOne).toHaveLength(2);
    expect(eventsAfterOne[1]).toEqual([hh.householdId]);
  });
});
