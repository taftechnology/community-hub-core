import { appendAuditEvent, newId, type AppTransaction } from "@community-hub/db";
import { personIsMinor } from "@community-hub/people";
import { bundle, decide } from "@community-hub/policy";

import { AccessError } from "../domain/error.js";
import { COMMUNITY_ROLE_KEYS, ORGANISATION_ROLE_KEYS, parseUuid } from "../domain/role.js";
import { insertMembership, isMember, lockOrganisation } from "./membership.js";

const BOOTSTRAPPED = "access.owner.bootstrapped";
const GRANTED = "access.role.granted";
const REVOKED = "access.role.revoked";
const LINKED = "access.user.linked";
const UNLINKED = "access.user.unlinked";
const DENIED = "access.permission.denied";
const MANAGE = "access.roles.manage";
const USERS = "access.users.manage";

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

export type RoleToGrant =
  | { kind: "builtin"; roleKey: string }
  | { kind: "custom"; permissions: readonly string[] | string[] };

export function roleGrantAllowed(actor: ActorGrants, role: RoleToGrant): boolean {
  if (role.kind === "builtin") {
    if (role.roleKey === "org_owner") {
      if (!holdsOrgOwner(actor)) {
        return false;
      }
    } else if (ORGANISATION_ROLES.has(role.roleKey)) {
      if (!holdsOrgOwner(actor) && !holdsOrgAdmin(actor)) {
        return false;
      }
    }
    const permissions = bundle(role.roleKey);
    if (permissions === null) {
      return false;
    }
    for (const permission of permissions) {
      if (!allows(actor, permission)) {
        return false;
      }
    }
    return true;
  }
  for (const permission of role.permissions) {
    if (!allows(actor, permission)) {
      return false;
    }
  }
  return true;
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

export async function deny(
  tx: AppTransaction,
  actorUserId: string,
  purpose: string = MANAGE,
): Promise<never> {
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: DENIED,
    purpose,
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

async function denyNotMember(tx: AppTransaction, actorUserId: string): Promise<never> {
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: DENIED,
    purpose: "access.user.not_member",
    targetIds: [actorUserId],
  });
  throw new AccessError("not_member");
}

export type WriteRoleGrantInput = {
  readonly userId: string;
  readonly roleKey: string;
  readonly actorUserId: string;
  readonly skipDuplicate?: boolean;
};

export type WriteCustomRoleGrantInput = {
  readonly userId: string;
  readonly customRoleId: string;
  readonly actorUserId: string;
  readonly skipDuplicate?: boolean;
};

export type WriteUserLinkInput = {
  readonly userId: string;
  readonly personId: string;
  readonly actorUserId: string;
  readonly skipDuplicate?: boolean;
};

export async function writeUserLink(
  tx: AppTransaction,
  input: WriteUserLinkInput,
): Promise<{ linkId: string | null; skipped: boolean }> {
  const userId = parseUuid(input.userId);
  const personId = parseUuid(input.personId);
  const actorUserId = parseUuid(input.actorUserId);

  if (!(await isMember(tx, userId))) {
    throw new AccessError("not_member");
  }

  const minor = await personIsMinor(tx, personId, { lock: "share" });
  if (minor === null) {
    throw new AccessError("not_found");
  }
  if (minor) {
    throw new AccessError("minor_forbidden");
  }

  if (input.skipDuplicate) {
    const exact = await tx<{ id: string }[]>`
      select id::text as id
      from app.user_links
      where org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
        and user_id = ${userId}::uuid
        and person_id = ${personId}::uuid
    `;
    if (exact.length > 0) {
      return { linkId: exact[0]!.id, skipped: true };
    }
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
      if (input.skipDuplicate) {
        const recheck = await tx<{ id: string }[]>`
          select id::text as id
          from app.user_links
          where org_id = current_setting('app.org_id')::uuid
            and community_id = current_setting('app.community_id')::uuid
            and user_id = ${userId}::uuid
            and person_id = ${personId}::uuid
        `;
        if (recheck.length > 0) {
          return { linkId: recheck[0]!.id, skipped: true };
        }
      }
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

  return { linkId, skipped: false };
}

export async function linkUser(tx: AppTransaction, input: LinkInput): Promise<{ linkId: string }> {
  const userId = parseUuid(input.userId);
  const personId = parseUuid(input.personId);
  const actorUserId = parseUuid(input.actorUserId);
  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, USERS)) {
    await deny(tx, actorUserId, USERS);
  }
  if (!(await isMember(tx, userId))) {
    await denyNotMember(tx, actorUserId);
  }
  const result = await writeUserLink(tx, {
    userId,
    personId,
    actorUserId,
    skipDuplicate: false,
  });
  return { linkId: result.linkId! };
}

export async function unlinkUser(
  tx: AppTransaction,
  input: { now: Date; userId: string; actorUserId: string },
): Promise<void> {
  const userId = parseUuid(input.userId);
  const actorUserId = parseUuid(input.actorUserId);
  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, USERS)) {
    await deny(tx, actorUserId, USERS);
  }
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
  await lockOrganisation(tx);
  const organisationGrants = await countSettingRows(tx, "organisation");
  const communityGrants = await countSettingRows(tx, "community");
  if (organisationGrants > 0 || communityGrants > 0) {
    throw new AccessError("already_bootstrapped");
  }
  await insertMembership(tx, {
    userId,
    source: "provision",
    now: input.now,
  });
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

export async function findOwner(tx: AppTransaction): Promise<{ userId: string } | null> {
  const organisationRows = await tx<{ user_id: string }[]>`
    select user_id::text as user_id
    from app.organisation_role_grants
    where org_id = current_setting('app.org_id')::uuid
    limit 1
  `;
  const organisationUserId = organisationRows[0]?.user_id;
  if (organisationUserId !== undefined) {
    return { userId: organisationUserId };
  }
  const communityRows = await tx<{ user_id: string }[]>`
    select user_id::text as user_id
    from app.community_role_grants
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    limit 1
  `;
  const communityUserId = communityRows[0]?.user_id;
  if (communityUserId !== undefined) {
    return { userId: communityUserId };
  }
  return null;
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

export async function writeCustomRoleGrant(
  tx: AppTransaction,
  input: WriteCustomRoleGrantInput,
): Promise<{ grantId: string | null; scope: "community"; skipped: boolean }> {
  const userId = parseUuid(input.userId);
  const customRoleId = parseUuid(input.customRoleId);
  const actorUserId = parseUuid(input.actorUserId);

  if (!(await isMember(tx, userId))) {
    throw new AccessError("not_member");
  }

  await assertGrantSubjectAdult(tx, userId);

  if (input.skipDuplicate) {
    const existing = await tx<{ id: string }[]>`
      select id::text as id
      from app.community_role_grants
      where org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
        and user_id = ${userId}::uuid
        and custom_role_id = ${customRoleId}::uuid
    `;
    if (existing.length > 0) {
      return { grantId: existing[0]!.id, scope: "community", skipped: true };
    }
  }

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
      if (input.skipDuplicate) {
        return { grantId: null, scope: "community", skipped: true };
      }
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

  return { grantId, scope: "community", skipped: false };
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
  if (
    !roleGrantAllowed(actor, {
      kind: "custom",
      permissions: permissionRows.map((row) => row.permission),
    })
  ) {
    await deny(tx, actorUserId);
  }
  if (!(await isMember(tx, userId))) {
    await denyNotMember(tx, actorUserId);
  }
  const result = await writeCustomRoleGrant(tx, {
    userId,
    customRoleId,
    actorUserId,
    skipDuplicate: false,
  });
  return { grantId: result.grantId!, scope: "community" };
}

export async function writeRoleGrant(
  tx: AppTransaction,
  input: WriteRoleGrantInput,
): Promise<{ grantId: string | null; scope: "organisation" | "community"; skipped: boolean }> {
  const userId = parseUuid(input.userId);
  const actorUserId = parseUuid(input.actorUserId);
  const roleKey = input.roleKey;
  const organisationRole = ORGANISATION_ROLES.has(roleKey);
  const communityRole = COMMUNITY_ROLES.has(roleKey);
  if (!organisationRole && !communityRole) {
    throw new AccessError("invalid_role");
  }

  if (!(await isMember(tx, userId))) {
    throw new AccessError("not_member");
  }

  await assertGrantSubjectAdult(tx, userId);

  const scope = organisationRole ? "organisation" : "community";

  if (input.skipDuplicate) {
    if (scope === "organisation") {
      const existing = await tx<{ id: string }[]>`
        select id::text as id
        from app.organisation_role_grants
        where org_id = current_setting('app.org_id')::uuid
          and user_id = ${userId}::uuid
          and role_key = ${roleKey}
      `;
      if (existing.length > 0) {
        return { grantId: existing[0]!.id, scope, skipped: true };
      }
    } else {
      const existing = await tx<{ id: string }[]>`
        select id::text as id
        from app.community_role_grants
        where org_id = current_setting('app.org_id')::uuid
          and community_id = current_setting('app.community_id')::uuid
          and user_id = ${userId}::uuid
          and role_key = ${roleKey}
      `;
      if (existing.length > 0) {
        return { grantId: existing[0]!.id, scope, skipped: true };
      }
    }
  }

  const grantId = newId();
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
      if (input.skipDuplicate) {
        return { grantId: null, scope, skipped: true };
      }
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

  return { grantId, scope, skipped: false };
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
  if (!roleGrantAllowed(actor, { kind: "builtin", roleKey })) {
    await deny(tx, actorUserId);
  }
  if (!(await isMember(tx, userId))) {
    await denyNotMember(tx, actorUserId);
  }
  const result = await writeRoleGrant(tx, {
    userId,
    roleKey,
    actorUserId,
    skipDuplicate: false,
  });
  return { grantId: result.grantId!, scope: result.scope };
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
      await lockOrganisation(tx);
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
