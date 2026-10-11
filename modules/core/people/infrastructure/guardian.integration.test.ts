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

import { createHousehold, createPerson, linkGuardian, unlinkGuardian } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
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

describe("guardian links", () => {
  it("links an adult to a minor in the same household", async () => {
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
          values (${organisationId}, 'guardian-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'guardian-parish', 'au')
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

          const linked = await linkGuardian(tx, {
            now: NOW,
            householdId: household.householdId,
            guardianPersonId: adult.personId,
            childPersonId: minor.personId,
            consent: true,
            pickup: false,
            view: false,
            manage: false,
            actorUserId: null,
          });
          const stored = await tx<
            { consent: boolean; pickup: boolean; view: boolean; manage: boolean }[]
          >`
            select consent, pickup, view, manage
            from app.guardian_links
            where id = ${linked.linkId}::uuid
          `;
          expect(stored).toEqual([{ consent: true, pickup: false, view: false, manage: false }]);
          const linkedActivity = await tx<{ kind: string }[]>`
            select kind from app.person_activity
            where person_id = ${minor.personId}::uuid and kind = 'guardian_linked'
          `;
          expect(linkedActivity).toEqual([{ kind: "guardian_linked" }]);

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: household.householdId,
              guardianPersonId: minor.personId,
              childPersonId: adult.personId,
              consent: true,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_guardian" });
          const links = await tx<{ n: number }[]>`
            select count(*)::int as n from app.guardian_links
          `;
          expect(links).toEqual([{ n: 1 }]);

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: household.householdId,
              guardianPersonId: adult.personId,
              childPersonId: minor.personId,
              consent: true,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "duplicate_guardian_link" });

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: household.householdId,
              guardianPersonId: adult.personId,
              childPersonId: minor.personId,
              consent: false,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_guardian" });
          const stillOne = await tx<{ n: number }[]>`
            select count(*)::int as n from app.guardian_links
          `;
          expect(stillOne).toEqual([{ n: 1 }]);

          await unlinkGuardian(tx, { now: NOW, linkId: linked.linkId, actorUserId: null });
          const unlinked = await tx<{ kind: string }[]>`
            select kind from app.person_activity
            where person_id = ${minor.personId}::uuid and kind = 'guardian_unlinked'
          `;
          expect(unlinked).toEqual([{ kind: "guardian_unlinked" }]);

          await expect(
            unlinkGuardian(tx, { now: NOW, linkId: linked.linkId, actorUserId: null }),
          ).rejects.toMatchObject({ code: "not_found" });
          const unlinkedAgain = await tx<{ n: number }[]>`
            select count(*)::int as n
            from app.person_activity
            where person_id = ${minor.personId}::uuid and kind = 'guardian_unlinked'
          `;
          expect(unlinkedAgain).toEqual([{ n: 1 }]);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects a minor guardian and a household that does not match", async () => {
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
          values (${organisationId}, 'guardian-rule-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'guardian-rule-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const home = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const other = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: home.householdId,
            dateOfBirth: "2008-10-11",
            givenName: "Ada",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const child = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: home.householdId,
            dateOfBirth: null,
            givenName: "Ned",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const minorGuardian = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: home.householdId,
            dateOfBirth: null,
            givenName: "Bea",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
          const otherChild = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: other.householdId,
            dateOfBirth: null,
            givenName: "Cara",
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: home.householdId,
              guardianPersonId: minorGuardian.personId,
              childPersonId: child.personId,
              consent: true,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_guardian" });

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: other.householdId,
              guardianPersonId: adult.personId,
              childPersonId: otherChild.personId,
              consent: true,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_guardian" });

          await expect(
            linkGuardian(tx, {
              now: NOW,
              householdId: other.householdId,
              guardianPersonId: adult.personId,
              childPersonId: child.personId,
              consent: true,
              pickup: false,
              view: false,
              manage: false,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "invalid_guardian" });

          const links = await tx<{ n: number }[]>`
            select count(*)::int as n from app.guardian_links
          `;
          expect(links).toEqual([{ n: 0 }]);
          const activity = await tx<{ n: number }[]>`
            select count(*)::int as n
            from app.person_activity
            where kind = 'guardian_linked'
          `;
          expect(activity).toEqual([{ n: 0 }]);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
