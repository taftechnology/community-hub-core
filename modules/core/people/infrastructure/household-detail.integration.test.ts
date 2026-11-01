import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
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
  it("pin 9: caller without people.restricted.read sees adults only, no minors key, no link to a minor, label: null; response bytes contain no minor id", async () => {
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

          const m2 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
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

      // Caller without people.restricted.read (includeRestricted: false)
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const detail = await readHouseholdDetail(tx, kms, KEY_ARN, {
            householdId,
            includeRestricted: false,
            actorUserId: null,
          });

          expect(detail).not.toBeNull();
          expect(detail!.householdId).toBe(householdId);
          expect(detail!.version).toBe(1);
          expect(detail!.label).toBeNull();
          expect("minors" in detail!).toBe(false);
          expect(detail!.minors).toBeUndefined();
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

      // Caller with people.restricted.read (includeRestricted: true)
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const detail = await readHouseholdDetail(tx, kms, KEY_ARN, {
            householdId,
            includeRestricted: true,
            actorUserId: null,
          });

          expect(detail).not.toBeNull();
          expect(detail!.householdId).toBe(householdId);
          expect(detail!.version).toBe(1);
          expect(detail!.label).toBe("Smith Family");
          expect(detail!.minors).toBeDefined();
          expect(detail!.minors).toHaveLength(2);

          const minorsSorted = [...detail!.minors!].sort((a, b) =>
            a.personId.localeCompare(b.personId),
          );
          const expectedMinorIds = [minor1Id, minor2Id].sort();
          expect(minorsSorted.map((m) => m.personId)).toEqual(expectedMinorIds);

          const bobby = detail!.minors!.find((m) => m.personId === minor1Id);
          expect(bobby?.givenName).toBe("Bobby");
          expect(bobby?.familyName).toBe("Smith");
          expect(bobby?.dateOfBirth).toBe("2015-06-15");

          const sally = detail!.minors!.find((m) => m.personId === minor2Id);
          expect(sally?.givenName).toBe("Sally");
          expect(sally?.familyName).toBe("Smith");
          expect(sally?.dateOfBirth).toBe("2018-09-20");

          expect(detail!.guardians).toHaveLength(2);
          const g1 = detail!.guardians.find((g) => g.linkId === link1Id);
          expect(g1).toBeDefined();
          expect(g1?.guardianId).toBe(adult1Id);
          expect(g1?.childId).toBe(minor1Id);
          expect(g1?.rights).toEqual({
            consent: true,
            pickup: true,
            view: true,
            manage: false,
          });
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
  });

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
