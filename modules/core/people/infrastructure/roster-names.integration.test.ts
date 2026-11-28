import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import type { KmsPort } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { createHousehold, createPerson, PeopleError, readRosterNames } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);
const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "roster-names.ts");

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-11T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

function createCountingKmsPort(base: KmsPort): {
  kms: KmsPort;
  count: () => number;
  reset: () => void;
} {
  let unwraps = 0;
  const kms: KmsPort = {
    generateDataKey: (keyId, context) => base.generateDataKey(keyId, context),
    decrypt: async (keyId, blob, context) => {
      unwraps += 1;
      return base.decrypt(keyId, blob, context);
    },
  };
  return {
    kms,
    count: () => unwraps,
    reset: () => {
      unwraps = 0;
    },
  };
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
  await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`.catch(() => {});
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
  await directSql`delete from platform.communities where organisation_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from platform.organisations where id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
}

describe("readRosterNames", () => {
  it("omits an id from another community and another organisation (pin 12)", async () => {
    const source = readFileSync(SOURCE, "utf8");
    expect(source).toMatch(/community_id\s*=\s*current_setting\(\s*'app\.community_id'\s*\)::uuid/);
    expect(source).toMatch(/org_id\s*=\s*current_setting\(\s*'app\.org_id'\s*\)::uuid/);
    const whereMatch = source.match(/from\s+app\.persons\s+(where[\s\S]*?)`;/i);
    expect(whereMatch).not.toBeNull();
    const whereClause = whereMatch![1]!;
    expect(whereClause).not.toMatch(/\bor\b/i);
    expect(whereClause).toMatch(
      /where\s+id\s*=\s*any\(\$\{ids\}::uuid\[\]\)\s+and\s+org_id\s*=\s*current_setting\(\s*'app\.org_id'\s*\)::uuid\s+and\s+community_id\s*=\s*current_setting\(\s*'app\.community_id'\s*\)::uuid/i,
    );

    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scopeA = await createScope(platform);
    const commA2 = await createCommunityInOrg(platform, scopeA.orgId);
    const scopeB = await createScope(platform);
    const actorUserId = newId();

    try {
      let adultAId = "";
      let adultOtherCommId = "";
      let adultOtherOrgId = "";

      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scopeA, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "AdultA",
            familyName: "Local",
            email: null,
            phone: null,
            actorUserId,
          });
          adultAId = adult.personId;
        });

        await withAppTransaction(app, { orgId: scopeA.orgId, communityId: commA2 }, async (tx) => {
          const adultOtherComm = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "AdultComm2",
            familyName: "OtherComm",
            email: null,
            phone: null,
            actorUserId,
          });
          adultOtherCommId = adultOtherComm.personId;
        });

        await withAppTransaction(app, scopeB, async (tx) => {
          const adultOtherOrg = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "AdultOrgB",
            familyName: "OtherOrg",
            email: null,
            phone: null,
            actorUserId,
          });
          adultOtherOrgId = adultOtherOrg.personId;
        });

        await withAppTransaction(app, scopeA, async (tx) => {
          const results = await readRosterNames(tx, kms, KEY_ARN, {
            personIds: [adultAId, adultOtherCommId, adultOtherOrgId],
            childView: "admin",
            actorUserId,
          });
          expect(results.adults).toHaveLength(1);
          expect(results.adults[0]?.personId).toBe(adultAId);
          expect(results.children).toEqual([]);
          expect(results.minorCount).toBe(0);
        });
      });
    } finally {
      await cleanScope(directSql, scopeA);
      await cleanScope(directSql, scopeB);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("returns no row for a minor under presence, only minorCount (pin 13)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Smith",
            actorUserId,
          });
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: hh.householdId,
            dateOfBirth: null,
            givenName: "Jane",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId,
          });
          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: hh.householdId,
            dateOfBirth: null,
            givenName: "Johnny",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId,
          });

          const auditBefore = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events where action = 'people.person.read'
          `;

          const results = await readRosterNames(tx, kms, KEY_ARN, {
            personIds: [adult.personId, minor.personId],
            childView: "presence",
            actorUserId,
          });

          // The adult is unchanged. The minor is not a row: it is only counted.
          expect(results.adults).toEqual([
            { personId: adult.personId, isMinor: false, givenName: "Jane", familyName: "Smith" },
          ]);
          expect(results.children).toEqual([]);
          expect(results.minorCount).toBe(1);
          expect(JSON.stringify(results)).not.toContain(minor.personId);

          const auditAfter = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events where action = 'people.person.read'
          `;
          expect(auditAfter[0]?.count).toBe(auditBefore[0]?.count);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("under admin a minor is an id and a label, and no people.person.read event is written (pin 14)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Smith",
            actorUserId,
          });
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: hh.householdId,
            dateOfBirth: null,
            givenName: "Jane",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId,
          });
          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: hh.householdId,
            dateOfBirth: null,
            givenName: "Johnny",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId,
          });

          const results = await readRosterNames(tx, kms, KEY_ARN, {
            personIds: [adult.personId, minor.personId],
            childView: "admin",
            actorUserId,
          });

          // A minor is an id and a label, never a name.
          expect(results.children).toEqual([{ personId: minor.personId, label: "Child 1" }]);
          expect(results.minorCount).toBe(1);

          // Nothing was decrypted, so there is no read to audit: no people.person.read event
          // names the minor, or anyone else, for this actor.
          const auditRows = await tx<{ target_ids: string[] }[]>`
            select target_ids::text[] as target_ids
            from app.audit_events
            where action = 'people.person.read'
              and actor_id = ${actorUserId}::uuid
          `;
          expect(auditRows).toEqual([]);

          // No name of the minor appears in the child rows (the adult's own name is in `adults`).
          const serialized = JSON.stringify(results.children);
          expect(serialized).not.toContain("Johnny");
          expect(serialized).not.toContain("Smith");
          expect(JSON.stringify(results.adults)).not.toContain("Johnny");
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects a null actor (pin 14)", async () => {
    const runtime = loadRuntime();
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          await expect(
            readRosterNames(tx, kms, KEY_ARN, {
              personIds: [newId()],
              childView: "admin",
              actorUserId: null as never,
            }),
          ).rejects.toBeInstanceOf(PeopleError);

          await expect(
            readRosterNames(tx, kms, KEY_ARN, {
              personIds: [newId()],
              childView: "admin",
              actorUserId: "not-a-uuid",
            }),
          ).rejects.toBeInstanceOf(PeopleError);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects an invalid actor before performing any decryption or auditing (pin 14)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const baseKms = createLocalKmsPort();
    const countingKms = createCountingKmsPort(baseKms);

    const scope = await createScope(platform);
    const setupActorUserId = newId();

    try {
      let minorId = "";
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const hh = await createHousehold(tx, countingKms.kms, KEY_ARN, {
            now: NOW,
            label: "MinorHousehold",
            actorUserId: setupActorUserId,
          });
          const minor = await createPerson(tx, countingKms.kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: hh.householdId,
            dateOfBirth: null,
            givenName: "Tommy",
            familyName: "Tester",
            email: null,
            phone: null,
            actorUserId: setupActorUserId,
          });
          minorId = minor.personId;
        });

        countingKms.reset();

        await withAppTransaction(app, scope, async (tx) => {
          await expect(
            readRosterNames(tx, countingKms.kms, KEY_ARN, {
              personIds: [minorId],
              childView: "admin",
              actorUserId: null as never,
            }),
          ).rejects.toBeInstanceOf(PeopleError);

          expect(countingKms.count()).toBe(0);

          const auditRows = await tx<{ count: string }[]>`
            select count(*)::text as count
            from app.audit_events
            where action = 'people.person.read'
              and org_id = ${scope.orgId}::uuid
          `;
          expect(Number(auditRows[0]?.count ?? "0")).toBe(0);
        });

        await withAppTransaction(app, scope, async (tx) => {
          await expect(
            readRosterNames(tx, countingKms.kms, KEY_ARN, {
              personIds: [minorId],
              childView: "admin",
              actorUserId: "not-a-valid-uuid",
            }),
          ).rejects.toBeInstanceOf(PeopleError);

          expect(countingKms.count()).toBe(0);

          const auditRows = await tx<{ count: string }[]>`
            select count(*)::text as count
            from app.audit_events
            where action = 'people.person.read'
              and org_id = ${scope.orgId}::uuid
          `;
          expect(Number(auditRows[0]?.count ?? "0")).toBe(0);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("returns exactly the roster fields: four for an adult, two for a minor (pin 15)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Smith",
            actorUserId,
          });
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: hh.householdId,
            dateOfBirth: null,
            givenName: "Jane",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId,
          });
          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: hh.householdId,
            dateOfBirth: null,
            givenName: "Johnny",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId,
          });

          const results = await readRosterNames(tx, kms, KEY_ARN, {
            personIds: [adult.personId, minor.personId],
            childView: "admin",
            actorUserId,
          });

          expect(Object.keys(results).sort()).toEqual(["adults", "children", "minorCount"]);
          expect(results.adults).toHaveLength(1);
          for (const entry of results.adults) {
            expect(Object.keys(entry).sort()).toEqual([
              "familyName",
              "givenName",
              "isMinor",
              "personId",
            ]);
          }
          // A minor is an id and a label and nothing else.
          expect(results.children).toHaveLength(1);
          for (const entry of results.children) {
            expect(Object.keys(entry).sort()).toEqual(["label", "personId"]);
          }
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("opens no household key for a minor under either view (pin 16)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const localKms = createLocalKmsPort();
    const counting = createCountingKmsPort(localKms);

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let m1Id = "";
      let m2Id = "";
      let m3Id = "";
      let m4Id = "";

      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const hh1 = await createHousehold(tx, localKms, KEY_ARN, {
            now: NOW,
            label: "HouseholdOne",
            actorUserId,
          });
          const hh2 = await createHousehold(tx, localKms, KEY_ARN, {
            now: NOW,
            label: "HouseholdTwo",
            actorUserId,
          });

          const m1 = await createPerson(tx, localKms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: hh1.householdId,
            dateOfBirth: null,
            givenName: "MinorOne",
            familyName: "HH1",
            email: null,
            phone: null,
            actorUserId,
          });
          const m2 = await createPerson(tx, localKms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: hh1.householdId,
            dateOfBirth: null,
            givenName: "MinorTwo",
            familyName: "HH1",
            email: null,
            phone: null,
            actorUserId,
          });
          const m3 = await createPerson(tx, localKms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: hh1.householdId,
            dateOfBirth: null,
            givenName: "MinorThree",
            familyName: "HH1",
            email: null,
            phone: null,
            actorUserId,
          });
          const m4 = await createPerson(tx, localKms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: hh2.householdId,
            dateOfBirth: null,
            givenName: "MinorFour",
            familyName: "HH2",
            email: null,
            phone: null,
            actorUserId,
          });

          m1Id = m1.personId;
          m2Id = m2.personId;
          m3Id = m3.personId;
          m4Id = m4.personId;
        });

        // No key is derived for a minor under either view: a label comes from clear columns, and
        // under presence a minor is only counted. So the KMS is never asked, whatever the mix of
        // households (this replaces the old one-key-per-household cost check).
        await withAppTransaction(app, scope, async (tx) => {
          for (const childView of ["admin", "presence"] as const) {
            // One minor in HH1
            counting.reset();
            const r1 = await readRosterNames(tx, counting.kms, KEY_ARN, {
              personIds: [m1Id],
              childView,
              actorUserId,
            });
            expect(r1.minorCount).toBe(1);
            expect(r1.children).toHaveLength(childView === "admin" ? 1 : 0);

            // Three minors in one household (HH1)
            const r2 = await readRosterNames(tx, counting.kms, KEY_ARN, {
              personIds: [m1Id, m2Id, m3Id],
              childView,
              actorUserId,
            });
            expect(r2.minorCount).toBe(3);
            expect(r2.children).toHaveLength(childView === "admin" ? 3 : 0);

            // Three minors in two households (m1, m2 from HH1, m4 from HH2)
            const r3 = await readRosterNames(tx, counting.kms, KEY_ARN, {
              personIds: [m1Id, m2Id, m4Id],
              childView,
              actorUserId,
            });
            expect(r3.minorCount).toBe(3);
            expect(r3.children).toHaveLength(childView === "admin" ? 3 : 0);

            expect(counting.count()).toBe(0);
          }

          // Labels restart in each household: m4 is the only child of HH2.
          const admin = await readRosterNames(tx, counting.kms, KEY_ARN, {
            personIds: [m1Id, m2Id, m3Id, m4Id],
            childView: "admin",
            actorUserId,
          });
          const labelOf = Object.fromEntries(admin.children.map((c) => [c.personId, c.label]));
          expect(labelOf[m4Id]).toBe("Child 1");
          expect(Object.values(labelOf).filter((label) => label === "Child 1")).toHaveLength(2);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("no people.person.read event for an adults-only call", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "AdultOnly",
            familyName: "Test",
            email: null,
            phone: null,
            actorUserId,
          });

          const auditBefore = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events where action = 'people.person.read'
          `;

          const results = await readRosterNames(tx, kms, KEY_ARN, {
            personIds: [adult.personId],
            childView: "admin",
            actorUserId,
          });
          expect(results.adults).toHaveLength(1);
          expect(results.minorCount).toBe(0);

          const auditAfter = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events where action = 'people.person.read'
          `;
          expect(auditAfter[0]?.count).toBe(auditBefore[0]?.count);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("empty personIds returns [] without audit", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const auditBefore = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events where action = 'people.person.read'
          `;

          const results = await readRosterNames(tx, kms, KEY_ARN, {
            personIds: [],
            childView: "admin",
            actorUserId,
          });
          expect(results).toEqual({ adults: [], children: [], minorCount: 0 });

          const auditAfter = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events where action = 'people.person.read'
          `;
          expect(auditAfter[0]?.count).toBe(auditBefore[0]?.count);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("duplicate ids are returned once", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Dupe",
            familyName: "Test",
            email: null,
            phone: null,
            actorUserId,
          });

          const results = await readRosterNames(tx, kms, KEY_ARN, {
            personIds: [adult.personId, adult.personId, adult.personId],
            childView: "admin",
            actorUserId,
          });
          expect(results.adults).toHaveLength(1);
          expect(results.adults[0]?.personId).toBe(adult.personId);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects a malformed person id alone or mixed with a valid id and writes no audit row", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Valid",
            familyName: "Person",
            email: null,
            phone: null,
            actorUserId,
          });

          const auditBefore = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events
          `;

          await expect(
            readRosterNames(tx, kms, KEY_ARN, {
              personIds: ["not-a-uuid"],
              childView: "admin",
              actorUserId,
            }),
          ).rejects.toMatchObject({ code: "invalid_input" });

          await expect(
            readRosterNames(tx, kms, KEY_ARN, {
              personIds: [adult.personId, "not-a-uuid"],
              childView: "admin",
              actorUserId,
            }),
          ).rejects.toMatchObject({ code: "invalid_input" });

          const auditAfter = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events
          `;
          expect(auditAfter[0]?.count).toBe(auditBefore[0]?.count);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
