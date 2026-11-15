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
  AccessError,
  bootstrapOwner,
  createCustomRole,
  createInvitation,
  deleteCustomRole,
  grantRole,
  revokeInvitation,
  revokeRole,
} from "../public/index.js";
import { MemoryInvitationAddresses } from "./testing.js";

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

      await addMember(tx, member);
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
      await addMember(tx, clerk);
      await grantRole(tx, {
        now: NOW,
        userId: clerk,
        roleKey: null,
        customRoleId: desk.customRoleId,
        actorUserId: owner,
      });
      await addMember(tx, member);
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

  it("stores people.view and people.manage in custom_role_permissions and rejects an unknown permission via CHECK", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'st-check', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'st-check', 'au')
        `;
      });

      let roleId = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const owner = newId();
          await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });

          const role = await createCustomRole(tx, {
            now: NOW,
            key: "contacts_lead",
            permissions: ["people.view", "people.manage"],
            actorUserId: owner,
          });
          roleId = role.customRoleId;

          const perms = await tx<{ permission: string }[]>`
            select permission
            from app.custom_role_permissions
            where custom_role_id = ${role.customRoleId}::uuid
            order by permission
          `;
          expect(perms).toEqual([{ permission: "people.manage" }, { permission: "people.view" }]);
        }),
      );

      await expect(
        withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(
            app,
            { orgId: organisationId, communityId },
            (tx) =>
              tx`
              insert into app.custom_role_permissions (
                org_id, community_id, custom_role_id, permission
              ) values (
                current_setting('app.org_id')::uuid,
                current_setting('app.community_id')::uuid,
                ${roleId}::uuid,
                'unknown.permission'
              )
            `,
          ),
        ),
      ).rejects.toMatchObject({
        constraint_name: "custom_role_permissions_permission",
      });
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("pin 30: deletes custom roles with pending/expired/revoked invitations correctly", async () => {
    await withParish("pin-30-roles", async (tx) => {
      const owner = newId();
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
      const dummyHash = Buffer.alloc(32, 7);

      // (a) unexpired pending invitation gives role_in_use
      const roleA = await createCustomRole(tx, {
        now: NOW,
        key: "role_pending_unexpired",
        permissions: ["access.users.view"],
        actorUserId: owner,
      });
      const invA = newId();
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
          person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
        ) values (
          ${invA}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
          ${owner}::uuid, ${dummyHash}, null, ${roleA.customRoleId}::uuid,
          null, 'pending', ${new Date(NOW.getTime() + 7 * 86400000)}, 0, ${NOW}, null, null, ${NOW}
        )
      `;
      await expect(
        deleteCustomRole(tx, {
          now: NOW,
          customRoleId: roleA.customRoleId,
          actorUserId: owner,
        }),
      ).rejects.toThrow(new AccessError("role_in_use"));

      // (b) role named only by expired pending invitation deletes; invitation becomes void with custom_role_id & person_id null, closed_at set, and audit voided row written
      const roleB = await createCustomRole(tx, {
        now: NOW,
        key: "role_pending_expired",
        permissions: ["access.users.view"],
        actorUserId: owner,
      });
      const invB = newId();
      await tx`
        insert into app.invitations (
          id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
          person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
        ) values (
          ${invB}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
          ${owner}::uuid, ${dummyHash}, null, ${roleB.customRoleId}::uuid,
          null, 'pending', ${new Date(NOW.getTime() - 86400000)}, 0, ${NOW}, null, null, ${NOW}
        )
      `;
      await deleteCustomRole(tx, {
        now: NOW,
        customRoleId: roleB.customRoleId,
        actorUserId: owner,
      });

      const roleBRows = await tx<{ id: string }[]>`
        select id::text as id from app.custom_roles where id = ${roleB.customRoleId}::uuid
      `;
      expect(roleBRows).toHaveLength(0);

      const invBRows = await tx<
        {
          status: string;
          custom_role_id: string | null;
          person_id: string | null;
          closed_at: Date | null;
        }[]
      >`
        select status, custom_role_id::text as custom_role_id, person_id::text as person_id, closed_at
        from app.invitations
        where id = ${invB}::uuid
      `;
      expect(invBRows).toEqual([
        {
          status: "void",
          custom_role_id: null,
          person_id: null,
          closed_at: NOW,
        },
      ]);

      const voidAudit = await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.invitation.voided'
          and ${invB}::uuid = any(target_ids)
      `;
      expect(voidAudit).toEqual([{ target_ids: [invB] }]);

      // (c) a role named only by a revoked invitation deletes
      const roleC = await createCustomRole(tx, {
        now: NOW,
        key: "role_revoked",
        permissions: ["access.users.view"],
        actorUserId: owner,
      });
      const invC = newId();
      const stubC = new MemoryInvitationAddresses();
      await createInvitation(tx, stubC, {
        invitationId: invC,
        actorUserId: owner,
        address: "revoked-role@example.test",
        customRoleId: roleC.customRoleId,
        now: NOW,
      });
      await revokeInvitation(tx, stubC, {
        invitationId: invC,
        actorUserId: owner,
        now: NOW,
      });
      await deleteCustomRole(tx, {
        now: NOW,
        customRoleId: roleC.customRoleId,
        actorUserId: owner,
      });
      const roleCRows = await tx<{ id: string }[]>`
        select id::text as id from app.custom_roles where id = ${roleC.customRoleId}::uuid
      `;
      expect(roleCRows).toHaveLength(0);
    });
  });

  it("serialises custom-role delete with createInvitation in both orders (delete first, create first)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const holderApp = createPlaintextAppSql(roleUrl(runtime, "app"));
    const runnerApp = createPlaintextAppSql(roleUrl(runtime, "app"));
    const observerApp = createPlaintextAppSql(roleUrl(runtime, "app"));

    const organisationId = newId();
    const communityId = newId();
    const scope = { orgId: organisationId, communityId };
    const owner = newId();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'cr-concurrency', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'cr-concurrency', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
        }),
      );

      // (a) Delete first: Delete runs and holds its transaction open, and create starts with that custom role.
      // Commit the delete: create gives role_not_found, and there is no invitation row.
      let roleAId = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const roleA = await createCustomRole(tx, {
            now: NOW,
            key: "role_del_first",
            permissions: ["access.users.view"],
            actorUserId: owner,
          });
          roleAId = roleA.customRoleId;
        }),
      );

      let deleteActionDoneResolve!: () => void;
      const deleteActionDone = new Promise<void>((r) => {
        deleteActionDoneResolve = r;
      });
      let releaseDeleteResolve!: () => void;
      const releaseDelete = new Promise<void>((r) => {
        releaseDeleteResolve = r;
      });

      const deleteTxPromise = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(holderApp, scope, async (tx) => {
          await deleteCustomRole(tx, {
            now: NOW,
            customRoleId: roleAId,
            actorUserId: owner,
          });
          deleteActionDoneResolve();
          await releaseDelete;
        }),
      );

      await deleteActionDone;

      const stubA = new MemoryInvitationAddresses();
      const invAId = newId();
      let createASettled = false;
      const createAPromise = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(runnerApp, scope, async (tx) => {
          return createInvitation(tx, stubA, {
            invitationId: invAId,
            actorUserId: owner,
            address: "concurrency-a@example.test",
            customRoleId: roleAId,
            now: NOW,
          });
        }),
      ).finally(() => {
        createASettled = true;
      });

      // Poll pg_locks until the second transaction waits on advisory lock (granted = false)
      let secondWaitedA = false;
      const startA = Date.now();
      while (Date.now() - startA < 5_000) {
        const waiting = await observerApp<{ n: number }[]>`
          select count(*)::int as n
          from pg_locks
          where locktype = 'advisory'
            and not granted
        `;
        if ((waiting[0]?.n ?? 0) >= 1) {
          secondWaitedA = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(secondWaitedA).toBe(true);
      expect(createASettled).toBe(false);

      // Commit the delete
      releaseDeleteResolve();
      await deleteTxPromise;

      // Create should finish with role_not_found
      const createAResult = await createAPromise.then(
        () => "resolved",
        (e) => e,
      );
      expect(createAResult).toBeInstanceOf(AccessError);
      expect((createAResult as AccessError).code).toBe("role_not_found");

      // Verify no invitation row
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(observerApp, scope, async (tx) => {
          const invRows = await tx<{ id: string }[]>`
            select id::text as id from app.invitations where id = ${invAId}::uuid
          `;
          expect(invRows).toHaveLength(0);
        }),
      );

      // (b) Create first: Create runs and holds its transaction open, and delete starts.
      // Commit the create: delete gives role_in_use, and the role still exists.
      let roleBId = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const roleB = await createCustomRole(tx, {
            now: NOW,
            key: "role_create_first",
            permissions: ["access.users.view"],
            actorUserId: owner,
          });
          roleBId = roleB.customRoleId;
        }),
      );

      let createActionDoneResolve!: () => void;
      const createActionDone = new Promise<void>((r) => {
        createActionDoneResolve = r;
      });
      let releaseCreateResolve!: () => void;
      const releaseCreate = new Promise<void>((r) => {
        releaseCreateResolve = r;
      });

      const stubB = new MemoryInvitationAddresses();
      const invBId = newId();

      const createTxPromise = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(holderApp, scope, async (tx) => {
          await createInvitation(tx, stubB, {
            invitationId: invBId,
            actorUserId: owner,
            address: "concurrency-b@example.test",
            customRoleId: roleBId,
            now: NOW,
          });
          createActionDoneResolve();
          await releaseCreate;
        }),
      );

      await createActionDone;

      let deleteBSettled = false;
      const deleteBPromise = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(runnerApp, scope, async (tx) => {
          return deleteCustomRole(tx, {
            now: NOW,
            customRoleId: roleBId,
            actorUserId: owner,
          });
        }),
      ).finally(() => {
        deleteBSettled = true;
      });

      // Poll pg_locks until delete waits on advisory lock (granted = false)
      let secondWaitedB = false;
      const startB = Date.now();
      while (Date.now() - startB < 5_000) {
        const waiting = await observerApp<{ n: number }[]>`
          select count(*)::int as n
          from pg_locks
          where locktype = 'advisory'
            and not granted
        `;
        if ((waiting[0]?.n ?? 0) >= 1) {
          secondWaitedB = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(secondWaitedB).toBe(true);
      expect(deleteBSettled).toBe(false);

      // Commit the create
      releaseCreateResolve();
      await createTxPromise;

      // Delete should give role_in_use
      const deleteBResult = await deleteBPromise.then(
        () => "resolved",
        (e) => e,
      );
      expect(deleteBResult).toBeInstanceOf(AccessError);
      expect((deleteBResult as AccessError).code).toBe("role_in_use");

      // Verify the role still exists
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(observerApp, scope, async (tx) => {
          const roleRows = await tx<{ id: string }[]>`
            select id::text as id from app.custom_roles where id = ${roleBId}::uuid
          `;
          expect(roleRows).toHaveLength(1);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await holderApp.end({ timeout: 1 });
      await runnerApp.end({ timeout: 1 });
      await observerApp.end({ timeout: 1 });
    }
  }, 15_000);

  it("pin 53: deleteCustomRole without access.roles.manage settles with forbidden while organisation lock is held", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const holderApp = createPlaintextAppSql(roleUrl(runtime, "app"));
    const runnerApp = createPlaintextAppSql(roleUrl(runtime, "app"));

    const organisationId = newId();
    const communityId = newId();
    const scope = { orgId: organisationId, communityId };
    const owner = newId();
    const unprivileged = newId();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'pin-53-org', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'pin-53-comm', 'au')
        `;
      });

      let roleId = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
          await addMember(tx, unprivileged);
          const role = await createCustomRole(tx, {
            now: NOW,
            key: "pin53_role",
            permissions: ["access.users.view"],
            actorUserId: owner,
          });
          roleId = role.customRoleId;
        }),
      );

      let lockHeldResolve!: () => void;
      const lockHeld = new Promise<void>((r) => {
        lockHeldResolve = r;
      });
      let releaseLockResolve!: () => void;
      const releaseLock = new Promise<void>((r) => {
        releaseLockResolve = r;
      });

      const holderPromise = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(holderApp, scope, async (tx) => {
          await tx`
            select pg_advisory_xact_lock(
              hashtextextended('access.org:' || current_setting('app.org_id'), 0)
            )
          `;
          lockHeldResolve();
          await releaseLock;
        }),
      );

      await lockHeld;

      const TIMEOUT_SENTINEL = Symbol("timeout");
      const callPromise = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(runnerApp, scope, async (tx) => {
          await deleteCustomRole(tx, {
            now: NOW,
            customRoleId: roleId,
            actorUserId: unprivileged,
          });
        }),
      ).then(
        () => "resolved" as const,
        (err) => err,
      );

      const timerPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        setTimeout(() => resolve(TIMEOUT_SENTINEL), 2000);
      });

      const outcome = await Promise.race([callPromise, timerPromise]);

      releaseLockResolve();
      await holderPromise;

      expect(outcome).not.toBe(TIMEOUT_SENTINEL);
      expect(outcome).toBeInstanceOf(AccessError);
      expect((outcome as AccessError).code).toBe("forbidden");
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await holderApp.end({ timeout: 1 });
      await runnerApp.end({ timeout: 1 });
    }
  }, 10_000);
});
