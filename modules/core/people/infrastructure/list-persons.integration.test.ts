import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import type { KmsPort } from "@community-hub/crypto";
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

import { createHousehold, createPerson, listPersons, PeopleError } from "../public/index.js";
import type { PersonSource } from "../domain/person.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);
const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "list-persons.ts");

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

function createCountingKms(inner: KmsPort): { kms: KmsPort; decryptCalls: () => number } {
  let count = 0;
  return {
    kms: {
      async generateDataKey(keyId, context) {
        return inner.generateDataKey(keyId, context);
      },
      async decrypt(keyId, blob, context) {
        count += 1;
        return inner.decrypt(keyId, blob, context);
      },
    },
    decryptCalls: () => count,
  };
}

describe("listPersons", () => {
  it("adult list excludes minors in SQL (pin 1)", async () => {
    const source = readFileSync(SOURCE, "utf8");
    expect(source).toMatch(/is_minor\s*=\s*false/i);

    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let adult1Id = "";
      let adult2Id = "";
      let minor1Id = "";
      let minor2Id = "";

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const hh = await createHousehold(tx, kms, KEY_ARN, {
              now: NOW,
              label: "Smith Family",
              actorUserId,
            });

            const a1 = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: hh.householdId,
              dateOfBirth: null,
              givenName: "John",
              familyName: "Smith",
              email: "john.smith@example.com",
              phone: "+61411111111",
              actorUserId,
            });
            adult1Id = a1.personId;

            const a2 = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: hh.householdId,
              dateOfBirth: null,
              givenName: "Jane",
              familyName: "Smith",
              email: "jane.smith@example.com",
              phone: "+61422222222",
              actorUserId,
            });
            adult2Id = a2.personId;

            const m1 = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: false,
              householdId: hh.householdId,
              dateOfBirth: "2018-01-01",
              givenName: "Tommy",
              familyName: "Smith",
              email: null,
              phone: null,
              actorUserId,
            });
            minor1Id = m1.personId;

            const m2 = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: false,
              householdId: hh.householdId,
              dateOfBirth: "2020-05-05",
              givenName: "Lucy",
              familyName: "Smith",
              email: null,
              phone: null,
              actorUserId,
            });
            minor2Id = m2.personId;
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            // Adults list with no search
            const res = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              actorUserId,
            });

            expect(res.items).toHaveLength(2);
            const returnedIds = res.items.map((it) => it.id);
            expect(returnedIds).toContain(adult1Id);
            expect(returnedIds).toContain(adult2Id);
            expect(returnedIds).not.toContain(minor1Id);
            expect(returnedIds).not.toContain(minor2Id);
            expect(res.items[0]?.version).toBe(1);
            expect(res.items[1]?.version).toBe(1);

            // Adults list with search matching the shared household name "Smith"
            const resSearch = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              search: "Smith",
              actorUserId,
            });
            expect(resSearch.items).toHaveLength(2);
            const searchIds = resSearch.items.map((it) => it.id);
            expect(searchIds).not.toContain(minor1Id);
            expect(searchIds).not.toContain(minor2Id);

            // Adults list with search for minor's given name "Tommy"
            const resTommy = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              search: "Tommy",
              actorUserId,
            });
            expect(resTommy.items).toHaveLength(0);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("enforces organisation and community scope on list (pin 10)", async () => {
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
      let a1Id = "";
      let a2Id = "";
      let b1Id = "";

      // Scope A comm 1
      await withAppTransaction(
        app,
        { orgId: scopeA.orgId, communityId: scopeA.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const a = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Person",
              familyName: "CommA1",
              email: "comma1@example.com",
              phone: "+61400000001",
              actorUserId,
            });
            a1Id = a.personId;
          });
        },
      );

      // Scope A comm 2
      await withAppTransaction(app, { orgId: scopeA.orgId, communityId: commA2 }, async (tx) => {
        await withRequest({ requestId: REQUEST_ID }, async () => {
          const a = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Person",
            familyName: "CommA2",
            email: "comma2@example.com",
            phone: "+61400000002",
            actorUserId,
          });
          a2Id = a.personId;
        });
      });

      // Scope B comm 1
      await withAppTransaction(
        app,
        { orgId: scopeB.orgId, communityId: scopeB.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const b = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Person",
              familyName: "OrgB",
              email: "orgb@example.com",
              phone: "+61400000003",
              actorUserId,
            });
            b1Id = b.personId;
          });
        },
      );

      // Query from Scope A comm 1: must only see a1Id
      await withAppTransaction(
        app,
        { orgId: scopeA.orgId, communityId: scopeA.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              actorUserId,
            });
            const ids = res.items.map((it) => it.id);
            expect(ids).toContain(a1Id);
            expect(ids).not.toContain(a2Id);
            expect(ids).not.toContain(b1Id);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scopeA);
      await cleanScope(directSql, scopeB);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("pages adults across three pages in (family_name, given_name, id) keyset order", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      const createdNames: { given: string; family: string; id: string }[] = [];

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const names = [
              { given: "Charlie", family: "Adams" },
              { given: "Alice", family: "Baker" },
              { given: "Bob", family: "Baker" },
              { given: "David", family: "Clark" },
              { given: "Edward", family: "Davis" },
            ];

            for (let i = 0; i < names.length; i += 1) {
              const n = names[i]!;
              const p = await createPerson(tx, kms, KEY_ARN, {
                now: NOW,
                declaredAdult: true,
                householdId: null,
                dateOfBirth: null,
                givenName: n.given,
                familyName: n.family,
                email: `person${i}@example.com`,
                phone: `+6140000001${i}`,
                actorUserId,
              });
              createdNames.push({ given: n.given, family: n.family, id: p.personId });
            }
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            // Page 1: limit 2
            const p1 = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              limit: 2,
              actorUserId,
            });
            expect(p1.items).toHaveLength(2);
            expect(p1.items[0]!.familyName).toBe("Adams");
            expect(p1.items[1]!.familyName).toBe("Baker");
            expect(p1.items[1]!.givenName).toBe("Alice");
            expect(p1.nextCursor).not.toBeNull();

            // Page 2: limit 2 with cursor
            const p2 = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              limit: 2,
              cursor: p1.nextCursor,
              actorUserId,
            });
            expect(p2.items).toHaveLength(2);
            expect(p2.items[0]!.familyName).toBe("Baker");
            expect(p2.items[0]!.givenName).toBe("Bob");
            expect(p2.items[1]!.familyName).toBe("Clark");
            expect(p2.nextCursor).not.toBeNull();

            // Page 3: limit 2 with cursor
            const p3 = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              limit: 2,
              cursor: p2.nextCursor,
              actorUserId,
            });
            expect(p3.items).toHaveLength(1);
            expect(p3.items[0]!.familyName).toBe("Davis");
            expect(p3.nextCursor).toBeNull();
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("validates page size bounds (1–100, default 50)", async () => {
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
            await expect(listPersons(tx, kms, KEY_ARN, { limit: 0, actorUserId })).rejects.toThrow(
              PeopleError,
            );

            await expect(listPersons(tx, kms, KEY_ARN, { limit: -1, actorUserId })).rejects.toThrow(
              PeopleError,
            );

            await expect(
              listPersons(tx, kms, KEY_ARN, { limit: 101, actorUserId }),
            ).rejects.toThrow(PeopleError);

            await expect(
              listPersons(tx, kms, KEY_ARN, { limit: 1.5 as number, actorUserId }),
            ).rejects.toThrow(PeopleError);

            // default limit 50 succeeds
            const res = await listPersons(tx, kms, KEY_ARN, { actorUserId });
            expect(res.items).toBeDefined();
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("performs case-insensitive prefix search and escapes LIKE specials on adults", async () => {
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
            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Alice",
              familyName: "Smith",
              email: "alice@example.com",
              phone: "+61400000021",
              actorUserId,
            });

            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Bob",
              familyName: "Albertson",
              email: "bob@example.com",
              phone: "+61400000022",
              actorUserId,
            });

            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Special%Name",
              familyName: "Wildcard",
              email: "special@example.com",
              phone: "+61400000023",
              actorUserId,
            });
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            // Search "al" (matches given Alice and family Albertson)
            const res = await listPersons(tx, kms, KEY_ARN, {
              search: "al",
              actorUserId,
            });
            expect(res.items).toHaveLength(2);

            // Case-insensitive "AL"
            const resUpper = await listPersons(tx, kms, KEY_ARN, {
              search: "AL",
              actorUserId,
            });
            expect(resUpper.items).toHaveLength(2);

            // Searching with % escaped
            const resSpecial = await listPersons(tx, kms, KEY_ARN, {
              search: "Special%",
              actorUserId,
            });
            expect(resSpecial.items).toHaveLength(1);
            expect(resSpecial.items[0]!.givenName).toBe("Special%Name");
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("performs exact blind-index search on email and phone without echoing search term", async () => {
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
            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Target",
              familyName: "Contact",
              email: "target.contact@example.com",
              phone: "+61412345678",
              actorUserId,
            });
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            // Exact email match
            const emailRes = await listPersons(tx, kms, KEY_ARN, {
              search: "target.contact@example.com",
              actorUserId,
            });
            expect(emailRes.items).toHaveLength(1);
            expect(emailRes.items[0]!.givenName).toBe("Target");

            // Incomplete email returns 0 results
            const partialEmailRes = await listPersons(tx, kms, KEY_ARN, {
              search: "target.contact@",
              actorUserId,
            });
            expect(partialEmailRes.items).toHaveLength(0);

            // Exact phone match (formatted)
            const phoneRes = await listPersons(tx, kms, KEY_ARN, {
              search: "+61 412 345 678",
              actorUserId,
            });
            expect(phoneRes.items).toHaveLength(1);
            expect(phoneRes.items[0]!.givenName).toBe("Target");

            // Incomplete phone digits return 0 results
            const partialPhoneRes = await listPersons(tx, kms, KEY_ARN, {
              search: "12345",
              actorUserId,
            });
            expect(partialPhoneRes.items).toHaveLength(0);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("minors mode pages by id, returns labels and no names, and audits (pin 7)", async () => {
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
            const hh = await createHousehold(tx, kms, KEY_ARN, {
              now: NOW,
              label: "Minor Household",
              actorUserId,
            });

            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: false,
              householdId: hh.householdId,
              dateOfBirth: "2015-06-15",
              givenName: "ChildOne",
              familyName: "MinorFamily",
              email: null,
              phone: null,
              actorUserId,
            });

            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: false,
              householdId: hh.householdId,
              dateOfBirth: "2017-08-20",
              givenName: "ChildTwo",
              familyName: "MinorFamily",
              email: null,
              phone: null,
              actorUserId,
            });
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            // 1. Minors mode without childView "admin" throws invalid_input with no audit row (Deviation 7)
            await expect(
              listPersons(tx, kms, KEY_ARN, {
                kind: "minors",
                childView: "presence",
                actorUserId,
              }),
            ).rejects.toMatchObject({ code: "invalid_input" });

            await expect(
              listPersons(tx, kms, KEY_ARN, {
                kind: "minors",
                actorUserId,
              } as never),
            ).rejects.toMatchObject({ code: "invalid_input" });

            const auditsBefore = await tx<{ n: number }[]>`
              select count(*)::int as n
              from app.audit_events
              where action = 'people.person.listed_minors'
            `;
            expect(auditsBefore).toEqual([{ n: 0 }]);

            // 2. Minors mode with childView "admin": labels, no names
            const resLabelled = await listPersons(tx, kms, KEY_ARN, {
              kind: "minors",
              childView: "admin",
              actorUserId,
            });
            expect(resLabelled.items).toHaveLength(2);
            expect(resLabelled.items.map((it) => it.label).sort()).toEqual(["Child 1", "Child 2"]);
            expect(resLabelled.items.every((it) => it.householdLabel === "Minor Household")).toBe(
              true,
            );
            for (const forbidden of ["ChildOne", "ChildTwo", "MinorFamily"]) {
              expect(JSON.stringify(resLabelled)).not.toContain(forbidden);
            }

            // 3. Minors mode keyset paging by id
            const page1 = await listPersons(tx, kms, KEY_ARN, {
              kind: "minors",
              limit: 1,
              childView: "admin",
              actorUserId,
            });
            expect(page1.items).toHaveLength(1);
            expect(page1.nextCursor).not.toBeNull();

            const page2 = await listPersons(tx, kms, KEY_ARN, {
              kind: "minors",
              limit: 1,
              cursor: page1.nextCursor,
              childView: "admin",
              actorUserId,
            });
            expect(page2.items).toHaveLength(1);
            expect(page2.nextCursor).toBeNull();
            expect(page2.items[0]!.personId).not.toBe(page1.items[0]!.personId);
          });
        },
      );

      // Pin 7: Verify audit rows
      const auditRows = await directSql<
        {
          action: string;
          purpose: string;
          target_ids: string[];
        }[]
      >`
        select action, purpose, target_ids
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and action in ('people.person.listed_minors', 'people.person.read')
        order by occurred_at asc
      `;

      // Check that people.person.listed_minors was recorded
      const listedMinorsEvents = auditRows.filter(
        (r) => r.action === "people.person.listed_minors",
      );
      expect(listedMinorsEvents.length).toBeGreaterThanOrEqual(1);
      for (const ev of listedMinorsEvents) {
        expect(ev.purpose).toBe("people.person.listed_minors");
        expect(Array.isArray(ev.target_ids)).toBe(true);
      }

      // Nothing of a child is decrypted any more, so no people.person.read event is written
      const readEvents = auditRows.filter((r) => r.action === "people.person.read");
      expect(readEvents).toHaveLength(0);
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects invalid input", async () => {
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
            // invalid actorUserId
            await expect(
              listPersons(tx, kms, KEY_ARN, { actorUserId: "not-a-uuid" }),
            ).rejects.toThrow(PeopleError);

            // invalid cursor
            await expect(
              listPersons(tx, kms, KEY_ARN, {
                actorUserId: newId(),
                cursor: "invalid-base64-garbage!!",
              }),
            ).rejects.toThrow(PeopleError);

            // invalid kind
            await expect(
              listPersons(tx, kms, KEY_ARN, {
                actorUserId: newId(),
                kind: "aliens" as never,
              }),
            ).rejects.toThrow(PeopleError);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("propagates KMS errors during email and phone search instead of returning empty results (finding 8)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const actorUserId = newId();

    const localKms = createLocalKmsPort();
    await withAppTransaction(
      app,
      { orgId: scope.orgId, communityId: scope.communityId },
      async (tx) => {
        await withRequest({ requestId: REQUEST_ID }, async () => {
          await createPerson(tx, localKms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Seed",
            familyName: "Person",
            email: "seed@example.test",
            phone: "+61412555000",
            actorUserId,
          });
        });
      },
    );

    const failingKms: KmsPort = {
      async decrypt() {
        throw new Error("kms_outage");
      },
      async generateDataKey() {
        throw new Error("kms_outage");
      },
    };

    try {
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            // Email search with failing KMS propagates error
            await expect(
              listPersons(tx, failingKms, KEY_ARN, {
                kind: "adults",
                search: "search@example.com",
                actorUserId,
              }),
            ).rejects.toThrow("kms_outage");

            // Phone search with failing KMS propagates error
            await expect(
              listPersons(tx, failingKms, KEY_ARN, {
                kind: "adults",
                search: "+61412345678",
                actorUserId,
              }),
            ).rejects.toThrow("kms_outage");
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: a minor in the filtered group never appears", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let adultId = "";
      let minorId = "";
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const hh = await createHousehold(tx, kms, KEY_ARN, {
              now: NOW,
              label: "Pin17 Family",
              actorUserId,
            });
            const adult = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: hh.householdId,
              dateOfBirth: null,
              givenName: "AdultSeventeen",
              familyName: "Person",
              email: "adult17@example.test",
              phone: "+61412555017",
              actorUserId,
            });
            adultId = adult.personId;

            const minor = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: false,
              householdId: hh.householdId,
              dateOfBirth: null,
              givenName: "MinorSeventeen",
              familyName: "Person",
              email: null,
              phone: null,
              actorUserId,
            });
            minorId = minor.personId;
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              personIds: [adultId, minorId],
              actorUserId,
            });
            expect(res.items).toHaveLength(1);
            expect(res.items[0]?.id).toBe(adultId);
            expect(res.items[0]?.givenName).toBe("AdultSeventeen");
            expect(res.items.map((i) => i.givenName)).toEqual(["AdultSeventeen"]);
            expect(res.items.some((i) => i.id === minorId)).toBe(false);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: a non-empty adult page appends one listed event with the page ids only", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let a1Id = "";
      let a2Id = "";
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const a1 = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AuditOne",
              familyName: "Person",
              email: "audit1@example.test",
              phone: "+61412555018",
              actorUserId,
            });
            a1Id = a1.personId;

            const a2 = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AuditTwo",
              familyName: "Person",
              email: "audit2@example.test",
              phone: "+61412555019",
              actorUserId,
            });
            a2Id = a2.personId;
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              actorUserId,
            });
            expect(res.items.length).toBeGreaterThanOrEqual(2);

            const events = await tx<
              {
                action: string;
                purpose: string;
                actor_id: string;
                actor_kind: string;
                target_ids: string[];
              }[]
            >`
              select action, purpose, actor_id::text as actor_id, actor_kind, target_ids::text[] as target_ids
              from app.audit_events
              where org_id = ${scope.orgId}::uuid
                and action = 'people.person.listed'
            `;
            expect(events).toHaveLength(1);
            expect(events[0]?.purpose).toBe("people.person.listed");
            expect(events[0]?.actor_id).toBe(actorUserId);
            expect(events[0]?.actor_kind).toBe("user");
            expect(events[0]?.target_ids.sort()).toEqual([a1Id, a2Id].sort());
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: an email search page with contact details makes one KMS Decrypt", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const baseKms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await createPerson(tx, baseKms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "SearchKms",
              familyName: "Person",
              email: "search19@example.test",
              phone: "+61412555119",
              actorUserId,
            });
          });
        },
      );

      const countingKms = createCountingKms(baseKms);
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, countingKms.kms, KEY_ARN, {
              kind: "adults",
              search: "search19@example.test",
              actorUserId,
            });
            expect(res.items).toHaveLength(1);
            const itm = res.items[0];
            if (!itm || itm.isMinor) {
              throw new Error("expected adult item");
            }
            expect(itm.email).toBe("search19@example.test");
            expect(countingKms.decryptCalls()).toBe(1);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: a page of two adults with contact details makes one KMS Decrypt", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const baseKms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await createPerson(tx, baseKms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "TwoAdultsOne",
              familyName: "Person",
              email: "two1@example.test",
              phone: "+61412555121",
              actorUserId,
            });
            await createPerson(tx, baseKms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "TwoAdultsTwo",
              familyName: "Person",
              email: "two2@example.test",
              phone: "+61412555122",
              actorUserId,
            });
          });
        },
      );

      const countingKms = createCountingKms(baseKms);
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, countingKms.kms, KEY_ARN, {
              kind: "adults",
              actorUserId,
            });
            expect(res.items).toHaveLength(2);
            expect(countingKms.decryptCalls()).toBe(1);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: an email search in a community with no key rows returns an empty page, creates no key rows and makes no KMS call", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const baseKms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      const countingKms = createCountingKms(baseKms);
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, countingKms.kms, KEY_ARN, {
              kind: "adults",
              search: "nobody@example.test",
              actorUserId,
            });
            expect(res.items).toEqual([]);
            expect(res.nextCursor).toBeNull();
            expect(countingKms.decryptCalls()).toBe(0);

            const commKeys = await tx<{ id: string }[]>`
              select id::text as id
              from app.community_keys
              where community_id = ${scope.communityId}::uuid
            `;
            expect(commKeys).toHaveLength(0);

            const orgKeys = await tx<{ id: string }[]>`
              select id::text as id
              from app.organisation_keys
              where org_id = ${scope.orgId}::uuid
            `;
            expect(orgKeys).toHaveLength(0);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: a tampered email ciphertext fails the request", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

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
              givenName: "TamperEmail",
              familyName: "Person",
              email: "tamper21@example.test",
              phone: null,
              actorUserId,
            });
            adultId = adult.personId;

            const rows = await tx<{ email: Uint8Array | null }[]>`
              select email from app.persons where id = ${adultId}::uuid
            `;
            const row = rows[0];
            if (!row || !row.email) {
              throw new Error("expected email ciphertext");
            }
            const tampered = new Uint8Array(row.email);
            const firstByte = tampered[0];
            if (firstByte === undefined) {
              throw new Error("expected non-empty ciphertext");
            }
            tampered[0] = firstByte ^ 0xff;
            await tx`
              update app.persons set email = ${tampered} where id = ${adultId}::uuid
            `;
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await expect(
              listPersons(tx, kms, KEY_ARN, {
                kind: "adults",
                actorUserId,
              }),
            ).rejects.toThrow();
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: an adult item has exactly the expected keys", async () => {
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
            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: "1988-08-08",
              givenName: "ExactKeysAdult",
              familyName: "Person",
              email: "keys25@example.test",
              phone: "+61412555125",
              actorUserId,
            });
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              actorUserId,
            });
            expect(res.items).toHaveLength(1);
            const item = res.items[0]!;
            const expectedKeys = [
              "age",
              "createdAt",
              "email",
              "familyName",
              "givenName",
              "id",
              "isMinor",
              "personId",
              "phone",
              "source",
              "status",
              "version",
            ].sort();
            expect(Object.keys(item).sort()).toEqual(expectedKeys);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: a minor item has exactly the label keys", async () => {
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
            const hh = await createHousehold(tx, kms, KEY_ARN, {
              now: NOW,
              label: "MinorKeys Family",
              actorUserId,
            });
            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: false,
              householdId: hh.householdId,
              dateOfBirth: "2018-01-01",
              givenName: "ExactKeysMinor",
              familyName: "Person",
              email: null,
              phone: null,
              actorUserId,
            });
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, kms, KEY_ARN, {
              kind: "minors",
              childView: "admin",
              actorUserId,
            });
            expect(res.items).toHaveLength(1);
            const item = res.items[0]!;
            const expectedKeys = ["householdId", "householdLabel", "label", "personId"].sort();
            expect(Object.keys(item).sort()).toEqual(expectedKeys);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: an empty personIds returns an empty page and makes no query", async () => {
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
            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "EmptyFilterAdult",
              familyName: "Person",
              email: "empty42@example.test",
              phone: null,
              actorUserId,
            });
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              personIds: [],
              actorUserId,
            });
            expect(res.items).toEqual([]);
            expect(res.nextCursor).toBeNull();
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: filters by status, by source, by personIds and combines them with search", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let a1Id = "";
      let a2Id = "";
      let a3Id = "";
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const a1 = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AlphaOne",
              familyName: "Person",
              email: "alpha1@example.test",
              phone: "+61412555201",
              actorUserId,
              source: "manual",
            });
            a1Id = a1.personId;

            const a2 = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "BetaTwo",
              familyName: "Person",
              email: "beta2@example.test",
              phone: "+61412555202",
              actorUserId,
              source: "manual",
            });
            a2Id = a2.personId;
            // update a2 to inactive
            await tx`update app.persons set status = 'inactive' where id = ${a2Id}::uuid`;

            const a3 = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "GammaThree",
              familyName: "Person",
              email: "gamma3@example.test",
              phone: "+61412555203",
              actorUserId,
              source: "family_records",
            });
            a3Id = a3.personId;
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            // Filter by status inactive
            const resInactive = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              status: "inactive",
              actorUserId,
            });
            expect(resInactive.items.map((i) => i.id)).toEqual([a2Id]);

            // Filter by source family_records
            const resSource = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              source: "family_records",
              actorUserId,
            });
            expect(resSource.items.map((i) => i.id)).toEqual([a3Id]);

            // Filter by personIds [a1Id, a2Id]
            const resIds = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              personIds: [a1Id, a2Id],
              actorUserId,
            });
            expect(resIds.items.map((i) => i.id).sort()).toEqual([a1Id, a2Id].sort());

            // Combine status: active, source: manual, search email
            const resCombined = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              status: "active",
              source: "manual",
              search: "alpha1@example.test",
              actorUserId,
            });
            expect(resCombined.items.map((i) => i.id)).toEqual([a1Id]);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: returns email, phone, age, createdAt, status and source for adults", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      const createdNow = new Date("2026-06-01T12:00:00.000Z");
      const listNow = new Date("2026-11-20T12:00:00.000Z");
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await createPerson(tx, kms, KEY_ARN, {
              now: createdNow,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: "1990-05-15",
              givenName: "FullDetails",
              familyName: "Person",
              email: "details@example.test",
              phone: "+61412555190",
              actorUserId,
              source: "family_records",
            });
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              now: listNow,
              actorUserId,
            });
            expect(res.items).toHaveLength(1);
            const itm = res.items[0];
            if (!itm || itm.isMinor) {
              throw new Error("expected adult item");
            }
            expect(itm.email).toBe("details@example.test");
            expect(itm.phone).toBe("61412555190");
            expect(itm.age).toBe(36);
            expect(itm.status).toBe("active");
            expect(itm.source).toBe("family_records");
            expect(typeof itm.createdAt).toBe("string");
            expect(itm.createdAt).toBe(createdNow.toISOString());
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: an empty page appends no audit and makes no KMS call", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const baseKms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      const countingKms = createCountingKms(baseKms);
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, countingKms.kms, KEY_ARN, {
              kind: "adults",
              actorUserId,
            });
            expect(res.items).toHaveLength(0);
            expect(countingKms.decryptCalls()).toBe(0);

            const events = await tx<{ id: string }[]>`
              select id::text as id
              from app.audit_events
              where org_id = ${scope.orgId}::uuid
                and action = 'people.person.listed'
            `;
            expect(events).toHaveLength(0);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: the minors list carries no field of a child", async () => {
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
            const hh = await createHousehold(tx, kms, KEY_ARN, {
              now: NOW,
              label: "UnchangedMinor Family",
              actorUserId,
            });
            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: false,
              householdId: hh.householdId,
              dateOfBirth: "2018-01-01",
              givenName: "UnchangedMinor",
              familyName: "Person",
              email: null,
              phone: null,
              actorUserId,
            });
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, kms, KEY_ARN, {
              kind: "minors",
              childView: "admin",
              actorUserId,
            });
            expect(res.items).toHaveLength(1);
            const itm = res.items[0]!;
            expect(itm.label).toBe("Child 1");
            for (const field of [
              "isMinor",
              "id",
              "givenName",
              "familyName",
              "version",
              "email",
              "phone",
              "dateOfBirth",
              "age",
              "createdAt",
              "status",
              "source",
            ]) {
              expect(itm).not.toHaveProperty(field);
            }
            // The family label (set above) names the child; the item itself must not.
            expect(JSON.stringify({ ...itm, householdLabel: null })).not.toContain(
              "UnchangedMinor",
            );

            const events = await tx<{ id: string }[]>`
              select id::text as id
              from app.audit_events
              where org_id = ${scope.orgId}::uuid
                and action = 'people.person.listed_minors'
            `;
            expect(events.length).toBeGreaterThanOrEqual(1);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: a page smaller than the community audits exactly the returned ids", async () => {
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
            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AuditA",
              familyName: "Person",
              email: null,
              phone: null,
              actorUserId,
            });

            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AuditB",
              familyName: "Person",
              email: null,
              phone: null,
              actorUserId,
            });

            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "AuditC",
              familyName: "Person",
              email: null,
              phone: null,
              actorUserId,
            });
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              limit: 2,
              actorUserId,
            });
            expect(res.items).toHaveLength(2);
            const expectedIds = res.items.map((i) => i.id);

            const events = await tx<
              {
                action: string;
                purpose: string;
                actor_id: string;
                actor_kind: string;
                target_ids: string[];
              }[]
            >`
              select action, purpose, actor_id::text as actor_id, actor_kind, target_ids::text[] as target_ids
              from app.audit_events
              where org_id = ${scope.orgId}::uuid
                and action = 'people.person.listed'
            `;
            expect(events).toHaveLength(1);
            expect(events[0]?.target_ids).toEqual(expectedIds);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: an email or phone search in a keyless community with a name-only adult returns an empty page", async () => {
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
          await tx`
            insert into app.persons (
              id, org_id, community_id, is_minor, age_basis,
              given_name, family_name, version, status, source
            ) values (
              ${newId()}::uuid,
              ${scope.orgId}::uuid,
              ${scope.communityId}::uuid,
              false,
              'declared_adult',
              'NameOnlyKeyless',
              'Person',
              1,
              'active',
              'manual'
            )
          `;
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const resEmail = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              search: "nobody@example.test",
              actorUserId,
            });
            expect(resEmail.items).toEqual([]);

            const resPhone = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              search: "+61412555999",
              actorUserId,
            });
            expect(resPhone.items).toEqual([]);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: a search in a keyless community of an organisation that has a key returns an empty page", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const baseKms = createLocalKmsPort();
    const scope = await createScope(platform);
    const commKeyless = await createCommunityInOrg(platform, scope.orgId);
    const actorUserId = newId();

    try {
      // Seed organisation key via community 1
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await createPerson(tx, baseKms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "KeyHolder",
              familyName: "Person",
              email: "orgkey@example.test",
              phone: null,
              actorUserId,
            });
          });
        },
      );

      const countingKms = createCountingKms(baseKms);
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: commKeyless },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, countingKms.kms, KEY_ARN, {
              kind: "adults",
              search: "orgkey@example.test",
              actorUserId,
            });
            expect(res.items).toEqual([]);
            expect(res.nextCursor).toBeNull();
            expect(countingKms.decryptCalls()).toBe(0);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: a page of name-only adults makes no KMS call and does not throw without keys", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const baseKms = createLocalKmsPort();
    const scopeWithKeys = await createScope(platform);
    const scopeKeyless = await createScope(platform);
    const actorUserId = newId();

    try {
      // 1. Community WITH keys: seed adult with email so keys exist, then delete that person
      await withAppTransaction(
        app,
        { orgId: scopeWithKeys.orgId, communityId: scopeWithKeys.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await createPerson(tx, baseKms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "KeyInit",
              familyName: "Person",
              email: "keyinit@example.test",
              phone: null,
              actorUserId,
            });
          });
        },
      );
      // Remove that person so only name-only adults will exist
      await directSql`delete from app.person_activity where org_id = ${scopeWithKeys.orgId}::uuid`;
      await directSql`delete from app.audit_events where org_id = ${scopeWithKeys.orgId}::uuid`;
      await directSql`delete from app.persons where org_id = ${scopeWithKeys.orgId}::uuid`;

      // Seed name-only adult in scopeWithKeys
      await withAppTransaction(
        app,
        { orgId: scopeWithKeys.orgId, communityId: scopeWithKeys.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await createPerson(tx, baseKms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "NameOnlyWithKeys",
              familyName: "Person",
              email: null,
              phone: null,
              actorUserId,
            });
          });
        },
      );

      // Seed name-only adult in scopeKeyless via direct SQL so no key rows exist
      await withAppTransaction(
        app,
        { orgId: scopeKeyless.orgId, communityId: scopeKeyless.communityId },
        async (tx) => {
          await tx`
            insert into app.persons (
              id, org_id, community_id, is_minor, age_basis,
              given_name, family_name, version, status, source
            ) values (
              ${newId()}::uuid,
              ${scopeKeyless.orgId}::uuid,
              ${scopeKeyless.communityId}::uuid,
              false,
              'declared_adult',
              'NameOnlyKeyless',
              'Person',
              1,
              'active',
              'manual'
            )
          `;
        },
      );

      // In community with keys: decryptCalls() === 0
      const countingKms = createCountingKms(baseKms);
      await withAppTransaction(
        app,
        { orgId: scopeWithKeys.orgId, communityId: scopeWithKeys.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, countingKms.kms, KEY_ARN, {
              kind: "adults",
              actorUserId,
            });
            expect(res.items).toHaveLength(1);
            expect(countingKms.decryptCalls()).toBe(0);
          });
        },
      );

      // In community without keys: does not throw
      await withAppTransaction(
        app,
        { orgId: scopeKeyless.orgId, communityId: scopeKeyless.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, baseKms, KEY_ARN, {
              kind: "adults",
              actorUserId,
            });
            expect(res.items).toHaveLength(1);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scopeWithKeys);
      await cleanScope(directSql, scopeKeyless);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: refuses a source outside PERSON_SOURCES with invalid_input", async () => {
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
            await expect(
              listPersons(tx, kms, KEY_ARN, {
                kind: "adults",
                actorUserId,
                source: "invalid_source" as unknown as PersonSource,
              }),
            ).rejects.toMatchObject({ code: "invalid_input" });
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: the adult list query filters by community_id explicitly", async () => {
    const sqlCalls: string[] = [];
    const stubTx = vi.fn((strings: TemplateStringsArray) => {
      sqlCalls.push(strings.join("?"));
      return Promise.resolve([]);
    }) as unknown as AppTransaction;

    const kms = createLocalKmsPort();
    await listPersons(stubTx, kms, KEY_ARN, {
      kind: "adults",
      actorUserId: newId(),
    });

    const selectCall = sqlCalls.find((sql) => sql.includes("from app.persons"));
    expect(selectCall).toBeDefined();
    expect(selectCall).toContain("current_setting('app.community_id')");
    expect(selectCall).toContain("current_setting('app.org_id')");
    expect(selectCall).toContain("is_minor = false");
  });

  it("listPersons: age is computed on the injected now, across a birthday", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      const createdNow = new Date("2026-01-01T12:00:00.000Z");
      // Choose DOB 1990-05-15 and injected listNow 2026-05-14 (day before birthday).
      // On 2026-05-14 the age is 35, whereas on today's real date (after May 15, 2026) the age is 36+.
      const listNow = new Date("2026-05-14T12:00:00.000Z");
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await createPerson(tx, kms, KEY_ARN, {
              now: createdNow,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: "1990-05-15",
              givenName: "BirthdayTest",
              familyName: "Person",
              email: "birthday@example.test",
              phone: null,
              actorUserId,
            });
          });
        },
      );

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const res = await listPersons(tx, kms, KEY_ARN, {
              kind: "adults",
              now: listNow,
              actorUserId,
            });
            expect(res.items).toHaveLength(1);
            const itm = res.items[0];
            if (!itm || itm.isMinor) {
              throw new Error("expected adult item");
            }
            expect(itm.age).toBe(35);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("listPersons: a community key row without an organisation key row gives no keys", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const baseKms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      // Seed a community key row directly, leaving organisation_keys completely empty
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await tx`
            insert into app.community_keys (
              id, org_id, community_id, wrapped, key_version, parent_key_id
            ) values (
              ${newId()}::uuid,
              ${scope.orgId}::uuid,
              ${scope.communityId}::uuid,
              ${Buffer.from("dummy-wrapped-bytes-for-test")}::bytea,
              '1',
              ${newId()}::uuid
            )
          `;
        },
      );

      const countingKms = createCountingKms(baseKms);
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            let listError: unknown = null;
            let res: Awaited<ReturnType<typeof listPersons>> | null = null;
            try {
              res = await listPersons(tx, countingKms.kms, KEY_ARN, {
                kind: "adults",
                search: "nobody@example.test",
                actorUserId,
              });
            } catch (err) {
              listError = err;
            }
            expect(listError).toBeNull();
            expect(res?.items).toEqual([]);
            expect(res?.nextCursor).toBeNull();
            expect(countingKms.decryptCalls()).toBe(0);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
