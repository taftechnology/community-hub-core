import { appendAuditEvent, newId, type AppTransaction } from "@community-hub/db";
import { personIsMinor } from "@community-hub/people";
import { bundle, decide } from "@community-hub/policy";

import { AccessError } from "../domain/error.js";
import { COMMUNITY_ROLE_KEYS, ORGANISATION_ROLE_KEYS, parseUuid } from "../domain/role.js";

const BOOTSTRAPPED = "access.owner.bootstrapped";
const GRANTED = "access.role.granted";
const REVOKED = "access.role.revoked";
const LINKED = "access.user.linked";
const UNLINKED = "access.user.unlinked";
const DENIED = "access.permission.denied";
const MANAGE = "access.roles.manage";

type LinkInput = {
  now: Date;
  userId: string;
  personId: string;
  actorUserId: string;
};

type GrantInput = {
  now: Date;
  userId: string;
  roleKey: string | null;
  customRoleId: string | null;
  actorUserId: string;
};

export type ActorGrants = {
  organisationRoleKeys: string[];
  communityRoleKeys: string[];
  customPermissions: string[];
};

const ORGANISATION_ROLES = new Set<string>(ORGANISATION_ROLE_KEYS);
const COMMUNITY_ROLES = new Set<string>(COMMUNITY_ROLE_KEYS);

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

export function allows(grants: ActorGrants, permission: string): boolean {
  return decide({
    permission,
    organisationRoleKeys: grants.organisationRoleKeys,
    communityRoleKeys: grants.communityRoleKeys,
    customPermissions: grants.customPermissions,
    guardianView: false,
    personScoped: false,
  });
}

function holdsOrgOwner(actor: ActorGrants): boolean {
  return actor.organisationRoleKeys.includes("org_owner");
}

function holdsOrgAdmin(actor: ActorGrants): boolean {
  return actor.organisationRoleKeys.includes("org_admin");
}

async function assertMayGrantRole(
  tx: AppTransaction,
  actor: ActorGrants,
  actorUserId: string,
  roleKey: string,
): Promise<void> {
  if (roleKey === "org_owner") {
    if (!holdsOrgOwner(actor)) {
      await deny(tx, actorUserId);
    }
    return;
  }
  if (ORGANISATION_ROLES.has(roleKey) && !holdsOrgOwner(actor) && !holdsOrgAdmin(actor)) {
    await deny(tx, actorUserId);
  }
}

export async function loadActor(tx: AppTransaction, actorUserId: string): Promise<ActorGrants> {
  const organisationRows = await tx<{ role_key: string }[]>`
    select role_key
    from app.organisation_role_grants
    where user_id = ${actorUserId}::uuid
      and org_id = current_setting('app.org_id')::uuid
  `;
  const communityRows = await tx<{ role_key: string | null; custom_role_id: string | null }[]>`
    select role_key, custom_role_id::text as custom_role_id
    from app.community_role_grants
    where user_id = ${actorUserId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const customPermissions: string[] = [];
  for (const row of communityRows) {
    if (row.custom_role_id === null) {
      continue;
    }
    const permissionRows = await tx<{ permission: string }[]>`
      select permission
      from app.custom_role_permissions
      where custom_role_id = ${row.custom_role_id}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
    `;
    for (const permission of permissionRows) {
      customPermissions.push(permission.permission);
    }
  }
  return {
    organisationRoleKeys: organisationRows.map((row) => row.role_key),
    communityRoleKeys: communityRows.flatMap((row) =>
      row.role_key === null ? [] : [row.role_key],
    ),
    customPermissions,
  };
}

export async function deny(tx: AppTransaction, actorUserId: string): Promise<never> {
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: DENIED,
    purpose: MANAGE,
    targetIds: [actorUserId],
  });
  throw new AccessError("forbidden");
}

async function countSettingRows(
  tx: AppTransaction,
  table: "organisation" | "community",
): Promise<number> {
  const rows =
    table === "organisation"
      ? await tx<{ n: number }[]>`
          select count(*)::int as n
          from app.organisation_role_grants
          where org_id = current_setting('app.org_id')::uuid
        `
      : await tx<{ n: number }[]>`
          select count(*)::int as n
          from app.community_role_grants
          where org_id = current_setting('app.org_id')::uuid
            and community_id = current_setting('app.community_id')::uuid
        `;
  return rows[0]?.n ?? 0;
}

export async function linkUser(tx: AppTransaction, input: LinkInput): Promise<{ linkId: string }> {
  const userId = parseUuid(input.userId);
  const personId = parseUuid(input.personId);
  const actorUserId = parseUuid(input.actorUserId);
  const minor = await personIsMinor(tx, personId);
  if (minor === null) {
    throw new AccessError("not_found");
  }
  if (minor) {
    throw new AccessError("minor_forbidden");
  }
  const linkId = newId();
  try {
    await tx.savepoint("user_link", async (sp) => {
      await sp`
        insert into app.user_links (id, org_id, community_id, user_id, person_id)
        values (
          ${linkId}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${userId}::uuid,
          ${personId}::uuid
        )
      `;
    });
  } catch (error) {
    if (uniqueViolation(error, "user_links")) {
      throw new AccessError("duplicate_link");
    }
    throw error;
  }
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: LINKED,
    purpose: LINKED,
    targetIds: [linkId],
  });
  return { linkId };
}

export async function unlinkUser(
  tx: AppTransaction,
  input: { now: Date; userId: string; actorUserId: string },
): Promise<void> {
  const userId = parseUuid(input.userId);
  const actorUserId = parseUuid(input.actorUserId);
  const removed = await tx<{ id: string }[]>`
    delete from app.user_links
    where user_id = ${userId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    returning id::text as id
  `;
  if (removed[0] === undefined) {
    throw new AccessError("not_found");
  }
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: UNLINKED,
    purpose: UNLINKED,
    targetIds: [userId],
  });
}

export async function bootstrapOwner(
  tx: AppTransaction,
  input: { now: Date; userId: string; actorUserId: string },
): Promise<{ organisationGrantId: string; communityGrantId: string }> {
  const userId = parseUuid(input.userId);
  const actorUserId = parseUuid(input.actorUserId);
  if (userId !== actorUserId) {
    throw new AccessError("invalid_id");
  }
  const organisationGrants = await countSettingRows(tx, "organisation");
  const communityGrants = await countSettingRows(tx, "community");
  if (organisationGrants > 0 || communityGrants > 0) {
    throw new AccessError("already_bootstrapped");
  }
  const organisationGrantId = newId();
  const communityGrantId = newId();
  await tx`
    insert into app.organisation_role_grants (id, org_id, user_id, role_key)
    values (
      ${organisationGrantId}::uuid,
      current_setting('app.org_id')::uuid,
      ${userId}::uuid,
      'org_owner'
    )
  `;
  await tx`
    insert into app.community_role_grants (
      id, org_id, community_id, user_id, role_key, custom_role_id
    ) values (
      ${communityGrantId}::uuid,
      current_setting('app.org_id')::uuid,
      current_setting('app.community_id')::uuid,
      ${userId}::uuid,
      'community_admin',
      null
    )
  `;
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: BOOTSTRAPPED,
    purpose: BOOTSTRAPPED,
    targetIds: [organisationGrantId, communityGrantId],
  });
  return { organisationGrantId, communityGrantId };
}

async function assertGrantSubjectAdult(tx: AppTransaction, userId: string): Promise<void> {
  const linked = await tx<{ person_id: string }[]>`
    select person_id::text as person_id
    from app.user_links
    where user_id = ${userId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const personId = linked[0]?.person_id;
  if (personId === undefined) {
    return;
  }
  const minor = await personIsMinor(tx, personId);
  if (minor === null) {
    throw new AccessError("not_found");
  }
  if (minor) {
    throw new AccessError("minor_forbidden");
  }
}

async function grantCustomRole(
  tx: AppTransaction,
  userId: string,
  actorUserId: string,
  customRoleId: string,
): Promise<{ grantId: string; scope: "community" }> {
  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, MANAGE)) {
    await deny(tx, actorUserId);
  }
  const roles = await tx<{ id: string }[]>`
    select id::text as id
    from app.custom_roles
    where id = ${customRoleId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  if (roles[0] === undefined) {
    throw new AccessError("invalid_role");
  }
  const permissionRows = await tx<{ permission: string }[]>`
    select permission
    from app.custom_role_permissions
    where custom_role_id = ${customRoleId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  for (const row of permissionRows) {
    if (!allows(actor, row.permission)) {
      await deny(tx, actorUserId);
    }
  }
  await assertGrantSubjectAdult(tx, userId);
  const grantId = newId();
  try {
    await tx.savepoint("role_grant", async (sp) => {
      await sp`
        insert into app.community_role_grants (
          id, org_id, community_id, user_id, role_key, custom_role_id
        ) values (
          ${grantId}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${userId}::uuid,
          null,
          ${customRoleId}::uuid
        )
      `;
    });
  } catch (error) {
    if (uniqueViolation(error, "role_grant")) {
      throw new AccessError("duplicate_grant");
    }
    throw error;
  }
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: GRANTED,
    purpose: GRANTED,
    targetIds: [grantId],
  });
  return { grantId, scope: "community" };
}

export async function grantRole(
  tx: AppTransaction,
  input: GrantInput,
): Promise<{ grantId: string; scope: "organisation" | "community" }> {
  const userId = parseUuid(input.userId);
  const actorUserId = parseUuid(input.actorUserId);
  const hasRole = input.roleKey !== null;
  const hasCustom = input.customRoleId !== null;
  if (hasRole === hasCustom) {
    throw new AccessError("invalid_role");
  }
  if (input.customRoleId !== null) {
    return grantCustomRole(tx, userId, actorUserId, parseUuid(input.customRoleId));
  }
  const roleKey = input.roleKey ?? "";
  const organisationRole = ORGANISATION_ROLES.has(roleKey);
  const communityRole = COMMUNITY_ROLES.has(roleKey);
  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, MANAGE)) {
    await deny(tx, actorUserId);
  }
  if (!organisationRole && !communityRole) {
    throw new AccessError("invalid_role");
  }
  await assertMayGrantRole(tx, actor, actorUserId, roleKey);
  const permissions = bundle(roleKey);
  if (permissions === null) {
    throw new AccessError("invalid_role");
  }
  for (const permission of permissions) {
    if (!allows(actor, permission)) {
      await deny(tx, actorUserId);
    }
  }
  const linked = await tx<{ person_id: string }[]>`
    select person_id::text as person_id
    from app.user_links
    where user_id = ${userId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const personId = linked[0]?.person_id;
  if (personId !== undefined) {
    const minor = await personIsMinor(tx, personId);
    if (minor === null) {
      throw new AccessError("not_found");
    }
    if (minor) {
      throw new AccessError("minor_forbidden");
    }
  }
  const grantId = newId();
  const scope = organisationRole ? "organisation" : "community";
  try {
    await tx.savepoint("role_grant", async (sp) => {
      if (scope === "organisation") {
        await sp`
          insert into app.organisation_role_grants (id, org_id, user_id, role_key)
          values (
            ${grantId}::uuid,
            current_setting('app.org_id')::uuid,
            ${userId}::uuid,
            ${roleKey}
          )
        `;
        return;
      }
      await sp`
        insert into app.community_role_grants (
          id, org_id, community_id, user_id, role_key, custom_role_id
        ) values (
          ${grantId}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${userId}::uuid,
          ${roleKey},
          null
        )
      `;
    });
  } catch (error) {
    if (uniqueViolation(error, "role_grant")) {
      throw new AccessError("duplicate_grant");
    }
    throw error;
  }
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: GRANTED,
    purpose: GRANTED,
    targetIds: [grantId],
  });
  return { grantId, scope };
}

export async function revokeRole(
  tx: AppTransaction,
  input: {
    now: Date;
    grantId: string;
    scope: "organisation" | "community";
    actorUserId: string;
  },
): Promise<void> {
  const grantId = parseUuid(input.grantId);
  const actorUserId = parseUuid(input.actorUserId);
  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, MANAGE)) {
    await deny(tx, actorUserId);
  }
  if (input.scope === "organisation") {
    const rows = await tx<{ role_key: string }[]>`
      select role_key
      from app.organisation_role_grants
      where id = ${grantId}::uuid
        and org_id = current_setting('app.org_id')::uuid
    `;
    const roleKey = rows[0]?.role_key;
    if (roleKey === undefined) {
      throw new AccessError("not_found");
    }
    await assertMayGrantRole(tx, actor, actorUserId, roleKey);
    const permissions = bundle(roleKey);
    if (permissions === null) {
      throw new AccessError("invalid_role");
    }
    for (const permission of permissions) {
      if (!allows(actor, permission)) {
        await deny(tx, actorUserId);
      }
    }
    if (roleKey === "org_owner") {
      const owners = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.organisation_role_grants
        where role_key = 'org_owner'
          and org_id = current_setting('app.org_id')::uuid
      `;
      if ((owners[0]?.n ?? 0) <= 1) {
        throw new AccessError("last_owner");
      }
    }
    await tx`
      delete from app.organisation_role_grants
      where id = ${grantId}::uuid
        and org_id = current_setting('app.org_id')::uuid
    `;
  } else {
    const rows = await tx<{ role_key: string | null; custom_role_id: string | null }[]>`
      select role_key, custom_role_id::text as custom_role_id
      from app.community_role_grants
      where id = ${grantId}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new AccessError("not_found");
    }
    if (row.role_key !== null) {
      await assertMayGrantRole(tx, actor, actorUserId, row.role_key);
      const permissions = bundle(row.role_key);
      if (permissions === null) {
        throw new AccessError("invalid_role");
      }
      for (const permission of permissions) {
        if (!allows(actor, permission)) {
          await deny(tx, actorUserId);
        }
      }
    } else if (row.custom_role_id !== null) {
      const permissionRows = await tx<{ permission: string }[]>`
        select permission
        from app.custom_role_permissions
        where custom_role_id = ${row.custom_role_id}::uuid
          and org_id = current_setting('app.org_id')::uuid
          and community_id = current_setting('app.community_id')::uuid
      `;
      for (const permission of permissionRows) {
        if (!allows(actor, permission.permission)) {
          await deny(tx, actorUserId);
        }
      }
    }
    await tx`
      delete from app.community_role_grants
      where id = ${grantId}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
    `;
  }
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: REVOKED,
    purpose: REVOKED,
    targetIds: [grantId],
  });
}
