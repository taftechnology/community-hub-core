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

import { createHousehold, createPerson, listPersons, PeopleError } from "../public/index.js";

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

  it("minors mode pages by id, resolves names with includeRestricted, and audits (pin 7)", async () => {
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
            // 1. Minors mode without includeRestricted: names blank
            const resBlank = await listPersons(tx, kms, KEY_ARN, {
              kind: "minors",
              includeRestricted: false,
              actorUserId,
            });
            expect(resBlank.items).toHaveLength(2);
            expect(resBlank.items.every((it) => it.isMinor)).toBe(true);
            expect(resBlank.items.every((it) => it.givenName === "" && it.familyName === "")).toBe(
              true,
            );

            // 2. Minors mode with includeRestricted: names decrypted
            const resDecrypted = await listPersons(tx, kms, KEY_ARN, {
              kind: "minors",
              includeRestricted: true,
              actorUserId,
            });
            expect(resDecrypted.items).toHaveLength(2);
            expect(resDecrypted.items[0]?.version).toBe(1);
            expect(resDecrypted.items[1]?.version).toBe(1);
            const names = resDecrypted.items.map((it) => `${it.givenName} ${it.familyName}`);
            expect(names).toContain("ChildOne MinorFamily");
            expect(names).toContain("ChildTwo MinorFamily");

            // 3. Minors mode keyset paging by id
            const page1 = await listPersons(tx, kms, KEY_ARN, {
              kind: "minors",
              limit: 1,
              includeRestricted: true,
              actorUserId,
            });
            expect(page1.items).toHaveLength(1);
            expect(page1.nextCursor).not.toBeNull();

            const page2 = await listPersons(tx, kms, KEY_ARN, {
              kind: "minors",
              limit: 1,
              cursor: page1.nextCursor,
              includeRestricted: true,
              actorUserId,
            });
            expect(page2.items).toHaveLength(1);
            expect(page2.nextCursor).toBeNull();
            expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
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

      // Check that people.person.read was recorded by readRosterNames on decrypt
      const readEvents = auditRows.filter((r) => r.action === "people.person.read");
      expect(readEvents.length).toBeGreaterThanOrEqual(1);
      for (const ev of readEvents) {
        expect(ev.purpose).toBe("people.person.read");
        expect(Array.isArray(ev.target_ids)).toBe(true);
        expect(ev.target_ids.length).toBeGreaterThan(0);
      }
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
});
