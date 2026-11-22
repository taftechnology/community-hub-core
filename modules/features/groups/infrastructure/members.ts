import type { KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";
import { personIsMinor, readRosterNames, visiblePersonIds } from "@community-hub/people";

import { GroupsError } from "../domain/error.js";

export type GroupMemberRole = "leader" | "member";

export interface GroupMemberRecord {
  personId: string;
  role: GroupMemberRole;
  isMinor: boolean;
  addedAt: Date;
}

export interface AddMemberInput {
  groupId: string;
  personId: string;
  role?: GroupMemberRole;
  now: Date;
  actorUserId: string;
}

export interface RemoveMemberInput {
  groupId: string;
  personId: string;
  now?: Date;
  actorUserId: string;
}

export interface SetMemberRoleInput {
  groupId: string;
  personId: string;
  role: GroupMemberRole;
  now?: Date;
  actorUserId: string;
}

export interface ListMembersInput {
  groupId: string;
  actorUserId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function classifyMemberUniqueViolation(error: unknown): "already_member" | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "23505") {
      const constraint =
        ("constraint_name" in current && typeof current.constraint_name === "string"
          ? current.constraint_name
          : undefined) ??
        ("constraint" in current && typeof current.constraint === "string"
          ? current.constraint
          : undefined);
      if (
        constraint === "group_members_org_id_group_id_person_id_pk" ||
        constraint === "group_members_pkey"
      ) {
        return "already_member";
      }
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export async function addMember(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: AddMemberInput,
): Promise<GroupMemberRecord> {
  if (
    typeof input.groupId !== "string" ||
    !UUID_RE.test(input.groupId) ||
    typeof input.personId !== "string" ||
    !UUID_RE.test(input.personId) ||
    typeof input.actorUserId !== "string" ||
    !UUID_RE.test(input.actorUserId)
  ) {
    throw new GroupsError("invalid_input");
  }

  const role: GroupMemberRole = input.role ?? "member";
  if (role !== "leader" && role !== "member") {
    throw new GroupsError("invalid_input");
  }

  const groupRows = await tx<{ id: string; status: string }[]>`
    select id::text as id, status
    from app.groups
    where id = ${input.groupId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const group = groupRows[0];
  if (group === undefined) {
    throw new GroupsError("group_not_found");
  }
  if (group.status === "archived") {
    throw new GroupsError("group_archived");
  }

  // One locked read answers existence, hidden and minor: a contact being deleted waits here.
  const isMinor = await personIsMinor(tx, input.personId, { lock: "share" });
  if (isMinor === null) {
    throw new GroupsError("person_not_found");
  }

  try {
    await tx.savepoint(async (sp) => {
      await sp`
        insert into app.group_members (
          org_id,
          community_id,
          group_id,
          person_id,
          role,
          added_at
        ) values (
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${input.groupId}::uuid,
          ${input.personId}::uuid,
          ${role},
          ${input.now}
        )
      `;
    });
  } catch (error) {
    const violation = classifyMemberUniqueViolation(error);
    if (violation === "already_member") {
      throw new GroupsError("already_member");
    }
    throw error;
  }

  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: input.actorUserId,
    action: "groups.member.added",
    purpose: "groups.member.added",
    targetIds: [input.groupId, input.personId],
  });

  return {
    personId: input.personId,
    role,
    isMinor,
    addedAt: input.now,
  };
}

export async function removeMember(tx: AppTransaction, input: RemoveMemberInput): Promise<boolean> {
  if (
    typeof input.groupId !== "string" ||
    !UUID_RE.test(input.groupId) ||
    typeof input.personId !== "string" ||
    !UUID_RE.test(input.personId) ||
    typeof input.actorUserId !== "string" ||
    !UUID_RE.test(input.actorUserId)
  ) {
    throw new GroupsError("invalid_input");
  }

  const groupRows = await tx<{ id: string; status: string }[]>`
    select id::text as id, status
    from app.groups
    where id = ${input.groupId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const group = groupRows[0];
  if (group === undefined) {
    throw new GroupsError("group_not_found");
  }
  if (group.status === "archived") {
    throw new GroupsError("group_archived");
  }

  // A hidden contact is not found. A person who is no member keeps the old answer, false.
  if ((await visiblePersonIds(tx, [input.personId])).length === 0) {
    const held = await tx<{ person_id: string }[]>`
      select person_id::text as person_id
      from app.group_members
      where group_id = ${input.groupId}::uuid
        and person_id = ${input.personId}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
    `;
    if (held.length > 0) {
      throw new GroupsError("person_not_found");
    }
    return false;
  }

  const deletedRows = await tx<{ person_id: string }[]>`
    delete from app.group_members
    where group_id = ${input.groupId}::uuid
      and person_id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    returning person_id::text as person_id
  `;

  if (deletedRows.length === 0) {
    return false;
  }

  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: input.actorUserId,
    action: "groups.member.removed",
    purpose: "groups.member.removed",
    targetIds: [input.groupId, input.personId],
  });

  return true;
}

export async function setMemberRole(tx: AppTransaction, input: SetMemberRoleInput): Promise<void> {
  if (
    typeof input.groupId !== "string" ||
    !UUID_RE.test(input.groupId) ||
    typeof input.personId !== "string" ||
    !UUID_RE.test(input.personId) ||
    typeof input.actorUserId !== "string" ||
    !UUID_RE.test(input.actorUserId)
  ) {
    throw new GroupsError("invalid_input");
  }

  if (input.role !== "leader" && input.role !== "member") {
    throw new GroupsError("invalid_input");
  }

  const groupRows = await tx<{ id: string; status: string }[]>`
    select id::text as id, status
    from app.groups
    where id = ${input.groupId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const group = groupRows[0];
  if (group === undefined) {
    throw new GroupsError("group_not_found");
  }
  if (group.status === "archived") {
    throw new GroupsError("group_archived");
  }

  if ((await visiblePersonIds(tx, [input.personId])).length === 0) {
    throw new GroupsError("person_not_found");
  }

  const memberRows = await tx<{ role: string }[]>`
    select role
    from app.group_members
    where group_id = ${input.groupId}::uuid
      and person_id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const existing = memberRows[0];
  if (existing === undefined) {
    throw new GroupsError("person_not_found");
  }

  if (existing.role === input.role) {
    return;
  }

  await tx`
    update app.group_members
    set "role" = ${input.role}
    where group_id = ${input.groupId}::uuid
      and person_id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;

  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: input.actorUserId,
    action: "groups.member.role_changed",
    purpose: "groups.member.role_changed",
    targetIds: [input.groupId, input.personId],
  });
}

export async function listMembers(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ListMembersInput,
): Promise<GroupMemberRecord[]> {
  if (
    typeof input.groupId !== "string" ||
    !UUID_RE.test(input.groupId) ||
    typeof input.actorUserId !== "string" ||
    !UUID_RE.test(input.actorUserId)
  ) {
    throw new GroupsError("invalid_input");
  }

  const groupRows = await tx<{ id: string }[]>`
    select id::text as id
    from app.groups
    where id = ${input.groupId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  if (groupRows[0] === undefined) {
    throw new GroupsError("group_not_found");
  }

  const rows = await tx<{ person_id: string; role: string; added_at: Date | string }[]>`
    select person_id::text as person_id, role, added_at
    from app.group_members
    where group_id = ${input.groupId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    order by added_at asc, person_id asc
  `;

  if (rows.length === 0) {
    return [];
  }

  const personIds = rows.map((r) => r.person_id);
  const roster = await readRosterNames(tx, kms, keyArn, {
    personIds,
    includeRestricted: false,
    actorUserId: input.actorUserId,
  });

  const minorMap = new Map<string, boolean>();
  for (const person of roster) {
    minorMap.set(person.personId, person.isMinor);
  }

  // A member absent from the roster is hidden (or gone) and is not listed.
  return rows.flatMap((row) => {
    const isMinor = minorMap.get(row.person_id);
    if (isMinor === undefined) {
      return [];
    }
    return [
      {
        personId: row.person_id,
        role: row.role as GroupMemberRole,
        isMinor,
        addedAt: new Date(row.added_at),
      },
    ];
  });
}

export async function groupLeaderFact(
  tx: AppTransaction,
  groupId: string,
  personId: string,
): Promise<boolean> {
  if (
    typeof groupId !== "string" ||
    !UUID_RE.test(groupId) ||
    typeof personId !== "string" ||
    !UUID_RE.test(personId)
  ) {
    return false;
  }

  const rows = await tx<{ exists: boolean }[]>`
    select true as exists
    from app.group_members
    where group_id = ${groupId}::uuid
      and person_id = ${personId}::uuid
      and role = 'leader'
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    limit 1
  `;
  return rows.length > 0;
}

export async function personIdsInGroup(tx: AppTransaction, groupId: string): Promise<string[]> {
  if (typeof groupId !== "string" || !UUID_RE.test(groupId)) {
    return [];
  }

  const rows = await tx<{ person_id: string }[]>`
    select gm.person_id::text as person_id
    from app.group_members gm
    inner join app.groups g
      on g.id = gm.group_id
      and g.org_id = gm.org_id
      and g.community_id = gm.community_id
    where gm.group_id = ${groupId}::uuid
      and gm.org_id = current_setting('app.org_id')::uuid
      and gm.community_id = current_setting('app.community_id')::uuid
      and g.status = 'active'
    order by gm.added_at asc, gm.person_id asc
  `;

  const visible = new Set(
    await visiblePersonIds(
      tx,
      rows.map((r) => r.person_id),
    ),
  );
  return rows.map((r) => r.person_id).filter((id) => visible.has(id));
}

export async function activeGroupsForPersons(
  tx: AppTransaction,
  personIds: string[],
): Promise<Map<string, { id: string; name: string }[]>> {
  if (!Array.isArray(personIds) || personIds.length === 0) {
    return new Map();
  }

  const validIds = personIds.filter((id) => typeof id === "string" && UUID_RE.test(id));
  if (validIds.length === 0) {
    return new Map();
  }

  const ids = await visiblePersonIds(tx, [...new Set(validIds)]);
  if (ids.length === 0) {
    return new Map();
  }
  const result = new Map<string, { id: string; name: string }[]>();
  for (const id of ids) {
    result.set(id, []);
  }

  const rows = await tx<{ person_id: string; id: string; name: string }[]>`
    select
      gm.person_id::text as person_id,
      g.id::text as id,
      g.name
    from app.group_members gm
    inner join app.groups g
      on g.id = gm.group_id
      and g.org_id = gm.org_id
      and g.community_id = gm.community_id
    where gm.person_id = any(${ids}::uuid[])
      and gm.org_id = current_setting('app.org_id')::uuid
      and gm.community_id = current_setting('app.community_id')::uuid
      and g.status = 'active'
    order by g.name_key asc, g.id asc
  `;

  for (const row of rows) {
    result.get(row.person_id)?.push({ id: row.id, name: row.name });
  }

  return result;
}
