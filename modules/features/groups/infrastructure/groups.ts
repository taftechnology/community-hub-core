import { appendAuditEvent, newId, type AppTransaction } from "@community-hub/db";
import { recordSuccess } from "@community-hub/usage";

import { GroupsError } from "../domain/error.js";
import { parseGroupName } from "../domain/name.js";

export type GroupKind = "ministry" | "group";
export type GroupStatus = "active" | "archived";

export interface GroupRecord {
  id: string;
  name: string;
  nameKey: string;
  description: string | null;
  kind: GroupKind;
  status: GroupStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGroupInput {
  groupId?: string;
  name: string;
  description?: string | null;
  kind: GroupKind;
  now: Date;
  actorUserId: string | null;
}

export interface UpdateGroupInput {
  name?: string;
  description?: string | null;
  kind?: GroupKind;
  now: Date;
  actorUserId: string | null;
}

export interface ArchiveGroupInput {
  now: Date;
  actorUserId: string | null;
}

export interface RestoreGroupInput {
  now: Date;
  actorUserId: string | null;
}

export interface ListGroupsOptions {
  includeArchived?: boolean;
}

interface StoredGroup {
  id: string;
  name: string;
  name_key: string;
  description: string | null;
  kind: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function classifyUniqueViolation(error: unknown): "duplicate_name" | "invalid_input" | undefined {
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
      if (constraint === "groups_active_name_key_unique") {
        return "duplicate_name";
      }
      return "invalid_input";
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function mapGroup(row: StoredGroup): GroupRecord {
  return {
    id: row.id,
    name: row.name,
    nameKey: row.name_key,
    description: row.description,
    kind: row.kind as GroupKind,
    status: row.status as GroupStatus,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

export async function createGroup(
  tx: AppTransaction,
  input: CreateGroupInput,
): Promise<GroupRecord> {
  const { name: cleanName, nameKey } = parseGroupName(input.name);

  if (
    input.description !== undefined &&
    input.description !== null &&
    input.description.length > 2000
  ) {
    throw new GroupsError("invalid_input");
  }
  if (input.kind !== "ministry" && input.kind !== "group") {
    throw new GroupsError("invalid_input");
  }
  if (input.groupId !== undefined && !UUID_RE.test(input.groupId)) {
    throw new GroupsError("invalid_input");
  }

  const groupId = input.groupId ?? newId();
  const description = input.description ?? null;

  let inserted: StoredGroup;
  try {
    await tx.savepoint(async (sp) => {
      const rows = await sp<StoredGroup[]>`
        insert into app.groups (
          id, org_id, community_id, name, name_key, description, kind, status, created_at, updated_at
        ) values (
          ${groupId}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${cleanName},
          ${nameKey},
          ${description},
          ${input.kind},
          'active',
          ${input.now},
          ${input.now}
        )
        returning id, name, name_key, description, kind, status, created_at, updated_at
      `;
      inserted = rows[0]!;
    });
  } catch (error) {
    const violation = classifyUniqueViolation(error);
    if (violation) {
      throw new GroupsError(violation);
    }
    throw error;
  }

  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: "groups.group.created",
    purpose: "groups.group.created",
    targetIds: [groupId],
  });

  await recordSuccess(tx, "groups.basic", input.now);
  return mapGroup(inserted!);
}

export async function readGroup(tx: AppTransaction, groupId: string): Promise<GroupRecord> {
  if (!UUID_RE.test(groupId)) {
    throw new GroupsError("group_not_found");
  }
  const rows = await tx<StoredGroup[]>`
    select id, name, name_key, description, kind, status, created_at, updated_at
    from app.groups
    where id = ${groupId}::uuid
  `;
  if (rows.length === 0) {
    throw new GroupsError("group_not_found");
  }
  return mapGroup(rows[0]!);
}

export async function updateGroup(
  tx: AppTransaction,
  groupId: string,
  input: UpdateGroupInput,
): Promise<GroupRecord> {
  const existing = await readGroup(tx, groupId);
  if (existing.status === "archived") {
    throw new GroupsError("group_archived");
  }

  let cleanName = existing.name;
  let nameKey = existing.nameKey;
  if (input.name !== undefined) {
    const parsed = parseGroupName(input.name);
    cleanName = parsed.name;
    nameKey = parsed.nameKey;
  }

  let description = existing.description;
  if (input.description !== undefined) {
    if (input.description !== null && input.description.length > 2000) {
      throw new GroupsError("invalid_input");
    }
    description = input.description;
  }

  let kind = existing.kind;
  if (input.kind !== undefined) {
    if (input.kind !== "ministry" && input.kind !== "group") {
      throw new GroupsError("invalid_input");
    }
    kind = input.kind;
  }

  let updated: StoredGroup;
  try {
    await tx.savepoint(async (sp) => {
      const rows = await sp<StoredGroup[]>`
        update app.groups
        set name = ${cleanName},
            name_key = ${nameKey},
            description = ${description},
            kind = ${kind},
            updated_at = ${input.now}
        where id = ${groupId}::uuid and status = 'active'
        returning id, name, name_key, description, kind, status, created_at, updated_at
      `;
      if (rows.length === 0) {
        throw new GroupsError("group_archived");
      }
      updated = rows[0]!;
    });
  } catch (error) {
    if (error instanceof GroupsError) {
      throw error;
    }
    const violation = classifyUniqueViolation(error);
    if (violation) {
      throw new GroupsError(violation);
    }
    throw error;
  }

  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: "groups.group.updated",
    purpose: "groups.group.updated",
    targetIds: [groupId],
  });

  return mapGroup(updated!);
}

export async function archiveGroup(
  tx: AppTransaction,
  groupId: string,
  input: ArchiveGroupInput,
): Promise<GroupRecord> {
  const existing = await readGroup(tx, groupId);
  if (existing.status === "archived") {
    return existing;
  }

  const rows = await tx<StoredGroup[]>`
    update app.groups
    set status = 'archived',
        updated_at = ${input.now}
    where id = ${groupId}::uuid
    returning id, name, name_key, description, kind, status, created_at, updated_at
  `;
  if (rows.length === 0) {
    throw new GroupsError("group_not_found");
  }

  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: "groups.group.archived",
    purpose: "groups.group.archived",
    targetIds: [groupId],
  });

  return mapGroup(rows[0]!);
}

export async function restoreGroup(
  tx: AppTransaction,
  groupId: string,
  input: RestoreGroupInput,
): Promise<GroupRecord> {
  const existing = await readGroup(tx, groupId);
  if (existing.status === "active") {
    return existing;
  }

  let restored: StoredGroup;
  try {
    await tx.savepoint(async (sp) => {
      const rows = await sp<StoredGroup[]>`
        update app.groups
        set status = 'active',
            updated_at = ${input.now}
        where id = ${groupId}::uuid
        returning id, name, name_key, description, kind, status, created_at, updated_at
      `;
      restored = rows[0]!;
    });
  } catch (error) {
    if (error instanceof GroupsError) {
      throw error;
    }
    const violation = classifyUniqueViolation(error);
    if (violation) {
      throw new GroupsError(violation);
    }
    throw error;
  }

  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: "groups.group.updated",
    purpose: "groups.group.updated",
    targetIds: [groupId],
  });

  return mapGroup(restored!);
}

export async function listGroups(
  tx: AppTransaction,
  options?: ListGroupsOptions,
): Promise<GroupRecord[]> {
  if (options?.includeArchived) {
    const rows = await tx<StoredGroup[]>`
      select id, name, name_key, description, kind, status, created_at, updated_at
      from app.groups
      order by name_key asc, id asc
    `;
    return rows.map(mapGroup);
  }

  const rows = await tx<StoredGroup[]>`
    select id, name, name_key, description, kind, status, created_at, updated_at
    from app.groups
    where status = 'active'
    order by name_key asc, id asc
  `;
  return rows.map(mapGroup);
}
