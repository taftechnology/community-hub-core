import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

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

import {
  createHousehold,
  createLifeEvent,
  createPerson,
  guardianLinkChildIsMinor,
  hasGuardianView,
  householdHasMinor,
  lifeEventPersonIsMinor,
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

  it("personIsMinor with lock: share returns expected values and succeeds as app", async () => {
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
          values (${organisationId}, 'access-facts-share-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'access-facts-share-parish', 'au')
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

          expect(await personIsMinor(tx, adult.personId, { lock: "share" })).toBe(false);
          expect(await personIsMinor(tx, minor.personId, { lock: "share" })).toBe(true);
          expect(await personIsMinor(tx, newId(), { lock: "share" })).toBeNull();
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("answers whether a family, a guardian link or a life event is about a child, hidden and cross-community cases included", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    const organisationId = newId();
    const communityId = newId();
    const otherCommunityId = newId();
    const kms = createLocalKmsPort();
    const inCommunity = <T>(id: string, run: (tx: AppTransaction) => Promise<T>): Promise<T> =>
      withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId: id }, run),
      );
    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, ${`access-facts-child-${organisationId}`}, 'au', 'implicit')
        `;
        for (const id of [communityId, otherCommunityId]) {
          await tx`
            insert into platform.communities (id, organisation_id, slug, region)
            values (${id}, ${organisationId}, ${`access-facts-child-${id}`}, 'au')
          `;
        }
      });

      const seeded = await inCommunity(communityId, async (tx) => {
        const family = await createHousehold(tx, kms, KEY_ARN, {
          now: NOW,
          label: null,
          actorUserId: null,
        });
        const adultsOnly = await createHousehold(tx, kms, KEY_ARN, {
          now: NOW,
          label: null,
          actorUserId: null,
        });
        const person = (householdId: string, declaredAdult: boolean, givenName: string) =>
          createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult,
            householdId,
            dateOfBirth: null,
            givenName,
            familyName: "Example",
            email: null,
            phone: null,
            actorUserId: null,
          });
        const adult = await person(family.householdId, true, "Ada");
        await person(adultsOnly.householdId, true, "Bea");
        const child = await person(family.householdId, false, "Quillon");
        const link = await linkGuardian(tx, {
          now: NOW,
          householdId: family.householdId,
          guardianPersonId: adult.personId,
          childPersonId: child.personId,
          consent: true,
          pickup: false,
          view: true,
          manage: false,
          actorUserId: null,
        });
        const event = (personId: string) =>
          createLifeEvent(tx, kms, KEY_ARN, {
            personId,
            type: "baptism",
            date: "2020-01-01",
            actorUserId: null,
            now: NOW,
          });
        return {
          familyId: family.householdId,
          adultsOnlyId: adultsOnly.householdId,
          childId: child.personId,
          linkId: link.linkId,
          childEventId: (await event(child.personId)).eventId,
          adultEventId: (await event(adult.personId)).eventId,
        };
      });
      const linkOf = { householdId: seeded.familyId, linkId: seeded.linkId };

      await inCommunity(communityId, async (tx) => {
        const audits = () => tx<{ n: number }[]>`select count(*)::int as n from app.audit_events`;
        const before = await audits();
        expect(await householdHasMinor(tx, seeded.familyId)).toBe(true);
        expect(await householdHasMinor(tx, seeded.familyId, { lock: "update" })).toBe(true);
        expect(await householdHasMinor(tx, seeded.adultsOnlyId)).toBe(false);
        expect(await householdHasMinor(tx, newId())).toBe(false);
        expect(await guardianLinkChildIsMinor(tx, linkOf)).toBe(true);
        expect(await guardianLinkChildIsMinor(tx, { ...linkOf, linkId: newId() })).toBeNull();
        expect(
          await guardianLinkChildIsMinor(tx, { ...linkOf, householdId: seeded.adultsOnlyId }),
        ).toBeNull();
        expect(await lifeEventPersonIsMinor(tx, seeded.childEventId)).toBe(true);
        expect(await lifeEventPersonIsMinor(tx, seeded.adultEventId)).toBe(false);
        expect(await lifeEventPersonIsMinor(tx, newId())).toBeNull();
        expect(await audits()).toEqual(before);
      });

      // Another community of the same organisation sees none of them.
      await inCommunity(otherCommunityId, async (tx) => {
        expect(await householdHasMinor(tx, seeded.familyId)).toBe(false);
        expect(await guardianLinkChildIsMinor(tx, linkOf)).toBeNull();
        expect(await lifeEventPersonIsMinor(tx, seeded.childEventId)).toBeNull();
      });

      // A hidden child is still the family's child, and their link is still a child's link. Their
      // life events answer as a missing event's do, as updateLifeEvent does. The user triggers
      // refuse to hide a child today, so it is done as the migrator with them off.
      await withAppTransaction(direct, { orgId: organisationId, communityId }, async (tx) => {
        await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
        await tx`
          update app.persons
          set deleted_at = now() - interval '1 hour', deleted_by = ${newId()}::uuid
          where id = ${seeded.childId}::uuid
        `;
        await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
      });
      await inCommunity(communityId, async (tx) => {
        expect(await householdHasMinor(tx, seeded.familyId)).toBe(true);
        expect(await guardianLinkChildIsMinor(tx, linkOf)).toBe(true);
        expect(await lifeEventPersonIsMinor(tx, seeded.childEventId)).toBeNull();
      });
    } finally {
      await direct.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
