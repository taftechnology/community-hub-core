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

import { createHousehold, createPerson, readPerson } from "../public/index.js";
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
              is_minor, birthday_md, given_name, family_name,
              given_name_restricted, family_name_restricted, email, phone
            from app.persons
            where id = ${created.personId}::uuid
          `;
          expect(row).toEqual([
            {
              is_minor: false,
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
              birthday_md: number | null;
              given_name: string | null;
              family_name: string | null;
              given_name_restricted: Uint8Array | null;
            }[]
          >`
            select is_minor, birthday_md, given_name, family_name, given_name_restricted
            from app.persons
            where id = ${minor.personId}::uuid
          `;
          expect(minorRow[0]).toMatchObject({
            is_minor: true,
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
});

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
