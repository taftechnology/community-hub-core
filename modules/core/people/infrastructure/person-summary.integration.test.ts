import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

import { createHousehold, createPerson } from "../public/index.js";
import { summarisePersons } from "./person-summary.js";

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
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

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
  await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from app.person_activity where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`.catch(
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
  await directSql`delete from platform.communities where organisation_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from platform.organisations where id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
}

describe("summarisePersons", () => {
  it("summarisePersons: minors are never counted", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);

    try {
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const adultDate = new Date("2026-10-15T00:00:00Z");
            await createPerson(tx, kms, KEY_ARN, {
              now: adultDate,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Adult",
              familyName: "Contact",
              email: "adult@example.com",
              phone: "+61411111111",
              actorUserId: null,
            });

            const household = await createHousehold(tx, kms, KEY_ARN, {
              now: adultDate,
              label: null,
              actorUserId: null,
            });

            await createPerson(tx, kms, KEY_ARN, {
              now: adultDate,
              declaredAdult: false,
              householdId: household.householdId,
              dateOfBirth: null,
              givenName: "Minor",
              familyName: "Child",
              email: null,
              phone: null,
              actorUserId: null,
            });

            // Minor 2 set as inactive
            const minor2 = await createPerson(tx, kms, KEY_ARN, {
              now: adultDate,
              declaredAdult: false,
              householdId: household.householdId,
              dateOfBirth: null,
              givenName: "MinorTwo",
              familyName: "ChildTwo",
              email: null,
              phone: null,
              actorUserId: null,
            });
            await tx`update app.persons set status = 'inactive' where id = ${minor2.personId}::uuid`;

            const summary = await summarisePersons(tx, {
              addedSince: new Date("2026-10-01T00:00:00Z"),
            });

            expect(summary).toEqual({
              total: 1,
              active: 1,
              inactive: 0,
              addedSince: 1,
            });
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await app.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("summarisePersons: every count filters by org, community and is_minor explicitly", async () => {
    const sqlCalls: string[] = [];
    const stubTx = vi.fn((strings: TemplateStringsArray) => {
      sqlCalls.push(strings.join("?"));
      return Promise.resolve([{ total: 0, active: 0, inactive: 0, added_since: 0 }]);
    }) as unknown as AppTransaction;

    await summarisePersons(stubTx, {
      addedSince: new Date("2026-10-01T00:00:00Z"),
    });

    expect(sqlCalls.length).toBe(1);
    expect(sqlCalls[0]).toContain("current_setting('app.org_id')");
    expect(sqlCalls[0]).toContain("current_setting('app.community_id')");
    expect(sqlCalls[0]).toContain("is_minor = false");
  });

  it("summarisePersons: counts total, active, inactive and added since", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);

    try {
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            // Adult 1: active, created in window (2026-10-15)
            await createPerson(tx, kms, KEY_ARN, {
              now: new Date("2026-10-15T00:00:00Z"),
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AdultOne",
              familyName: "ContactOne",
              email: "one@example.com",
              phone: "+61411111111",
              actorUserId: null,
            });

            // Adult 2: inactive, created in window (2026-10-25)
            const adult2 = await createPerson(tx, kms, KEY_ARN, {
              now: new Date("2026-10-25T00:00:00Z"),
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AdultTwo",
              familyName: "ContactTwo",
              email: "two@example.com",
              phone: "+61422222222",
              actorUserId: null,
            });
            await tx`update app.persons set status = 'inactive' where id = ${adult2.personId}::uuid`;

            // Adult 3: active, created before window (2026-09-01)
            await createPerson(tx, kms, KEY_ARN, {
              now: new Date("2026-09-01T00:00:00Z"),
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AdultThree",
              familyName: "ContactThree",
              email: "three@example.com",
              phone: "+61433333333",
              actorUserId: null,
            });

            const summary = await summarisePersons(tx, {
              addedSince: new Date("2026-10-01T00:00:00Z"),
            });

            expect(summary).toEqual({
              total: 3,
              active: 2,
              inactive: 1,
              addedSince: 2,
            });
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await app.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("summarisePersons: a future addedSince counts 0", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);

    try {
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await createPerson(tx, kms, KEY_ARN, {
              now: new Date("2026-10-15T00:00:00Z"),
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AdultFuture",
              familyName: "ContactFuture",
              email: "future@example.com",
              phone: "+61411111111",
              actorUserId: null,
            });

            const summary = await summarisePersons(tx, {
              addedSince: new Date("2099-01-01T00:00:00Z"),
            });

            expect(summary).toEqual({
              total: 1,
              active: 1,
              inactive: 0,
              addedSince: 0,
            });
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await app.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("summarisePersons: records no usage fact", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);

    try {
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await createPerson(tx, kms, KEY_ARN, {
              now: new Date("2026-10-15T00:00:00Z"),
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AdultUsage",
              familyName: "ContactUsage",
              email: "usage@example.com",
              phone: "+61411111111",
              actorUserId: null,
            });
          });
        },
      );

      // Clear any facts created during setup via directSql
      await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`;

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await summarisePersons(tx, {
              addedSince: new Date("2026-10-01T00:00:00Z"),
            });

            const facts = await tx<{ count: number }[]>`
              select count(*)::int as count
              from app.usage_facts_daily
              where org_id = ${scope.orgId}::uuid
                and community_id = ${scope.communityId}::uuid
            `;
            expect(facts[0]?.count).toBe(0);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await app.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("summarisePersons: another community's adults are not counted", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const community2Id = await createCommunityInOrg(platform, scope.orgId);

    try {
      // Community 1: 2 adults
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const now = new Date("2026-10-15T00:00:00Z");
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Comm1A",
              familyName: "User",
              email: "c1a@example.com",
              phone: "+61411111111",
              actorUserId: null,
            });
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Comm1B",
              familyName: "User",
              email: "c1b@example.com",
              phone: "+61411111112",
              actorUserId: null,
            });
          });
        },
      );

      // Community 2: 3 adults
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: community2Id },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const now = new Date("2026-10-15T00:00:00Z");
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Comm2A",
              familyName: "User",
              email: "c2a@example.com",
              phone: "+61422222221",
              actorUserId: null,
            });
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Comm2B",
              familyName: "User",
              email: "c2b@example.com",
              phone: "+61422222222",
              actorUserId: null,
            });
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Comm2C",
              familyName: "User",
              email: "c2c@example.com",
              phone: "+61422222223",
              actorUserId: null,
            });
          });
        },
      );

      // Check Community 1 summary
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const summary1 = await summarisePersons(tx, {
              addedSince: new Date("2026-10-01T00:00:00Z"),
            });
            expect(summary1.total).toBe(2);
            expect(summary1.active).toBe(2);
          });
        },
      );

      // Check Community 2 summary
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: community2Id },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const summary2 = await summarisePersons(tx, {
              addedSince: new Date("2026-10-01T00:00:00Z"),
            });
            expect(summary2.total).toBe(3);
            expect(summary2.active).toBe(3);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await app.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("summarisePersons: counts an adult whose created_at equals addedSince", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);

    try {
      const boundaryDate = new Date("2026-10-01T00:00:00.000Z");
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await createPerson(tx, kms, KEY_ARN, {
              now: boundaryDate,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "BoundaryAdult",
              familyName: "Person",
              email: "boundary@example.test",
              phone: "+61411111199",
              actorUserId: null,
            });

            const summary = await summarisePersons(tx, {
              addedSince: boundaryDate,
            });

            expect(summary.total).toBe(1);
            expect(summary.addedSince).toBe(1);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await app.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("summarisePersons: adults in another organisation are not counted", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scopeA = await createScope(platform);
    const scopeB = await createScope(platform);

    try {
      // Scope A: 2 adults
      await withAppTransaction(
        app,
        { orgId: scopeA.orgId, communityId: scopeA.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const now = new Date("2026-10-15T00:00:00Z");
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "OrgA1",
              familyName: "User",
              email: "orga1@example.test",
              phone: "+61411111111",
              actorUserId: null,
            });
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "OrgA2",
              familyName: "User",
              email: "orga2@example.test",
              phone: "+61411111112",
              actorUserId: null,
            });
          });
        },
      );

      // Scope B: 3 adults
      await withAppTransaction(
        app,
        { orgId: scopeB.orgId, communityId: scopeB.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const now = new Date("2026-10-15T00:00:00Z");
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "OrgB1",
              familyName: "User",
              email: "orgb1@example.test",
              phone: "+61422222221",
              actorUserId: null,
            });
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "OrgB2",
              familyName: "User",
              email: "orgb2@example.test",
              phone: "+61422222222",
              actorUserId: null,
            });
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "OrgB3",
              familyName: "User",
              email: "orgb3@example.test",
              phone: "+61422222223",
              actorUserId: null,
            });
          });
        },
      );

      // Check Scope A summary
      await withAppTransaction(
        app,
        { orgId: scopeA.orgId, communityId: scopeA.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const summaryA = await summarisePersons(tx, {
              addedSince: new Date("2026-10-01T00:00:00Z"),
            });
            expect(summaryA.total).toBe(2);
            expect(summaryA.active).toBe(2);
          });
        },
      );

      // Check Scope B summary
      await withAppTransaction(
        app,
        { orgId: scopeB.orgId, communityId: scopeB.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const summaryB = await summarisePersons(tx, {
              addedSince: new Date("2026-10-01T00:00:00Z"),
            });
            expect(summaryB.total).toBe(3);
            expect(summaryB.active).toBe(3);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scopeA);
      await cleanScope(directSql, scopeB);
      await app.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });
});
