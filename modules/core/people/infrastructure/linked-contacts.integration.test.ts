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

import { createHousehold, createPerson } from "../public/index.js";
import { readLinkedContacts } from "./linked-contacts.js";

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
const NOW = new Date("2026-11-11T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

function createCountingKmsPort(base: KmsPort = createLocalKmsPort()) {
  let decryptCalls = 0;
  let generateDataKeyCalls = 0;
  return {
    get decryptCalls() {
      return decryptCalls;
    },
    get generateDataKeyCalls() {
      return generateDataKeyCalls;
    },
    resetCounts() {
      decryptCalls = 0;
      generateDataKeyCalls = 0;
    },
    async generateDataKey(keyId: string, context: Parameters<KmsPort["generateDataKey"]>[1]) {
      generateDataKeyCalls += 1;
      return base.generateDataKey(keyId, context);
    },
    async decrypt(keyId: string, blob: Uint8Array, context: Parameters<KmsPort["decrypt"]>[2]) {
      decryptCalls += 1;
      return base.decrypt(keyId, blob, context);
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

function recordTx(tx: AppTransaction, statementCollector: string[]): AppTransaction {
  return new Proxy(tx, {
    apply(target, thisArg, argArray) {
      const strings = argArray[0] as TemplateStringsArray;
      if (strings && Array.isArray(strings)) {
        const text = strings.reduce((acc, str, i) => acc + "$" + i + str);
        statementCollector.push(text);
      }
      return Reflect.apply(target, thisArg, argArray);
    },
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe("readLinkedContacts integration", () => {
  it("returns adult's given name, family name and phone", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createCountingKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let adultId = "";
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Morgan",
            familyName: "Finch",
            email: null,
            phone: "+61491570006",
            actorUserId,
          });
          adultId = adult.personId;
        });

        await withAppTransaction(app, scope, async (tx) => {
          const result = await readLinkedContacts(tx, kms, KEY_ARN, {
            personIds: [adultId],
            includePhone: true,
            actorUserId,
          });

          expect(result.size).toBe(1);
          expect(result.get(adultId)).toEqual({
            minor: false,
            given: "Morgan",
            family: "Finch",
            phone: "61491570006",
          });
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("returns minor: true only, with no name and no phone, and never touches household_keys", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createCountingKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let minorId = "";
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const household = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Finch",
            actorUserId,
          });
          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: null,
            givenName: "Child",
            familyName: "Finch",
            email: null,
            phone: "+61491570156",
            actorUserId,
          });
          minorId = minor.personId;
        });

        // Clear audit events from creation
        await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`;
        kms.resetCounts();

        const statements: string[] = [];
        await withAppTransaction(app, scope, async (tx) => {
          const wrappedTx = recordTx(tx, statements);
          const result = await readLinkedContacts(wrappedTx, kms, KEY_ARN, {
            personIds: [minorId],
            includePhone: true,
            actorUserId,
          });

          expect(result.size).toBe(1);
          expect(result.get(minorId)).toEqual({ minor: true });
        });

        expect(kms.decryptCalls).toBe(0);
        expect(kms.generateDataKeyCalls).toBe(0);

        expect(statements.length).toBeGreaterThan(0);
        for (const statement of statements) {
          expect(statement).not.toContain("household_keys");
        }

        const auditRows = await directSql<{ count: number }[]>`
          select count(*)::int as count
          from app.audit_events
          where action = 'people.person.read'
            and org_id = ${scope.orgId}::uuid
        `;
        expect(auditRows[0]?.count).toBe(0);
      });
    } finally {
      await cleanScope(directSql, scope);
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("includePhone: false makes zero KMS calls and writes no audit row", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createCountingKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let adultId = "";
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Robin",
            familyName: "Taylor",
            email: null,
            phone: "+61491570157",
            actorUserId,
          });
          adultId = adult.personId;
        });

        // Clear audit events from creation
        await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`;
        kms.resetCounts();

        await withAppTransaction(app, scope, async (tx) => {
          const result = await readLinkedContacts(tx, kms, KEY_ARN, {
            personIds: [adultId],
            includePhone: false,
            actorUserId,
          });

          expect(result.size).toBe(1);
          expect(result.get(adultId)).toEqual({
            minor: false,
            given: "Robin",
            family: "Taylor",
            phone: null,
          });
        });

        expect(kms.decryptCalls).toBe(0);
        expect(kms.generateDataKeyCalls).toBe(0);

        const auditRows = await directSql<{ count: number }[]>`
          select count(*)::int as count
          from app.audit_events
          where action = 'people.person.read'
            and org_id = ${scope.orgId}::uuid
        `;
        expect(auditRows[0]?.count).toBe(0);
      });
    } finally {
      await cleanScope(directSql, scope);
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("pin 6: with includePhone: true, exactly one people.person.read audit row is written for opened phones only, with no fixture data", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createCountingKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let adultWithPhoneId = "";
      let adultWithoutPhoneId = "";
      let minorId = "";

      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const adult1 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Avery",
            familyName: "Quill",
            email: null,
            phone: "+61491570158",
            actorUserId,
          });
          adultWithPhoneId = adult1.personId;

          const adult2 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Jordan",
            familyName: "River",
            email: null,
            phone: null,
            actorUserId,
          });
          adultWithoutPhoneId = adult2.personId;

          const household = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Quill",
            actorUserId,
          });
          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: null,
            givenName: "Young",
            familyName: "Quill",
            email: null,
            phone: "+61491570159",
            actorUserId,
          });
          minorId = minor.personId;
        });

        // 1. When no adult has a phone, no audit row is written
        await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`;
        await withAppTransaction(app, scope, async (tx) => {
          const result = await readLinkedContacts(tx, kms, KEY_ARN, {
            personIds: [adultWithoutPhoneId],
            includePhone: true,
            actorUserId,
          });
          expect(result.size).toBe(1);
          expect(result.get(adultWithoutPhoneId)?.minor).toBe(false);
        });

        const zeroAuditRows = await directSql<{ count: number }[]>`
          select count(*)::int as count
          from app.audit_events
          where action = 'people.person.read'
            and org_id = ${scope.orgId}::uuid
        `;
        expect(zeroAuditRows[0]?.count).toBe(0);

        // 2. When one adult has a phone and one does not: exactly one audit row written with target_ids = [adultWithPhoneId]
        await withAppTransaction(app, scope, async (tx) => {
          const result = await readLinkedContacts(tx, kms, KEY_ARN, {
            personIds: [adultWithPhoneId, adultWithoutPhoneId, minorId],
            includePhone: true,
            actorUserId,
          });
          expect(result.size).toBe(3);
          expect(result.get(minorId)).toEqual({ minor: true });
        });

        const auditRows = await directSql<
          {
            id: string;
            actor_kind: string;
            actor_id: string;
            action: string;
            purpose: string;
            target_ids: string[];
          }[]
        >`
          select id::text as id, actor_kind, actor_id::text as actor_id, action, purpose, target_ids::text[] as target_ids
          from app.audit_events
          where action = 'people.person.read'
            and org_id = ${scope.orgId}::uuid
        `;

        expect(auditRows).toHaveLength(1);
        expect(auditRows[0]?.actor_kind).toBe("user");
        expect(auditRows[0]?.actor_id).toBe(actorUserId);
        expect(auditRows[0]?.purpose).toBe("people.person.read");
        expect(auditRows[0]?.target_ids).toEqual([adultWithPhoneId]);

        // Verify no fixture name or phone appears anywhere in the audit row
        const rowJson = JSON.stringify(auditRows[0]);
        expect(rowJson).not.toContain("Avery");
        expect(rowJson).not.toContain("Quill");
        expect(rowJson).not.toContain("61491570158");
      });
    } finally {
      await cleanScope(directSql, scope);
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("pin 11 fixture (i): throws without creating community key when community key row is missing", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createCountingKmsPort();

    const scope1 = await createScope(platform);
    const actorUserId = newId();

    try {
      // Fixture (i): organisation key exists, and community key row is deleted through owner connection in community with no households
      let adultId1 = "";
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope1, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Casey",
            familyName: "Rowan",
            email: null,
            phone: "+61491570110",
            actorUserId,
          });
          adultId1 = adult.personId;
        });
      });

      // Confirm both keys exist before deletion
      const orgKeysBefore = await directSql<{ count: number }[]>`
        select count(*)::int as count from app.organisation_keys where org_id = ${scope1.orgId}::uuid
      `;
      const commKeysBefore = await directSql<{ count: number }[]>`
        select count(*)::int as count from app.community_keys where community_id = ${scope1.communityId}::uuid
      `;
      expect(orgKeysBefore[0]?.count).toBe(1);
      expect(commKeysBefore[0]?.count).toBe(1);

      // Delete community key through owner connection
      await directSql`delete from app.community_keys where community_id = ${scope1.communityId}::uuid`;

      kms.resetCounts();

      let error1: unknown;
      await withAppTransaction(app, scope1, async (tx) => {
        try {
          await readLinkedContacts(tx, kms, KEY_ARN, {
            personIds: [adultId1],
            includePhone: true,
            actorUserId,
          });
        } catch (err) {
          error1 = err;
        }
      });

      // Assert row counts remain unchanged (org keys = 1, comm keys = 0) and zero generateDataKey calls
      const orgKeysAfter1 = await directSql<{ count: number }[]>`
        select count(*)::int as count from app.organisation_keys where org_id = ${scope1.orgId}::uuid
      `;
      const commKeysAfter1 = await directSql<{ count: number }[]>`
        select count(*)::int as count from app.community_keys where community_id = ${scope1.communityId}::uuid
      `;
      expect(orgKeysAfter1[0]?.count).toBe(1);
      expect(commKeysAfter1[0]?.count).toBe(0);
      expect(kms.generateDataKeyCalls).toBe(0);
      expect(error1).toBeInstanceOf(Error);
      expect((error1 as Error).message).toContain("community key is missing");
    } finally {
      await cleanScope(directSql, scope1);
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("pin 11 fixture (ii): throws without creating organisation key when both key rows are missing", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createCountingKmsPort();

    const scope2 = await createScope(platform);
    const actorUserId = newId();

    try {
      // Fixture (ii): both key rows are absent
      const personId2 = newId();
      await directSql`
        insert into app.persons (
          id, org_id, community_id, is_minor, age_basis, given_name, family_name, phone, phone_bidx
        ) values (
          ${personId2}::uuid,
          ${scope2.orgId}::uuid,
          ${scope2.communityId}::uuid,
          false,
          'declared_adult',
          'Riley',
          'Harper',
          ${new Uint8Array(32)},
          ${new Uint8Array(32)}
        )
      `;

      kms.resetCounts();

      let error2: unknown;
      await withAppTransaction(app, scope2, async (tx) => {
        try {
          await readLinkedContacts(tx, kms, KEY_ARN, {
            personIds: [personId2],
            includePhone: true,
            actorUserId,
          });
        } catch (err) {
          error2 = err;
        }
      });

      const orgKeysAfter2 = await directSql<{ count: number }[]>`
        select count(*)::int as count from app.organisation_keys where org_id = ${scope2.orgId}::uuid
      `;
      const commKeysAfter2 = await directSql<{ count: number }[]>`
        select count(*)::int as count from app.community_keys where community_id = ${scope2.communityId}::uuid
      `;
      expect(orgKeysAfter2[0]?.count).toBe(0);
      expect(commKeysAfter2[0]?.count).toBe(0);
      expect(kms.generateDataKeyCalls).toBe(0);
      expect(error2).toBeInstanceOf(Error);
      expect((error2 as Error).message).toContain("organisation key is missing");
    } finally {
      await cleanScope(directSql, scope2);
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("pin 14: drops person in community 2 of the same organisation and in organisation B", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createCountingKmsPort();

    const scopeA = await createScope(platform);
    const commA2 = await createCommunityInOrg(platform, scopeA.orgId);
    const scopeB = await createScope(platform);
    const actorUserId = newId();

    try {
      let adultA1Id = "";
      let adultA2Id = "";
      let adultBId = "";

      await withRequest({ requestId: REQUEST_ID }, async () => {
        // Person in org A, community 1
        await withAppTransaction(app, scopeA, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Dana",
            familyName: "Brooks",
            email: null,
            phone: "+61491570313",
            actorUserId,
          });
          adultA1Id = adult.personId;
        });

        // Person in org A, community 2
        await withAppTransaction(app, { orgId: scopeA.orgId, communityId: commA2 }, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Ellis",
            familyName: "Vance",
            email: null,
            phone: "+61491570737",
            actorUserId,
          });
          adultA2Id = adult.personId;
        });

        // Person in org B
        await withAppTransaction(app, scopeB, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Cameron",
            familyName: "Reed",
            email: null,
            phone: "+61491570006",
            actorUserId,
          });
          adultBId = adult.personId;
        });

        // Read from scopeA (community 1)
        await withAppTransaction(app, scopeA, async (tx) => {
          const result = await readLinkedContacts(tx, kms, KEY_ARN, {
            personIds: [adultA1Id, adultA2Id, adultBId],
            includePhone: false,
            actorUserId,
          });

          expect(result.has(adultA2Id)).toBe(false);
          expect(result.has(adultBId)).toBe(false);
          expect(result.size).toBe(1);
          expect(result.get(adultA1Id)).toEqual({
            minor: false,
            given: "Dana",
            family: "Brooks",
            phone: null,
          });
        });
      });
    } finally {
      await cleanScope(directSql, scopeA);
      await cleanScope(directSql, scopeB);
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });
});
