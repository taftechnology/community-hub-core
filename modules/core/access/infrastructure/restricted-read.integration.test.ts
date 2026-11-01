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

import {
  bootstrapOwner,
  createCustomRole,
  grantRole,
  linkUser,
  readPersonForActor,
} from "../public/index.js";

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

async function withTwoCommunities(
  slug: string,
  setupCommunity2: (tx2: AppTransaction, kms: Kms) => Promise<void>,
  runCommunity1: (tx1: AppTransaction, kms: Kms) => Promise<void>,
): Promise<void> {
  const runtime = loadRuntime();
  const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  const organisationId = newId();
  const communityId1 = newId();
  const communityId2 = newId();
  const kms = createLocalKmsPort();
  try {
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${organisationId}, ${slug}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId1}, ${organisationId}, ${slug + "-c1"}, 'au')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId2}, ${organisationId}, ${slug + "-c2"}, 'au')
      `;
    });
    await withRequest({ requestId: REQUEST_ID }, async () => {
      await withAppTransaction(app, { orgId: organisationId, communityId: communityId2 }, (tx2) =>
        setupCommunity2(tx2, kms),
      );
      await withAppTransaction(app, { orgId: organisationId, communityId: communityId1 }, (tx1) =>
        runCommunity1(tx1, kms),
      );
    });
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
      expect(view).toMatchObject({
        personId: minorId,
        isMinor: true,
        givenName: "Ned",
        version: 1,
      });
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

  it("people.view reads an adult, is refused a minor with forbidden, and safeguarding officer reads an adult (pin 8)", async () => {
    await withParish("read-view-pin8", async (tx, kms) => {
      const owner = newId();
      const viewer = newId();
      const officer = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const createdRole = await createCustomRole(tx, {
        now: NOW,
        key: "contact_viewer",
        permissions: ["people.view"],
        actorUserId: owner,
      });
      await grantRole(tx, {
        now: NOW,
        userId: viewer,
        roleKey: null,
        customRoleId: createdRole.customRoleId,
        actorUserId: owner,
      });
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
      const adult = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: household.householdId,
        dateOfBirth: "1985-05-05",
        givenName: "Arthur",
        familyName: "Pendelton",
        email: null,
        phone: null,
        actorUserId: null,
      });
      const minorId = await createMinor(tx, kms, household.householdId, "Ned");

      // 1. people.view reads an adult
      const adultView = await readPersonForActor(tx, kms, KEY_ARN, {
        personId: adult.personId,
        actorUserId: viewer,
      });
      expect(adultView).toMatchObject({
        personId: adult.personId,
        isMinor: false,
        givenName: "Arthur",
        familyName: "Pendelton",
        version: 1,
      });

      // 2. people.view is refused a minor with forbidden (pin 8)
      await expect(
        readPersonForActor(tx, kms, KEY_ARN, { personId: minorId, actorUserId: viewer }),
      ).rejects.toMatchObject({ code: "forbidden" });

      // Denial audit row records purpose: people.restricted.read and ids only
      const minorDenials = await tx<{ purpose: string; target_ids: string[] }[]>`
        select purpose, target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.permission.denied'
          and ${minorId}::uuid = any(target_ids)
      `;
      expect(minorDenials).toEqual([{ purpose: "people.restricted.read", target_ids: [minorId] }]);

      // 3. safeguarding officer still reads an adult (Deviation 2)
      const officerAdultView = await readPersonForActor(tx, kms, KEY_ARN, {
        personId: adult.personId,
        actorUserId: officer,
      });
      expect(officerAdultView).toMatchObject({
        personId: adult.personId,
        isMinor: false,
        givenName: "Arthur",
      });
    });
  });

  it("refuses a member and staff reading an adult with forbidden and audits people.person.view (finding 1, 6)", async () => {
    await withParish("read-adult-denied", async (tx, kms) => {
      const owner = newId();
      const member = newId();
      const staffUser = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      await grantRole(tx, {
        now: NOW,
        userId: member,
        roleKey: "member",
        customRoleId: null,
        actorUserId: owner,
      });
      await grantRole(tx, {
        now: NOW,
        userId: staffUser,
        roleKey: "staff",
        customRoleId: null,
        actorUserId: owner,
      });

      const household = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const adult = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: household.householdId,
        dateOfBirth: "1985-05-05",
        givenName: "Arthur",
        familyName: "Pendelton",
        email: null,
        phone: null,
        actorUserId: null,
      });
      const adultId = adult.personId;

      // 1. member is refused an adult
      await expect(
        readPersonForActor(tx, kms, KEY_ARN, { personId: adultId, actorUserId: member }),
      ).rejects.toMatchObject({ code: "forbidden" });

      const memberDenials = await tx<{ purpose: string; target_ids: string[] }[]>`
        select purpose, target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.permission.denied'
          and actor_id = ${member}::uuid
      `;
      expect(memberDenials).toEqual([{ purpose: "people.person.view", target_ids: [adultId] }]);

      // 2. staff is refused an adult
      await expect(
        readPersonForActor(tx, kms, KEY_ARN, { personId: adultId, actorUserId: staffUser }),
      ).rejects.toMatchObject({ code: "forbidden" });

      const staffDenials = await tx<{ purpose: string; target_ids: string[] }[]>`
        select purpose, target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.permission.denied'
          and actor_id = ${staffUser}::uuid
      `;
      expect(staffDenials).toEqual([{ purpose: "people.person.view", target_ids: [adultId] }]);

      // No read rows
      const reads = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.audit_events
        where action = 'people.person.read'
          and ${adultId}::uuid = any(target_ids)
      `;
      expect(reads).toEqual([{ n: 0 }]);
    });
  });

  it("unknown id and cross-community id throw forbidden with identical denial audit (pin 8)", async () => {
    let crossCommunityPersonId = "";
    await withTwoCommunities(
      "read-unknown-cross",
      async (tx2, kms) => {
        const household2 = await createHousehold(tx2, kms, KEY_ARN, {
          now: NOW,
          label: null,
          actorUserId: null,
        });
        const person2 = await createPerson(tx2, kms, KEY_ARN, {
          now: NOW,
          declaredAdult: true,
          householdId: household2.householdId,
          dateOfBirth: "1980-01-01",
          givenName: "Other",
          familyName: "Parishioner",
          email: null,
          phone: null,
          actorUserId: null,
        });
        crossCommunityPersonId = person2.personId;
      },
      async (tx1, kms) => {
        const owner = newId();
        const viewer = newId();
        await bootstrapOwner(tx1, { now: NOW, userId: owner, actorUserId: owner });
        const createdRole = await createCustomRole(tx1, {
          now: NOW,
          key: "contact_viewer",
          permissions: ["people.view"],
          actorUserId: owner,
        });
        await grantRole(tx1, {
          now: NOW,
          userId: viewer,
          roleKey: null,
          customRoleId: createdRole.customRoleId,
          actorUserId: owner,
        });

        const unknownId = newId();

        // Unknown id throws forbidden
        await expect(
          readPersonForActor(tx1, kms, KEY_ARN, { personId: unknownId, actorUserId: viewer }),
        ).rejects.toMatchObject({ code: "forbidden" });

        // Cross-community id throws forbidden
        await expect(
          readPersonForActor(tx1, kms, KEY_ARN, {
            personId: crossCommunityPersonId,
            actorUserId: viewer,
          }),
        ).rejects.toMatchObject({ code: "forbidden" });

        // Both denial audits record purpose: people.restricted.read and ids only
        const unknownDenials = await tx1<{ purpose: string; target_ids: string[] }[]>`
          select purpose, target_ids::text[] as target_ids
          from app.audit_events
          where action = 'access.permission.denied'
            and ${unknownId}::uuid = any(target_ids)
        `;
        expect(unknownDenials).toEqual([
          { purpose: "people.restricted.read", target_ids: [unknownId] },
        ]);

        const crossDenials = await tx1<{ purpose: string; target_ids: string[] }[]>`
          select purpose, target_ids::text[] as target_ids
          from app.audit_events
          where action = 'access.permission.denied'
            and ${crossCommunityPersonId}::uuid = any(target_ids)
        `;
        expect(crossDenials).toEqual([
          { purpose: "people.restricted.read", target_ids: [crossCommunityPersonId] },
        ]);
      },
    );
  });
});
