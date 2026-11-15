import { appendAuditEvent, newId, type AppTransaction } from "@community-hub/db";

import { AccessError } from "../domain/error.js";
import {
  assertCustomRoleCapacity,
  parseCustomRoleKey,
  parsePermissionList,
  parseUuid,
} from "../domain/role.js";
import { allows, deny, loadActor } from "./grants.js";
import { lockOrganisation } from "./membership.js";

const CREATED = "access.custom_role.created";
const DELETED = "access.custom_role.deleted";
const INVITATION_VOIDED = "access.invitation.voided";
const MANAGE = "access.roles.manage";

type CreateInput = {
  now: Date;
  key: string;
  permissions: string[];
  actorUserId: string;
};

function uniqueViolation(error: unknown, marker: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      typeof current.constraint_name === "string" &&
      current.constraint_name.includes(marker)
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

async function customRoleCount(tx: AppTransaction): Promise<number> {
  const rows = await tx<{ n: number }[]>`
    select count(*)::int as n
    from app.custom_roles
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  return rows[0]?.n ?? 0;
}

export async function createCustomRole(
  tx: AppTransaction,
  input: CreateInput,
): Promise<{ customRoleId: string }> {
  const actorUserId = parseUuid(input.actorUserId);
  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, MANAGE)) {
    await deny(tx, actorUserId);
  }
  const key = parseCustomRoleKey(input.key);
  const permissions = parsePermissionList(input.permissions);
  for (const permission of permissions) {
    if (!allows(actor, permission)) {
      await deny(tx, actorUserId);
    }
  }
  assertCustomRoleCapacity(await customRoleCount(tx));
  const customRoleId = newId();
  try {
    await tx.savepoint("custom_role", async (sp) => {
      await sp`
        insert into app.custom_roles (id, org_id, community_id, key)
        values (
          ${customRoleId}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${key}
        )
      `;
      for (const permission of permissions) {
        await sp`
          insert into app.custom_role_permissions (
            org_id, community_id, custom_role_id, permission
          ) values (
            current_setting('app.org_id')::uuid,
            current_setting('app.community_id')::uuid,
            ${customRoleId}::uuid,
            ${permission}
          )
        `;
      }
    });
  } catch (error) {
    if (uniqueViolation(error, "custom_roles")) {
      throw new AccessError("duplicate_role");
    }
    throw error;
  }
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: CREATED,
    purpose: CREATED,
    targetIds: [customRoleId],
  });
  return { customRoleId };
}

export async function deleteCustomRole(
  tx: AppTransaction,
  input: { now: Date; customRoleId: string; actorUserId: string },
): Promise<void> {
  const customRoleId = parseUuid(input.customRoleId);
  const actorUserId = parseUuid(input.actorUserId);
  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, MANAGE)) {
    await deny(tx, actorUserId);
  }
  await lockOrganisation(tx);
  const roles = await tx<{ id: string }[]>`
    select id::text as id
    from app.custom_roles
    where id = ${customRoleId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  if (roles[0] === undefined) {
    throw new AccessError("not_found");
  }
  const grants = await tx<{ n: number }[]>`
    select count(*)::int as n
    from app.community_role_grants
    where custom_role_id = ${customRoleId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  if ((grants[0]?.n ?? 0) > 0) {
    throw new AccessError("role_in_use");
  }
  const pendingInvitations = await tx<{ n: number }[]>`
    select count(*)::int as n
    from app.invitations
    where custom_role_id = ${customRoleId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and status = 'pending'
      and expires_at > ${input.now}
  `;
  if ((pendingInvitations[0]?.n ?? 0) > 0) {
    throw new AccessError("role_in_use");
  }
  const closedExpired = await tx<{ id: string }[]>`
    update app.invitations
    set status = 'void',
        person_id = null,
        custom_role_id = null,
        closed_at = ${input.now}
    where custom_role_id = ${customRoleId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and status = 'pending'
      and expires_at <= ${input.now}
    returning id::text as id
  `;
  for (const row of closedExpired) {
    await appendAuditEvent(tx, {
      actorKind: "user",
      actorId: actorUserId,
      action: INVITATION_VOIDED,
      purpose: INVITATION_VOIDED,
      targetIds: [row.id],
    });
  }
  await tx`
    delete from app.custom_role_permissions
    where custom_role_id = ${customRoleId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  await tx`
    delete from app.custom_roles
    where id = ${customRoleId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: DELETED,
    purpose: DELETED,
    targetIds: [customRoleId],
  });
}
