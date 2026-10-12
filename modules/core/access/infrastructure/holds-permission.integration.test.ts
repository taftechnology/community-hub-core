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

import { bootstrapOwner, grantRole, holdsPermission } from "../public/index.js";

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

async function auditCount(tx: AppTransaction): Promise<number> {
  const rows = await tx<{ n: number }[]>`
    select count(*)::int as n
    from app.audit_events
    where org_id = current_setting('app.org_id')::uuid
  `;
  return rows[0]?.n ?? 0;
}

describe("holdsPermission", () => {
  it("reads staff and a custom role without writing an audit row", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const slug = `holds-${newId().replaceAll("-", "").slice(0, 12)}`;
    const ownerId = newId();
    const staffId = newId();
    const strangerId = newId();
    const customUserId = newId();
    const customRoleId = newId();
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
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          await bootstrapOwner(tx, { now: NOW, userId: ownerId, actorUserId: ownerId });
          await grantRole(tx, {
            now: NOW,
            userId: staffId,
            roleKey: "staff",
            customRoleId: null,
            actorUserId: ownerId,
          });
          await tx`
            insert into app.custom_roles (id, org_id, community_id, key)
            values (
              ${customRoleId}::uuid,
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              'toggle_lead'
            )
          `;
          await tx`
            insert into app.custom_role_permissions (
              org_id, community_id, custom_role_id, permission
            ) values (
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              ${customRoleId}::uuid,
              'entitlements.manage'
            )
          `;
          await tx`
            insert into app.community_role_grants (
              id, org_id, community_id, user_id, role_key, custom_role_id
            ) values (
              ${newId()}::uuid,
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              ${customUserId}::uuid,
              null,
              ${customRoleId}::uuid
            )
          `;
          const before = await auditCount(tx);
          expect(await holdsPermission(tx, staffId, "entitlements.view")).toBe(true);
          expect(await holdsPermission(tx, staffId, "entitlements.manage")).toBe(false);
          expect(await holdsPermission(tx, strangerId, "entitlements.view")).toBe(false);
          expect(await holdsPermission(tx, customUserId, "entitlements.manage")).toBe(true);
          expect(await holdsPermission(tx, customUserId, "entitlements.view")).toBe(false);
          expect(await auditCount(tx)).toBe(before);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
