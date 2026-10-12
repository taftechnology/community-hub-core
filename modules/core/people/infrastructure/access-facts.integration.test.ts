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

import {
  createHousehold,
  createPerson,
  hasGuardianView,
  linkGuardian,
  personIsMinor,
} from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);
const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "access-facts.ts");

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-11T00:00:00+11:00");

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

describe("access facts", () => {
  it("reads the clear minor flag and a guardian view without an audit row", async () => {
    const source = readFileSync(SOURCE, "utf8");
    for (const column of ["given_name", "email", "phone", "date_of_birth"]) {
      expect(source, column).not.toContain(column);
    }

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
          values (${organisationId}, 'access-facts-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'access-facts-parish', 'au')
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
            dateOfBirth: "1990-01-01",
            givenName: "Ada",
            familyName: "Example",
            email: null,
            phone: null,
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
          const other = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: null,
            givenName: "Bea",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });

          const before = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events
          `;
          expect(await personIsMinor(tx, adult.personId)).toBe(false);
          expect(await personIsMinor(tx, minor.personId)).toBe(true);
          expect(await personIsMinor(tx, newId())).toBeNull();
          expect(await hasGuardianView(tx, adult.personId, minor.personId)).toBe(false);
          const afterReads = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events
          `;
          expect(afterReads).toEqual(before);

          await linkGuardian(tx, {
            now: NOW,
            householdId: household.householdId,
            guardianPersonId: adult.personId,
            childPersonId: minor.personId,
            consent: false,
            pickup: false,
            view: true,
            manage: false,
            actorUserId: null,
          });

          const afterLink = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events
          `;
          expect(await hasGuardianView(tx, adult.personId, minor.personId)).toBe(true);
          expect(await hasGuardianView(tx, adult.personId, other.personId)).toBe(false);
          const afterView = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events
          `;
          expect(afterView).toEqual(afterLink);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
