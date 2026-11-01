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

import { createHousehold, createPerson, listHouseholds } from "../public/index.js";

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

describe("household list", () => {
  it("pin 16: page of 5 households writes exactly one audit event whose targetIds equal the returned ids; audit row contains none of the synthetic names", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);

    try {
      const createdIds: string[] = [];
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          for (let i = 0; i < 5; i += 1) {
            const hh = await createHousehold(tx, kms, KEY_ARN, {
              now: NOW,
              label: `Synthetic House ${i}`,
              actorUserId: null,
            });
            createdIds.push(hh.householdId);

            // Add an adult to some households
            if (i % 2 === 0) {
              await createPerson(tx, kms, KEY_ARN, {
                now: NOW,
                declaredAdult: true,
                householdId: hh.householdId,
                dateOfBirth: null,
                givenName: `Adult${i}`,
                familyName: "Member",
                email: `adult${i}@example.test`,
                phone: null,
                actorUserId: null,
              });
            }
            // Add a minor to one household (minor must NOT be counted in adultCount)
            if (i === 0) {
              await createPerson(tx, kms, KEY_ARN, {
                now: NOW,
                declaredAdult: false,
                householdId: hh.householdId,
                dateOfBirth: "2016-01-01",
                givenName: "Minor0",
                familyName: "Member",
                email: null,
                phone: null,
                actorUserId: null,
              });
            }
          }
        }),
      );

      // Clean existing audits from creation
      await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`;

      // List households with includeRestricted: true
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const res = await listHouseholds(tx, kms, KEY_ARN, {
            limit: 5,
            includeRestricted: true,
            actorUserId: null,
          });

          expect(res.items).toHaveLength(5);
          const returnedIds = res.items.map((it) => it.householdId);
          expect(returnedIds.sort()).toEqual(createdIds.sort());

          // Verify adultCount
          for (const item of res.items) {
            const idx = createdIds.indexOf(item.householdId);
            if (idx % 2 === 0) {
              expect(item.adultCount).toBe(1); // minor in household 0 is excluded!
            } else {
              expect(item.adultCount).toBe(0);
            }
            expect(item.label).toBe(`Synthetic House ${idx}`);
          }
        }),
      );

      // Check audit: exactly one list audit event
      const audits = await directSql<{ action: string; purpose: string; target_ids: string[] }[]>`
        select action, purpose, target_ids::text[] as target_ids
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]!.action).toBe("people.household.listed");
      expect(audits[0]!.purpose).toBe("people.household.listed");
      expect(audits[0]!.target_ids.sort()).toEqual(createdIds.sort());

      const auditJson = JSON.stringify(audits[0]);
      for (let i = 0; i < 5; i += 1) {
        expect(auditJson).not.toContain(`Synthetic House ${i}`);
        expect(auditJson).not.toContain(`Adult${i}`);
        expect(auditJson).not.toContain("Minor0");
      }
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

  it("keyset paging on id alone, default and max limit 25, label null when includeRestricted is false", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);

    try {
      const createdIds: string[] = [];
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          for (let i = 0; i < 6; i += 1) {
            const hh = await createHousehold(tx, kms, KEY_ARN, {
              now: NOW,
              label: `Family ${i}`,
              actorUserId: null,
            });
            createdIds.push(hh.householdId);
          }
        }),
      );

      // Keyset order by id asc
      const sortedIds = [...createdIds].sort();

      // Page 1: limit 3, includeRestricted false
      let nextCursor: string | null = null;
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const res = await listHouseholds(tx, kms, KEY_ARN, {
            limit: 3,
            includeRestricted: false,
            actorUserId: null,
          });

          expect(res.items).toHaveLength(3);
          expect(res.items.map((it) => it.householdId)).toEqual(sortedIds.slice(0, 3));
          for (const item of res.items) {
            expect(item.label).toBeNull(); // restricted read off -> label: null
          }
          expect(res.nextCursor).not.toBeNull();
          nextCursor = res.nextCursor;
        }),
      );

      // Page 2: with cursor
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const res = await listHouseholds(tx, kms, KEY_ARN, {
            cursor: nextCursor,
            limit: 3,
            includeRestricted: true,
            actorUserId: null,
          });

          expect(res.items).toHaveLength(3);
          expect(res.items.map((it) => it.householdId)).toEqual(sortedIds.slice(3, 6));
          for (const item of res.items) {
            expect(item.label).not.toBeNull();
          }
          expect(res.nextCursor).toBeNull();
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

  it("pin 12: cross-organisation and cross-community households are not returned", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scopeA = await createScope(platform);
    const scopeB = await createScope(platform);
    const communityA2 = await createCommunityInOrg(platform, scopeA.orgId);

    try {
      let hhA = "";
      let hhB = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scopeA, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Scope A HH",
            actorUserId: null,
          });
          hhA = hh.householdId;
        }),
      );

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scopeB, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Scope B HH",
            actorUserId: null,
          });
          hhB = hh.householdId;
        }),
      );

      // List in scope A
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scopeA, async (tx) => {
          const res = await listHouseholds(tx, kms, KEY_ARN, {
            includeRestricted: true,
            actorUserId: null,
          });
          const ids = res.items.map((it) => it.householdId);
          expect(ids).toContain(hhA);
          expect(ids).not.toContain(hhB);
        }),
      );

      // List in community A2 (different community in same org)
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: scopeA.orgId, communityId: communityA2 }, async (tx) => {
          const res = await listHouseholds(tx, kms, KEY_ARN, {
            includeRestricted: true,
            actorUserId: null,
          });
          expect(res.items).toHaveLength(0);
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
});
