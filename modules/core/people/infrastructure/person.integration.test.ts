import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { blindIndex, decrypt, type Ciphertext } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { createHousehold, createPerson, createTag, readPerson } from "../public/index.js";
import { communityFieldKeys, householdFieldKeys } from "./person-keys.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-11T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

function asCiphertext(bytes: Uint8Array): Ciphertext {
  return bytes as never;
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

describe("person create and read", () => {
  it("stores an adult in the community and a minor in the household", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const otherOrganisationId = newId();
    const otherCommunityId = newId();
    const kms = createLocalKmsPort();
    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'person-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'person-parish', 'au')
        `;
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${otherOrganisationId}, 'other-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${otherCommunityId}, ${otherOrganisationId}, 'other-parish', 'au')
        `;
      });

      const adultId = await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          await expect(
            createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: false,
              householdId: null,
              dateOfBirth: null,
              givenName: "Ned",
              familyName: "Example",
              email: null,
              phone: null,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "household_required" });
          const none = await tx<{ n: number }[]>`select count(*)::int as n from app.persons`;
          expect(none).toEqual([{ n: 0 }]);

          const created = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: null,
            dateOfBirth: "2008-10-11",
            givenName: "Ada",
            familyName: "Example",
            email: "ada@example.com",
            phone: "+61 412 345 678",
            actorUserId: null,
          });
          const row = await tx<
            {
              is_minor: boolean;
              age_basis: string;
              birthday_md: number | null;
              given_name: string | null;
              family_name: string | null;
              given_name_restricted: Uint8Array | null;
              family_name_restricted: Uint8Array | null;
              email: Uint8Array | null;
              phone: Uint8Array | null;
            }[]
          >`
            select
              is_minor, age_basis, birthday_md, given_name, family_name,
              given_name_restricted, family_name_restricted, email, phone
            from app.persons
            where id = ${created.personId}::uuid
          `;
          expect(row).toEqual([
            {
              is_minor: false,
              age_basis: "date_of_birth",
              birthday_md: 1011,
              given_name: "Ada",
              family_name: "Example",
              given_name_restricted: null,
              family_name_restricted: null,
              email: expect.any(Uint8Array),
              phone: expect.any(Uint8Array),
            },
          ]);
          const communityKeys = await communityFieldKeys(tx, kms, KEY_ARN);
          const emailBytes = row[0]?.email;
          const phoneBytes = row[0]?.phone;
          if (emailBytes == null || phoneBytes == null) {
            throw new Error("adult contact ciphertext is missing");
          }
          const emailPlain = await decrypt(
            asCiphertext(emailBytes),
            async () => communityKeys.enc,
            {
              tag: "chub/field/v1",
              label: "people.email",
              rowId: uuidBytes(created.personId),
              communityId: uuidBytes(communityId),
            },
          );
          const phonePlain = await decrypt(
            asCiphertext(phoneBytes),
            async () => communityKeys.enc,
            {
              tag: "chub/field/v1",
              label: "people.phone",
              rowId: uuidBytes(created.personId),
              communityId: uuidBytes(communityId),
            },
          );
          expect(new TextDecoder().decode(emailPlain)).toBe("ada@example.com");
          expect(new TextDecoder().decode(phonePlain)).toBe("61412345678");

          const read = await readPerson(tx, kms, KEY_ARN, {
            personId: created.personId,
            actorUserId: null,
          });
          expect(read).toEqual({
            personId: created.personId,
            householdId: null,
            isMinor: false,
            ageBasis: "date_of_birth",
            birthdayMd: 1011,
            givenName: "Ada",
            familyName: "Example",
            email: "ada@example.com",
            phone: "61412345678",
            dateOfBirth: "2008-10-11",
          });
          const createdAudit = await tx<{ n: number }[]>`
            select count(*)::int as n
            from app.audit_events
            where action = 'people.person.created'
              and ${created.personId}::uuid = any(target_ids)
          `;
          const readAudit = await tx<{ n: number }[]>`
            select count(*)::int as n
            from app.audit_events
            where action = 'people.person.read'
              and ${created.personId}::uuid = any(target_ids)
          `;
          expect(createdAudit).toEqual([{ n: 1 }]);
          expect(readAudit).toEqual([{ n: 1 }]);
          const activity = await tx<{ kind: string }[]>`
            select kind from app.person_activity where person_id = ${created.personId}::uuid
          `;
          expect(activity).toEqual([{ kind: "created" }]);

          await expect(
            createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: false,
              householdId: null,
              dateOfBirth: "2008-10-11",
              givenName: "Ada",
              familyName: "Example",
              email: "ada@example.com",
              phone: null,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "duplicate_email" });
          const people = await tx<{ n: number }[]>`select count(*)::int as n from app.persons`;
          const createdRows = await tx<{ n: number }[]>`
            select count(*)::int as n
            from app.audit_events
            where action = 'people.person.created'
          `;
          expect(people).toEqual([{ n: 1 }]);
          expect(createdRows).toEqual([{ n: 1 }]);

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
            givenName: "Ned",
            familyName: "Example",
            email: "ned@example.com",
            phone: null,
            actorUserId: null,
          });
          const minorRow = await tx<
            {
              is_minor: boolean;
              age_basis: string;
              birthday_md: number | null;
              given_name: string | null;
              family_name: string | null;
              given_name_restricted: Uint8Array | null;
            }[]
          >`
            select is_minor, age_basis, birthday_md, given_name, family_name, given_name_restricted
            from app.persons
            where id = ${minor.personId}::uuid
          `;
          expect(minorRow[0]).toMatchObject({
            is_minor: true,
            age_basis: "unknown",
            birthday_md: null,
            given_name: null,
            family_name: null,
          });
          const restricted = minorRow[0]?.given_name_restricted;
          if (restricted == null) {
            throw new Error("minor name ciphertext is missing");
          }
          const householdKeys = await householdFieldKeys(tx, kms, KEY_ARN, household.householdId);
          const minorName = await decrypt(asCiphertext(restricted), async () => householdKeys.enc, {
            tag: "chub/field/v1",
            label: "people.given_name",
            rowId: uuidBytes(minor.personId),
            communityId: uuidBytes(communityId),
          });
          expect(new TextDecoder().decode(minorName)).toBe("Ned");
          await expect(
            decrypt(asCiphertext(restricted), async () => communityKeys.enc, {
              tag: "chub/field/v1",
              label: "people.given_name",
              rowId: uuidBytes(minor.personId),
              communityId: uuidBytes(communityId),
            }),
          ).rejects.toThrow();
          const communityIndex = await blindIndex(
            communityKeys.bidx,
            "people.email",
            new TextEncoder().encode("ned@example.com"),
          );
          const communityHit = await tx<{ id: string }[]>`
            select id::text as id from app.persons where email_bidx = ${communityIndex}
          `;
          expect(communityHit).toEqual([]);
          const householdIndex = await blindIndex(
            householdKeys.bidx,
            "people.email",
            new TextEncoder().encode("ned@example.com"),
          );
          const householdHit = await tx<{ id: string }[]>`
            select id::text as id from app.persons where email_bidx = ${householdIndex}
          `;
          expect(householdHit).toEqual([{ id: minor.personId }]);
          return created.personId;
        }),
      );

      await withAppTransaction(
        app,
        { orgId: otherOrganisationId, communityId: otherCommunityId },
        async (tx) => {
          const rows = await tx<{ id: string }[]>`
            select id::text as id from app.persons where id = ${adultId}::uuid
          `;
          expect(rows).toEqual([]);
        },
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("records age basis from the date, a declaration, or an unknown birth date", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();
    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'age-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'age-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const before = await tx<{ n: number }[]>`select count(*)::int as n from app.persons`;
          await expect(
            createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: "2008-10-12",
              givenName: "Ned",
              familyName: "Example",
              email: null,
              phone: null,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_declaration" });
          const afterReject = await tx<{ n: number }[]>`
            select count(*)::int as n from app.persons
          `;
          expect(afterReject).toEqual(before);

          const household = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const datedMinor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: "2008-10-12",
            givenName: "Ned",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const datedAdult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: null,
            dateOfBirth: "2008-10-11",
            givenName: "Ada",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const declared = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Bea",
            familyName: "Example",
            email: "bea@example.com",
            phone: null,
            actorUserId: null,
          });
          const unknown = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: null,
            givenName: "Cara",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });

          const datedMinorRead = await readPerson(tx, kms, KEY_ARN, {
            personId: datedMinor.personId,
            actorUserId: null,
          });
          const datedAdultRead = await readPerson(tx, kms, KEY_ARN, {
            personId: datedAdult.personId,
            actorUserId: null,
          });
          const declaredRead = await readPerson(tx, kms, KEY_ARN, {
            personId: declared.personId,
            actorUserId: null,
          });
          const unknownRead = await readPerson(tx, kms, KEY_ARN, {
            personId: unknown.personId,
            actorUserId: null,
          });
          expect(datedMinorRead).toMatchObject({
            isMinor: true,
            ageBasis: "date_of_birth",
            givenName: "Ned",
          });
          expect(datedAdultRead).toMatchObject({
            isMinor: false,
            ageBasis: "date_of_birth",
            givenName: "Ada",
          });
          expect(declaredRead).toMatchObject({
            isMinor: false,
            ageBasis: "declared_adult",
            givenName: "Bea",
            familyName: "Example",
            email: "bea@example.com",
            dateOfBirth: null,
          });
          expect(unknownRead).toMatchObject({
            isMinor: true,
            ageBasis: "unknown",
            dateOfBirth: null,
          });

          const declaredRow = await tx<
            {
              given_name: string | null;
              family_name: string | null;
              given_name_restricted: Uint8Array | null;
              email: Uint8Array | null;
            }[]
          >`
            select given_name, family_name, given_name_restricted, email
            from app.persons
            where id = ${declared.personId}::uuid
          `;
          expect(declaredRow[0]).toMatchObject({
            given_name: "Bea",
            family_name: "Example",
            given_name_restricted: null,
          });
          const emailBytes = declaredRow[0]?.email;
          if (emailBytes == null) {
            throw new Error("declared adult email is missing");
          }
          const communityKeys = await communityFieldKeys(tx, kms, KEY_ARN);
          const emailPlain = await decrypt(
            asCiphertext(emailBytes),
            async () => communityKeys.enc,
            {
              tag: "chub/field/v1",
              label: "people.email",
              rowId: uuidBytes(declared.personId),
              communityId: uuidBytes(communityId),
            },
          );
          expect(new TextDecoder().decode(emailPlain)).toBe("bea@example.com");
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("hides a community's people from another community in the same organisation", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const otherCommunityId = newId();
    const kms = createLocalKmsPort();
    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'two-community-parish', 'au', 'explicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'north-parish', 'au')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${otherCommunityId}, ${organisationId}, 'south-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: null,
            dateOfBirth: "2008-10-11",
            givenName: "Ada",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          await createTag(tx, { label: "Choir" });
          const seen = await tx<{ persons: number; households: number; tags: number }[]>`
            select
              (select count(*)::int from app.persons) as persons,
              (select count(*)::int from app.households) as households,
              (select count(*)::int from app.person_tags) as tags
          `;
          expect(seen).toEqual([{ persons: 1, households: 1, tags: 1 }]);
        }),
      );

      await withAppTransaction(
        app,
        { orgId: organisationId, communityId: otherCommunityId },
        async (tx) => {
          const persons = await tx<{ id: string }[]>`select id::text as id from app.persons`;
          const households = await tx<{ id: string }[]>`
            select id::text as id from app.households
          `;
          const tags = await tx<{ id: string }[]>`select id::text as id from app.person_tags`;
          expect(persons).toEqual([]);
          expect(households).toEqual([]);
          expect(tags).toEqual([]);
        },
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects a direct insert that breaks an age-basis check", async () => {
    const direct = createPlaintextDirectSql(loadRuntime().productOnlyUrl);
    const orgId = newId();
    const communityId = newId();
    const householdId = newId();
    const name = new Uint8Array([1]);
    try {
      await direct`
        insert into app.households (id, org_id, community_id, label)
        values (${householdId}::uuid, ${orgId}::uuid, ${communityId}::uuid, null)
      `;
      await expect(
        direct`
          insert into app.persons (
            id, org_id, community_id, household_id, is_minor, age_basis,
            given_name_restricted, family_name_restricted
          ) values (
            ${newId()}::uuid, ${orgId}::uuid, ${communityId}::uuid, ${householdId}::uuid,
            true, 'other', ${name}, ${name}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        direct`
          insert into app.persons (
            id, org_id, community_id, is_minor, age_basis, given_name, family_name
          ) values (
            ${newId()}::uuid, ${orgId}::uuid, ${communityId}::uuid,
            false, 'date_of_birth', 'Ada', 'Example'
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        direct`
          insert into app.persons (
            id, org_id, community_id, household_id, is_minor, age_basis,
            given_name_restricted, family_name_restricted
          ) values (
            ${newId()}::uuid, ${orgId}::uuid, ${communityId}::uuid, ${householdId}::uuid,
            true, 'declared_adult', ${name}, ${name}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        direct`
          insert into app.persons (
            id, org_id, community_id, is_minor, age_basis, given_name, family_name
          ) values (
            ${newId()}::uuid, ${orgId}::uuid, ${communityId}::uuid,
            false, 'unknown', 'Ada', 'Example'
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await direct`delete from app.persons where org_id = ${orgId}::uuid`;
      await direct`delete from app.households where id = ${householdId}::uuid`;
      await direct.end({ timeout: 1 });
    }
  });

  it("rejects a clear name on a minor and a restricted name on an adult", async () => {
    const direct = createPlaintextDirectSql(loadRuntime().productOnlyUrl);
    const orgId = newId();
    const communityId = newId();
    const householdId = newId();
    const name = new Uint8Array([1]);
    try {
      await direct`
        insert into app.households (id, org_id, community_id, label)
        values (${householdId}::uuid, ${orgId}::uuid, ${communityId}::uuid, null)
      `;
      await expect(
        direct`
          insert into app.persons (
            id, org_id, community_id, household_id, is_minor, age_basis,
            given_name, given_name_restricted, family_name_restricted
          ) values (
            ${newId()}::uuid, ${orgId}::uuid, ${communityId}::uuid, ${householdId}::uuid,
            true, 'unknown', 'Ada', ${name}, ${name}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        direct`
          insert into app.persons (
            id, org_id, community_id, is_minor, age_basis,
            given_name, family_name, given_name_restricted
          ) values (
            ${newId()}::uuid, ${orgId}::uuid, ${communityId}::uuid,
            false, 'declared_adult', 'Ada', 'Example', ${name}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await direct`delete from app.persons where org_id = ${orgId}::uuid`;
      await direct`delete from app.households where id = ${householdId}::uuid`;
      await direct.end({ timeout: 1 });
    }
  });

  it("keeps an adult email on the community key inside a household", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();
    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'adult-home-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'adult-home-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const household = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: "2008-10-11",
            givenName: "Ada",
            familyName: "Example",
            email: "ada.home@example.com",
            phone: null,
            actorUserId: null,
          });
          const row = await tx<{ email: Uint8Array | null; email_bidx: Uint8Array | null }[]>`
            select email, email_bidx from app.persons where id = ${adult.personId}::uuid
          `;
          const emailBytes = row[0]?.email;
          const storedIndex = row[0]?.email_bidx;
          if (emailBytes == null || storedIndex == null) {
            throw new Error("adult email is missing");
          }
          const communityKeys = await communityFieldKeys(tx, kms, KEY_ARN);
          const householdKeys = await householdFieldKeys(tx, kms, KEY_ARN, household.householdId);
          const aad = {
            tag: "chub/field/v1" as const,
            label: "people.email",
            rowId: uuidBytes(adult.personId),
            communityId: uuidBytes(communityId),
          };
          const plain = await decrypt(asCiphertext(emailBytes), async () => communityKeys.enc, aad);
          expect(new TextDecoder().decode(plain)).toBe("ada.home@example.com");
          await expect(
            decrypt(asCiphertext(emailBytes), async () => householdKeys.enc, aad),
          ).rejects.toThrow();
          const communityIndex = await blindIndex(
            communityKeys.bidx,
            "people.email",
            new TextEncoder().encode("ada.home@example.com"),
          );
          expect(Array.from(storedIndex)).toEqual(Array.from(communityIndex));
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
