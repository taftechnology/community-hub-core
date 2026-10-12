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
import { createHousehold, createPerson } from "@community-hub/people";

import {
  bootstrapOwner,
  createCustomRole,
  grantRole,
  linkUser,
  revokeRole,
} from "../public/index.js";

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
  run: (
    tx: AppTransaction,
    kms: ReturnType<typeof createLocalKmsPort>,
    scope: { organisationId: string; communityId: string },
    app: ReturnType<typeof createPlaintextAppSql>,
  ) => Promise<void>,
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
      withAppTransaction(app, { orgId: organisationId, communityId }, (tx) =>
        run(tx, kms, { organisationId, communityId }, app),
      ),
    );
  } finally {
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
  }
}

async function householdWithPeople(
  tx: AppTransaction,
  kms: ReturnType<typeof createLocalKmsPort>,
): Promise<{ adultId: string; minorId: string }> {
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
  return { adultId: adult.personId, minorId: minor.personId };
}

describe("links, bootstrap, and grants", () => {
  it("bootstraps one owner and refuses a second bootstrap", async () => {
    await withParish("grant-bootstrap", async (tx) => {
      const owner = newId();
      const boot = await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const audits = await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.owner.bootstrapped'
      `;
      expect(audits).toEqual([{ target_ids: [boot.organisationGrantId, boot.communityGrantId] }]);

      await expect(
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      ).rejects.toMatchObject({ code: "already_bootstrapped" });
      const grants = await tx<{ n: number }[]>`
        select count(*)::int as n from app.organisation_role_grants
      `;
      const community = await tx<{ n: number }[]>`
        select count(*)::int as n from app.community_role_grants
      `;
      const bootAudits = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.audit_events
        where action = 'access.owner.bootstrapped'
      `;
      expect(grants).toEqual([{ n: 1 }]);
      expect(community).toEqual([{ n: 1 }]);
      expect(bootAudits).toEqual([{ n: 1 }]);
    });
  });

  it("links an adult and refuses a minor", async () => {
    await withParish("grant-link", async (tx, kms) => {
      const people = await householdWithPeople(tx, kms);
      const owner = newId();
      const linked = await linkUser(tx, {
        now: NOW,
        userId: owner,
        personId: people.adultId,
        actorUserId: owner,
      });
      const linkAudits = await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.user.linked'
      `;
      expect(linkAudits).toEqual([{ target_ids: [linked.linkId] }]);

      await expect(
        linkUser(tx, {
          now: NOW,
          userId: newId(),
          personId: people.minorId,
          actorUserId: owner,
        }),
      ).rejects.toMatchObject({ code: "minor_forbidden" });
      const links = await tx<{ n: number }[]>`
        select count(*)::int as n from app.user_links
      `;
      expect(links).toEqual([{ n: 1 }]);
    });
  });

  it("refuses an org_admin granting themselves org_owner", async () => {
    await withParish("grant-admin-rank", async (tx) => {
      const owner = newId();
      const admin = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      await grantRole(tx, {
        now: NOW,
        userId: admin,
        roleKey: "org_admin",
        customRoleId: null,
        actorUserId: owner,
      });
      const before = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.organisation_role_grants
        where role_key = 'org_owner'
      `;
      await expect(
        grantRole(tx, {
          now: NOW,
          userId: admin,
          roleKey: "org_owner",
          customRoleId: null,
          actorUserId: admin,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const after = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.organisation_role_grants
        where role_key = 'org_owner'
      `;
      expect(after).toEqual(before);
    });
  });

  it("lets an owner grant staff and refuses org_owner from a community admin", async () => {
    await withParish("grant-roles", async (tx) => {
      const owner = newId();
      const staffUser = newId();
      const adminUser = newId();
      const target = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const staff = await grantRole(tx, {
        now: NOW,
        userId: staffUser,
        roleKey: "staff",
        customRoleId: null,
        actorUserId: owner,
      });
      expect(staff.scope).toBe("community");
      const granted = await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.role.granted'
          and ${staff.grantId}::uuid = any(target_ids)
      `;
      expect(granted).toEqual([{ target_ids: [staff.grantId] }]);

      await grantRole(tx, {
        now: NOW,
        userId: adminUser,
        roleKey: "community_admin",
        customRoleId: null,
        actorUserId: owner,
      });
      const before = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.organisation_role_grants
        where role_key = 'org_owner'
      `;
      await expect(
        grantRole(tx, {
          now: NOW,
          userId: target,
          roleKey: "org_owner",
          customRoleId: null,
          actorUserId: adminUser,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const denied = await tx<{ purpose: string; target_ids: string[] }[]>`
        select purpose, target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.permission.denied'
      `;
      expect(denied).toEqual([{ purpose: "access.roles.manage", target_ids: [adminUser] }]);
      const after = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.organisation_role_grants
        where role_key = 'org_owner'
      `;
      expect(after).toEqual(before);
    });
  });

  it("refuses a community admin, a manage-only custom role, and an org admin revoking an owner", async () => {
    await withParish("grant-revoke-rank", async (tx) => {
      const owner = newId();
      const second = newId();
      const communityAdmin = newId();
      const customHolder = newId();
      const orgAdmin = newId();
      const boot = await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const other = await grantRole(tx, {
        now: NOW,
        userId: second,
        roleKey: "org_owner",
        customRoleId: null,
        actorUserId: owner,
      });
      await grantRole(tx, {
        now: NOW,
        userId: communityAdmin,
        roleKey: "community_admin",
        customRoleId: null,
        actorUserId: owner,
      });
      const custom = await createCustomRole(tx, {
        now: NOW,
        key: "desk",
        permissions: ["access.roles.manage"],
        actorUserId: owner,
      });
      await grantRole(tx, {
        now: NOW,
        userId: customHolder,
        roleKey: null,
        customRoleId: custom.customRoleId,
        actorUserId: owner,
      });
      await grantRole(tx, {
        now: NOW,
        userId: orgAdmin,
        roleKey: "org_admin",
        customRoleId: null,
        actorUserId: owner,
      });

      for (const actorUserId of [communityAdmin, customHolder, orgAdmin]) {
        await expect(
          revokeRole(tx, {
            now: NOW,
            grantId: boot.organisationGrantId,
            scope: "organisation",
            actorUserId,
          }),
        ).rejects.toMatchObject({ code: "forbidden" });
      }

      const owners = await tx<{ id: string }[]>`
        select id::text as id
        from app.organisation_role_grants
        where role_key = 'org_owner'
        order by id
      `;
      expect(owners.map((row) => row.id).sort()).toEqual(
        [boot.organisationGrantId, other.grantId].sort(),
      );
    });
  });

  it("keeps the last organisation owner and revokes a second one", async () => {
    await withParish("grant-revoke", async (tx) => {
      const owner = newId();
      const secondUser = newId();
      const boot = await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      await expect(
        revokeRole(tx, {
          now: NOW,
          grantId: boot.organisationGrantId,
          scope: "organisation",
          actorUserId: owner,
        }),
      ).rejects.toMatchObject({ code: "last_owner" });
      const kept = await tx<{ id: string }[]>`
        select id::text as id
        from app.organisation_role_grants
        where id = ${boot.organisationGrantId}::uuid
      `;
      expect(kept).toEqual([{ id: boot.organisationGrantId }]);

      const second = await grantRole(tx, {
        now: NOW,
        userId: secondUser,
        roleKey: "org_owner",
        customRoleId: null,
        actorUserId: owner,
      });
      await revokeRole(tx, {
        now: NOW,
        grantId: second.grantId,
        scope: "organisation",
        actorUserId: owner,
      });
      const owners = await tx<{ id: string }[]>`
        select id::text as id
        from app.organisation_role_grants
        where role_key = 'org_owner'
      `;
      expect(owners).toEqual([{ id: boot.organisationGrantId }]);
    });
  });

  it("hides links and organisation grants from another organisation", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const otherOrg = newId();
    const otherCommunity = newId();
    const kms = createLocalKmsPort();
    try {
      await platform.begin(async (platformTx) => {
        await platformTx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'grant-tenant-a', 'au', 'implicit')
        `;
        await platformTx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'grant-tenant-a', 'au')
        `;
        await platformTx`
          insert into platform.organisations (id, slug, region, kind)
          values (${otherOrg}, 'grant-tenant-b', 'au', 'implicit')
        `;
        await platformTx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${otherCommunity}, ${otherOrg}, 'grant-tenant-b', 'au')
        `;
      });
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const people = await householdWithPeople(tx, kms);
          const owner = newId();
          await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
          await linkUser(tx, {
            now: NOW,
            userId: owner,
            personId: people.adultId,
            actorUserId: owner,
          });
        }),
      );
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: otherOrg, communityId: otherCommunity }, async (tx) => {
          const links = await tx<{ id: string }[]>`select id::text as id from app.user_links`;
          const grants = await tx<{ id: string }[]>`
            select id::text as id from app.organisation_role_grants
          `;
          expect(links).toEqual([]);
          expect(grants).toEqual([]);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
