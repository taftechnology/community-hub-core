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

import { AccessError, bootstrapOwner, createCustomRole, grantRole } from "../public/index.js";
import {
  createInvitation,
  deleteInvitationAfterMailFailure,
  listInvitations,
  resendInvitation,
  revokeInvitation,
  voidInvitationAfterMailFailure,
} from "./invitations.js";
import { lockOrganisation } from "./membership.js";
import { addMember, MemoryInvitationAddresses } from "./testing.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
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

async function withTwoOrgs(
  run: (env: {
    app: ReturnType<typeof createPlaintextAppSql>;
    direct: ReturnType<typeof createPlaintextDirectSql>;
    kms: ReturnType<typeof createLocalKmsPort>;
    orgA: { organisationId: string; community1Id: string; community2Id: string };
    orgB: { organisationId: string; communityId: string };
  }) => Promise<void>,
): Promise<void> {
  const runtime = loadRuntime();
  const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
  const kms = createLocalKmsPort();
  const orgA = {
    organisationId: newId(),
    community1Id: newId(),
    community2Id: newId(),
  };
  const orgB = { organisationId: newId(), communityId: newId() };

  const slugA = `org-a-${orgA.organisationId.replaceAll("-", "")}`;
  const slugB = `org-b-${orgB.organisationId.replaceAll("-", "")}`;
  const slugA1 = `comm-a1-${orgA.community1Id.replaceAll("-", "")}`;
  const slugA2 = `comm-a2-${orgA.community2Id.replaceAll("-", "")}`;
  const slugB1 = `comm-b-${orgB.communityId.replaceAll("-", "")}`;

  try {
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values
          (${orgA.organisationId}, ${slugA}, 'au', 'implicit'),
          (${orgB.organisationId}, ${slugB}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values
          (${orgA.community1Id}, ${orgA.organisationId}, ${slugA1}, 'au'),
          (${orgA.community2Id}, ${orgA.organisationId}, ${slugA2}, 'au'),
          (${orgB.communityId}, ${orgB.organisationId}, ${slugB1}, 'au')
      `;
    });
    await run({ app, direct, kms, orgA, orgB });
  } finally {
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
    await direct.end({ timeout: 1 });
  }
}

function runInCommunity<T>(
  app: ReturnType<typeof createPlaintextAppSql>,
  scope: { orgId: string; communityId: string },
  fn: (tx: AppTransaction) => Promise<T>,
): Promise<T> {
  return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, fn));
}

async function createAdultAndMinor(
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
    declaredAdult: true,
    householdId: household.householdId,
    dateOfBirth: "1990-01-01",
    givenName: "Jane",
    familyName: "Doe",
    email: null,
    phone: null,
    actorUserId: null,
  });
  const minor = await createPerson(tx, kms, KEY_ARN, {
    now: NOW,
    declaredAdult: false,
    householdId: household.householdId,
    dateOfBirth: null,
    givenName: "Bobby",
    familyName: "Doe",
    email: null,
    phone: null,
    actorUserId: null,
  });
  return { adultId: adult.personId, minorId: minor.personId };
}

async function assertNoSensitiveDataInAudit(
  tx: AppTransaction,
  sensitiveTexts: string[],
): Promise<void> {
  const auditRows = await tx<{ payload: Record<string, unknown> }[]>`
    select to_jsonb(a) as payload
    from app.audit_events a
  `;
  for (const row of auditRows) {
    for (const [col, val] of Object.entries(row.payload)) {
      const serialized = typeof val === "string" ? val : JSON.stringify(val);
      for (const text of sensitiveTexts) {
        if (text && serialized.includes(text)) {
          throw new Error(`Sensitive text matched audit event column: ${col}`);
        }
      }
    }
  }
}

describe("invitations repository integration (pins & behaviour)", () => {
  it("pin 20: caps are checked under the organisation lock", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scopeA1 = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scopeA1, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      await runInCommunity(app, scopeA1, async (tx) => {
        const dummyHash = Buffer.alloc(32, 1);
        const twoHoursAgo = new Date(NOW.getTime() - 2 * 3600_000);
        for (let i = 0; i < 99; i++) {
          const invId = newId();
          await tx`
            insert into app.invitations (
              id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
              person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
            ) values (
              ${invId}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
              ${owner}::uuid, ${dummyHash}, 'member', null,
              null, 'pending', ${new Date(NOW.getTime() + 7 * 86400000)}, 0, ${twoHoursAgo}, null, null, ${twoHoursAgo}
            )
          `;
        }
      });

      const holderApp = createPlaintextAppSql(roleUrl(loadRuntime(), "app"));
      const observerApp = createPlaintextAppSql(roleUrl(loadRuntime(), "app"));
      let lockHeldResolve!: () => void;
      const lockHeld = new Promise<void>((r) => {
        lockHeldResolve = r;
      });
      let releaseLockResolve!: () => void;
      const releaseLock = new Promise<void>((r) => {
        releaseLockResolve = r;
      });

      let pendingCreates: Promise<PromiseSettledResult<unknown>[]>;

      const gate = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(holderApp, scopeA1, async (tx) => {
          await lockOrganisation(tx);
          lockHeldResolve();
          await releaseLock;
        }),
      );

      try {
        await lockHeld;

        const stub1 = new MemoryInvitationAddresses();
        const stub2 = new MemoryInvitationAddresses();

        let create1Settled = false;
        let create2Settled = false;

        const p1 = runInCommunity(app, scopeA1, (tx) =>
          createInvitation(tx, stub1, {
            invitationId: newId(),
            actorUserId: owner,
            address: "user1@example.test",
            roleKey: "member",
            now: NOW,
          }),
        ).finally(() => {
          create1Settled = true;
        });

        const p2 = runInCommunity(app, scopeA1, (tx) =>
          createInvitation(tx, stub2, {
            invitationId: newId(),
            actorUserId: owner,
            address: "user2@example.test",
            roleKey: "member",
            now: NOW,
          }),
        ).finally(() => {
          create2Settled = true;
        });

        pendingCreates = Promise.allSettled([p1, p2]);

        let waitedBoth = false;
        const started = Date.now();
        while (Date.now() - started < 5_000) {
          const waiting = await observerApp<{ n: number }[]>`
            select count(*)::int as n
            from pg_locks
            where locktype = 'advisory'
              and not granted
          `;
          if ((waiting[0]?.n ?? 0) >= 2) {
            waitedBoth = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        expect(waitedBoth).toBe(true);
        expect(create1Settled).toBe(false);
        expect(create2Settled).toBe(false);

        releaseLockResolve();
        await gate;

        const results = await pendingCreates;
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const err = (rejected[0] as PromiseRejectedResult).reason;
        expect(err).toBeInstanceOf(AccessError);
        expect((err as AccessError).code).toBe("too_many");

        const successfulToken = (fulfilled[0] as PromiseFulfilledResult<{ token: string }>).value
          .token;
        await runInCommunity(app, scopeA1, (tx) =>
          assertNoSensitiveDataInAudit(tx, [
            "user1@example.test",
            "user2@example.test",
            successfulToken,
          ]),
        );
      } finally {
        releaseLockResolve();
        await gate.catch(() => undefined);
        await holderApp.end({ timeout: 1 });
        await observerApp.end({ timeout: 1 });
      }
    });
  }, 15_000);

  it("pin 21 (access half): 100 pending in community 2 do not trigger too_many in community 1", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scopeA1 = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const scopeA2 = { orgId: orgA.organisationId, communityId: orgA.community2Id };
      const owner = newId();
      await runInCommunity(app, scopeA1, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      // Seed 100 pending in community 2
      await runInCommunity(app, scopeA2, async (tx) => {
        const dummyHash = Buffer.alloc(32, 2);
        for (let i = 0; i < 100; i++) {
          const invId = newId();
          await tx`
            insert into app.invitations (
              id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
              person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
            ) values (
              ${invId}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
              ${owner}::uuid, ${dummyHash}, 'member', null,
              null, 'pending', ${new Date(NOW.getTime() + 7 * 86400000)}, 0, ${NOW}, null, null, ${NOW}
            )
          `;
        }
      });

      // Create in community 1 succeeds
      const stub = new MemoryInvitationAddresses();
      const created = await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: newId(),
          actorUserId: owner,
          address: "comm1@example.test",
          roleKey: "member",
          now: NOW,
        }),
      );
      expect(created.token).toMatch(/^v1\./);
      await runInCommunity(app, scopeA1, (tx) =>
        assertNoSensitiveDataInAudit(tx, ["comm1@example.test", created.token]),
      );
    });
  });

  it("pin 22 a: re-inviting after expiry succeeds without changing earlier row and no voided audit", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const invId1 = newId();
      const stub = new MemoryInvitationAddresses();
      const address = "expired-reinvite@example.test";

      const created1 = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId1,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      // Move row 1's expires_at into the past
      const past = new Date(NOW.getTime() - 3600_000);
      await runInCommunity(app, scope, async (tx) => {
        await tx`
          update app.invitations
          set expires_at = ${past}
          where id = ${invId1}::uuid
        `;
      });

      // Snapshot row 1 columns
      const row1Snapshot = await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<
          {
            status: string;
            token_hash: Buffer;
            person_id: string | null;
            custom_role_id: string | null;
            closed_at: Date | null;
            expires_at: Date;
          }[]
        >`
          select status, token_hash, person_id::text as person_id,
                 custom_role_id::text as custom_role_id, closed_at, expires_at
          from app.invitations
          where id = ${invId1}::uuid
        `;
        return rows[0]!;
      });

      // Create again for the same address with a new id
      const invId2 = newId();
      const later = new Date(NOW.getTime() + 10_000);
      const created2 = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId2,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: later,
        }),
      );
      expect(created2.invitationId).toBe(invId2);

      // Verify row 1 is unchanged in every column
      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<
          {
            status: string;
            token_hash: Buffer;
            person_id: string | null;
            custom_role_id: string | null;
            closed_at: Date | null;
            expires_at: Date;
          }[]
        >`
          select status, token_hash, person_id::text as person_id,
                 custom_role_id::text as custom_role_id, closed_at, expires_at
          from app.invitations
          where id = ${invId1}::uuid
        `;
        expect(rows[0]!).toEqual(row1Snapshot);

        // Confirm no access.invitation.voided row was written
        const voidedEvents = await tx<{ id: string }[]>`
          select id::text as id
          from app.audit_events
          where action = 'access.invitation.voided'
        `;
        expect(voidedEvents).toHaveLength(0);

        await assertNoSensitiveDataInAudit(tx, [address, created1.token, created2.token]);
      });
    });
  });

  it("pin 22 b: 100 expired pending rows, created more than an hour ago, and 20 expired pending rows in the past hour; create succeeds", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      // Seed 100 expired pending rows created 2 hours ago
      await runInCommunity(app, scope, async (tx) => {
        const dummyHash = Buffer.alloc(32, 3);
        const twoHoursAgo = new Date(NOW.getTime() - 2 * 3600_000);
        const pastExpiry = new Date(NOW.getTime() - 3600_000);
        for (let i = 0; i < 100; i++) {
          const invId = newId();
          await tx`
            insert into app.invitations (
              id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
              person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
            ) values (
              ${invId}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
              ${owner}::uuid, ${dummyHash}, 'member', null,
              null, 'pending', ${pastExpiry}, 0, ${twoHoursAgo}, null, null, ${twoHoursAgo}
            )
          `;
        }
      });

      // Seed 20 expired pending rows created within the past hour (A6: expired pending rows count toward no cap)
      await runInCommunity(app, scope, async (tx) => {
        const dummyHash = Buffer.alloc(32, 3);
        const tenMinutesAgo = new Date(NOW.getTime() - 10 * 60_000);
        const fiveMinutesAgo = new Date(NOW.getTime() - 5 * 60_000);
        for (let i = 0; i < 20; i++) {
          const invId = newId();
          await tx`
            insert into app.invitations (
              id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
              person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
            ) values (
              ${invId}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
              ${owner}::uuid, ${dummyHash}, 'member', null,
              null, 'pending', ${fiveMinutesAgo}, 0, ${tenMinutesAgo}, null, null, ${tenMinutesAgo}
            )
          `;
        }
      });

      const stub = new MemoryInvitationAddresses();
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: newId(),
          actorUserId: owner,
          address: "success-with-100-expired@example.test",
          roleKey: "member",
          now: NOW,
        }),
      );
      expect(created.token).toMatch(/^v1\./);

      await runInCommunity(app, scope, (tx) =>
        assertNoSensitiveDataInAudit(tx, ["success-with-100-expired@example.test", created.token]),
      );
    });
  });

  it("pin 23 (revoke): revoke sets status='revoked', person_id & custom_role_id null, closed_at set, and calls close", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const customRole = await runInCommunity(app, scope, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "revoke_target_role",
          permissions: ["access.users.view"],
          actorUserId: owner,
        }),
      );

      const invId = newId();
      const stub = new MemoryInvitationAddresses();
      const address = "revoke-pin-23@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          customRoleId: customRole.customRoleId,
          now: NOW,
        }),
      );

      const revokeNow = new Date(NOW.getTime() + 5000);
      await runInCommunity(app, scope, (tx) =>
        revokeInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          now: revokeNow,
        }),
      );

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<
          {
            status: string;
            custom_role_id: string | null;
            person_id: string | null;
            closed_at: Date | null;
          }[]
        >`
          select status, custom_role_id::text as custom_role_id,
                 person_id::text as person_id, closed_at
          from app.invitations
          where id = ${invId}::uuid
        `;
        expect(rows[0]!).toEqual({
          status: "revoked",
          custom_role_id: null,
          person_id: null,
          closed_at: revokeNow,
        });

        expect(stub.calls.some((c) => c.method === "close" && c.invitationId === invId)).toBe(true);

        const revokedAudits = await tx<{ action: string }[]>`
          select action from app.audit_events
          where action = 'access.invitation.revoked'
            and ${invId}::uuid = any(target_ids)
        `;
        expect(revokedAudits).toHaveLength(1);

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("pin 24: resend and revoke answer one invitation_not_found for unknown/foreign/closed rows; revoking expired pending row succeeds", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scopeA1 = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const scopeA2 = { orgId: orgA.organisationId, communityId: orgA.community2Id };
      const owner = newId();
      await runInCommunity(app, scopeA1, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const dummyHash = Buffer.alloc(32, 4);

      // Create accepted row, revoked row, and expired pending row in A1
      const acceptedId = newId();
      const revokedId = newId();
      const expiredPendingId = newId();
      const comm2Id = newId();

      await runInCommunity(app, scopeA1, async (tx) => {
        await tx`
          insert into app.invitations (
            id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
            person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
          ) values
            (${acceptedId}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'accepted', ${new Date(NOW.getTime() + 86400000)}, 0, ${NOW}, ${owner}::uuid, ${NOW}, ${NOW}),
            (${revokedId}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'revoked', ${new Date(NOW.getTime() + 86400000)}, 0, ${NOW}, null, ${NOW}, ${NOW}),
            (${expiredPendingId}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'pending', ${new Date(NOW.getTime() - 86400000)}, 0, ${NOW}, null, null, ${NOW})
        `;
      });

      // Comm2 row
      await runInCommunity(app, scopeA2, async (tx) => {
        await tx`
          insert into app.invitations (
            id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
            person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
          ) values
            (${comm2Id}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'pending', ${new Date(NOW.getTime() + 86400000)}, 0, ${NOW}, null, null, ${NOW})
        `;
      });

      const auditCountBefore = await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ n: number }[]>`select count(*)::int as n from app.audit_events`;
        return rows[0]!.n;
      });

      const notFoundIds = [
        newId(), // unknown id
        comm2Id, // community 2's id
        acceptedId, // accepted row
        revokedId, // revoked row
      ];

      for (const id of notFoundIds) {
        await expect(
          runInCommunity(app, scopeA1, (tx) =>
            resendInvitation(tx, stub, { invitationId: id, actorUserId: owner, now: NOW }),
          ),
        ).rejects.toThrow(new AccessError("invitation_not_found"));

        await expect(
          runInCommunity(app, scopeA1, (tx) =>
            revokeInvitation(tx, stub, { invitationId: id, actorUserId: owner, now: NOW }),
          ),
        ).rejects.toThrow(new AccessError("invitation_not_found"));
      }

      // resend on expired row gives invitation_not_found
      await expect(
        runInCommunity(app, scopeA1, (tx) =>
          resendInvitation(tx, stub, {
            invitationId: expiredPendingId,
            actorUserId: owner,
            now: NOW,
          }),
        ),
      ).rejects.toThrow(new AccessError("invitation_not_found"));

      // Ensure no audit rows were written for not-found failures
      const auditCountAfter = await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ n: number }[]>`select count(*)::int as n from app.audit_events`;
        return rows[0]!.n;
      });
      expect(auditCountAfter).toBe(auditCountBefore);

      // But revoking an expired pending row succeeds, closes row and writes access.invitation.revoked
      await runInCommunity(app, scopeA1, (tx) =>
        revokeInvitation(tx, stub, {
          invitationId: expiredPendingId,
          actorUserId: owner,
          now: NOW,
        }),
      );

      await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ status: string; closed_at: Date | null }[]>`
          select status, closed_at from app.invitations where id = ${expiredPendingId}::uuid
        `;
        expect(rows[0]!.status).toBe("revoked");
        expect(rows[0]!.closed_at).not.toBeNull();

        const audit = await tx<{ action: string }[]>`
          select action from app.audit_events
          where action = 'access.invitation.revoked'
            and ${expiredPendingId}::uuid = any(target_ids)
        `;
        expect(audit).toHaveLength(1);

        await assertNoSensitiveDataInAudit(tx, []);
      });
    });
  });

  it("pin 25: a minor contact gives person_minor and no row", async () => {
    await withTwoOrgs(async ({ app, kms, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const { minorId } = await runInCommunity(app, scope, (tx) => createAdultAndMinor(tx, kms));

      const stub = new MemoryInvitationAddresses();
      const invId = newId();

      const auditCountBefore = await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ n: number }[]>`select count(*)::int as n from app.audit_events`;
        return rows[0]!.n;
      });

      const res = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address: "minor-refusal@example.test",
          personId: minorId,
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(res).toBeInstanceOf(AccessError);
      expect((res as AccessError).code).toBe("person_minor");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id::text as id from app.invitations where id = ${invId}::uuid
        `;
        expect(rows).toHaveLength(0);

        const auditCountAfter = (
          await tx<{ n: number }[]>`select count(*)::int as n from app.audit_events`
        )[0]!.n;
        expect(auditCountAfter).toBe(auditCountBefore);

        await assertNoSensitiveDataInAudit(tx, ["minor-refusal@example.test"]);
      });
    });
  });

  it("pin 26 (i): bundle subset check in roleGrantAllowed stops inviter from granting role with missing bundle permission", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      // Create custom role with access.roles.manage, access.users.manage, access.users.view (lacks people.restricted.read)
      const inviterRole = await runInCommunity(app, scope, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "inviter_admin",
          permissions: ["access.roles.manage", "access.users.manage", "access.users.view"],
          actorUserId: owner,
        }),
      );

      const inviter = newId();
      // Provision membership for inviter
      await runInCommunity(app, scope, async (tx) => {
        await tx`
          insert into app.organisation_members (org_id, user_id, source, invitation_id, created_at)
          values (current_setting('app.org_id')::uuid, ${inviter}::uuid, 'provision', null, ${NOW})
        `;
      });
      await runInCommunity(app, scope, (tx) =>
        grantRole(tx, {
          now: NOW,
          userId: inviter,
          roleKey: null,
          customRoleId: inviterRole.customRoleId,
          actorUserId: owner,
        }),
      );

      // Inviting with community_admin gives forbidden and no row
      const stub = new MemoryInvitationAddresses();
      const invId = newId();

      const res = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: inviter,
          address: "forbidden-bundle@example.test",
          roleKey: "community_admin",
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(res).toBeInstanceOf(AccessError);
      expect((res as AccessError).code).toBe("forbidden");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id::text as id from app.invitations where id = ${invId}::uuid
        `;
        expect(rows).toHaveLength(0);
        await assertNoSensitiveDataInAudit(tx, ["forbidden-bundle@example.test"]);
      });
    });
  });

  it("pin 26b (i): custom-role permission subset check stops inviter from granting custom role with missing permission", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const inviterRole = await runInCommunity(app, scope, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "inviter_custom",
          permissions: ["access.roles.manage", "access.users.manage", "access.users.view"],
          actorUserId: owner,
        }),
      );

      const inviter = newId();
      await runInCommunity(app, scope, async (tx) => {
        await tx`
          insert into app.organisation_members (org_id, user_id, source, invitation_id, created_at)
          values (current_setting('app.org_id')::uuid, ${inviter}::uuid, 'provision', null, ${NOW})
        `;
      });
      await runInCommunity(app, scope, (tx) =>
        grantRole(tx, {
          now: NOW,
          userId: inviter,
          roleKey: null,
          customRoleId: inviterRole.customRoleId,
          actorUserId: owner,
        }),
      );

      // Target custom role carries people.restricted.read
      const targetRole = await runInCommunity(app, scope, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "target_with_restricted",
          permissions: ["people.restricted.read"],
          actorUserId: owner,
        }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();

      const res = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: inviter,
          address: "forbidden-custom-perm@example.test",
          customRoleId: targetRole.customRoleId,
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(res).toBeInstanceOf(AccessError);
      expect((res as AccessError).code).toBe("forbidden");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id::text as id from app.invitations where id = ${invId}::uuid
        `;
        expect(rows).toHaveLength(0);
        await assertNoSensitiveDataInAudit(tx, ["forbidden-custom-perm@example.test"]);
      });
    });
  });

  it("pin 27: cap values for create (20/hr, 100 pending) and resend (3/24hr, reset after 24hr)", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();

      // (a) 20 creates within an hour succeed, 21st gives too_many
      for (let i = 0; i < 20; i++) {
        await runInCommunity(app, scope, (tx) =>
          createInvitation(tx, stub, {
            invitationId: newId(),
            actorUserId: owner,
            address: `hourly-${i}@example.test`,
            roleKey: "member",
            now: NOW,
          }),
        );
      }

      const resA = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: newId(),
          actorUserId: owner,
          address: "hourly-21@example.test",
          roleKey: "member",
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(resA).toBeInstanceOf(AccessError);
      expect((resA as AccessError).code).toBe("too_many");

      // Clean up for part (b)
      await runInCommunity(app, scope, async (tx) => {
        await tx`delete from app.invitations`;
      });

      // (b) 100 pending older than an hour; 101st gives too_many
      await runInCommunity(app, scope, async (tx) => {
        const dummyHash = Buffer.alloc(32, 5);
        const twoHoursAgo = new Date(NOW.getTime() - 2 * 3600_000);
        for (let i = 0; i < 100; i++) {
          const invId = newId();
          await tx`
            insert into app.invitations (
              id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
              person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
            ) values (
              ${invId}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
              ${owner}::uuid, ${dummyHash}, 'member', null,
              null, 'pending', ${new Date(NOW.getTime() + 7 * 86400000)}, 0, ${twoHoursAgo}, null, null, ${twoHoursAgo}
            )
          `;
        }
      });

      const resB = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: newId(),
          actorUserId: owner,
          address: "pending-101@example.test",
          roleKey: "member",
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(resB).toBeInstanceOf(AccessError);
      expect((resB as AccessError).code).toBe("too_many");

      // Clean up for parts (c) and (d)
      await runInCommunity(app, scope, async (tx) => {
        await tx`delete from app.invitations`;
      });

      // (c) 4th resend within 24 hours gives too_many
      const resendInvId = newId();
      await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: resendInvId,
          actorUserId: owner,
          address: "resend-cap@example.test",
          roleKey: "member",
          now: NOW,
        }),
      );

      // Resends 1, 2, 3 succeed
      for (let i = 1; i <= 3; i++) {
        const time = new Date(NOW.getTime() + i * 1000);
        await runInCommunity(app, scope, (tx) =>
          resendInvitation(tx, stub, {
            invitationId: resendInvId,
            actorUserId: owner,
            now: time,
          }),
        );
      }

      // 4th resend gives too_many
      const resC = await runInCommunity(app, scope, (tx) =>
        resendInvitation(tx, stub, {
          invitationId: resendInvId,
          actorUserId: owner,
          now: new Date(NOW.getTime() + 4000),
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(resC).toBeInstanceOf(AccessError);
      expect((resC as AccessError).code).toBe("too_many");

      // (d) with last_sent_at moved 25 hours back, resend succeeds and resend_count becomes 1
      const past25h = new Date(NOW.getTime() - 25 * 3600_000);
      await runInCommunity(app, scope, async (tx) => {
        await tx`
          update app.invitations
          set last_sent_at = ${past25h}
          where id = ${resendInvId}::uuid
        `;
      });

      const resent = await runInCommunity(app, scope, (tx) =>
        resendInvitation(tx, stub, {
          invitationId: resendInvId,
          actorUserId: owner,
          now: NOW,
        }),
      );
      expect(resent.token).toMatch(/^v1\./);

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ resend_count: number }[]>`
          select resend_count from app.invitations where id = ${resendInvId}::uuid
        `;
        expect(rows[0]!.resend_count).toBe(1);

        await assertNoSensitiveDataInAudit(tx, ["resend-cap@example.test", resent.token]);
      });
    });
  });

  it("pin 28: list purges revoked/void closed > 30d and pending expired > 30d; keeps <= 30d and accepted", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const dummyHash = Buffer.alloc(32, 6);
      const day31Ago = new Date(NOW.getTime() - 31 * 86400000);
      const day29Ago = new Date(NOW.getTime() - 29 * 86400000);

      const idRevoked31 = newId();
      const idVoid31 = newId();
      const idPending31 = newId();
      const idRevoked29 = newId();
      const idVoid29 = newId();
      const idPending29 = newId();
      const idPendingFuture = newId();
      const idAccepted31 = newId();

      await runInCommunity(app, scope, async (tx) => {
        await tx`
          insert into app.invitations (
            id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
            person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
          ) values
            (${idRevoked31}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'revoked', ${day31Ago}, 0, ${day31Ago}, null, ${day31Ago}, ${day31Ago}),
            (${idVoid31}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'void', ${day31Ago}, 0, ${day31Ago}, null, ${day31Ago}, ${day31Ago}),
            (${idPending31}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'pending', ${day31Ago}, 0, ${day31Ago}, null, null, ${day31Ago}),
            (${idRevoked29}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'revoked', ${day29Ago}, 0, ${day29Ago}, null, ${day29Ago}, ${day29Ago}),
            (${idVoid29}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'void', ${day29Ago}, 0, ${day29Ago}, null, ${day29Ago}, ${day29Ago}),
            (${idPending29}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'pending', ${day29Ago}, 0, ${day29Ago}, null, null, ${day29Ago}),
            (${idPendingFuture}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'pending', ${new Date(NOW.getTime() + 7 * 86400000)}, 0, ${NOW}, null, null, ${NOW}),
            (${idAccepted31}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
             ${owner}::uuid, ${dummyHash}, 'member', null, null, 'accepted', ${day31Ago}, 0, ${day31Ago}, ${owner}::uuid, ${day31Ago}, ${day31Ago})
        `;
      });

      const stub = new MemoryInvitationAddresses();
      await runInCommunity(app, scope, (tx) =>
        listInvitations(tx, stub, { actorUserId: owner, now: NOW }),
      );

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id::text as id from app.invitations
        `;
        const ids = new Set(rows.map((r) => r.id));

        // Deleted
        expect(ids.has(idRevoked31)).toBe(false);
        expect(ids.has(idVoid31)).toBe(false);
        expect(ids.has(idPending31)).toBe(false);

        // Kept
        expect(ids.has(idRevoked29)).toBe(true);
        expect(ids.has(idVoid29)).toBe(true);
        expect(ids.has(idPending29)).toBe(true);
        expect(ids.has(idPendingFuture)).toBe(true);
        expect(ids.has(idAccepted31)).toBe(true);

        await assertNoSensitiveDataInAudit(tx, []);
      });
    });
  });

  it("pin 48: sweep is called first for create, list, resend and revoke", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      // Create
      const stubCreate = new MemoryInvitationAddresses();
      const invId = newId();
      await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stubCreate, {
          invitationId: invId,
          actorUserId: owner,
          address: "sweep-first@example.test",
          roleKey: "member",
          now: NOW,
        }),
      );
      expect(stubCreate.calls[0]?.method).toBe("sweep");

      // List
      const stubList = new MemoryInvitationAddresses();
      await runInCommunity(app, scope, (tx) =>
        listInvitations(tx, stubList, { actorUserId: owner, now: NOW }),
      );
      expect(stubList.calls[0]?.method).toBe("sweep");

      // Resend
      const stubResend = new MemoryInvitationAddresses();
      await runInCommunity(app, scope, (tx) =>
        resendInvitation(tx, stubResend, {
          invitationId: invId,
          actorUserId: owner,
          now: new Date(NOW.getTime() + 1000),
        }),
      );
      expect(stubResend.calls[0]?.method).toBe("sweep");

      // Revoke
      const stubRevoke = new MemoryInvitationAddresses();
      await runInCommunity(app, scope, (tx) =>
        revokeInvitation(tx, stubRevoke, {
          invitationId: invId,
          actorUserId: owner,
          now: new Date(NOW.getTime() + 2000),
        }),
      );
      expect(stubRevoke.calls[0]?.method).toBe("sweep");

      await runInCommunity(app, scope, (tx) =>
        assertNoSensitiveDataInAudit(tx, ["sweep-first@example.test"]),
      );
    });
  });

  it("pin 49: already_invited from stub create rolls back app row and audit row", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      stub.createAnswer = { ok: false, reason: "already_invited" };
      const invId = newId();

      const res = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address: "already-invited@example.test",
          roleKey: "member",
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(res).toBeInstanceOf(AccessError);
      expect((res as AccessError).code).toBe("already_invited");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id::text as id from app.invitations where id = ${invId}::uuid
        `;
        expect(rows).toHaveLength(0);

        const audit = await tx<{ id: string }[]>`
          select id::text as id from app.audit_events
          where action = 'access.invitation.created'
            and ${invId}::uuid = any(target_ids)
        `;
        expect(audit).toHaveLength(0);

        await assertNoSensitiveDataInAudit(tx, ["already-invited@example.test"]);
      });
    });
  });

  it("pin 50: refresh returning false gives invitation_not_found, no audit, and token_hash unchanged", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address: "refresh-false@example.test",
          roleKey: "member",
          now: NOW,
        }),
      );

      const rowBefore = await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ token_hash: Buffer }[]>`
          select token_hash from app.invitations where id = ${invId}::uuid
        `;
        return rows[0]!;
      });

      const auditCountBefore = await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ n: number }[]>`select count(*)::int as n from app.audit_events`;
        return rows[0]!.n;
      });

      // Stub refresh returns false
      stub.refreshAnswer = false;

      const res = await runInCommunity(app, scope, (tx) =>
        resendInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          now: new Date(NOW.getTime() + 1000),
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(res).toBeInstanceOf(AccessError);
      expect((res as AccessError).code).toBe("invitation_not_found");

      await runInCommunity(app, scope, async (tx) => {
        const rowAfter = await tx<{ token_hash: Buffer }[]>`
          select token_hash from app.invitations where id = ${invId}::uuid
        `;
        expect(Buffer.from(rowAfter[0]!.token_hash).equals(rowBefore.token_hash)).toBe(true);

        const auditCountAfter = (
          await tx<{ n: number }[]>`select count(*)::int as n from app.audit_events`
        )[0]!.n;
        expect(auditCountAfter).toBe(auditCountBefore);

        await assertNoSensitiveDataInAudit(tx, ["refresh-false@example.test"]);
      });
    });
  });

  it("covers happy paths and edge cases (email null, foreign role, linked contact, unreadable contact, permissions)", async () => {
    await withTwoOrgs(async ({ app, kms, orgA }) => {
      const scopeA1 = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const scopeA2 = { orgId: orgA.organisationId, communityId: orgA.community2Id };
      const owner = newId();
      await runInCommunity(app, scopeA1, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();

      // 1. Happy path create with contact
      const { adultId } = await runInCommunity(app, scopeA1, (tx) => createAdultAndMinor(tx, kms));
      const invWithContact = newId();
      const testNow = new Date();
      const createdContact = await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invWithContact,
          actorUserId: owner,
          address: "contact-invite@example.test",
          personId: adultId,
          now: testNow,
        }),
      );
      expect(createdContact.token).toMatch(/^v1\./);

      // 2. listInvitations: returns non-null email from stub, or email null when stub has no address
      const listBeforeClear = await runInCommunity(app, scopeA1, (tx) =>
        listInvitations(tx, stub, { actorUserId: owner, now: testNow }),
      );
      const happyItem = listBeforeClear.find((i) => i.id === invWithContact);
      expect(happyItem).toBeDefined();
      expect(happyItem?.email).toBe("contact-invite@example.test");
      expect(happyItem?.linksContact).toBe(true);

      stub.entries.clear(); // Stub has no entry for this invitation
      const listResult = await runInCommunity(app, scopeA1, (tx) =>
        listInvitations(tx, stub, { actorUserId: owner, now: testNow }),
      );
      const foundItem = listResult.find((i) => i.id === invWithContact);
      expect(foundItem).toBeDefined();
      expect(foundItem?.email).toBeNull();
      expect(foundItem?.linksContact).toBe(true);

      // 3. custom role from community 2 gives role_not_found in community 1
      const roleInComm2 = await runInCommunity(app, scopeA2, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "comm2_role",
          permissions: ["access.users.view"],
          actorUserId: owner,
        }),
      );

      const res3 = await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: newId(),
          actorUserId: owner,
          address: "comm2-role@example.test",
          customRoleId: roleInComm2.customRoleId,
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(res3).toBeInstanceOf(AccessError);
      expect((res3 as AccessError).code).toBe("role_not_found");

      // 4. already linked contact gives person_linked
      const userToLink = newId();
      await runInCommunity(app, scopeA1, async (tx) => {
        await tx`
          insert into app.user_links (id, org_id, community_id, user_id, person_id)
          values (${newId()}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid, ${userToLink}::uuid, ${adultId}::uuid)
        `;
      });

      const res4 = await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: newId(),
          actorUserId: owner,
          address: "already-linked@example.test",
          personId: adultId,
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(res4).toBeInstanceOf(AccessError);
      expect((res4 as AccessError).code).toBe("person_linked");

      // 5. unreadable contact gives person_not_found
      const res5 = await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: newId(),
          actorUserId: owner,
          address: "unreadable-person@example.test",
          personId: newId(),
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(res5).toBeInstanceOf(AccessError);
      expect((res5 as AccessError).code).toBe("person_not_found");

      // 6. Permission re-checks in create & list:
      // (a) caller without access.users.manage
      const plainUser = newId();
      await runInCommunity(app, scopeA1, async (tx) => {
        await tx`
          insert into app.organisation_members (org_id, user_id, source, invitation_id, created_at)
          values (current_setting('app.org_id')::uuid, ${plainUser}::uuid, 'provision', null, ${NOW})
        `;
      });

      const invNoUsersManage = newId();
      const resNoUsers = await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invNoUsersManage,
          actorUserId: plainUser,
          address: "no-users-manage@example.test",
          roleKey: "member",
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(resNoUsers).toBeInstanceOf(AccessError);
      expect((resNoUsers as AccessError).code).toBe("forbidden");
      await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id::text as id from app.invitations where id = ${invNoUsersManage}::uuid
        `;
        expect(rows).toHaveLength(0);
      });

      // (b) caller without access.roles.manage inviting with a role gives forbidden and no row
      const roleUsersOnly = await runInCommunity(app, scopeA1, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "users_manage_only",
          permissions: ["access.users.manage", "access.users.view"],
          actorUserId: owner,
        }),
      );
      const userUsersOnly = newId();
      await runInCommunity(app, scopeA1, async (tx) => {
        await addMember(tx, userUsersOnly);
        await grantRole(tx, {
          now: NOW,
          userId: userUsersOnly,
          roleKey: null,
          customRoleId: roleUsersOnly.customRoleId,
          actorUserId: owner,
        });
      });
      const invNoRolesManage = newId();
      const resNoRoles = await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invNoRolesManage,
          actorUserId: userUsersOnly,
          address: "no-roles-manage@example.test",
          roleKey: "member",
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(resNoRoles).toBeInstanceOf(AccessError);
      expect((resNoRoles as AccessError).code).toBe("forbidden");
      await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id::text as id from app.invitations where id = ${invNoRolesManage}::uuid
        `;
        expect(rows).toHaveLength(0);
      });

      // (c) caller without people.view inviting with a contact gives forbidden and no row
      const roleNoPeopleView = await runInCommunity(app, scopeA1, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "users_roles_manage",
          permissions: ["access.users.manage", "access.roles.manage"],
          actorUserId: owner,
        }),
      );
      const userNoPeopleView = newId();
      await runInCommunity(app, scopeA1, async (tx) => {
        await addMember(tx, userNoPeopleView);
        await grantRole(tx, {
          now: NOW,
          userId: userNoPeopleView,
          roleKey: null,
          customRoleId: roleNoPeopleView.customRoleId,
          actorUserId: owner,
        });
      });
      const invNoPeopleView = newId();
      const resNoPeople = await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invNoPeopleView,
          actorUserId: userNoPeopleView,
          address: "no-people-view@example.test",
          personId: adultId,
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(resNoPeople).toBeInstanceOf(AccessError);
      expect((resNoPeople as AccessError).code).toBe("forbidden");
      await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id::text as id from app.invitations where id = ${invNoPeopleView}::uuid
        `;
        expect(rows).toHaveLength(0);
      });

      // (d) caller without access.roles.view calling list gives forbidden
      const roleUsersViewOnly = await runInCommunity(app, scopeA1, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "users_view_only",
          permissions: ["access.users.view"],
          actorUserId: owner,
        }),
      );
      const userUsersViewOnly = newId();
      await runInCommunity(app, scopeA1, async (tx) => {
        await addMember(tx, userUsersViewOnly);
        await grantRole(tx, {
          now: NOW,
          userId: userUsersViewOnly,
          roleKey: null,
          customRoleId: roleUsersViewOnly.customRoleId,
          actorUserId: owner,
        });
      });
      const resNoRolesView = await runInCommunity(app, scopeA1, (tx) =>
        listInvitations(tx, stub, {
          actorUserId: userUsersViewOnly,
          now: NOW,
        }),
      ).then(
        () => "resolved",
        (e) => e,
      );
      expect(resNoRolesView).toBeInstanceOf(AccessError);
      expect((resNoRolesView as AccessError).code).toBe("forbidden");

      // 7. Mail failure paths: deleteInvitationAfterMailFailure and voidInvitationAfterMailFailure
      // Close pins on matched pending rows
      const deleteFailId = newId();
      await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: deleteFailId,
          actorUserId: owner,
          address: "delete-fail@example.test",
          roleKey: "member",
          now: NOW,
        }),
      );

      stub.calls.length = 0;
      await runInCommunity(app, scopeA1, (tx) =>
        deleteInvitationAfterMailFailure(tx, stub, {
          invitationId: deleteFailId,
          actorUserId: owner,
          now: NOW,
        }),
      );

      await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id::text as id from app.invitations where id = ${deleteFailId}::uuid
        `;
        expect(rows).toHaveLength(0);
        expect(
          stub.calls.some((c) => c.method === "close" && c.invitationId === deleteFailId),
        ).toBe(true);
        const audit = await tx<{ action: string }[]>`
          select action from app.audit_events
          where action = 'access.invitation.voided'
            and ${deleteFailId}::uuid = any(target_ids)
        `;
        expect(audit).toHaveLength(1);
      });

      const voidFailId = newId();
      await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: voidFailId,
          actorUserId: owner,
          address: "void-fail@example.test",
          roleKey: "member",
          now: NOW,
        }),
      );

      stub.calls.length = 0;
      await runInCommunity(app, scopeA1, (tx) =>
        voidInvitationAfterMailFailure(tx, stub, {
          invitationId: voidFailId,
          actorUserId: owner,
          now: NOW,
        }),
      );

      await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ status: string; closed_at: Date | null }[]>`
          select status, closed_at from app.invitations where id = ${voidFailId}::uuid
        `;
        expect(rows[0]!.status).toBe("void");
        expect(rows[0]!.closed_at).not.toBeNull();
        expect(stub.calls.some((c) => c.method === "close" && c.invitationId === voidFailId)).toBe(
          true,
        );
        const audit = await tx<{ action: string }[]>`
          select action from app.audit_events
          where action = 'access.invitation.voided'
            and ${voidFailId}::uuid = any(target_ids)
        `;
        expect(audit).toHaveLength(1);
      });

      // Mail failure on accepted row leaves accepted row unchanged, calls no close, writes no voided audit
      const acceptedMailFailId = newId();
      const dummyHash = Buffer.alloc(32, 8);
      await runInCommunity(app, scopeA1, async (tx) => {
        await tx`
          insert into app.invitations (
            id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
            person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
          ) values (
            ${acceptedMailFailId}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
            ${owner}::uuid, ${dummyHash}, 'member', null,
            null, 'accepted', ${new Date(NOW.getTime() + 7 * 86400000)}, 0, ${NOW}, ${owner}::uuid, ${NOW}, ${NOW}
          )
        `;
      });

      stub.calls.length = 0;
      await runInCommunity(app, scopeA1, (tx) =>
        deleteInvitationAfterMailFailure(tx, stub, {
          invitationId: acceptedMailFailId,
          actorUserId: owner,
          now: NOW,
        }),
      );

      await runInCommunity(app, scopeA1, (tx) =>
        voidInvitationAfterMailFailure(tx, stub, {
          invitationId: acceptedMailFailId,
          actorUserId: owner,
          now: NOW,
        }),
      );

      await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ status: string; closed_at: Date | null }[]>`
          select status, closed_at from app.invitations where id = ${acceptedMailFailId}::uuid
        `;
        expect(rows[0]!.status).toBe("accepted");
        expect(
          stub.calls.filter((c) => c.method === "close" && c.invitationId === acceptedMailFailId),
        ).toHaveLength(0);
        const audit = await tx<{ action: string }[]>`
          select action from app.audit_events
          where action = 'access.invitation.voided'
            and ${acceptedMailFailId}::uuid = any(target_ids)
        `;
        expect(audit).toHaveLength(0);
      });

      // Mail failure on another community's id leaves that row unchanged, calls no close, writes no audit
      const comm2MailFailId = newId();
      await runInCommunity(app, scopeA2, (tx) =>
        createInvitation(tx, stub, {
          invitationId: comm2MailFailId,
          actorUserId: owner,
          address: "comm2-mail-fail@example.test",
          roleKey: "member",
          now: NOW,
        }),
      );

      stub.calls.length = 0;
      await runInCommunity(app, scopeA1, (tx) =>
        deleteInvitationAfterMailFailure(tx, stub, {
          invitationId: comm2MailFailId,
          actorUserId: owner,
          now: NOW,
        }),
      );

      await runInCommunity(app, scopeA1, (tx) =>
        voidInvitationAfterMailFailure(tx, stub, {
          invitationId: comm2MailFailId,
          actorUserId: owner,
          now: NOW,
        }),
      );

      await runInCommunity(app, scopeA2, async (tx) => {
        const rows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${comm2MailFailId}::uuid
        `;
        expect(rows[0]!.status).toBe("pending");
      });

      expect(
        stub.calls.filter((c) => c.method === "close" && c.invitationId === comm2MailFailId),
      ).toHaveLength(0);

      await runInCommunity(app, scopeA1, async (tx) => {
        const audit = await tx<{ action: string }[]>`
          select action from app.audit_events
          where action = 'access.invitation.voided'
            and ${comm2MailFailId}::uuid = any(target_ids)
        `;
        expect(audit).toHaveLength(0);

        await assertNoSensitiveDataInAudit(tx, [
          "contact-invite@example.test",
          "delete-fail@example.test",
          "void-fail@example.test",
        ]);
      });
    });
  });

  it("pin 52: create without access.users.manage at pending cap gives forbidden, no sweep, keeps old revoked row", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scopeA1 = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      const unprivileged = newId();

      await runInCommunity(app, scopeA1, async (tx) => {
        await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
        await addMember(tx, unprivileged);
      });

      const oldRevokedId = newId();
      const dummyHash = Buffer.alloc(32, 1);
      const fortyDaysAgo = new Date(NOW.getTime() - 40 * 86400000);
      const thirtyFiveDaysAgo = new Date(NOW.getTime() - 35 * 86400000);

      await runInCommunity(app, scopeA1, async (tx) => {
        await tx`
          insert into app.invitations (
            id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
            person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
          ) values (
            ${oldRevokedId}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
            ${owner}::uuid, ${dummyHash}, 'member', null,
            null, 'revoked', ${thirtyFiveDaysAgo}, 0, ${fortyDaysAgo}, null, ${thirtyFiveDaysAgo}, ${fortyDaysAgo}
          )
        `;

        for (let i = 0; i < 100; i++) {
          const invId = newId();
          await tx`
            insert into app.invitations (
              id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
              person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
            ) values (
              ${invId}::uuid, current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid,
              ${owner}::uuid, ${dummyHash}, 'member', null,
              null, 'pending', ${new Date(NOW.getTime() + 7 * 86400000)}, 0, ${NOW}, null, null, ${NOW}
            )
          `;
        }
      });

      const stub = new MemoryInvitationAddresses();
      const call = runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: newId(),
          actorUserId: unprivileged,
          address: "pin52@example.test",
          roleKey: "member",
          now: NOW,
        }),
      );

      const err = await call.then(
        () => "resolved" as const,
        (e) => e,
      );
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("forbidden");
      expect(stub.calls).toHaveLength(0);

      await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id::text as id from app.invitations where id = ${oldRevokedId}::uuid
        `;
        expect(rows).toHaveLength(1);
        await assertNoSensitiveDataInAudit(tx, ["pin52@example.test"]);
      });
    });
  });

  it("pin 55 a: deleteInvitationAfterMailFailure requires access.users.manage", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scopeA1 = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      const unprivileged = newId();

      await runInCommunity(app, scopeA1, async (tx) => {
        await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
        await addMember(tx, unprivileged);
      });

      const invId = newId();
      const stub = new MemoryInvitationAddresses();
      await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address: "pin55a@example.test",
          roleKey: "member",
          now: NOW,
        }),
      );

      stub.calls.length = 0;
      const call = runInCommunity(app, scopeA1, (tx) =>
        deleteInvitationAfterMailFailure(tx, stub, {
          invitationId: invId,
          actorUserId: unprivileged,
          now: NOW,
        }),
      );

      const err = await call.then(
        () => "resolved" as const,
        (e) => e,
      );
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("forbidden");
      expect(stub.calls).toHaveLength(0);

      await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ id: string; status: string }[]>`
          select id::text as id, status from app.invitations where id = ${invId}::uuid
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("pending");
        await assertNoSensitiveDataInAudit(tx, ["pin55a@example.test"]);
      });
    });
  });

  it("pin 55 b: voidInvitationAfterMailFailure requires access.users.manage", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scopeA1 = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      const unprivileged = newId();

      await runInCommunity(app, scopeA1, async (tx) => {
        await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
        await addMember(tx, unprivileged);
      });

      const invId = newId();
      const stub = new MemoryInvitationAddresses();
      await runInCommunity(app, scopeA1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address: "pin55b@example.test",
          roleKey: "member",
          now: NOW,
        }),
      );

      stub.calls.length = 0;
      const call = runInCommunity(app, scopeA1, (tx) =>
        voidInvitationAfterMailFailure(tx, stub, {
          invitationId: invId,
          actorUserId: unprivileged,
          now: NOW,
        }),
      );

      const err = await call.then(
        () => "resolved" as const,
        (e) => e,
      );
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("forbidden");
      expect(stub.calls).toHaveLength(0);

      await runInCommunity(app, scopeA1, async (tx) => {
        const rows = await tx<{ id: string; status: string }[]>`
          select id::text as id, status from app.invitations where id = ${invId}::uuid
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("pending");
        await assertNoSensitiveDataInAudit(tx, ["pin55b@example.test"]);
      });
    });
  });
});
