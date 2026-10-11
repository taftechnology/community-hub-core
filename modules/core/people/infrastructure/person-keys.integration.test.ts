import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { decrypt, type Ciphertext } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { createHousehold, createPerson, openPersonFieldKeys } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
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

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function readCount(
  tx: Parameters<Parameters<typeof withAppTransaction>[2]>[0],
  personId: string,
): Promise<number> {
  const rows = await tx<{ n: number }[]>`
    select count(*)::int as n
    from app.audit_events
    where action = 'people.person.read'
      and ${personId}::uuid = any(target_ids)
  `;
  return rows[0]?.n ?? 0;
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

describe("person field keys", () => {
  it("opens the community key for an adult and the household key for a minor", async () => {
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
          values (${organisationId}, 'field-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'field-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: null,
            dateOfBirth: "2008-10-11",
            givenName: "Ada",
            familyName: "Example",
            email: "ada@example.com",
            phone: null,
            actorUserId: null,
          });
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
            email: null,
            phone: null,
            actorUserId: null,
          });
          const emailRow = await tx<{ email: Uint8Array | null }[]>`
            select email from app.persons where id = ${adult.personId}::uuid
          `;
          const nameRow = await tx<{ given_name_restricted: Uint8Array | null }[]>`
            select given_name_restricted from app.persons where id = ${minor.personId}::uuid
          `;
          const emailBytes = emailRow[0]?.email;
          const restricted = nameRow[0]?.given_name_restricted;
          if (emailBytes == null || restricted == null) {
            throw new Error("person ciphertext is missing");
          }

          const adultReads = await readCount(tx, adult.personId);
          const adultKeys = await openPersonFieldKeys(tx, kms, KEY_ARN, {
            personId: adult.personId,
            actorUserId: null,
          });
          expect(adultKeys).not.toBeNull();
          if (adultKeys === null) {
            return;
          }
          expect(Object.keys(adultKeys).sort()).toEqual(["bidx", "enc"]);
          const emailPlain = await decrypt(asCiphertext(emailBytes), async () => adultKeys.enc, {
            tag: "chub/field/v1",
            label: "people.email",
            rowId: uuidBytes(adult.personId),
            communityId: uuidBytes(communityId),
          });
          expect(new TextDecoder().decode(emailPlain)).toBe("ada@example.com");
          await expect(crypto.subtle.exportKey("raw", adultKeys.enc)).rejects.toThrow();
          expect(await readCount(tx, adult.personId)).toBe(adultReads + 1);

          const minorReads = await readCount(tx, minor.personId);
          const minorKeys = await openPersonFieldKeys(tx, kms, KEY_ARN, {
            personId: minor.personId,
            actorUserId: null,
          });
          expect(minorKeys).not.toBeNull();
          if (minorKeys === null) {
            return;
          }
          expect(Object.keys(minorKeys).sort()).toEqual(["bidx", "enc"]);
          await expect(
            decrypt(asCiphertext(restricted), async () => adultKeys.enc, {
              tag: "chub/field/v1",
              label: "people.given_name",
              rowId: uuidBytes(minor.personId),
              communityId: uuidBytes(communityId),
            }),
          ).rejects.toThrow();
          const minorName = await decrypt(asCiphertext(restricted), async () => minorKeys.enc, {
            tag: "chub/field/v1",
            label: "people.given_name",
            rowId: uuidBytes(minor.personId),
            communityId: uuidBytes(communityId),
          });
          expect(new TextDecoder().decode(minorName)).toBe("Ned");
          await expect(crypto.subtle.exportKey("raw", minorKeys.enc)).rejects.toThrow();
          expect(await readCount(tx, minor.personId)).toBe(minorReads + 1);

          const missingId = newId();
          const readsBefore = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events where action = 'people.person.read'
          `;
          expect(
            await openPersonFieldKeys(tx, kms, KEY_ARN, {
              personId: missingId,
              actorUserId: null,
            }),
          ).toBeNull();
          const readsAfter = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events where action = 'people.person.read'
          `;
          expect(readsAfter).toEqual(readsBefore);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
