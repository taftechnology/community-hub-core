import { createHash } from "node:crypto";
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
import { catalogue } from "@community-hub/policy";

import { buildInvitationToken, parseInvitationToken } from "../domain/invitation-token.js";
import {
  AccessError,
  bootstrapOwner,
  createCustomRole,
  grantRole,
  revokeRole,
} from "../public/index.js";
import { writeUserLink } from "./grants.js";
import {
  acceptInvitation,
  createInvitation,
  proveInvitation,
  revokeInvitation,
} from "./invitations.js";
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
const NOW = new Date();

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
  const targets: string[] = [];
  for (const text of sensitiveTexts) {
    if (!text) continue;
    targets.push(text);
    const parsed = parseInvitationToken(text);
    if (parsed !== "invalid") {
      const secret = Buffer.from(parsed.secret);
      targets.push(secret.toString("base64url"));
      targets.push(secret.toString("hex"));
      const hash = createHash("sha256").update(secret).digest();
      targets.push(hash.toString("hex"));
      targets.push(hash.toString("base64"));
    }
  }

  for (const row of auditRows) {
    for (const [col, val] of Object.entries(row.payload)) {
      const serialized = typeof val === "string" ? val : JSON.stringify(val);
      for (const text of targets) {
        if (text && serialized.includes(text)) {
          throw new Error(`Sensitive text matched audit event column: ${col}`);
        }
      }
    }
  }
}

describe("invitation accept repository integration (pins & behaviour)", () => {
  it("pin 23 (c): accept sets accepted, clears columns, sets closed_at, calls close", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "invitee-23c@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      await runInCommunity(app, scope, (tx) =>
        acceptInvitation(tx, stub, {
          token: created.token,
          userId: acceptingUser,
          now: NOW,
        }),
      );

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<
          {
            status: string;
            accepted_user_id: string | null;
            person_id: string | null;
            custom_role_id: string | null;
            closed_at: Date | null;
          }[]
        >`
          select
            status,
            accepted_user_id::text as accepted_user_id,
            person_id::text as person_id,
            custom_role_id::text as custom_role_id,
            closed_at
          from app.invitations
          where id = ${invId}::uuid
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("accepted");
        expect(rows[0]!.accepted_user_id).toBe(acceptingUser);
        expect(rows[0]!.person_id).toBeNull();
        expect(rows[0]!.custom_role_id).toBeNull();
        expect(rows[0]!.closed_at).not.toBeNull();

        const closeCalls = stub.calls.filter(
          (c) => c.method === "close" && c.invitationId === invId,
        );
        expect(closeCalls).toHaveLength(1);

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("pin 23 (d): void at accept sets void, clears columns, sets closed_at, calls close, writes audit", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const inviterRole = await runInCommunity(app, scope, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "inviter_role_23d",
          permissions: ["access.roles.manage", "access.users.manage", "access.users.view"],
          actorUserId: owner,
        }),
      );

      const inviter = newId();
      await runInCommunity(app, scope, (tx) => addMember(tx, inviter));
      const grantRes = await runInCommunity(app, scope, (tx) =>
        grantRole(tx, {
          now: NOW,
          userId: inviter,
          roleKey: null,
          customRoleId: inviterRole.customRoleId,
          actorUserId: owner,
        }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "invitee-23d@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: inviter,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      // Revoke inviter's role so accept re-check fails and voids
      await runInCommunity(app, scope, (tx) =>
        revokeRole(tx, {
          now: NOW,
          grantId: grantRes.grantId,
          scope: "community",
          actorUserId: owner,
        }),
      );

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      let acceptErr: unknown;
      await runInCommunity(app, scope, async (tx) => {
        try {
          await acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          });
        } catch (e) {
          if (e instanceof AccessError && e.code === "invitation_void") {
            acceptErr = e;
            return;
          }
          throw e;
        }
      });
      expect(acceptErr).toBeInstanceOf(AccessError);
      expect((acceptErr as AccessError).code).toBe("invitation_void");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<
          {
            status: string;
            accepted_user_id: string | null;
            person_id: string | null;
            custom_role_id: string | null;
            closed_at: Date | null;
          }[]
        >`
          select
            status,
            accepted_user_id::text as accepted_user_id,
            person_id::text as person_id,
            custom_role_id::text as custom_role_id,
            closed_at
          from app.invitations
          where id = ${invId}::uuid
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe("void");
        expect(rows[0]!.person_id).toBeNull();
        expect(rows[0]!.custom_role_id).toBeNull();
        expect(rows[0]!.closed_at).not.toBeNull();

        const closeCalls = stub.calls.filter(
          (c) => c.method === "close" && c.invitationId === invId,
        );
        expect(closeCalls).toHaveLength(1);

        const voidAudit = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.audit_events
          where action = 'access.invitation.voided'
            and purpose = 'access.invitation.voided'
            and target_ids = array[${invId}::uuid]
        `;
        expect(voidAudit[0]?.count).toBe(1);

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("pin 23 (e): custom role invitation accept clears custom_role_id", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const targetRole = await runInCommunity(app, scope, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "target_custom_23e",
          permissions: ["access.users.view"],
          actorUserId: owner,
        }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "invitee-23e@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          customRoleId: targetRole.customRoleId,
          now: NOW,
        }),
      );

      // Verify custom_role_id is initially set on the pending invitation
      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ custom_role_id: string | null }[]>`
          select custom_role_id::text as custom_role_id
          from app.invitations
          where id = ${invId}::uuid
        `;
        expect(rows[0]?.custom_role_id).toBe(targetRole.customRoleId);
      });

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      await runInCommunity(app, scope, (tx) =>
        acceptInvitation(tx, stub, {
          token: created.token,
          userId: acceptingUser,
          now: NOW,
        }),
      );

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<
          {
            status: string;
            custom_role_id: string | null;
          }[]
        >`
          select
            status,
            custom_role_id::text as custom_role_id
          from app.invitations
          where id = ${invId}::uuid
        `;
        expect(rows[0]!.status).toBe("accepted");
        expect(rows[0]!.custom_role_id).toBeNull();

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("pin 26 (ii): bundle permission removed from inviter gives invitation_void", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      // Inviter has custom role with all catalogue permissions
      const allPerms = [...catalogue()];
      const inviterRole = await runInCommunity(app, scope, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "inviter_full_26ii",
          permissions: allPerms,
          actorUserId: owner,
        }),
      );

      const inviter = newId();
      await runInCommunity(app, scope, (tx) => addMember(tx, inviter));
      await runInCommunity(app, scope, (tx) =>
        grantRole(tx, {
          now: NOW,
          userId: inviter,
          roleKey: null,
          customRoleId: inviterRole.customRoleId,
          actorUserId: owner,
        }),
      );

      // Inviter invites with community_admin
      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "invitee-26ii@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: inviter,
          address,
          roleKey: "community_admin",
          now: NOW,
        }),
      );

      // One bundle permission (people.restricted.read) is then removed from inviter's custom role
      await runInCommunity(app, scope, async (tx) => {
        await tx`
          delete from app.custom_role_permissions
          where custom_role_id = ${inviterRole.customRoleId}::uuid
            and permission = 'people.restricted.read'
            and org_id = current_setting('app.org_id')::uuid
            and community_id = current_setting('app.community_id')::uuid
        `;
      });

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      let err: unknown;
      await runInCommunity(app, scope, async (tx) => {
        try {
          await acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          });
        } catch (e) {
          if (e instanceof AccessError && e.code === "invitation_void") {
            err = e;
            return;
          }
          throw e;
        }
      });
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("invitation_void");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(rows[0]!.status).toBe("void");

        const grants = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.community_role_grants
          where user_id = ${acceptingUser}::uuid
        `;
        expect(grants[0]!.count).toBe(0);

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("pin 26b (ii): custom role gaining permission inviter lacks gives invitation_void", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      // Target role initially has only access.users.view
      const targetRole = await runInCommunity(app, scope, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "target_role_26b",
          permissions: ["access.users.view"],
          actorUserId: owner,
        }),
      );

      // Inviter has access.roles.manage, access.users.manage, access.users.view (lacks people.restricted.read)
      const inviterRole = await runInCommunity(app, scope, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "inviter_role_26b",
          permissions: ["access.roles.manage", "access.users.manage", "access.users.view"],
          actorUserId: owner,
        }),
      );

      const inviter = newId();
      await runInCommunity(app, scope, (tx) => addMember(tx, inviter));
      await runInCommunity(app, scope, (tx) =>
        grantRole(tx, {
          now: NOW,
          userId: inviter,
          roleKey: null,
          customRoleId: inviterRole.customRoleId,
          actorUserId: owner,
        }),
      );

      // Inviter invites naming targetRole
      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "invitee-26b@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: inviter,
          address,
          customRoleId: targetRole.customRoleId,
          now: NOW,
        }),
      );

      // After invite, targetRole gains people.restricted.read, which inviter lacks
      await runInCommunity(app, scope, async (tx) => {
        await tx`
          insert into app.custom_role_permissions (org_id, community_id, custom_role_id, permission)
          values (
            current_setting('app.org_id')::uuid,
            current_setting('app.community_id')::uuid,
            ${targetRole.customRoleId}::uuid,
            'people.restricted.read'
          )
        `;
      });

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      let err: unknown;
      await runInCommunity(app, scope, async (tx) => {
        try {
          await acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          });
        } catch (e) {
          if (e instanceof AccessError && e.code === "invitation_void") {
            err = e;
            return;
          }
          throw e;
        }
      });
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("invitation_void");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(rows[0]!.status).toBe("void");

        const grants = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.community_role_grants
          where user_id = ${acceptingUser}::uuid
        `;
        expect(grants[0]!.count).toBe(0);

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("pin 31 (a): proveInvitation full hash comparison", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "invitee-31a@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      // Corrupt token_hash: keep first 8 bytes identical to SHA-256(secret), corrupt the remaining 24 bytes
      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ token_hash: Buffer }[]>`
          select token_hash from app.invitations where id = ${invId}::uuid
        `;
        const corruptHash = Buffer.from(rows[0]!.token_hash);
        for (let i = 8; i < 32; i++) {
          corruptHash[i] = corruptHash[i]! ^ 0xff;
        }
        await tx`
          update app.invitations
          set token_hash = ${corruptHash}
          where id = ${invId}::uuid
        `;
      });

      const proveResult = await runInCommunity(app, scope, (tx) =>
        proveInvitation(tx, {
          token: created.token,
          now: NOW,
        }),
      );
      expect(proveResult).toBe("invalid");
    });
  });

  it("pin 31 (b): acceptInvitation full hash comparison", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "invitee-31b@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      // Corrupt token_hash: first 8 bytes match, rest differ
      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ token_hash: Buffer }[]>`
          select token_hash from app.invitations where id = ${invId}::uuid
        `;
        const corruptHash = Buffer.from(rows[0]!.token_hash);
        for (let i = 8; i < 32; i++) {
          corruptHash[i] = corruptHash[i]! ^ 0xff;
        }
        await tx`
          update app.invitations
          set token_hash = ${corruptHash}
          where id = ${invId}::uuid
        `;
      });

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      const auditCountBefore = await runInCommunity(app, scope, async (tx) => {
        const res = await tx<{ count: number }[]>`
          select count(*)::int as count from app.audit_events
        `;
        return res[0]!.count;
      });

      let err: unknown;
      try {
        await runInCommunity(app, scope, (tx) =>
          acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          }),
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("invitation_invalid");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(rows[0]!.status).toBe("pending");

        const members = await tx<{ count: number }[]>`
          select count(*)::int as count from app.organisation_members where user_id = ${acceptingUser}::uuid
        `;
        expect(members[0]!.count).toBe(0);

        const grants = await tx<{ count: number }[]>`
          select count(*)::int as count from app.community_role_grants where user_id = ${acceptingUser}::uuid
        `;
        expect(grants[0]!.count).toBe(0);

        const auditCountAfter = (
          await tx<{ count: number }[]>`select count(*)::int as count from app.audit_events`
        )[0]!.count;
        expect(auditCountAfter).toBe(auditCountBefore);
      });
    });
  });

  it("pin 32 (a): expired invitation gives invitation_invalid and writes nothing", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "invitee-32a@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      // Expire invitation
      const expiredAt = new Date(NOW.getTime() - 1000);
      await runInCommunity(app, scope, async (tx) => {
        await tx`
          update app.invitations
          set expires_at = ${expiredAt}
          where id = ${invId}::uuid
        `;
      });

      const proveRes = await runInCommunity(app, scope, (tx) =>
        proveInvitation(tx, { token: created.token, now: NOW }),
      );
      expect(proveRes).toBe("invalid");

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      const auditCountBefore = await runInCommunity(app, scope, async (tx) => {
        const res = await tx<{ count: number }[]>`
          select count(*)::int as count from app.audit_events
        `;
        return res[0]!.count;
      });

      let acceptErr: unknown;
      try {
        await runInCommunity(app, scope, (tx) =>
          acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          }),
        );
      } catch (e) {
        acceptErr = e;
      }
      expect(acceptErr).toBeInstanceOf(AccessError);
      expect((acceptErr as AccessError).code).toBe("invitation_invalid");

      expect(stub.calls.filter((c) => c.method === "close")).toHaveLength(0);
      expect(stub.calls.filter((c) => c.method === "matches")).toHaveLength(0);

      await runInCommunity(app, scope, async (tx) => {
        const auditCountAfter = (
          await tx<{ count: number }[]>`select count(*)::int as count from app.audit_events`
        )[0]!.count;
        expect(auditCountAfter).toBe(auditCountBefore);

        const memberships = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.organisation_members
          where invitation_id = ${invId}::uuid
        `;
        expect(memberships[0]!.count).toBe(0);

        const grants = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.community_role_grants
          where user_id = ${acceptingUser}::uuid
        `;
        expect(grants[0]!.count).toBe(0);

        const links = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.user_links
          where user_id = ${acceptingUser}::uuid
        `;
        expect(links[0]!.count).toBe(0);

        const invRows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(invRows[0]!.status).toBe("pending");
      });
    });
  });

  it("pin 32 (b): revoked invitation gives invitation_invalid and writes nothing", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "invitee-32b@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      await runInCommunity(app, scope, (tx) =>
        revokeInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          now: NOW,
        }),
      );

      const proveRes = await runInCommunity(app, scope, (tx) =>
        proveInvitation(tx, { token: created.token, now: NOW }),
      );
      expect(proveRes).toBe("invalid");

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      const auditCountBefore = await runInCommunity(app, scope, async (tx) => {
        const res = await tx<{ count: number }[]>`
          select count(*)::int as count from app.audit_events
        `;
        return res[0]!.count;
      });

      stub.calls.length = 0;

      let acceptErr: unknown;
      try {
        await runInCommunity(app, scope, (tx) =>
          acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          }),
        );
      } catch (e) {
        acceptErr = e;
      }
      expect(acceptErr).toBeInstanceOf(AccessError);
      expect((acceptErr as AccessError).code).toBe("invitation_invalid");

      expect(stub.calls.filter((c) => c.method === "close")).toHaveLength(0);
      expect(stub.calls.filter((c) => c.method === "matches")).toHaveLength(0);

      await runInCommunity(app, scope, async (tx) => {
        const auditCountAfter = (
          await tx<{ count: number }[]>`select count(*)::int as count from app.audit_events`
        )[0]!.count;
        expect(auditCountAfter).toBe(auditCountBefore);

        const memberships = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.organisation_members
          where invitation_id = ${invId}::uuid
        `;
        expect(memberships[0]!.count).toBe(0);

        const grants = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.community_role_grants
          where user_id = ${acceptingUser}::uuid
        `;
        expect(grants[0]!.count).toBe(0);

        const links = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.user_links
          where user_id = ${acceptingUser}::uuid
        `;
        expect(links[0]!.count).toBe(0);

        const invRows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(invRows[0]!.status).toBe("revoked");
      });
    });
  });

  it("pin 33: wrong address gets wrong_address and writes nothing", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "intended@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      // User 2 holds token but has a different address
      const otherUser = newId();
      stub.userAddresses.set(otherUser, "different@example.test");

      const auditCountBefore = await runInCommunity(app, scope, async (tx) => {
        const res = await tx<{ count: number }[]>`
          select count(*)::int as count from app.audit_events
        `;
        return res[0]!.count;
      });

      let err: unknown;
      try {
        await runInCommunity(app, scope, (tx) =>
          acceptInvitation(tx, stub, {
            token: created.token,
            userId: otherUser,
            now: NOW,
          }),
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("wrong_address");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(rows[0]!.status).toBe("pending");

        const members = await tx<{ count: number }[]>`
          select count(*)::int as count from app.organisation_members where user_id = ${otherUser}::uuid
        `;
        expect(members[0]!.count).toBe(0);

        const grants = await tx<{ count: number }[]>`
          select count(*)::int as count from app.community_role_grants where user_id = ${otherUser}::uuid
        `;
        expect(grants[0]!.count).toBe(0);

        const links = await tx<{ count: number }[]>`
          select count(*)::int as count from app.user_links where user_id = ${otherUser}::uuid
        `;
        expect(links[0]!.count).toBe(0);

        const closeCalls = stub.calls.filter((c) => c.method === "close");
        expect(closeCalls).toHaveLength(0);

        const auditCountAfter = (
          await tx<{ count: number }[]>`select count(*)::int as count from app.audit_events`
        )[0]!.count;
        expect(auditCountAfter).toBe(auditCountBefore);
      });
    });
  });

  it("pin 34: FOR UPDATE serialises concurrent accepts", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "concurrent-accept@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

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

      let pendingAccepts: Promise<PromiseSettledResult<unknown>[]>;

      const gate = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(holderApp, scope, async (tx) => {
          await tx`
            select id from app.invitations
            where id = ${invId}::uuid
            for update
          `;
          lockHeldResolve();
          await releaseLock;
        }),
      );

      try {
        await lockHeld;

        let accept1Settled = false;
        let accept2Settled = false;

        const p1 = runInCommunity(app, scope, (tx) =>
          acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          }),
        ).finally(() => {
          accept1Settled = true;
        });

        const p2 = runInCommunity(app, scope, (tx) =>
          acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          }),
        ).finally(() => {
          accept2Settled = true;
        });

        pendingAccepts = Promise.allSettled([p1, p2]);

        let waitedBoth = false;
        const started = Date.now();
        while (Date.now() - started < 5_000) {
          const waiting = await observerApp<{ n: number }[]>`
            select count(*)::int as n
            from pg_locks l
            join pg_stat_activity a on a.pid = l.pid
            where a.datname = current_database()
              and l.locktype in ('transactionid', 'tuple')
              and not l.granted
              and (
                a.query like '%app.invitations%'
                or a.query like '%app.organisation_members%'
                or a.query like '%app.community_role_grants%'
              )
          `;
          if ((waiting[0]?.n ?? 0) >= 2) {
            waitedBoth = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        expect(waitedBoth).toBe(true);
        expect(accept1Settled).toBe(false);
        expect(accept2Settled).toBe(false);

        releaseLockResolve();
        await gate;

        const results = await pendingAccepts;
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const err = (rejected[0] as PromiseRejectedResult).reason;
        expect(err).toBeInstanceOf(AccessError);
        expect((err as AccessError).code).toBe("invitation_invalid");

        await runInCommunity(app, scope, async (tx) => {
          const acceptedAudits = await tx<{ count: number }[]>`
            select count(*)::int as count
            from app.audit_events
            where action = 'access.invitation.accepted'
              and target_ids[1] = ${invId}::uuid
          `;
          expect(acceptedAudits[0]?.count).toBe(1);

          await assertNoSensitiveDataInAudit(tx, [address, created.token]);
        });
      } finally {
        releaseLockResolve();
        await gate.catch(() => undefined);
        await holderApp.end({ timeout: 1 });
        await observerApp.end({ timeout: 1 });
      }
    });
  }, 15_000);

  it("pin 35 (a): inviter role revoked before accept gives invitation_void without denied audit", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const inviterUsersRole = await runInCommunity(app, scope, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "inviter_users_role_35a",
          permissions: ["access.users.manage", "access.users.view"],
          actorUserId: owner,
        }),
      );
      const inviterRolesRole = await runInCommunity(app, scope, (tx) =>
        createCustomRole(tx, {
          now: NOW,
          key: "inviter_roles_role_35a",
          permissions: ["access.roles.manage"],
          actorUserId: owner,
        }),
      );

      const inviter = newId();
      await runInCommunity(app, scope, (tx) => addMember(tx, inviter));
      const grantUsers = await runInCommunity(app, scope, (tx) =>
        grantRole(tx, {
          now: NOW,
          userId: inviter,
          roleKey: null,
          customRoleId: inviterUsersRole.customRoleId,
          actorUserId: owner,
        }),
      );
      await runInCommunity(app, scope, (tx) =>
        grantRole(tx, {
          now: NOW,
          userId: inviter,
          roleKey: null,
          customRoleId: inviterRolesRole.customRoleId,
          actorUserId: owner,
        }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "invitee-35a@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: inviter,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      // Revoke inviter's role
      await runInCommunity(app, scope, (tx) =>
        revokeRole(tx, {
          now: NOW,
          grantId: grantUsers.grantId,
          scope: "community",
          actorUserId: owner,
        }),
      );

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      let err: unknown;
      await runInCommunity(app, scope, async (tx) => {
        try {
          await acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          });
        } catch (e) {
          if (e instanceof AccessError && e.code === "invitation_void") {
            err = e;
            return;
          }
          throw e;
        }
      });
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("invitation_void");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(rows[0]!.status).toBe("void");

        const grants = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.community_role_grants
          where user_id = ${acceptingUser}::uuid
        `;
        expect(grants[0]!.count).toBe(0);

        const deniedAudits = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.audit_events
          where action = 'access.permission.denied'
        `;
        expect(deniedAudits[0]!.count).toBe(0);

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("pin 35 (b): member who already holds the invited role accepts successfully", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "already-has-role@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      // User is already a member and already has member role
      await runInCommunity(app, scope, (tx) => addMember(tx, acceptingUser));
      await runInCommunity(app, scope, (tx) =>
        grantRole(tx, {
          now: NOW,
          userId: acceptingUser,
          roleKey: "member",
          customRoleId: null,
          actorUserId: owner,
        }),
      );

      const result = await runInCommunity(app, scope, (tx) =>
        acceptInvitation(tx, stub, {
          token: created.token,
          userId: acceptingUser,
          now: NOW,
        }),
      );
      expect(result.invitationId).toBe(invId);

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(rows[0]!.status).toBe("accepted");

        const grants = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.community_role_grants
          where user_id = ${acceptingUser}::uuid
            and role_key = 'member'
        `;
        expect(grants[0]!.count).toBe(1);

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("pin 35 (c): user whose existing link is to a person now a minor gets invitation_void", async () => {
    await withTwoOrgs(async ({ app, direct, kms, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const { adultId } = await runInCommunity(app, scope, (tx) => createAdultAndMinor(tx, kms));

      const acceptingUser = newId();
      await runInCommunity(app, scope, (tx) => addMember(tx, acceptingUser));

      // Link accepting user to adultId
      await runInCommunity(app, scope, async (tx) => {
        await tx`
          insert into app.user_links (id, org_id, community_id, user_id, person_id)
          values (
            ${newId()}::uuid,
            current_setting('app.org_id')::uuid,
            current_setting('app.community_id')::uuid,
            ${acceptingUser}::uuid,
            ${adultId}::uuid
          )
        `;
      });

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "linked-user-minor@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      // Now person becomes a minor
      await direct`
        update app.persons
        set is_minor = true,
            given_name_restricted = convert_to(given_name, 'UTF8'),
            family_name_restricted = convert_to(family_name, 'UTF8'),
            given_name = null,
            family_name = null
        where id = ${adultId}::uuid
      `;

      stub.userAddresses.set(acceptingUser, address);

      let err: unknown;
      await runInCommunity(app, scope, async (tx) => {
        try {
          await acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          });
        } catch (e) {
          if (e instanceof AccessError && e.code === "invitation_void") {
            err = e;
            return;
          }
          throw e;
        }
      });
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("invitation_void");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(rows[0]!.status).toBe("void");

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("pin 36: contact made a minor after invite gives invitation_void", async () => {
    await withTwoOrgs(async ({ app, direct, kms, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const { adultId } = await runInCommunity(app, scope, (tx) => createAdultAndMinor(tx, kms));

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "contact-becomes-minor@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          personId: adultId,
          now: NOW,
        }),
      );

      // Adult is made a minor after the invite
      await direct`
        update app.persons
        set is_minor = true,
            given_name_restricted = convert_to(given_name, 'UTF8'),
            family_name_restricted = convert_to(family_name, 'UTF8'),
            given_name = null,
            family_name = null
        where id = ${adultId}::uuid
      `;

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      let err: unknown;
      await runInCommunity(app, scope, async (tx) => {
        try {
          await acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          });
        } catch (e) {
          if (e instanceof AccessError && e.code === "invitation_void") {
            err = e;
            return;
          }
          throw e;
        }
      });
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("invitation_void");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(rows[0]!.status).toBe("void");

        const links = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.user_links
          where person_id = ${adultId}::uuid
        `;
        expect(links[0]!.count).toBe(0);

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("pin 36 (c): writeUserLink refuses a minor contact with minor_forbidden", async () => {
    await withTwoOrgs(async ({ app, kms, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const { minorId } = await runInCommunity(app, scope, (tx) => createAdultAndMinor(tx, kms));

      const memberUser = newId();
      await runInCommunity(app, scope, (tx) => addMember(tx, memberUser));

      let err: unknown;
      await runInCommunity(app, scope, async (tx) => {
        try {
          await writeUserLink(tx, {
            userId: memberUser,
            personId: minorId,
            actorUserId: owner,
          });
        } catch (e) {
          err = e;
        }
      });

      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("minor_forbidden");

      await runInCommunity(app, scope, async (tx) => {
        const links = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.user_links
          where user_id = ${memberUser}::uuid
        `;
        expect(links[0]!.count).toBe(0);
      });
    });
  });

  it("pin 37: step 7 failure rolls back savepoint and writes void", async () => {
    await withTwoOrgs(async ({ app, kms, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const { adultId } = await runInCommunity(app, scope, (tx) => createAdultAndMinor(tx, kms));

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "contact-conflict-37@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          personId: adultId,
          roleKey: "member",
          now: NOW,
        }),
      );

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      const anotherUser = newId();
      await runInCommunity(app, scope, (tx) => addMember(tx, anotherUser));

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

      let pendingAccept: Promise<unknown>;

      const gate = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(holderApp, scope, async (tx) => {
          await tx`
            insert into app.user_links (id, org_id, community_id, user_id, person_id)
            values (
              ${newId()}::uuid,
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              ${anotherUser}::uuid,
              ${adultId}::uuid
            )
          `;
          lockHeldResolve();
          await releaseLock;
        }),
      );

      try {
        await lockHeld;

        let acceptSettled = false;
        let acceptErr: unknown;
        pendingAccept = runInCommunity(app, scope, async (tx) => {
          try {
            await acceptInvitation(tx, stub, {
              token: created.token,
              userId: acceptingUser,
              now: NOW,
            });
          } catch (e) {
            if (e instanceof AccessError && e.code === "invitation_void") {
              acceptErr = e;
              return;
            }
            throw e;
          }
        }).finally(() => {
          acceptSettled = true;
        });

        let waited = false;
        const started = Date.now();
        while (Date.now() - started < 5_000) {
          const waiting = await observerApp<{ n: number }[]>`
            select count(*)::int as n
            from pg_locks l
            join pg_stat_activity a on a.pid = l.pid
            where a.datname = current_database()
              and l.locktype in ('transactionid', 'tuple')
              and not l.granted
              and a.query like '%app.user_links%'
          `;
          if ((waiting[0]?.n ?? 0) >= 1) {
            waited = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        expect(waited).toBe(true);
        expect(acceptSettled).toBe(false);

        releaseLockResolve();
        await gate;
        await pendingAccept;

        expect(acceptErr).toBeInstanceOf(AccessError);
        expect((acceptErr as AccessError).code).toBe("invitation_void");

        await runInCommunity(app, scope, async (tx) => {
          const rows = await tx<{ status: string }[]>`
            select status from app.invitations where id = ${invId}::uuid
          `;
          expect(rows[0]!.status).toBe("void");

          const members = await tx<{ count: number }[]>`
            select count(*)::int as count
            from app.organisation_members
            where invitation_id = ${invId}::uuid
          `;
          expect(members[0]!.count).toBe(0);

          const grants = await tx<{ count: number }[]>`
            select count(*)::int as count
            from app.community_role_grants
            where user_id = ${acceptingUser}::uuid
          `;
          expect(grants[0]!.count).toBe(0);

          const voidAudits = await tx<{ count: number }[]>`
            select count(*)::int as count
            from app.audit_events
            where action = 'access.invitation.voided'
              and target_ids[1] = ${invId}::uuid
          `;
          expect(voidAudits[0]!.count).toBe(1);

          await assertNoSensitiveDataInAudit(tx, [address, created.token]);
        });
      } finally {
        releaseLockResolve();
        await gate.catch(() => undefined);
        await holderApp.end({ timeout: 1 });
        await observerApp.end({ timeout: 1 });
      }
    });
  }, 15_000);

  it("pin 38: forged or invalid token writes no audit row", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const realInvId = newId();
      const address = "forged-test@example.test";
      await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: realInvId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      const auditCountBefore = await runInCommunity(app, scope, async (tx) => {
        const res = await tx<{ count: number }[]>`
          select count(*)::int as count from app.audit_events
        `;
        return res[0]!.count;
      });

      // 1. Forged token naming org A's real ids, with random invitation id
      const forged1 = buildInvitationToken({
        orgId: orgA.organisationId,
        communityId: orgA.community1Id,
        invitationId: newId(),
      });

      const user1 = newId();
      stub.userAddresses.set(user1, address);

      let err1: unknown;
      await runInCommunity(app, scope, async (tx) => {
        try {
          await acceptInvitation(tx, stub, {
            token: forged1.token,
            userId: user1,
            now: NOW,
          });
        } catch (e) {
          if (e instanceof AccessError && e.code === "invitation_invalid") {
            err1 = e;
            return;
          }
          throw e;
        }
      });
      expect(err1).toBeInstanceOf(AccessError);
      expect((err1 as AccessError).code).toBe("invitation_invalid");

      const auditCountMiddle = await runInCommunity(app, scope, async (tx) => {
        const res = await tx<{ count: number }[]>`
          select count(*)::int as count from app.audit_events
        `;
        return res[0]!.count;
      });
      expect(auditCountMiddle).toBe(auditCountBefore);

      // 2. Real invitation id with random secret
      const forged2 = buildInvitationToken({
        orgId: orgA.organisationId,
        communityId: orgA.community1Id,
        invitationId: realInvId,
      });

      let err2: unknown;
      await runInCommunity(app, scope, async (tx) => {
        try {
          await acceptInvitation(tx, stub, {
            token: forged2.token,
            userId: user1,
            now: NOW,
          });
        } catch (e) {
          if (e instanceof AccessError && e.code === "invitation_invalid") {
            err2 = e;
            return;
          }
          throw e;
        }
      });
      expect(err2).toBeInstanceOf(AccessError);
      expect((err2 as AccessError).code).toBe("invitation_invalid");

      const auditCountEnd = await runInCommunity(app, scope, async (tx) => {
        const res = await tx<{ count: number }[]>`
          select count(*)::int as count from app.audit_events
        `;
        return res[0]!.count;
      });
      expect(auditCountEnd).toBe(auditCountBefore);
    });
  });

  it("pin 38 (b): a token for org A used in a transaction scoped to org B gives invitation_invalid", async () => {
    await withTwoOrgs(async ({ app, orgA, orgB }) => {
      const scopeA = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const scopeB = { orgId: orgB.organisationId, communityId: orgB.communityId };
      const ownerA = newId();
      await runInCommunity(app, scopeA, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: ownerA, actorUserId: ownerA }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "cross-org@example.test";
      const created = await runInCommunity(app, scopeA, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: ownerA,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      const auditCountBeforeA = await runInCommunity(app, scopeA, async (tx) => {
        const res = await tx<
          { count: number }[]
        >`select count(*)::int as count from app.audit_events`;
        return res[0]!.count;
      });
      const auditCountBeforeB = await runInCommunity(app, scopeB, async (tx) => {
        const res = await tx<
          { count: number }[]
        >`select count(*)::int as count from app.audit_events`;
        return res[0]!.count;
      });

      const userB = newId();
      stub.userAddresses.set(userB, address);

      const proveRes = await runInCommunity(app, scopeB, (tx) =>
        proveInvitation(tx, { token: created.token, now: NOW }),
      );
      expect(proveRes).toBe("invalid");

      let acceptErr: unknown;
      try {
        await runInCommunity(app, scopeB, (tx) =>
          acceptInvitation(tx, stub, {
            token: created.token,
            userId: userB,
            now: NOW,
          }),
        );
      } catch (e) {
        acceptErr = e;
      }
      expect(acceptErr).toBeInstanceOf(AccessError);
      expect((acceptErr as AccessError).code).toBe("invitation_invalid");

      const matchCalls = stub.calls.filter((c) => c.method === "matches");
      expect(matchCalls).toHaveLength(0);

      await runInCommunity(app, scopeA, async (tx) => {
        const auditCountAfter = (
          await tx<{ count: number }[]>`select count(*)::int as count from app.audit_events`
        )[0]!.count;
        expect(auditCountAfter).toBe(auditCountBeforeA);

        const invRows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(invRows[0]!.status).toBe("pending");
      });

      await runInCommunity(app, scopeB, async (tx) => {
        const auditCountAfter = (
          await tx<{ count: number }[]>`select count(*)::int as count from app.audit_events`
        )[0]!.count;
        expect(auditCountAfter).toBe(auditCountBeforeB);

        const members = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.organisation_members
          where user_id = ${userB}::uuid
        `;
        expect(members[0]!.count).toBe(0);

        const grants = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.community_role_grants
          where user_id = ${userB}::uuid
        `;
        expect(grants[0]!.count).toBe(0);

        const links = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.user_links
          where user_id = ${userB}::uuid
        `;
        expect(links[0]!.count).toBe(0);
      });
    });
  });

  it("pin 48 (accept): sweep is the first recorded port call in accept", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "sweep-order@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      // Reset recorded calls to only observe accept
      stub.calls.length = 0;

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      await runInCommunity(app, scope, (tx) =>
        acceptInvitation(tx, stub, {
          token: created.token,
          userId: acceptingUser,
          now: NOW,
        }),
      );

      const methods = stub.calls.map((c) => c.method);
      expect(methods[0]).toBe("sweep");
      expect(methods).toContain("matches");
      expect(methods).toContain("close");
      expect(methods.indexOf("sweep")).toBeLessThan(methods.indexOf("matches"));
      expect(methods.indexOf("matches")).toBeLessThan(methods.indexOf("close"));

      await runInCommunity(app, scope, (tx) =>
        assertNoSensitiveDataInAudit(tx, [address, created.token]),
      );
    });
  });

  it("plain: accepting an invitation with a contact only succeeds", async () => {
    await withTwoOrgs(async ({ app, kms, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const { adultId } = await runInCommunity(app, scope, (tx) => createAdultAndMinor(tx, kms));

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "contact-only@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          personId: adultId,
          now: NOW,
        }),
      );

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      const res = await runInCommunity(app, scope, (tx) =>
        acceptInvitation(tx, stub, {
          token: created.token,
          userId: acceptingUser,
          now: NOW,
        }),
      );
      expect(res.invitationId).toBe(invId);
      expect(res.communityId).toBe(orgA.community1Id);

      await runInCommunity(app, scope, async (tx) => {
        const members = await tx<{ source: string; invitation_id: string | null }[]>`
          select source, invitation_id::text as invitation_id
          from app.organisation_members
          where user_id = ${acceptingUser}::uuid
        `;
        expect(members).toHaveLength(1);
        expect(members[0]!.source).toBe("invitation");
        expect(members[0]!.invitation_id).toBe(invId);

        const links = await tx<{ person_id: string }[]>`
          select person_id::text as person_id
          from app.user_links
          where user_id = ${acceptingUser}::uuid
        `;
        expect(links).toHaveLength(1);
        expect(links[0]!.person_id).toBe(adultId);

        const grants = await tx<{ id: string }[]>`
          select id::text as id
          from app.community_role_grants
          where user_id = ${acceptingUser}::uuid
        `;
        expect(grants).toHaveLength(0);

        const auditRows = await tx<{ target_ids: string[] }[]>`
          select target_ids::text[] as target_ids
          from app.audit_events
          where action = 'access.invitation.accepted'
            and target_ids[1] = ${invId}::uuid
        `;
        expect(auditRows).toHaveLength(1);
        expect(auditRows[0]!.target_ids).toEqual([invId, acceptingUser, orgA.community1Id]);

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("plain: an existing member accepting adds only the role, with no second membership row", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "existing-member@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      // Pre-existing provision membership
      await runInCommunity(app, scope, (tx) => addMember(tx, acceptingUser));

      await runInCommunity(app, scope, (tx) =>
        acceptInvitation(tx, stub, {
          token: created.token,
          userId: acceptingUser,
          now: NOW,
        }),
      );

      await runInCommunity(app, scope, async (tx) => {
        const members = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.organisation_members
          where user_id = ${acceptingUser}::uuid
        `;
        expect(members[0]!.count).toBe(1);

        const grants = await tx<{ count: number }[]>`
          select count(*)::int as count
          from app.community_role_grants
          where user_id = ${acceptingUser}::uuid
            and role_key = 'member'
        `;
        expect(grants[0]!.count).toBe(1);

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("plain: a contact linked to another user since the invite gives invitation_void", async () => {
    await withTwoOrgs(async ({ app, kms, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const { adultId } = await runInCommunity(app, scope, (tx) => createAdultAndMinor(tx, kms));

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "contact-linked-since-invite@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          personId: adultId,
          now: NOW,
        }),
      );

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      // Another user links to the contact before accept
      const otherUser = newId();
      await runInCommunity(app, scope, (tx) => addMember(tx, otherUser));
      await runInCommunity(app, scope, async (tx) => {
        await tx`
          insert into app.user_links (id, org_id, community_id, user_id, person_id)
          values (
            ${newId()}::uuid,
            current_setting('app.org_id')::uuid,
            current_setting('app.community_id')::uuid,
            ${otherUser}::uuid,
            ${adultId}::uuid
          )
        `;
      });

      let err: unknown;
      await runInCommunity(app, scope, async (tx) => {
        try {
          await acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          });
        } catch (e) {
          if (e instanceof AccessError && e.code === "invitation_void") {
            err = e;
            return;
          }
          throw e;
        }
      });
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("invitation_void");

      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ status: string }[]>`
          select status from app.invitations where id = ${invId}::uuid
        `;
        expect(rows[0]!.status).toBe("void");

        await assertNoSensitiveDataInAudit(tx, [address, created.token]);
      });
    });
  });

  it("plain: accepting twice gives invitation_invalid the second time", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const owner = newId();
      await runInCommunity(app, scope, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "accept-twice@example.test";
      const created = await runInCommunity(app, scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      // First accept succeeds
      await runInCommunity(app, scope, (tx) =>
        acceptInvitation(tx, stub, {
          token: created.token,
          userId: acceptingUser,
          now: NOW,
        }),
      );

      // Second accept fails with invitation_invalid
      let err: unknown;
      try {
        await runInCommunity(app, scope, (tx) =>
          acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          }),
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("invitation_invalid");

      await runInCommunity(app, scope, (tx) =>
        assertNoSensitiveDataInAudit(tx, [address, created.token]),
      );
    });
  });

  it("plain: a token for community 1 used in a transaction scoped to community 2 gives invitation_invalid", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope1 = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      const scope2 = { orgId: orgA.organisationId, communityId: orgA.community2Id };
      const owner = newId();
      await runInCommunity(app, scope1, (tx) =>
        bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
      );

      const stub = new MemoryInvitationAddresses();
      const invId = newId();
      const address = "cross-community@example.test";
      const created = await runInCommunity(app, scope1, (tx) =>
        createInvitation(tx, stub, {
          invitationId: invId,
          actorUserId: owner,
          address,
          roleKey: "member",
          now: NOW,
        }),
      );

      const acceptingUser = newId();
      stub.userAddresses.set(acceptingUser, address);

      // proveInvitation in community 2
      const proveRes = await runInCommunity(app, scope2, (tx) =>
        proveInvitation(tx, {
          token: created.token,
          now: NOW,
        }),
      );
      expect(proveRes).toBe("invalid");

      // acceptInvitation in community 2
      let err: unknown;
      try {
        await runInCommunity(app, scope2, (tx) =>
          acceptInvitation(tx, stub, {
            token: created.token,
            userId: acceptingUser,
            now: NOW,
          }),
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AccessError);
      expect((err as AccessError).code).toBe("invitation_invalid");
    });
  });

  it("proves app role privilege on app.persons UPDATE is false", async () => {
    await withTwoOrgs(async ({ app, orgA }) => {
      const scope = { orgId: orgA.organisationId, communityId: orgA.community1Id };
      await runInCommunity(app, scope, async (tx) => {
        const rows = await tx<{ can_update: boolean }[]>`
          select has_table_privilege('app', 'app.persons', 'UPDATE') as can_update
        `;
        expect(rows[0]!.can_update).toBe(false);
      });
    });
  });
});
