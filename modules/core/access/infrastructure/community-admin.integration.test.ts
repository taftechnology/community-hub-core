import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { addMember } from "@community-hub/access/testing";
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
  CATALOGUE_PERMISSIONS,
  COMMUNITY_ROLE_KEYS,
  ORGANISATION_ROLE_KEYS,
} from "../domain/role.js";
import {
  bootstrapOwner,
  createCustomRole,
  grantRole,
  isCommunityAdmin,
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

const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-10-12T00:00:00.000Z");

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

async function withParish(slug: string, run: (tx: AppTransaction) => Promise<void>): Promise<void> {
  const runtime = loadRuntime();
  const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  const organisationId = newId();
  const communityId = newId();
  const uniqueSlug = `${slug}-${organisationId.slice(0, 8)}`;
  try {
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${organisationId}, ${uniqueSlug}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${organisationId}, ${uniqueSlug}, 'au')
      `;
    });
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: organisationId, communityId }, (tx) => run(tx)),
    );
  } finally {
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
  }
}

describe("isCommunityAdmin", () => {
  it("returns true for a community_admin grant in the scoped community", async () => {
    await withParish("ca-scoped", async (tx) => {
      const owner = newId();
      const adminUser = newId();
      const stranger = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      await addMember(tx, adminUser);
      await grantRole(tx, {
        now: NOW,
        userId: adminUser,
        roleKey: "community_admin",
        customRoleId: null,
        actorUserId: owner,
      });

      expect(await isCommunityAdmin(tx, owner)).toBe(true);
      expect(await isCommunityAdmin(tx, adminUser)).toBe(true);
      expect(await isCommunityAdmin(tx, stranger)).toBe(false);
    });
  });

  it("staff in the community is not a Community Admin (pin 13)", async () => {
    await withParish("ca-pin13", async (tx) => {
      const owner = newId();
      const staffUser = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      await addMember(tx, staffUser);
      await grantRole(tx, {
        now: NOW,
        userId: staffUser,
        roleKey: "staff",
        customRoleId: null,
        actorUserId: owner,
      });

      expect(await isCommunityAdmin(tx, staffUser)).toBe(false);
    });
  });

  it("an org_owner with no community grant is not a Community Admin (pin 16)", async () => {
    await withParish("ca-pin16", async (tx) => {
      const owner = newId();
      const orgOwnerOnly = newId();
      const orgAdminOnly = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      await addMember(tx, orgOwnerOnly);
      await grantRole(tx, {
        now: NOW,
        userId: orgOwnerOnly,
        roleKey: "org_owner",
        customRoleId: null,
        actorUserId: owner,
      });
      await addMember(tx, orgAdminOnly);
      await grantRole(tx, {
        now: NOW,
        userId: orgAdminOnly,
        roleKey: "org_admin",
        customRoleId: null,
        actorUserId: owner,
      });

      expect(await isCommunityAdmin(tx, orgOwnerOnly)).toBe(false);
      expect(await isCommunityAdmin(tx, orgAdminOnly)).toBe(false);
    });
  });

  it("a custom role with every permission is not a Community Admin (pin 17)", async () => {
    await withParish("ca-pin17", async (tx) => {
      const owner = newId();
      const customUser = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const role = await createCustomRole(tx, {
        now: NOW,
        key: "all_perms",
        permissions: [...CATALOGUE_PERMISSIONS],
        actorUserId: owner,
      });
      await addMember(tx, customUser);
      await grantRole(tx, {
        now: NOW,
        userId: customUser,
        roleKey: null,
        customRoleId: role.customRoleId,
        actorUserId: owner,
      });

      expect(await isCommunityAdmin(tx, customUser)).toBe(false);
    });
  });

  it("refuses every other built-in community and organisation role key", async () => {
    await withParish("ca-all-roles", async (tx) => {
      const owner = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });

      for (const roleKey of COMMUNITY_ROLE_KEYS) {
        if (roleKey === "community_admin") {
          continue;
        }
        const userId = newId();
        await addMember(tx, userId);
        await grantRole(tx, {
          now: NOW,
          userId,
          roleKey,
          customRoleId: null,
          actorUserId: owner,
        });
        expect(await isCommunityAdmin(tx, userId), `community role ${roleKey}`).toBe(false);
      }

      for (const roleKey of ORGANISATION_ROLE_KEYS) {
        const userId = newId();
        await addMember(tx, userId);
        await grantRole(tx, {
          now: NOW,
          userId,
          roleKey,
          customRoleId: null,
          actorUserId: owner,
        });
        expect(await isCommunityAdmin(tx, userId), `organisation role ${roleKey}`).toBe(false);
      }
    });
  });

  it("refuses a community_admin grant in another community of the same organisation or another organisation", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));

    const orgA = newId();
    const commA1 = newId();
    const commA2 = newId();
    const orgB = newId();
    const commB1 = newId();
    const commB2 = newId();

    const adminA1 = newId();
    const adminA2 = newId();
    const adminB1 = newId();
    const adminB2 = newId();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values
            (${orgA}, ${`ca-a-${orgA.slice(0, 8)}`}, 'au', 'implicit'),
            (${orgB}, ${`ca-b-${orgB.slice(0, 8)}`}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values
            (${commA1}, ${orgA}, ${`ca-a1-${commA1.slice(0, 8)}`}, 'au'),
            (${commA2}, ${orgA}, ${`ca-a2-${commA2.slice(0, 8)}`}, 'au'),
            (${commB1}, ${orgB}, ${`ca-b1-${commB1.slice(0, 8)}`}, 'au'),
            (${commB2}, ${orgB}, ${`ca-b2-${commB2.slice(0, 8)}`}, 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, { orgId: orgA, communityId: commA2 }, async (tx) => {
          const ownerA2 = newId();
          await bootstrapOwner(tx, { now: NOW, userId: ownerA2, actorUserId: ownerA2 });
          await addMember(tx, adminA2);
          await grantRole(tx, {
            now: NOW,
            userId: adminA2,
            roleKey: "community_admin",
            customRoleId: null,
            actorUserId: ownerA2,
          });
        });

        await withAppTransaction(app, { orgId: orgB, communityId: commB1 }, async (tx) => {
          const ownerB1 = newId();
          await bootstrapOwner(tx, { now: NOW, userId: ownerB1, actorUserId: ownerB1 });
          await addMember(tx, adminB1);
          await grantRole(tx, {
            now: NOW,
            userId: adminB1,
            roleKey: "community_admin",
            customRoleId: null,
            actorUserId: ownerB1,
          });
        });

        await withAppTransaction(app, { orgId: orgB, communityId: commB2 }, async (tx) => {
          const ownerB2 = newId();
          await addMember(tx, ownerB2);
          await tx`
            insert into app.community_role_grants (
              id, org_id, community_id, user_id, role_key, custom_role_id
            ) values (
              ${newId()}::uuid,
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              ${ownerB2}::uuid,
              'community_admin',
              null
            )
          `;
          await addMember(tx, adminB2);
          await grantRole(tx, {
            now: NOW,
            userId: adminB2,
            roleKey: "community_admin",
            customRoleId: null,
            actorUserId: ownerB2,
          });
        });

        await withAppTransaction(app, { orgId: orgA, communityId: commA1 }, async (tx) => {
          const ownerA1 = newId();
          await addMember(tx, ownerA1);
          await tx`
            insert into app.community_role_grants (
              id, org_id, community_id, user_id, role_key, custom_role_id
            ) values (
              ${newId()}::uuid,
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              ${ownerA1}::uuid,
              'community_admin',
              null
            )
          `;
          await addMember(tx, adminA1);
          await grantRole(tx, {
            now: NOW,
            userId: adminA1,
            roleKey: "community_admin",
            customRoleId: null,
            actorUserId: ownerA1,
          });

          expect(await isCommunityAdmin(tx, adminA1)).toBe(true);
          expect(await isCommunityAdmin(tx, adminA2)).toBe(false);
          expect(await isCommunityAdmin(tx, adminB1)).toBe(false);
          expect(await isCommunityAdmin(tx, adminB2)).toBe(false);
        });

        await withAppTransaction(app, { orgId: orgA, communityId: commA2 }, async (tx) => {
          expect(await isCommunityAdmin(tx, adminA2)).toBe(true);
          expect(await isCommunityAdmin(tx, adminA1)).toBe(false);
        });

        await withAppTransaction(app, { orgId: orgB, communityId: commB1 }, async (tx) => {
          expect(await isCommunityAdmin(tx, adminB1)).toBe(true);
          expect(await isCommunityAdmin(tx, adminA1)).toBe(false);
          expect(await isCommunityAdmin(tx, adminB2)).toBe(false);
        });
      });
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("returns false after a community_admin grant is deleted", async () => {
    await withParish("ca-deleted", async (tx) => {
      const owner = newId();
      const adminUser = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      await addMember(tx, adminUser);
      const grant = await grantRole(tx, {
        now: NOW,
        userId: adminUser,
        roleKey: "community_admin",
        customRoleId: null,
        actorUserId: owner,
      });

      expect(await isCommunityAdmin(tx, adminUser)).toBe(true);

      await revokeRole(tx, {
        now: NOW,
        grantId: grant.grantId,
        scope: "community",
        actorUserId: owner,
      });

      expect(await isCommunityAdmin(tx, adminUser)).toBe(false);
    });
  });
});
