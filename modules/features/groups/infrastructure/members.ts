import type { KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";
import {
  personIsMinor,
  readRosterNames,
  visiblePersonIds,
  type ChildView,
} from "@community-hub/people";

import { GroupsError } from "../domain/error.js";
import { isChildView } from "./child-view.js";

export type GroupMemberRole = "leader" | "member";

export interface GroupMemberRecord {
  personId: string;
  role: GroupMemberRole;
  isMinor: boolean;
  addedAt: Date;
  // A child's display label ("Child n"), set only on a child listed under childView "admin". A
  // label, never a name: no function here decrypts a child's field.
  label?: string;
}

// childView is required on every input below, with no default. A child's membership is a Community
// Admin's to read or change: under "presence" a child is not found, listed or counted by id.
export interface AddMemberInput {
  groupId: string;
  personId: string;
  role?: GroupMemberRole;
  now: Date;
  actorUserId: string;
  childView: ChildView;
}

export interface RemoveMemberInput {
  groupId: string;
  personId: string;
  now?: Date;
  actorUserId: string;
  childView: ChildView;
}

export interface SetMemberRoleInput {
  groupId: string;
  personId: string;
  role: GroupMemberRole;
  now?: Date;
  actorUserId: string;
  childView: ChildView;
}

export interface ListMembersInput {
  groupId: string;
  actorUserId: string;
  childView: ChildView;
}

export interface ListMembersResult {
  // Under "presence" only adults. Under "admin" a child is a row with a label.
  members: GroupMemberRecord[];
  // The children who are members and not hidden, under both views.
  minorCount: number;
}

// The view for the reads that take ids rather than an input object.
export interface MemberViewOptions {
  childView: ChildView;
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
    !UUID_RE.test(input.actorUserId) ||
    !isChildView(input.childView)
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
  // A child is a Community Admin's to add. Anyone else gets the answer for a person who does not
  // exist, so the refusal says nothing about who is a child.
  if (isMinor && input.childView !== "admin") {
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
    !UUID_RE.test(input.actorUserId) ||
    !isChildView(input.childView)
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

  // A hidden contact is not found, and so is a child for anyone but a Community Admin. A person
  // who is no member keeps the old answer, false.
  const visible = await visiblePersonIds(tx, [input.personId], {
    childView: input.childView,
    lock: "share",
  });
  if (visible.length === 0) {
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
    !UUID_RE.test(input.actorUserId) ||
    !isChildView(input.childView)
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

  const visible = await visiblePersonIds(tx, [input.personId], {
    childView: input.childView,
    lock: "share",
  });
  if (visible.length === 0) {
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
): Promise<ListMembersResult> {
  if (
    typeof input.groupId !== "string" ||
    !UUID_RE.test(input.groupId) ||
    typeof input.actorUserId !== "string" ||
    !UUID_RE.test(input.actorUserId) ||
    !isChildView(input.childView)
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
    return { members: [], minorCount: 0 };
  }

  const personIds = rows.map((r) => r.person_id);
  const roster = await readRosterNames(tx, kms, keyArn, {
    personIds,
    childView: input.childView,
    actorUserId: input.actorUserId,
  });

  const adults = new Set(roster.adults.map((person) => person.personId));
  const labelOf = new Map(roster.children.map((child) => [child.personId, child.label]));

  // A member absent from the roster is hidden (or gone) and is not listed. A child is listed, with
  // a label, only under "admin"; under "presence" the roster has no child row, and the child is
  // only in minorCount.
  const members = rows.flatMap((row): GroupMemberRecord[] => {
    const role = row.role as GroupMemberRole;
    const addedAt = new Date(row.added_at);
    if (adults.has(row.person_id)) {
      return [{ personId: row.person_id, role, isMinor: false, addedAt }];
    }
    const label = labelOf.get(row.person_id);
    if (label !== undefined) {
      return [{ personId: row.person_id, role, isMinor: true, addedAt, label }];
    }
    return [];
  });
  return { members, minorCount: roster.minorCount };
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

export async function personIdsInGroup(
  tx: AppTransaction,
  groupId: string,
  options: MemberViewOptions,
): Promise<string[]> {
  if (!isChildView(options?.childView)) {
    throw new GroupsError("invalid_input");
  }
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

  // Under "presence" a child's id is left out, as a hidden contact's is.
  const visible = new Set(
    await visiblePersonIds(
      tx,
      rows.map((r) => r.person_id),
      { childView: options.childView },
    ),
  );
  return rows.map((r) => r.person_id).filter((id) => visible.has(id));
}

export async function activeGroupsForPersons(
  tx: AppTransaction,
  personIds: string[],
  options: MemberViewOptions,
): Promise<Map<string, { id: string; name: string }[]>> {
  if (!isChildView(options?.childView)) {
    throw new GroupsError("invalid_input");
  }
  if (!Array.isArray(personIds) || personIds.length === 0) {
    return new Map();
  }

  const validIds = personIds.filter((id) => typeof id === "string" && UUID_RE.test(id));
  if (validIds.length === 0) {
    return new Map();
  }

  // Under "presence" a child is not given a key or a group, as a hidden contact is not.
  const ids = await visiblePersonIds(tx, [...new Set(validIds)], { childView: options.childView });
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
