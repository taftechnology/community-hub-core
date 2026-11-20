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
import { setPersonStatus } from "./person-status.js";

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
const NOW = new Date("2026-10-31T00:00:00+11:00");

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

describe("setPersonStatus", () => {
  it("setPersonStatus: a minor's id throws not_found and changes nothing", async () => {
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
            const household = await createHousehold(tx, kms, KEY_ARN, {
              now: NOW,
              label: null,
              actorUserId: null,
            });
            const minor = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: false,
              householdId: household.householdId,
              dateOfBirth: null,
              givenName: "Minor",
              familyName: "Child",
              email: null,
              phone: null,
              actorUserId: null,
            });

            await expect(
              setPersonStatus(tx, {
                personId: minor.personId,
                version: 1,
                status: "inactive",
                actorUserId: null,
              }),
            ).rejects.toMatchObject({ code: "not_found" });

            const minorRows = await tx<{ status: string; version: number }[]>`
              select status, version from app.persons where id = ${minor.personId}::uuid
            `;
            expect(minorRows[0]).toEqual({ status: "active", version: 1 });

            const audits = await tx<{ id: string }[]>`
              select id::text as id from app.audit_events
              where org_id = ${scope.orgId}::uuid and action = 'people.person.status_changed'
            `;
            expect(audits.length).toBe(0);
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

  it("setPersonStatus: the update filters by org, community and is_minor explicitly", async () => {
    const sqlCalls: string[] = [];
    const stubTx = vi.fn((strings: TemplateStringsArray) => {
      sqlCalls.push(strings.join("?"));
      return Promise.resolve([]);
    }) as unknown as AppTransaction;

    await expect(
      setPersonStatus(stubTx, {
        personId: "11111111-1111-4111-8111-111111111111",
        version: 1,
        status: "inactive",
        actorUserId: null,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    expect(sqlCalls.length).toBe(2);
    for (const sql of sqlCalls) {
      expect(sql).toContain("current_setting('app.org_id')");
      expect(sql).toContain("current_setting('app.community_id')");
      expect(sql).toContain("is_minor = false");
    }
  });

  it("setPersonStatus: a stale version with a different status throws conflict and leaves the row unchanged", async () => {
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
            const adult = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Adult",
              familyName: "Contact",
              email: "adult@example.com",
              phone: "+61411111111",
              actorUserId: null,
            });

            await expect(
              setPersonStatus(tx, {
                personId: adult.personId,
                version: 2,
                status: "inactive",
                actorUserId: null,
              }),
            ).rejects.toMatchObject({ code: "conflict" });

            const rows = await tx<{ status: string; version: number }[]>`
              select status, version from app.persons where id = ${adult.personId}::uuid
            `;
            expect(rows[0]).toEqual({ status: "active", version: 1 });

            const audits = await tx<{ id: string }[]>`
              select id::text as id from app.audit_events
              where org_id = ${scope.orgId}::uuid and action = 'people.person.status_changed'
            `;
            expect(audits.length).toBe(0);
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

  it("setPersonStatus: a change bumps version and appends status_changed with the person id only", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const adult = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Adult",
              familyName: "Contact",
              email: "adult@example.com",
              phone: "+61411111111",
              actorUserId: null,
            });

            const res = await setPersonStatus(tx, {
              personId: adult.personId,
              version: 1,
              status: "inactive",
              actorUserId,
            });
            expect(res).toEqual({ version: 2, status: "inactive" });

            const rows = await tx<{ status: string; version: number }[]>`
              select status, version from app.persons where id = ${adult.personId}::uuid
            `;
            expect(rows[0]).toEqual({ status: "inactive", version: 2 });

            const audits = await tx<
              {
                action: string;
                purpose: string;
                actor_kind: string;
                actor_id: string;
                target_ids: string[];
              }[]
            >`
              select
                action,
                purpose,
                actor_kind,
                actor_id::text as actor_id,
                target_ids::text[] as target_ids
              from app.audit_events
              where org_id = ${scope.orgId}::uuid and action = 'people.person.status_changed'
            `;
            expect(audits.length).toBe(1);
            expect(audits[0]).toEqual({
              action: "people.person.status_changed",
              purpose: "people.person.status_changed",
              actor_kind: "user",
              actor_id: actorUserId,
              target_ids: [adult.personId],
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

  it("setPersonStatus: the stored status with a current version bumps nothing and audits nothing", async () => {
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
            const adult = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Adult",
              familyName: "Contact",
              email: "adult@example.com",
              phone: "+61411111111",
              actorUserId: null,
            });

            const res = await setPersonStatus(tx, {
              personId: adult.personId,
              version: 1,
              status: "active",
              actorUserId: null,
            });
            expect(res).toEqual({ version: 1, status: "active" });

            const rows = await tx<{ status: string; version: number }[]>`
              select status, version from app.persons where id = ${adult.personId}::uuid
            `;
            expect(rows[0]).toEqual({ status: "active", version: 1 });

            const audits = await tx<{ id: string }[]>`
              select id::text as id from app.audit_events
              where org_id = ${scope.orgId}::uuid and action = 'people.person.status_changed'
            `;
            expect(audits.length).toBe(0);
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

  it("setPersonStatus: a stale version with the status unchanged throws conflict", async () => {
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
            const adult = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Adult",
              familyName: "Contact",
              email: "adult@example.com",
              phone: "+61411111111",
              actorUserId: null,
            });

            await expect(
              setPersonStatus(tx, {
                personId: adult.personId,
                version: 999,
                status: "active",
                actorUserId: null,
              }),
            ).rejects.toMatchObject({ code: "conflict" });

            const rows = await tx<{ status: string; version: number }[]>`
              select status, version from app.persons where id = ${adult.personId}::uuid
            `;
            expect(rows[0]).toEqual({ status: "active", version: 1 });
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

  it("setPersonStatus: an unknown id throws not_found", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);

    try {
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await expect(
              setPersonStatus(tx, {
                personId: newId(),
                version: 1,
                status: "inactive",
                actorUserId: null,
              }),
            ).rejects.toMatchObject({ code: "not_found" });
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

  it("setPersonStatus: an id in another organisation throws not_found", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scopeA = await createScope(platform);
    const scopeB = await createScope(platform);

    try {
      let adultId = "";
      await withAppTransaction(
        app,
        { orgId: scopeA.orgId, communityId: scopeA.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const adult = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AdultA",
              familyName: "ContactA",
              email: "adulta@example.com",
              phone: "+61411111111",
              actorUserId: null,
            });
            adultId = adult.personId;
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scopeB.orgId, communityId: scopeB.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await expect(
              setPersonStatus(tx, {
                personId: adultId,
                version: 1,
                status: "inactive",
                actorUserId: null,
              }),
            ).rejects.toMatchObject({ code: "not_found" });
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

  it("setPersonStatus: an id in another community of the same organisation throws not_found", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const community2Id = await createCommunityInOrg(platform, scope.orgId);

    try {
      let adultId = "";
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const adult = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Adult1",
              familyName: "Contact1",
              email: "adult1@example.com",
              phone: "+61411111111",
              actorUserId: null,
            });
            adultId = adult.personId;
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: community2Id },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await expect(
              setPersonStatus(tx, {
                personId: adultId,
                version: 1,
                status: "inactive",
                actorUserId: null,
              }),
            ).rejects.toMatchObject({ code: "not_found" });
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
});
