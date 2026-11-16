import { createHash, timingSafeEqual } from "node:crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";
import { personIsMinor } from "@community-hub/people";

import { AccessError } from "../domain/error.js";
import type { InvitationAddresses } from "../domain/invitation-addresses.js";
import { buildInvitationToken, parseInvitationToken } from "../domain/invitation-token.js";
import { COMMUNITY_ROLE_KEYS, ORGANISATION_ROLE_KEYS, parseUuid } from "../domain/role.js";
import {
  allows,
  deny,
  loadActor,
  roleGrantAllowed,
  writeCustomRoleGrant,
  writeRoleGrant,
  writeUserLink,
} from "./grants.js";
import { insertMembership, lockOrganisation } from "./membership.js";

const ORGANISATION_ROLES = new Set<string>(ORGANISATION_ROLE_KEYS);
const COMMUNITY_ROLES = new Set<string>(COMMUNITY_ROLE_KEYS);

const INVITATION_CREATED = "access.invitation.created";
const INVITATION_RESENT = "access.invitation.resent";
const INVITATION_REVOKED = "access.invitation.revoked";
const INVITATION_ACCEPTED = "access.invitation.accepted";
const INVITATION_VOIDED = "access.invitation.voided";
const INVITATIONS_LISTED = "access.invitations.listed";

export type CreateInvitationInput = {
  readonly invitationId: string;
  readonly actorUserId: string;
  readonly address: string;
  readonly roleKey?: string | null;
  readonly customRoleId?: string | null;
  readonly personId?: string | null;
  readonly now?: Date;
};

export type ProveInvitationInput = {
  readonly token: string;
  readonly now?: Date;
};

export type AcceptInvitationInput = {
  readonly token: string;
  readonly userId: string;
  readonly now?: Date;
};

export type ListInvitationsInput = {
  readonly actorUserId: string;
  readonly now?: Date;
};

export type InvitationListItem = {
  readonly id: string;
  readonly email: string | null;
  readonly roleKey: string | null;
  readonly customRoleId: string | null;
  readonly linksContact: boolean;
  readonly expiresAt: Date;
};

export type ResendInvitationInput = {
  readonly invitationId: string;
  readonly actorUserId: string;
  readonly now?: Date;
};

export type RevokeInvitationInput = {
  readonly invitationId: string;
  readonly actorUserId: string;
  readonly now?: Date;
};

export type MailFailureInput = {
  readonly invitationId: string;
  readonly actorUserId: string;
  readonly now?: Date;
};

async function purgeOldInvitations(tx: AppTransaction, now: Date): Promise<void> {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  await tx`
    delete from app.invitations
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and (
        (status in ('revoked', 'void') and closed_at < ${thirtyDaysAgo})
        or (status = 'pending' and expires_at < ${thirtyDaysAgo})
      )
  `;
}

export async function createInvitation(
  tx: AppTransaction,
  addresses: Pick<InvitationAddresses, "sweep" | "create">,
  input: CreateInvitationInput,
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const invitationId = parseUuid(input.invitationId);
  const actorUserId = parseUuid(input.actorUserId);

  const hasRoleKey = input.roleKey !== null && input.roleKey !== undefined;
  const hasCustomRole = input.customRoleId !== null && input.customRoleId !== undefined;
  const hasPerson = input.personId !== null && input.personId !== undefined;

  if ((!hasRoleKey && !hasCustomRole && !hasPerson) || (hasRoleKey && hasCustomRole)) {
    throw new AccessError("invalid_role");
  }

  const customRoleId = hasCustomRole ? parseUuid(input.customRoleId!) : null;
  const personId = hasPerson ? parseUuid(input.personId!) : null;

  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, "access.users.manage")) {
    await deny(tx, actorUserId, "access.users.manage");
  }
  if ((hasRoleKey || hasCustomRole) && !allows(actor, "access.roles.manage")) {
    await deny(tx, actorUserId, "access.roles.manage");
  }
  if (hasPerson && !allows(actor, "people.view")) {
    await deny(tx, actorUserId, "people.person.view");
  }

  await lockOrganisation(tx);

  const now = input.now ?? new Date();
  await addresses.sweep(now);

  await purgeOldInvitations(tx, now);

  const pendingRows = await tx<{ n: number }[]>`
    select count(*)::int as n
    from app.invitations
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and status = 'pending'
      and expires_at > ${now}
  `;
  if ((pendingRows[0]?.n ?? 0) >= 100) {
    throw new AccessError("too_many");
  }

  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const recentRows = await tx<{ n: number }[]>`
    select count(*)::int as n
    from app.invitations
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and created_at >= ${oneHourAgo}
      and not (status = 'pending' and expires_at <= ${now})
  `;
  if ((recentRows[0]?.n ?? 0) >= 20) {
    throw new AccessError("too_many");
  }

  if (hasRoleKey) {
    const roleKey = input.roleKey!;
    if (!ORGANISATION_ROLES.has(roleKey) && !COMMUNITY_ROLES.has(roleKey)) {
      throw new AccessError("role_not_found");
    }
    if (!roleGrantAllowed(actor, { kind: "builtin", roleKey })) {
      await deny(tx, actorUserId, "access.roles.manage");
    }
  }

  if (hasCustomRole) {
    const roles = await tx<{ id: string }[]>`
      select id::text as id
      from app.custom_roles
      where id = ${customRoleId}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
    `;
    if (roles[0] === undefined) {
      throw new AccessError("role_not_found");
    }
    const perms = await tx<{ permission: string }[]>`
      select permission
      from app.custom_role_permissions
      where custom_role_id = ${customRoleId}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
    `;
    if (
      !roleGrantAllowed(actor, {
        kind: "custom",
        permissions: perms.map((p) => p.permission),
      })
    ) {
      await deny(tx, actorUserId, "access.roles.manage");
    }
  }

  if (hasPerson) {
    const minor = await personIsMinor(tx, personId!);
    if (minor === null) {
      throw new AccessError("person_not_found");
    }
    if (minor) {
      throw new AccessError("person_minor");
    }
    const existingLink = await tx<{ exists: boolean }[]>`
      select exists(
        select 1
        from app.user_links
        where person_id = ${personId}::uuid
          and org_id = current_setting('app.org_id')::uuid
          and community_id = current_setting('app.community_id')::uuid
      ) as exists
    `;
    if (existingLink[0]?.exists) {
      throw new AccessError("person_linked");
    }
  }

  const scope = await tx<{ org_id: string; community_id: string }[]>`
    select
      current_setting('app.org_id') as org_id,
      current_setting('app.community_id') as community_id
  `;
  const orgId = scope[0]!.org_id;
  const communityId = scope[0]!.community_id;

  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { token, tokenHash } = buildInvitationToken({
    orgId,
    communityId,
    invitationId,
  });

  await tx`
    insert into app.invitations (
      id, org_id, community_id, invited_by, token_hash, role_key, custom_role_id,
      person_id, status, expires_at, resend_count, last_sent_at, accepted_user_id, closed_at, created_at
    ) values (
      ${invitationId}::uuid,
      ${orgId}::uuid,
      ${communityId}::uuid,
      ${actorUserId}::uuid,
      ${tokenHash},
      ${hasRoleKey ? input.roleKey! : null},
      ${hasCustomRole ? customRoleId : null}::uuid,
      ${hasPerson ? personId : null}::uuid,
      'pending',
      ${expiresAt},
      0,
      ${now},
      null,
      null,
      ${now}
    )
  `;

  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: INVITATION_CREATED,
    purpose: INVITATION_CREATED,
    targetIds: [invitationId],
  });

  const created = await addresses.create({
    invitationId,
    communityId,
    address: input.address,
    expiresAt,
  });
  if (!created.ok) {
    if (created.reason === "already_invited") {
      throw new AccessError("already_invited");
    }
  }

  return { invitationId, token, expiresAt };
}

export async function listInvitations(
  tx: AppTransaction,
  addresses: Pick<InvitationAddresses, "sweep" | "open">,
  input: ListInvitationsInput,
): Promise<InvitationListItem[]> {
  const actorUserId = parseUuid(input.actorUserId);
  const now = input.now ?? new Date();

  await addresses.sweep(now);

  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, "access.users.view")) {
    await deny(tx, actorUserId, "access.users.view");
  }
  if (!allows(actor, "access.roles.view")) {
    await deny(tx, actorUserId, "access.roles.view");
  }

  await purgeOldInvitations(tx, now);

  const rows = await tx<
    {
      id: string;
      role_key: string | null;
      custom_role_id: string | null;
      person_id: string | null;
      expires_at: Date;
    }[]
  >`
    select
      id::text as id,
      role_key,
      custom_role_id::text as custom_role_id,
      person_id::text as person_id,
      expires_at
    from app.invitations
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and status = 'pending'
      and expires_at > ${now}
    order by expires_at asc, id asc
    limit 100
  `;

  const ids = rows.map((r) => r.id);
  const openMap = await addresses.open(ids);

  const invitations: InvitationListItem[] = rows.map((r) => ({
    id: r.id,
    email: openMap.get(r.id) ?? null,
    roleKey: r.role_key,
    customRoleId: r.custom_role_id,
    linksContact: r.person_id !== null,
    expiresAt: r.expires_at,
  }));

  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: INVITATIONS_LISTED,
    purpose: INVITATIONS_LISTED,
    targetIds: invitations.map((i) => i.id),
  });

  return invitations;
}

export async function resendInvitation(
  tx: AppTransaction,
  addresses: Pick<InvitationAddresses, "sweep" | "refresh">,
  input: ResendInvitationInput,
): Promise<{ token: string; expiresAt: Date }> {
  const invitationId = parseUuid(input.invitationId);
  const actorUserId = parseUuid(input.actorUserId);
  const now = input.now ?? new Date();

  await addresses.sweep(now);

  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, "access.users.manage")) {
    await deny(tx, actorUserId, "access.users.manage");
  }

  const rows = await tx<
    {
      id: string;
      org_id: string;
      community_id: string;
      resend_count: number;
      last_sent_at: Date;
    }[]
  >`
    select
      id::text as id,
      org_id::text as org_id,
      community_id::text as community_id,
      resend_count,
      last_sent_at
    from app.invitations
    where id = ${invitationId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and status = 'pending'
      and expires_at > ${now}
    for update
  `;

  const row = rows[0];
  if (row === undefined) {
    throw new AccessError("invitation_not_found");
  }

  const is24hOld = now.getTime() - row.last_sent_at.getTime() >= 24 * 60 * 60 * 1000;
  if (!is24hOld && row.resend_count >= 3) {
    throw new AccessError("too_many");
  }

  const newResendCount = is24hOld ? 1 : row.resend_count + 1;
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { token, tokenHash } = buildInvitationToken({
    orgId: row.org_id,
    communityId: row.community_id,
    invitationId,
  });

  await tx`
    update app.invitations
    set token_hash = ${tokenHash},
        expires_at = ${expiresAt},
        resend_count = ${newResendCount},
        last_sent_at = ${now}
    where id = ${invitationId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;

  const refreshed = await addresses.refresh({ invitationId, expiresAt });
  if (!refreshed) {
    throw new AccessError("invitation_not_found");
  }

  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: INVITATION_RESENT,
    purpose: INVITATION_RESENT,
    targetIds: [invitationId],
  });

  return { token, expiresAt };
}

export async function revokeInvitation(
  tx: AppTransaction,
  addresses: Pick<InvitationAddresses, "sweep" | "close">,
  input: RevokeInvitationInput,
): Promise<void> {
  const invitationId = parseUuid(input.invitationId);
  const actorUserId = parseUuid(input.actorUserId);
  const now = input.now ?? new Date();

  await addresses.sweep(now);

  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, "access.users.manage")) {
    await deny(tx, actorUserId, "access.users.manage");
  }

  const rows = await tx<{ id: string }[]>`
    select id::text as id
    from app.invitations
    where id = ${invitationId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and status = 'pending'
    for update
  `;

  if (rows[0] === undefined) {
    throw new AccessError("invitation_not_found");
  }

  await tx`
    update app.invitations
    set status = 'revoked',
        person_id = null,
        custom_role_id = null,
        closed_at = ${now}
    where id = ${invitationId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;

  await addresses.close(invitationId);

  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: INVITATION_REVOKED,
    purpose: INVITATION_REVOKED,
    targetIds: [invitationId],
  });
}

export async function deleteInvitationAfterMailFailure(
  tx: AppTransaction,
  addresses: Pick<InvitationAddresses, "sweep" | "close">,
  input: MailFailureInput,
): Promise<void> {
  const invitationId = parseUuid(input.invitationId);
  const actorUserId = parseUuid(input.actorUserId);
  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, "access.users.manage")) {
    await deny(tx, actorUserId, "access.users.manage");
  }
  const now = input.now ?? new Date();

  await addresses.sweep(now);

  const deleted = await tx<{ id: string }[]>`
    delete from app.invitations
    where id = ${invitationId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and status = 'pending'
    returning id::text as id
  `;

  if (deleted.length === 0) {
    return;
  }

  await addresses.close(invitationId);

  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: INVITATION_VOIDED,
    purpose: INVITATION_VOIDED,
    targetIds: [invitationId],
  });
}

export async function voidInvitationAfterMailFailure(
  tx: AppTransaction,
  addresses: Pick<InvitationAddresses, "sweep" | "close">,
  input: MailFailureInput,
): Promise<void> {
  const invitationId = parseUuid(input.invitationId);
  const actorUserId = parseUuid(input.actorUserId);
  const actor = await loadActor(tx, actorUserId);
  if (!allows(actor, "access.users.manage")) {
    await deny(tx, actorUserId, "access.users.manage");
  }
  const now = input.now ?? new Date();

  await addresses.sweep(now);

  const voided = await tx<{ id: string }[]>`
    update app.invitations
    set status = 'void',
        person_id = null,
        custom_role_id = null,
        closed_at = ${now}
    where id = ${invitationId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and status = 'pending'
    returning id::text as id
  `;

  if (voided.length === 0) {
    return;
  }

  await addresses.close(invitationId);

  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: INVITATION_VOIDED,
    purpose: INVITATION_VOIDED,
    targetIds: [invitationId],
  });
}

export async function proveInvitation(
  tx: AppTransaction,
  input: ProveInvitationInput,
): Promise<"ok" | "invalid"> {
  const parsed = parseInvitationToken(input.token);
  if (parsed === "invalid") {
    return "invalid";
  }

  const settings = await tx<{ org_id: string; community_id: string }[]>`
    select
      current_setting('app.org_id') as org_id,
      current_setting('app.community_id') as community_id
  `;
  if (parsed.orgId !== settings[0]?.org_id || parsed.communityId !== settings[0]?.community_id) {
    return "invalid";
  }

  const rows = await tx<
    {
      token_hash: Buffer | Uint8Array;
      status: string;
      expires_at: Date;
    }[]
  >`
    select token_hash, status, expires_at
    from app.invitations
    where id = ${parsed.invitationId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const row = rows[0];
  if (!row) {
    return "invalid";
  }

  const computedHash = createHash("sha256").update(parsed.secret).digest();
  const storedHash = Buffer.from(row.token_hash);
  if (storedHash.length !== computedHash.length) {
    return "invalid";
  }
  if (!timingSafeEqual(storedHash, computedHash)) {
    return "invalid";
  }

  const now = input.now ?? new Date();
  if (row.status !== "pending" || row.expires_at <= now) {
    return "invalid";
  }

  return "ok";
}

async function voidInvitation(
  tx: AppTransaction,
  addresses: Pick<InvitationAddresses, "close">,
  invitationId: string,
  actorUserId: string,
  now: Date,
): Promise<never> {
  const voided = await tx<{ id: string }[]>`
    update app.invitations
    set status = 'void',
        person_id = null,
        custom_role_id = null,
        closed_at = ${now}
    where id = ${invitationId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and status = 'pending'
    returning id::text as id
  `;
  if (voided.length === 0) {
    throw new AccessError("invitation_invalid");
  }
  await addresses.close(invitationId);
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: actorUserId,
    action: INVITATION_VOIDED,
    purpose: INVITATION_VOIDED,
    targetIds: [invitationId],
  });
  throw new AccessError("invitation_void");
}

export async function acceptInvitation(
  tx: AppTransaction,
  addresses: Pick<InvitationAddresses, "sweep" | "matches" | "close">,
  input: AcceptInvitationInput,
): Promise<{ invitationId: string; communityId: string }> {
  const parsed = parseInvitationToken(input.token);
  if (parsed === "invalid") {
    throw new AccessError("invitation_invalid");
  }

  const settings = await tx<{ org_id: string; community_id: string }[]>`
    select
      current_setting('app.org_id') as org_id,
      current_setting('app.community_id') as community_id
  `;
  if (parsed.orgId !== settings[0]?.org_id || parsed.communityId !== settings[0]?.community_id) {
    throw new AccessError("invitation_invalid");
  }

  const userId = parseUuid(input.userId);
  const now = input.now ?? new Date();

  const rows = await tx<
    {
      id: string;
      org_id: string;
      community_id: string;
      invited_by: string;
      token_hash: Buffer | Uint8Array;
      role_key: string | null;
      custom_role_id: string | null;
      person_id: string | null;
      status: string;
      expires_at: Date;
    }[]
  >`
    select
      id::text as id,
      org_id::text as org_id,
      community_id::text as community_id,
      invited_by::text as invited_by,
      token_hash,
      role_key,
      custom_role_id::text as custom_role_id,
      person_id::text as person_id,
      status,
      expires_at
    from app.invitations
    where id = ${parsed.invitationId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    for update
  `;
  const row = rows[0];
  if (!row) {
    throw new AccessError("invitation_invalid");
  }

  const computedHash = createHash("sha256").update(parsed.secret).digest();
  const storedHash = Buffer.from(row.token_hash);
  if (storedHash.length !== computedHash.length) {
    throw new AccessError("invitation_invalid");
  }
  if (!timingSafeEqual(storedHash, computedHash)) {
    throw new AccessError("invitation_invalid");
  }

  if (row.status !== "pending" || row.expires_at <= now) {
    throw new AccessError("invitation_invalid");
  }

  await addresses.sweep(now);

  const matched = await addresses.matches({
    invitationId: row.id,
    userId,
  });
  if (!matched) {
    throw new AccessError("wrong_address");
  }

  const inviter = await loadActor(tx, row.invited_by);
  if (!allows(inviter, "access.users.manage")) {
    await voidInvitation(tx, addresses, row.id, userId, now);
  }

  if (row.role_key !== null) {
    if (!allows(inviter, "access.roles.manage")) {
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
    const roleExists = ORGANISATION_ROLES.has(row.role_key) || COMMUNITY_ROLES.has(row.role_key);
    if (!roleExists) {
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
    if (!roleGrantAllowed(inviter, { kind: "builtin", roleKey: row.role_key })) {
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
  } else if (row.custom_role_id !== null) {
    if (!allows(inviter, "access.roles.manage")) {
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
    const customRoles = await tx<{ id: string }[]>`
      select id::text as id
      from app.custom_roles
      where id = ${row.custom_role_id}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
    `;
    if (customRoles[0] === undefined) {
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
    const permRows = await tx<{ permission: string }[]>`
      select permission
      from app.custom_role_permissions
      where custom_role_id = ${row.custom_role_id}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
    `;
    const currentPerms = permRows.map((p) => p.permission);
    if (!roleGrantAllowed(inviter, { kind: "custom", permissions: currentPerms })) {
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
  }

  if (row.person_id !== null) {
    if (!allows(inviter, "people.view")) {
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
    const minor = await personIsMinor(tx, row.person_id);
    if (minor === null || minor === true) {
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
    const contactLinks = await tx<{ user_id: string }[]>`
      select user_id::text as user_id
      from app.user_links
      where person_id = ${row.person_id}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
    `;
    if (contactLinks.length > 0 && contactLinks[0]!.user_id !== userId) {
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
  }

  const existingUserLinks = await tx<{ person_id: string }[]>`
    select person_id::text as person_id
    from app.user_links
    where user_id = ${userId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  if (existingUserLinks.length > 0) {
    const existingPersonId = existingUserLinks[0]!.person_id;
    if (row.person_id !== null && existingPersonId !== row.person_id) {
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
    const existingMinor = await personIsMinor(tx, existingPersonId);
    if (existingMinor === null || existingMinor === true) {
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
  }

  try {
    await tx.savepoint("invitation_accept", async (rawSp) => {
      const sp = rawSp as AppTransaction;
      await insertMembership(sp, {
        userId,
        source: "invitation",
        invitationId: row.id,
        now,
      });

      if (row.role_key !== null) {
        await writeRoleGrant(sp, {
          userId,
          roleKey: row.role_key,
          actorUserId: row.invited_by,
          skipDuplicate: true,
        });
      } else if (row.custom_role_id !== null) {
        await writeCustomRoleGrant(sp, {
          userId,
          customRoleId: row.custom_role_id,
          actorUserId: row.invited_by,
          skipDuplicate: true,
        });
      }

      if (row.person_id !== null) {
        await writeUserLink(sp, {
          userId,
          personId: row.person_id,
          actorUserId: row.invited_by,
          skipDuplicate: true,
        });
      }

      const updated = await sp<{ id: string }[]>`
        update app.invitations
        set status = 'accepted',
            accepted_user_id = ${userId}::uuid,
            closed_at = ${now},
            person_id = null,
            custom_role_id = null
        where id = ${row.id}::uuid
          and org_id = current_setting('app.org_id')::uuid
          and community_id = current_setting('app.community_id')::uuid
          and status = 'pending'
        returning id::text as id
      `;
      if (updated.length === 0) {
        throw new AccessError("invitation_invalid");
      }

      await addresses.close(row.id);

      await appendAuditEvent(sp, {
        actorKind: "user",
        actorId: userId,
        action: INVITATION_ACCEPTED,
        purpose: INVITATION_ACCEPTED,
        targetIds: [row.id, userId, row.community_id],
      });
    });
  } catch (error) {
    if (error instanceof AccessError) {
      if (error.code === "invitation_invalid") {
        throw error;
      }
      await voidInvitation(tx, addresses, row.id, userId, now);
    }
    throw error;
  }

  return {
    invitationId: row.id,
    communityId: row.community_id,
  };
}
