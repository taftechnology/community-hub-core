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
  findOwner,
  grantRole,
  linkUser,
  revokeRole,
  unlinkUser,
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

async function revokeInTransaction(
  runtime: Runtime,
  scope: { orgId: string; communityId: string },
  grantId: string,
  actorUserId: string,
): Promise<void> {
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  try {
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, (tx) =>
        revokeRole(tx, {
          now: NOW,
          grantId,
          scope: "organisation",
          actorUserId,
        }),
      ),
    );
  } finally {
    await app.end({ timeout: 1 });
  }
}

async function bootstrapInTransaction(
  runtime: Runtime,
  scope: { orgId: string; communityId: string },
  userId: string,
): Promise<void> {
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  try {
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId, actorUserId: userId }),
      ),
    );
  } finally {
    await app.end({ timeout: 1 });
  }
}

describe("links, bootstrap, and grants", () => {
  it("creates one owner when two bootstraps run together", async () => {
    const runtime = loadRuntime();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
      const organisationId = newId();
      const communityId = newId();
      const first = newId();
      const second = newId();
      const slug = `grant-boot-${attempt}`;
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
        const scope = { orgId: organisationId, communityId };
        await Promise.allSettled([
          bootstrapInTransaction(runtime, scope, first),
          bootstrapInTransaction(runtime, scope, second),
        ]);
        const app = createPlaintextAppSql(roleUrl(runtime, "app"));
        try {
          const counts = await withRequest({ requestId: REQUEST_ID }, () =>
            withAppTransaction(app, scope, async (tx) => {
              const owners = await tx<{ n: number }[]>`
                select count(*)::int as n
                from app.organisation_role_grants
                where role_key = 'org_owner'
              `;
              const community = await tx<{ n: number }[]>`
                select count(*)::int as n from app.community_role_grants
              `;
              return { owners: owners[0]?.n ?? 0, community: community[0]?.n ?? 0 };
            }),
          );
          expect(counts, slug).toEqual({ owners: 1, community: 1 });
        } finally {
          await app.end({ timeout: 1 });
        }
      } finally {
        await platform.end({ timeout: 1 });
      }
    }
  }, 20_000);

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

  it("finds no owner before bootstrap and the bootstrapped owner after", async () => {
    await withParish("grant-find-owner", async (tx) => {
      expect(await findOwner(tx)).toBeNull();
      const owner = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      expect(await findOwner(tx)).toEqual({ userId: owner });
    });
  });

  it("finds the owner from an organisation-level grant alone", async () => {
    await withParish("grant-find-owner-org-only", async (tx) => {
      const owner = newId();
      await tx`
        insert into app.organisation_role_grants (id, org_id, user_id, role_key)
        values (
          ${newId()}::uuid,
          current_setting('app.org_id')::uuid,
          ${owner}::uuid,
          'org_owner'
        )
      `;
      const community = await tx<{ n: number }[]>`
        select count(*)::int as n from app.community_role_grants
      `;
      expect(community).toEqual([{ n: 0 }]);
      expect(await findOwner(tx)).toEqual({ userId: owner });
    });
  });

  it("falls back to a community-level grant when no organisation-level grant exists", async () => {
    await withParish("grant-find-owner-community-only", async (tx) => {
      const owner = newId();
      await tx`
        insert into app.community_role_grants (
          id, org_id, community_id, user_id, role_key, custom_role_id
        ) values (
          ${newId()}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${owner}::uuid,
          'community_admin',
          null
        )
      `;
      const organisation = await tx<{ n: number }[]>`
        select count(*)::int as n from app.organisation_role_grants
      `;
      expect(organisation).toEqual([{ n: 0 }]);
      expect(await findOwner(tx)).toEqual({ userId: owner });
    });
  });

  it("does not find an owner bootstrapped in a different organisation", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const otherOrg = newId();
    const otherCommunity = newId();
    try {
      await platform.begin(async (platformTx) => {
        await platformTx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'grant-find-owner-tenant-a', 'au', 'implicit')
        `;
        await platformTx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'grant-find-owner-tenant-a', 'au')
        `;
        await platformTx`
          insert into platform.organisations (id, slug, region, kind)
          values (${otherOrg}, 'grant-find-owner-tenant-b', 'au', 'implicit')
        `;
        await platformTx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${otherCommunity}, ${otherOrg}, 'grant-find-owner-tenant-b', 'au')
        `;
      });
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const owner = newId();
          await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
          expect(await findOwner(tx)).toEqual({ userId: owner });
        }),
      );
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: otherOrg, communityId: otherCommunity }, async (tx) => {
          expect(await findOwner(tx)).toBeNull();
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("refuses a link and an unlink without users.manage", async () => {
    await withParish("grant-link-permission", async (tx, kms) => {
      const people = await householdWithPeople(tx, kms);
      const owner = newId();
      const stranger = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      await linkUser(tx, {
        now: NOW,
        userId: owner,
        personId: people.adultId,
        actorUserId: owner,
      });
      await expect(
        linkUser(tx, {
          now: NOW,
          userId: stranger,
          personId: people.adultId,
          actorUserId: stranger,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        unlinkUser(tx, { now: NOW, userId: owner, actorUserId: stranger }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const links = await tx<{ user_id: string }[]>`
        select user_id::text as user_id from app.user_links
      `;
      expect(links).toEqual([{ user_id: owner }]);
    });
  });

  it("links an adult and refuses a minor", async () => {
    await withParish("grant-link", async (tx, kms) => {
      const people = await householdWithPeople(tx, kms);
      const owner = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
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

  it("leaves one owner when two owner revokes run together", async () => {
    const runtime = loadRuntime();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
      const app = createPlaintextAppSql(roleUrl(runtime, "app"));
      const organisationId = newId();
      const communityId = newId();
      const first = newId();
      const second = newId();
      const slug = `grant-lock-${attempt}`;
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
        const scope = { orgId: organisationId, communityId };
        const boot = await withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(app, scope, (tx) =>
            bootstrapOwner(tx, { now: NOW, userId: first, actorUserId: first }),
          ),
        );
        const other = await withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(app, scope, (tx) =>
            grantRole(tx, {
              now: NOW,
              userId: second,
              roleKey: "org_owner",
              customRoleId: null,
              actorUserId: first,
            }),
          ),
        );
        await Promise.allSettled([
          revokeInTransaction(runtime, scope, other.grantId, first),
          revokeInTransaction(runtime, scope, boot.organisationGrantId, second),
        ]);
        const owners = await withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(app, scope, async (tx) => {
            const rows = await tx<{ n: number }[]>`
              select count(*)::int as n
              from app.organisation_role_grants
              where role_key = 'org_owner'
            `;
            return rows[0]?.n ?? 0;
          }),
        );
        expect(owners, slug).toBe(1);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
      }
    }
  }, 20_000);

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

  it("refuses role changes from an actor who lacks access.roles.manage", async () => {
    await withParish("pin-manage", async (tx) => {
      const owner = newId();
      const coordinator = newId();
      const memberUser = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      await grantRole(tx, {
        now: NOW,
        userId: coordinator,
        roleKey: "volunteer_coordinator",
        customRoleId: null,
        actorUserId: owner,
      });
      const member = await grantRole(tx, {
        now: NOW,
        userId: memberUser,
        roleKey: "member",
        customRoleId: null,
        actorUserId: owner,
      });
      const viewers = await createCustomRole(tx, {
        now: NOW,
        key: "viewers",
        permissions: ["access.users.view"],
        actorUserId: owner,
      });
      await expect(
        grantRole(tx, {
          now: NOW,
          userId: newId(),
          roleKey: "member",
          customRoleId: null,
          actorUserId: coordinator,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        grantRole(tx, {
          now: NOW,
          userId: newId(),
          roleKey: null,
          customRoleId: viewers.customRoleId,
          actorUserId: coordinator,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        createCustomRole(tx, {
          now: NOW,
          key: "desk",
          permissions: ["access.users.view"],
          actorUserId: coordinator,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        revokeRole(tx, {
          now: NOW,
          grantId: member.grantId,
          scope: "community",
          actorUserId: coordinator,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const still = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.community_role_grants
        where id = ${member.grantId}::uuid
      `;
      expect(still).toEqual([{ n: 1 }]);
    });
  });

  it("refuses a role whose permissions the actor does not hold", async () => {
    await withParish("pin-hold", async (tx) => {
      const owner = newId();
      const holder = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const desk = await createCustomRole(tx, {
        now: NOW,
        key: "desk",
        permissions: ["access.roles.manage"],
        actorUserId: owner,
      });
      const viewers = await createCustomRole(tx, {
        now: NOW,
        key: "viewers",
        permissions: ["access.users.view"],
        actorUserId: owner,
      });
      await grantRole(tx, {
        now: NOW,
        userId: holder,
        roleKey: null,
        customRoleId: desk.customRoleId,
        actorUserId: owner,
      });
      await expect(
        grantRole(tx, {
          now: NOW,
          userId: newId(),
          roleKey: "community_admin",
          customRoleId: null,
          actorUserId: holder,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        grantRole(tx, {
          now: NOW,
          userId: newId(),
          roleKey: null,
          customRoleId: viewers.customRoleId,
          actorUserId: holder,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        createCustomRole(tx, {
          now: NOW,
          key: "readers",
          permissions: ["access.users.view"],
          actorUserId: holder,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  it("refuses a grant to a user linked to a minor", async () => {
    await withParish("pin-minor", async (tx, kms) => {
      const owner = newId();
      const subject = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const people = await householdWithPeople(tx, kms);
      await tx`
        insert into app.user_links (id, org_id, community_id, user_id, person_id)
        values (
          ${newId()}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${subject}::uuid,
          ${people.minorId}::uuid
        )
      `;
      await expect(
        grantRole(tx, {
          now: NOW,
          userId: subject,
          roleKey: "member",
          customRoleId: null,
          actorUserId: owner,
        }),
      ).rejects.toMatchObject({ code: "minor_forbidden" });
    });
  });

  it("refuses a custom role grant to a user linked to a minor", async () => {
    await withParish("pin-custom-minor", async (tx, kms) => {
      const owner = newId();
      const subject = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const desk = await createCustomRole(tx, {
        now: NOW,
        key: "desk",
        permissions: ["access.users.view"],
        actorUserId: owner,
      });
      const people = await householdWithPeople(tx, kms);
      await tx`
        insert into app.user_links (id, org_id, community_id, user_id, person_id)
        values (
          ${newId()}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${subject}::uuid,
          ${people.minorId}::uuid
        )
      `;
      await expect(
        grantRole(tx, {
          now: NOW,
          userId: subject,
          roleKey: null,
          customRoleId: desk.customRoleId,
          actorUserId: owner,
        }),
      ).rejects.toMatchObject({ code: "minor_forbidden" });
      const grants = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.community_role_grants
        where user_id = ${subject}::uuid
      `;
      expect(grants).toEqual([{ n: 0 }]);
    });
  });

  it("writes an audit row when a second owner is revoked", async () => {
    await withParish("pin-revoke-audit", async (tx) => {
      const owner = newId();
      const second = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const granted = await grantRole(tx, {
        now: NOW,
        userId: second,
        roleKey: "org_owner",
        customRoleId: null,
        actorUserId: owner,
      });
      await revokeRole(tx, {
        now: NOW,
        grantId: granted.grantId,
        scope: "organisation",
        actorUserId: owner,
      });
      const revoked = await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.role.revoked'
          and ${granted.grantId}::uuid = any(target_ids)
      `;
      expect(revoked).toEqual([{ target_ids: [granted.grantId] }]);
    });
  });
});
