import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { holdsAnyGrant } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const REQUEST_ID = "55555555-5555-4555-8555-555555555555";

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

describe("holdsAnyGrant", () => {
  it("returns true for grants in scope and false across org or community boundaries", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));

    const organisationA = newId();
    const communityA1 = newId();
    const communityA2 = newId();
    const organisationB = newId();
    const communityB1 = newId();

    const slugA = `granta-${newId().replaceAll("-", "").slice(0, 12)}`;
    const slugA2 = `granta2-${newId().replaceAll("-", "").slice(0, 12)}`;
    const slugB = `grantb-${newId().replaceAll("-", "").slice(0, 12)}`;

    const orgGrantUser = newId();
    const communityRoleUser = newId();
    const memberUser = newId();
    const customRoleUser = newId();
    const otherOrgUser = newId();
    const otherCommunityUser = newId();
    const customRoleId = newId();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values
            (${organisationA}, ${slugA}, 'au', 'implicit'),
            (${organisationB}, ${slugB}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values
            (${communityA1}, ${organisationA}, ${slugA}, 'au'),
            (${communityA2}, ${organisationA}, ${slugA2}, 'au'),
            (${communityB1}, ${organisationB}, ${slugB}, 'au')
        `;
      });

      // Populate organisation B grants
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationB, communityId: communityB1 }, async (tx) => {
          await tx`
            insert into app.community_role_grants (
              id, org_id, community_id, user_id, role_key, custom_role_id
            ) values (
              ${newId()}::uuid,
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              ${otherOrgUser}::uuid,
              'staff',
              null
            )
          `;
          await tx`
            insert into app.organisation_role_grants (
              id, org_id, user_id, role_key
            ) values (
              ${newId()}::uuid,
              current_setting('app.org_id')::uuid,
              ${otherOrgUser}::uuid,
              'org_billing'
            )
          `;
        }),
      );

      // Populate organisation A, community A2 grants
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationA, communityId: communityA2 }, async (tx) => {
          await tx`
            insert into app.community_role_grants (
              id, org_id, community_id, user_id, role_key, custom_role_id
            ) values (
              ${newId()}::uuid,
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              ${otherCommunityUser}::uuid,
              'staff',
              null
            )
          `;
        }),
      );

      // Populate organisation A, community A1 grants and test holdsAnyGrant
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationA, communityId: communityA1 }, async (tx) => {
          // Organisation grant
          await tx`
            insert into app.organisation_role_grants (
              id, org_id, user_id, role_key
            ) values (
              ${newId()}::uuid,
              current_setting('app.org_id')::uuid,
              ${orgGrantUser}::uuid,
              'org_billing'
            )
          `;

          // Community role grant
          await tx`
            insert into app.community_role_grants (
              id, org_id, community_id, user_id, role_key, custom_role_id
            ) values (
              ${newId()}::uuid,
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              ${communityRoleUser}::uuid,
              'staff',
              null
            )
          `;

          // Member grant
          await tx`
            insert into app.community_role_grants (
              id, org_id, community_id, user_id, role_key, custom_role_id
            ) values (
              ${newId()}::uuid,
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              ${memberUser}::uuid,
              'member',
              null
            )
          `;

          // Custom role grant
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
              'entitlements.view'
            )
          `;
          await tx`
            insert into app.community_role_grants (
              id, org_id, community_id, user_id, role_key, custom_role_id
            ) values (
              ${newId()}::uuid,
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              ${customRoleUser}::uuid,
              null,
              ${customRoleId}::uuid
            )
          `;

          // Assertions
          expect(await holdsAnyGrant(tx, orgGrantUser)).toBe(true);
          expect(await holdsAnyGrant(tx, communityRoleUser)).toBe(true);
          expect(await holdsAnyGrant(tx, memberUser)).toBe(true);
          expect(await holdsAnyGrant(tx, customRoleUser)).toBe(true);
          expect(await holdsAnyGrant(tx, otherOrgUser)).toBe(false);
          expect(await holdsAnyGrant(tx, otherCommunityUser)).toBe(false);
        }),
      );

      // Inserting billing.manage into app.custom_role_permissions fails with SQLSTATE 23514
      await expect(
        withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(
            app,
            { orgId: organisationA, communityId: communityA1 },
            async (tx) => {
              await tx`
              insert into app.custom_role_permissions (
                org_id, community_id, custom_role_id, permission
              ) values (
                current_setting('app.org_id')::uuid,
                current_setting('app.community_id')::uuid,
                ${customRoleId}::uuid,
                'billing.manage'
              )
            `;
            },
          ),
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "custom_role_permissions_permission",
      });
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
