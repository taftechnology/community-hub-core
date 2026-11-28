import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import type { KmsPort } from "@community-hub/crypto";
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
  linkGuardian,
  readHousehold,
  readHouseholdDetail,
} from "../public/index.js";

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
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-01T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

beforeAll(async () => {
  const runtime = loadRuntime();
  const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

async function createScope(platform: ReturnType<typeof createPlaintextPlatformSql>): Promise<{
  orgId: string;
  communityId: string;
}> {
  const orgId = newId();
  const communityId = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.organisations (id, slug, region, kind)
      values (${orgId}, ${`scope-${orgId}`}, 'au', 'implicit')
    `;
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`comm-${communityId}`}, 'au')
    `;
  });
  return { orgId, communityId };
}

async function createCommunityInOrg(
  platform: ReturnType<typeof createPlaintextPlatformSql>,
  orgId: string,
): Promise<string> {
  const communityId = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`comm-${communityId}`}, 'au')
    `;
  });
  return communityId;
}

async function cleanScope(
  directSql: ReturnType<typeof createPlaintextDirectSql>,
  scope: { orgId: string },
): Promise<void> {
  await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.person_activity where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.guardian_links where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.persons where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from app.household_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.households where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from app.community_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.organisation_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from platform.communities where organisation_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from platform.organisations where id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
}

describe("household detail read", () => {
  it("pin 9: a caller without people.restricted.read sees adults and a child count, no link to a child, label: null; a Community Admin sees ids and labels, never a field", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);

    try {
      let householdId = "";
      let adult1Id = "";
      let adult2Id = "";
      let minor1Id = "";
      let minor2Id = "";
      let link1Id = "";
      let link2Id = "";

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Smith Family",
            actorUserId: null,
          });
          householdId = hh.householdId;

          const a1 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId,
            dateOfBirth: null,
            givenName: "John",
            familyName: "Smith",
            email: "john.smith@example.test",
            phone: null,
            actorUserId: null,
          });
          adult1Id = a1.personId;

          const a2 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId,
            dateOfBirth: null,
            givenName: "Jane",
            familyName: "Smith",
            email: "jane.smith@example.test",
            phone: null,
            actorUserId: null,
          });
          adult2Id = a2.personId;

          const m1 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId,
            dateOfBirth: "2015-06-15",
            givenName: "Bobby",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId: null,
          });
          minor1Id = m1.personId;

          // Created an hour later, so the labels follow created_at and not the order of the ids.
          const m2 = await createPerson(tx, kms, KEY_ARN, {
            now: new Date(NOW.getTime() + 3_600_000),
            declaredAdult: false,
            householdId,
            dateOfBirth: "2018-09-20",
            givenName: "Sally",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId: null,
          });
          minor2Id = m2.personId;

          const l1 = await linkGuardian(tx, {
            now: NOW,
            householdId,
            guardianPersonId: adult1Id,
            childPersonId: minor1Id,
            consent: true,
            pickup: true,
            view: true,
            manage: false,
            actorUserId: null,
          });
          link1Id = l1.linkId;

          const l2 = await linkGuardian(tx, {
            now: NOW,
            householdId,
            guardianPersonId: adult2Id,
            childPersonId: minor2Id,
            consent: true,
            pickup: false,
            view: true,
            manage: true,
            actorUserId: null,
          });
          link2Id = l2.linkId;
        }),
      );

      // Caller without people.restricted.read, shown the presence view (includeRestricted: false)
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const detail = await readHouseholdDetail(tx, kms, KEY_ARN, {
            householdId,
            includeRestricted: false,
            childView: "presence",
            actorUserId: null,
          });

          expect(detail).not.toBeNull();
          expect(detail!.householdId).toBe(householdId);
          expect(detail!.version).toBe(1);
          expect(detail!.label).toBeNull();
          expect(detail!.minors).toEqual({ childCount: 2 });
          expect(detail!.guardians).toEqual([]);

          expect(detail!.adults).toHaveLength(2);
          const adultIds = detail!.adults.map((a) => a.personId).sort();
          expect(adultIds).toEqual([adult1Id, adult2Id].sort());

          // Verify response bytes contain no minor id or synthetic minor name
          const responseJson = JSON.stringify(detail);
          expect(responseJson).not.toContain(minor1Id);
          expect(responseJson).not.toContain(minor2Id);
          expect(responseJson).not.toContain("Bobby");
          expect(responseJson).not.toContain("Sally");
          expect(responseJson).not.toContain(link1Id);
          expect(responseJson).not.toContain(link2Id);
        }),
      );

      // Caller with people.restricted.read (includeRestricted: true) who is not a Community Admin
      // (presence): the adult-level label is read as before, and a child is still only a count.
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const detail = await readHouseholdDetail(tx, kms, KEY_ARN, {
            householdId,
            includeRestricted: true,
            childView: "presence",
            actorUserId: null,
          });

          expect(detail).not.toBeNull();
          expect(detail!.householdId).toBe(householdId);
          expect(detail!.version).toBe(1);
          expect(detail!.label).toBe("Smith Family");
          expect(detail!.minors).toEqual({ childCount: 2 });
          expect(detail!.guardians).toEqual([]);
          const responseJson = JSON.stringify(detail);
          for (const forbidden of [
            minor1Id,
            minor2Id,
            link1Id,
            link2Id,
            "Bobby",
            "Sally",
            "2015",
          ]) {
            expect(responseJson).not.toContain(forbidden);
          }
        }),
      );

      // Community Admin (admin): each child is an id and a label, and every field stays shut.
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const detail = await readHouseholdDetail(tx, kms, KEY_ARN, {
            householdId,
            includeRestricted: true,
            childView: "admin",
            actorUserId: null,
          });

          expect(detail).not.toBeNull();
          expect(detail!.label).toBe("Smith Family");
          expect(detail!.minors?.childCount).toBe(2);
          const children = detail!.minors?.children ?? [];
          // Ids are time-prefixed and the children were created in order, so Bobby is Child 1.
          expect(children).toEqual([
            { personId: minor1Id, label: "Child 1" },
            { personId: minor2Id, label: "Child 2" },
          ]);

          expect(detail!.guardians).toHaveLength(2);
          const g1 = detail!.guardians.find((g) => g.linkId === link1Id);
          expect(g1).toBeDefined();
          expect(g1?.guardianId).toBe(adult1Id);
          expect(g1?.childId).toBe(minor1Id);
          expect(g1?.child).toEqual({ personId: minor1Id, label: "Child 1" });
          expect(g1?.rights).toEqual({
            consent: true,
            pickup: true,
            view: true,
            manage: false,
          });

          const responseJson = JSON.stringify(detail);
          for (const forbidden of ["Bobby", "Sally", "2015-06-15", "2018-09-20"]) {
            expect(responseJson).not.toContain(forbidden);
          }
          expect(responseJson).not.toContain("ageBasis");
          expect(responseJson).not.toContain("birthdayMd");
        }),
      );
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  }, 20_000);

  it("pin 24: detail read appends exactly one audit event with action people.household.read, ids only", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);

    try {
      let householdId = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Audit Test Family",
            actorUserId: null,
          });
          householdId = hh.householdId;
        }),
      );

      // Clean existing audits from create
      await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`;

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const detail = await readHouseholdDetail(tx, kms, KEY_ARN, {
            householdId,
            includeRestricted: true,
            childView: "presence",
            actorUserId: null,
          });
          expect(detail).not.toBeNull();
        }),
      );

      const audits = await directSql<{ action: string; purpose: string; target_ids: string[] }[]>`
        select action, purpose, target_ids::text[] as target_ids
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]!.action).toBe("people.household.read");
      expect(audits[0]!.purpose).toBe("people.household.read");
      expect(audits[0]!.target_ids).toEqual([householdId]);

      // Check no personal names or labels leaked in audit row
      const auditJson = JSON.stringify(audits[0]);
      expect(auditJson).not.toContain("Audit Test Family");
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("pin 12: cross-community and cross-organisation reading returns null", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scopeA = await createScope(platform);
    const scopeB = await createScope(platform);
    const communityA2 = await createCommunityInOrg(platform, scopeA.orgId);

    try {
      let householdA = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scopeA, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Scope A Family",
            actorUserId: null,
          });
          householdA = hh.householdId;
        }),
      );

      // Read from community A2 in same org
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: scopeA.orgId, communityId: communityA2 }, async (tx) => {
          const detail = await readHouseholdDetail(tx, kms, KEY_ARN, {
            householdId: householdA,
            includeRestricted: true,
            childView: "presence",
            actorUserId: null,
          });
          expect(detail).toBeNull();
        }),
      );

      // Read from organisation B
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scopeB, async (tx) => {
          const detail = await readHouseholdDetail(tx, kms, KEY_ARN, {
            householdId: householdA,
            includeRestricted: true,
            childView: "presence",
            actorUserId: null,
          });
          expect(detail).toBeNull();
        }),
      );
    } finally {
      try {
        await cleanScope(directSql, scopeA);
        await cleanScope(directSql, scopeB);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("unrestricted detail read fails closed when child in guardian link is absent or unknown", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const orgId = newId();
    const commA = newId();
    const commB = newId();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${orgId}, ${`failclose-${orgId.slice(0, 8)}`}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${commA}, ${orgId}, ${`comma-${commA.slice(0, 8)}`}, 'au')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${commB}, ${orgId}, ${`commb-${commB.slice(0, 8)}`}, 'au')
        `;
      });

      let householdId = "";
      let adultId = "";
      let crossCommPersonId = "";
      const orphanLinkId = newId();

      // Setup in commA: household and adult
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId, communityId: commA }, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "FailClosed Family",
            actorUserId: null,
          });
          householdId = hh.householdId;

          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId,
            dateOfBirth: null,
            givenName: "Adult",
            familyName: "Guardian",
            email: null,
            phone: null,
            actorUserId: null,
          });
          adultId = adult.personId;
        }),
      );

      // Setup in commB: person
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId, communityId: commB }, async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Other",
            familyName: "Person",
            email: null,
            phone: null,
            actorUserId: null,
          });
          crossCommPersonId = person.personId;
        }),
      );

      // Insert link in commA referencing person from commB (FK satisfies org_id)
      await directSql`
        insert into app.guardian_links (
          id, org_id, community_id, household_id, guardian_person_id, child_person_id,
          consent, pickup, view, manage
        ) values (
          ${orphanLinkId}::uuid,
          ${orgId}::uuid,
          ${commA}::uuid,
          ${householdId}::uuid,
          ${adultId}::uuid,
          ${crossCommPersonId}::uuid,
          true, false, true, false
        )
      `;

      // Read unrestricted detail in commA (includeRestricted: false)
      // Since child is in commB, minorCheck inside commA returns no row (absent/unknown)
      // Fail-closed rule: link MUST be omitted unless child is positively known to be an adult (=== false)
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId, communityId: commA }, async (tx) => {
          const detail = await readHouseholdDetail(tx, kms, KEY_ARN, {
            householdId,
            includeRestricted: false,
            childView: "presence",
            actorUserId: null,
          });

          expect(detail).not.toBeNull();
          expect(detail!.guardians).toEqual([]);
        }),
      );
    } finally {
      try {
        await cleanScope(directSql, { orgId });
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });
});

// Task 4: the household detail counts a family's children and never shows one. A Community
// Admin sees each child as an id and a label; nobody sees a field (ADR 0017, spec Scope 1 to 3).

const CHILD_A = {
  givenName: "Zephyrine",
  familyName: "Quillonwick",
  email: "zephyrine.quillonwick@zephyr.example.test",
  phone: "+61400555201",
  dateOfBirth: "2018-05-05",
};
const CHILD_B = {
  givenName: "Quillon",
  familyName: "Zephyrwick",
  email: "quillon.zephyrwick@zephyr.example.test",
  phone: "+61400555202",
  dateOfBirth: "2019-06-07",
};
const CHILD_C = {
  givenName: "Cassiopeia",
  familyName: "Vanterpool",
  email: null,
  phone: null,
  dateOfBirth: "2021-01-12",
};
const CHILD_VALUES: string[] = [
  CHILD_A.givenName,
  CHILD_A.familyName,
  CHILD_A.email,
  CHILD_A.phone,
  // A phone is stored without the plus sign, so that form is searched for too.
  CHILD_A.phone.slice(1),
  CHILD_A.dateOfBirth,
  CHILD_B.givenName,
  CHILD_B.familyName,
  CHILD_B.email,
  CHILD_B.phone,
  CHILD_B.phone.slice(1),
  CHILD_B.dateOfBirth,
  CHILD_C.givenName,
  CHILD_C.familyName,
  CHILD_C.dateOfBirth,
];

type Fixture = {
  app: ReturnType<typeof createPlaintextAppSql>;
  directSql: ReturnType<typeof createPlaintextDirectSql>;
  kms: ReturnType<typeof createLocalKmsPort>;
  scope: { orgId: string; communityId: string };
};

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const runtime = loadRuntime();
  const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
  const kms = createLocalKmsPort();
  const scope = await createScope(platform);
  try {
    await run({ app, directSql, kms, scope });
  } finally {
    try {
      await cleanScope(directSql, scope);
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  }
}

function inScope<T>(fixture: Fixture, run: (tx: AppTransaction) => Promise<T>): Promise<T> {
  return withRequest({ requestId: REQUEST_ID }, () =>
    withAppTransaction(fixture.app, fixture.scope, run),
  );
}

// Counts the KMS Decrypt calls, so a test can show that a view opened no key and so no field.
function countingKms(inner: KmsPort): { kms: KmsPort; calls: () => number } {
  let count = 0;
  return {
    kms: {
      generateDataKey(keyId, context) {
        return inner.generateDataKey(keyId, context);
      },
      decrypt(keyId, blob, context) {
        count += 1;
        return inner.decrypt(keyId, blob, context);
      },
    },
    calls: () => count,
  };
}

type Family = {
  householdId: string;
  version: number;
  adultId: string;
  childAId: string;
  childBId: string;
  linkAId: string;
  linkBId: string;
};

// One adult and two linked children. Child B is created an hour after child A, so the labels are
// Child 1 (A) and Child 2 (B) by created_at and do not depend on the order of the ids.
async function seedFamily(
  fixture: Fixture,
  label: string | null = "Marchetti",
  adultEmail = "aurelia.marchetti@parish.example.test",
): Promise<Family> {
  return inScope(fixture, async (tx) => {
    const household = await createHousehold(tx, fixture.kms, KEY_ARN, {
      now: NOW,
      label,
      actorUserId: null,
    });
    const householdId = household.householdId;
    const adult = await createPerson(tx, fixture.kms, KEY_ARN, {
      now: NOW,
      declaredAdult: true,
      householdId,
      dateOfBirth: null,
      givenName: "Aurelia",
      familyName: "Marchetti",
      email: adultEmail,
      phone: null,
      actorUserId: null,
    });
    const childA = await createPerson(tx, fixture.kms, KEY_ARN, {
      now: NOW,
      declaredAdult: false,
      householdId,
      ...CHILD_A,
      actorUserId: null,
    });
    const childB = await createPerson(tx, fixture.kms, KEY_ARN, {
      now: new Date(NOW.getTime() + 3_600_000),
      declaredAdult: false,
      householdId,
      ...CHILD_B,
      actorUserId: null,
    });
    const rights = { consent: true, pickup: true, view: true, manage: false };
    const linkA = await linkGuardian(tx, {
      now: NOW,
      householdId,
      guardianPersonId: adult.personId,
      childPersonId: childA.personId,
      ...rights,
      actorUserId: null,
    });
    const linkB = await linkGuardian(tx, {
      now: NOW,
      householdId,
      guardianPersonId: adult.personId,
      childPersonId: childB.personId,
      ...rights,
      actorUserId: null,
    });
    return {
      householdId,
      version: household.version,
      adultId: adult.personId,
      childAId: childA.personId,
      childBId: childB.personId,
      linkAId: linkA.linkId,
      linkBId: linkB.linkId,
    };
  });
}

// Hides a child the way a later chunk will (Family Records: children): deleted_at and deleted_by
// are set. Today the user triggers refuse that and no function does it, so it is done in a short
// committed transaction as the migrator with the user triggers off, as the other hidden-row tests
// do (Global constraints: seeding rows the product cannot yet create).
async function hideChild(fixture: Fixture, personId: string): Promise<void> {
  const deletedBy = newId();
  await withAppTransaction(fixture.directSql, fixture.scope, async (tx) => {
    await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
    await tx`
      update app.persons
      set deleted_at = now() - interval '1 hour', deleted_by = ${deletedBy}::uuid
      where id = ${personId}::uuid
    `;
    await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
  });
}

function expectNoChildValue(value: unknown): void {
  const text = JSON.stringify(value);
  for (const forbidden of CHILD_VALUES) {
    expect(text).not.toContain(forbidden);
  }
  expect(text).not.toContain("ageBasis");
  expect(text).not.toContain("birthdayMd");
}

function detailOf(
  fixture: Fixture,
  householdId: string,
  childView: "admin" | "presence",
  includeRestricted = false,
) {
  return inScope(fixture, (tx) =>
    readHouseholdDetail(tx, fixture.kms, KEY_ARN, {
      householdId,
      includeRestricted,
      childView,
      actorUserId: null,
    }),
  );
}

describe("household detail: a child is a count, or an id and a label (Task 4)", () => {
  it("pin 30: presence answers { childCount } only, with no child row, id, label, guardian link or field", async () => {
    await withFixture(async (fixture) => {
      const family = await seedFamily(fixture);
      for (const includeRestricted of [false, true]) {
        const detail = await detailOf(fixture, family.householdId, "presence", includeRestricted);
        expect(detail?.minors).toEqual({ childCount: 2 });
        expect(detail?.minors).not.toHaveProperty("children");
        expect(detail?.guardians).toEqual([]);
        expect(detail?.adults.map((adult) => adult.personId)).toEqual([family.adultId]);
        const text = JSON.stringify(detail);
        for (const forbidden of [
          family.childAId,
          family.childBId,
          family.linkAId,
          family.linkBId,
          "Child ",
        ]) {
          expect(text).not.toContain(forbidden);
        }
        expectNoChildValue(detail);
      }

      // A family without children still answers a count, so a client never has to guess.
      const none = await inScope(fixture, async (tx) => {
        const household = await createHousehold(tx, fixture.kms, KEY_ARN, {
          now: NOW,
          label: null,
          actorUserId: null,
        });
        return readHouseholdDetail(tx, fixture.kms, KEY_ARN, {
          householdId: household.householdId,
          includeRestricted: true,
          childView: "presence",
          actorUserId: null,
        });
      });
      expect(none?.minors).toEqual({ childCount: 0 });
    });
  });

  it("pin 31: admin answers each child as personId and label only, and opens no key", async () => {
    await withFixture(async (fixture) => {
      const family = await seedFamily(fixture);
      const counting = countingKms(fixture.kms);
      const detail = await inScope(fixture, (tx) =>
        readHouseholdDetail(tx, counting.kms, KEY_ARN, {
          householdId: family.householdId,
          includeRestricted: false,
          childView: "admin",
          actorUserId: null,
        }),
      );
      expect(detail?.minors?.childCount).toBe(2);
      const children = detail?.minors?.children ?? [];
      expect(children).toHaveLength(2);
      for (const child of children) {
        expect(Object.keys(child).sort()).toEqual(["label", "personId"]);
      }
      expect(children.map((child) => child.personId)).toEqual([family.childAId, family.childBId]);
      expect(children.map((child) => child.label)).toEqual(["Child 1", "Child 2"]);
      // Nothing was decrypted: no key was unwrapped, and no child field is in the answer.
      expect(counting.calls()).toBe(0);
      expectNoChildValue(detail);
    });
  });

  it("pin 32: the child count leaves out a hidden child, and a hidden child takes no number", async () => {
    await withFixture(async (fixture) => {
      const family = await seedFamily(fixture);
      const childC = await inScope(fixture, (tx) =>
        createPerson(tx, fixture.kms, KEY_ARN, {
          now: new Date(NOW.getTime() + 7_200_000),
          declaredAdult: false,
          householdId: family.householdId,
          ...CHILD_C,
          actorUserId: null,
        }),
      );
      const before = await detailOf(fixture, family.householdId, "presence");
      expect(before?.minors).toEqual({ childCount: 3 });

      await hideChild(fixture, family.childAId);
      const hidden = await fixture.directSql<{ id: string }[]>`
        select id::text as id
        from app.persons
        where household_id = ${family.householdId}::uuid and deleted_at is not null
      `;
      // The seeded state is what the test says it is: child A, and only child A, is hidden.
      expect(hidden.map((row) => row.id)).toEqual([family.childAId]);

      const presence = await detailOf(fixture, family.householdId, "presence");
      expect(presence?.minors).toEqual({ childCount: 2 });

      const admin = await detailOf(fixture, family.householdId, "admin");
      expect(admin?.minors?.childCount).toBe(2);
      expect(admin?.minors?.children).toEqual([
        { personId: family.childBId, label: "Child 1" },
        { personId: childC.personId, label: "Child 2" },
      ]);
      // The link to the hidden child is not listed either.
      expect(admin?.guardians.map((link) => link.linkId)).toEqual([family.linkBId]);
      expect(JSON.stringify(admin)).not.toContain(family.childAId);
      expectNoChildValue([presence, admin]);
    });
  });

  it("pin 33: labels follow created_at and then id, and restart in each household", async () => {
    await withFixture(async (fixture) => {
      const family = await seedFamily(fixture);
      const other = await seedFamily(
        fixture,
        "Vanterpool",
        "aurelia.vanterpool@parish.example.test",
      );

      // Seeded in SQL so that the earlier created_at has the LARGER id (ids carry a time prefix and
      // are not monotonic inside one millisecond, so the order of creation proves nothing).
      const [smaller, larger] =
        family.childAId < family.childBId
          ? [family.childAId, family.childBId]
          : [family.childBId, family.childAId];
      await withAppTransaction(fixture.directSql, fixture.scope, async (tx) => {
        await tx`
          update app.persons set created_at = ${new Date("2026-01-01T00:00:00Z")}
          where id = ${larger}::uuid
        `;
        await tx`
          update app.persons set created_at = ${new Date("2026-02-01T00:00:00Z")}
          where id = ${smaller}::uuid
        `;
      });
      const detail = await detailOf(fixture, family.householdId, "admin");
      expect(detail?.minors?.children).toEqual([
        { personId: larger, label: "Child 1" },
        { personId: smaller, label: "Child 2" },
      ]);

      // With the same created_at the id breaks the tie, smaller first.
      await withAppTransaction(fixture.directSql, fixture.scope, async (tx) => {
        await tx`
          update app.persons set created_at = ${new Date("2026-03-01T00:00:00Z")}
          where id in (${larger}::uuid, ${smaller}::uuid)
        `;
      });
      const tied = await detailOf(fixture, family.householdId, "admin");
      expect(tied?.minors?.children).toEqual([
        { personId: smaller, label: "Child 1" },
        { personId: larger, label: "Child 2" },
      ]);

      // The numbering is per household: the other family's children start again at 1.
      const otherDetail = await detailOf(fixture, other.householdId, "admin");
      expect(otherDetail?.minors?.children?.map((child) => child.label)).toEqual([
        "Child 1",
        "Child 2",
      ]);
      expect(otherDetail?.minors?.children?.map((child) => child.personId)).toEqual([
        other.childAId,
        other.childBId,
      ]);
    });
  });

  it("pin 34: an adult's guardian links to children are omitted under presence", async () => {
    await withFixture(async (fixture) => {
      const family = await seedFamily(fixture);
      for (const includeRestricted of [false, true]) {
        const presence = await detailOf(fixture, family.householdId, "presence", includeRestricted);
        expect(presence?.adults.map((adult) => adult.personId)).toEqual([family.adultId]);
        expect(presence?.guardians).toEqual([]);
        const text = JSON.stringify(presence);
        expect(text).not.toContain(family.linkAId);
        expect(text).not.toContain(family.linkBId);
        expect(text).not.toContain(family.childAId);
        expect(text).not.toContain(family.childBId);
      }
    });
  });

  it("pin 34b: under admin an adult's guardian links show each child as personId and label", async () => {
    await withFixture(async (fixture) => {
      const family = await seedFamily(fixture);
      const admin = await detailOf(fixture, family.householdId, "admin");
      expect(admin?.guardians).toHaveLength(2);
      const linkA = admin?.guardians.find((link) => link.linkId === family.linkAId);
      const linkB = admin?.guardians.find((link) => link.linkId === family.linkBId);
      expect(linkA?.guardianId).toBe(family.adultId);
      expect(linkA?.childId).toBe(family.childAId);
      expect(linkA?.child).toEqual({ personId: family.childAId, label: "Child 1" });
      expect(linkB?.child).toEqual({ personId: family.childBId, label: "Child 2" });
      expect(linkB?.rights).toEqual({ consent: true, pickup: true, view: true, manage: false });
      expectNoChildValue(admin?.guardians);
    });
  });

  it("pin 34c: readHousehold answers childCount and no child row under presence", async () => {
    await withFixture(async (fixture) => {
      const family = await seedFamily(fixture);
      const counting = countingKms(fixture.kms);
      const presence = await inScope(fixture, (tx) =>
        readHousehold(tx, counting.kms, KEY_ARN, {
          householdId: family.householdId,
          childView: "presence",
          actorUserId: null,
        }),
      );
      expect(presence).toEqual({
        householdId: family.householdId,
        label: "Marchetti",
        minors: { childCount: 2 },
      });
      expect(JSON.stringify(presence)).not.toContain(family.childAId);
      expectNoChildValue(presence);

      const admin = await inScope(fixture, (tx) =>
        readHousehold(tx, counting.kms, KEY_ARN, {
          householdId: family.householdId,
          childView: "admin",
          actorUserId: null,
        }),
      );
      expect(admin?.minors).toEqual({
        childCount: 2,
        children: [
          { personId: family.childAId, label: "Child 1" },
          { personId: family.childBId, label: "Child 2" },
        ],
      });
      expectNoChildValue(admin);
    });
  });

  it("refuses a missing or unknown childView, so there is no default", async () => {
    await withFixture(async (fixture) => {
      const family = await seedFamily(fixture);
      await inScope(fixture, async (tx) => {
        await expect(
          readHouseholdDetail(tx, fixture.kms, KEY_ARN, {
            householdId: family.householdId,
            includeRestricted: true,
            actorUserId: null,
          } as never),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(
          readHouseholdDetail(tx, fixture.kms, KEY_ARN, {
            householdId: family.householdId,
            includeRestricted: true,
            childView: "everyone",
            actorUserId: null,
          } as never),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(
          readHousehold(tx, fixture.kms, KEY_ARN, {
            householdId: family.householdId,
            actorUserId: null,
          } as never),
        ).rejects.toMatchObject({ code: "invalid_input" });
      });
    });
  });
});
