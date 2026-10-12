import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

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
  bootstrapOwner,
  createCustomRole,
  deleteCustomRole,
  grantRole,
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

async function withParish(slug: string, run: (tx: AppTransaction) => Promise<void>): Promise<void> {
  const runtime = loadRuntime();
  const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  const organisationId = newId();
  const communityId = newId();
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
      withAppTransaction(app, { orgId: organisationId, communityId }, (tx) => run(tx)),
    );
  } finally {
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
  }
}

async function roleCount(tx: AppTransaction): Promise<number> {
  const rows = await tx<{ n: number }[]>`
    select count(*)::int as n from app.custom_roles
  `;
  return rows[0]?.n ?? 0;
}

describe("custom roles", () => {
  it("caps a community at twenty catalogue roles and keeps a granted role", async () => {
    await withParish("custom-role", async (tx) => {
      const owner = newId();
      const member = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const created = await createCustomRole(tx, {
        now: NOW,
        key: "choir_lead",
        permissions: ["access.users.view"],
        actorUserId: owner,
      });
      const audits = await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.custom_role.created'
          and ${created.customRoleId}::uuid = any(target_ids)
      `;
      expect(audits).toEqual([{ target_ids: [created.customRoleId] }]);

      const grant = await grantRole(tx, {
        now: NOW,
        userId: member,
        roleKey: null,
        customRoleId: created.customRoleId,
        actorUserId: owner,
      });
      expect(grant.scope).toBe("community");
      const grants = await tx<{ role_key: string | null; custom_role_id: string }[]>`
        select role_key, custom_role_id::text as custom_role_id
        from app.community_role_grants
        where id = ${grant.grantId}::uuid
      `;
      expect(grants).toEqual([{ role_key: null, custom_role_id: created.customRoleId }]);

      await expect(
        createCustomRole(tx, {
          now: NOW,
          key: "choir_lead",
          permissions: ["access.users.view"],
          actorUserId: owner,
        }),
      ).rejects.toMatchObject({ code: "duplicate_role" });
      expect(await roleCount(tx)).toBe(1);

      await expect(
        createCustomRole(tx, {
          now: NOW,
          key: "refund_desk",
          permissions: ["giving.refund"],
          actorUserId: owner,
        }),
      ).rejects.toMatchObject({ code: "invalid_permission" });
      expect(await roleCount(tx)).toBe(1);

      for (let index = 2; index <= 20; index += 1) {
        await createCustomRole(tx, {
          now: NOW,
          key: `custom_${String(index).padStart(2, "0")}`,
          permissions: ["access.users.view"],
          actorUserId: owner,
        });
      }
      await expect(
        createCustomRole(tx, {
          now: NOW,
          key: "custom_21",
          permissions: ["access.users.view"],
          actorUserId: owner,
        }),
      ).rejects.toMatchObject({ code: "limit_reached" });
      expect(await roleCount(tx)).toBe(20);

      await expect(
        deleteCustomRole(tx, {
          now: NOW,
          customRoleId: created.customRoleId,
          actorUserId: owner,
        }),
      ).rejects.toMatchObject({ code: "role_in_use" });
      const blocked = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.custom_role_permissions
        where custom_role_id = ${created.customRoleId}::uuid
      `;
      expect(blocked).toEqual([{ n: 1 }]);

      await revokeRole(tx, {
        now: NOW,
        grantId: grant.grantId,
        scope: "community",
        actorUserId: owner,
      });
      await deleteCustomRole(tx, {
        now: NOW,
        customRoleId: created.customRoleId,
        actorUserId: owner,
      });
      const permissions = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.custom_role_permissions
        where custom_role_id = ${created.customRoleId}::uuid
      `;
      const roles = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.custom_roles
        where id = ${created.customRoleId}::uuid
      `;
      const deleted = await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.custom_role.deleted'
          and ${created.customRoleId}::uuid = any(target_ids)
      `;
      expect(permissions).toEqual([{ n: 0 }]);
      expect(roles).toEqual([{ n: 0 }]);
      expect(deleted).toEqual([{ target_ids: [created.customRoleId] }]);
    });
  });

  it("loads a custom role grant for a later grant", async () => {
    await withParish("custom-grant", async (tx) => {
      const owner = newId();
      const clerk = newId();
      const member = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const choir = await createCustomRole(tx, {
        now: NOW,
        key: "choir_lead",
        permissions: ["access.users.view"],
        actorUserId: owner,
      });
      const desk = await createCustomRole(tx, {
        now: NOW,
        key: "desk_clerk",
        permissions: ["access.roles.manage", "access.users.view"],
        actorUserId: owner,
      });
      await grantRole(tx, {
        now: NOW,
        userId: clerk,
        roleKey: null,
        customRoleId: desk.customRoleId,
        actorUserId: owner,
      });
      const granted = await grantRole(tx, {
        now: NOW,
        userId: member,
        roleKey: null,
        customRoleId: choir.customRoleId,
        actorUserId: clerk,
      });
      expect(granted.scope).toBe("community");
      const rows = await tx<{ role_key: string | null; custom_role_id: string }[]>`
        select role_key, custom_role_id::text as custom_role_id
        from app.community_role_grants
        where id = ${granted.grantId}::uuid
      `;
      expect(rows).toEqual([{ role_key: null, custom_role_id: choir.customRoleId }]);
    });
  });
});
