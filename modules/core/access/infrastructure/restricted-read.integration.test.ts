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
import { createHousehold, createPerson, linkGuardian } from "@community-hub/people";

import { bootstrapOwner, grantRole, linkUser, readPersonForActor } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

type Kms = ReturnType<typeof createLocalKmsPort>;

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

beforeAll(async () => {
  const runtime = loadRuntime();
  const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

async function withParish(
  slug: string,
  run: (tx: AppTransaction, kms: Kms) => Promise<void>,
): Promise<void> {
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
        values (${organisationId}, ${slug}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${organisationId}, ${slug}, 'au')
      `;
    });
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: organisationId, communityId }, (tx) => run(tx, kms)),
    );
  } finally {
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
  }
}

async function createMinor(
  tx: AppTransaction,
  kms: Kms,
  householdId: string,
  givenName: string,
): Promise<string> {
  const person = await createPerson(tx, kms, KEY_ARN, {
    now: NOW,
    declaredAdult: false,
    householdId,
    dateOfBirth: null,
    givenName,
    familyName: "Example",
    email: null,
    phone: null,
    actorUserId: null,
  });
  return person.personId;
}

describe("restricted read for an actor", () => {
  it("lets a safeguarding officer read a minor", async () => {
    await withParish("read-officer", async (tx, kms) => {
      const owner = newId();
      const officer = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      await grantRole(tx, {
        now: NOW,
        userId: officer,
        roleKey: "safeguarding_officer",
        customRoleId: null,
        actorUserId: owner,
      });
      const household = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const minorId = await createMinor(tx, kms, household.householdId, "Ned");
      const view = await readPersonForActor(tx, kms, KEY_ARN, {
        personId: minorId,
        actorUserId: officer,
      });
      expect(view).toMatchObject({ personId: minorId, isMinor: true, givenName: "Ned" });
      const reads = await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where action = 'people.person.read'
      `;
      expect(reads).toEqual([{ target_ids: [minorId] }]);
    });
  });

  it("refuses a member without writing a people read", async () => {
    await withParish("read-member", async (tx, kms) => {
      const owner = newId();
      const member = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      await grantRole(tx, {
        now: NOW,
        userId: member,
        roleKey: "member",
        customRoleId: null,
        actorUserId: owner,
      });
      const household = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const minorId = await createMinor(tx, kms, household.householdId, "Ned");
      await expect(
        readPersonForActor(tx, kms, KEY_ARN, { personId: minorId, actorUserId: member }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const reads = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.audit_events
        where action = 'people.person.read'
      `;
      const denied = await tx<{ purpose: string; target_ids: string[] }[]>`
        select purpose, target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.permission.denied'
      `;
      expect(reads).toEqual([{ n: 0 }]);
      expect(denied).toEqual([{ purpose: "people.restricted.read", target_ids: [minorId] }]);
    });
  });

  it("lets a guardian read only the linked child", async () => {
    await withParish("read-guardian", async (tx, kms) => {
      const guardianUser = newId();
      const owner = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
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
      const childId = await createMinor(tx, kms, household.householdId, "Ned");
      const otherId = await createMinor(tx, kms, household.householdId, "Kim");
      await linkUser(tx, {
        now: NOW,
        userId: guardianUser,
        personId: adult.personId,
        actorUserId: owner,
      });
      await linkGuardian(tx, {
        now: NOW,
        householdId: household.householdId,
        guardianPersonId: adult.personId,
        childPersonId: childId,
        consent: false,
        pickup: false,
        view: true,
        manage: false,
        actorUserId: null,
      });
      const view = await readPersonForActor(tx, kms, KEY_ARN, {
        personId: childId,
        actorUserId: guardianUser,
      });
      expect(view).toMatchObject({ personId: childId, givenName: "Ned" });
      await expect(
        readPersonForActor(tx, kms, KEY_ARN, { personId: otherId, actorUserId: guardianUser }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const otherReads = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.audit_events
        where action = 'people.person.read'
          and ${otherId}::uuid = any(target_ids)
      `;
      expect(otherReads).toEqual([{ n: 0 }]);
    });
  });
});
