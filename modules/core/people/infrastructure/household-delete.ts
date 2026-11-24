import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUSEHOLD_DELETED = "people.household.deleted";
const HOUSEHOLD_RESTORED = "people.household.restored";

export type HideHouseholdInput = {
  householdId: string;
  version: number;
  actorUserId: string;
};

export type HideHouseholdResult = {
  householdId: string;
  version: number;
  purgeAfter: Date;
};

export type RestoreHouseholdInput = {
  householdId: string;
  version: number;
  actorUserId: string;
};

export type RestoreHouseholdResult = {
  householdId: string;
  version: number;
};

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
}

export async function hideHousehold(
  tx: AppTransaction,
  input: HideHouseholdInput,
): Promise<HideHouseholdResult> {
  if (
    typeof input.householdId !== "string" ||
    !UUID_RE.test(input.householdId) ||
    typeof input.version !== "number" ||
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    typeof input.actorUserId !== "string" ||
    !UUID_RE.test(input.actorUserId)
  ) {
    throw new PeopleError("invalid_input");
  }

  // Pin 31: Lock the household FOR UPDATE with org and community predicates and deleted_at is null
  const rows = await tx<{ id: string; version: number }[]>`
    select id::text as id, version
    from app.households
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and deleted_at is null
    for update
  `;

  const household = rows[0];
  if (household === undefined) {
    throw new PeopleError("not_found");
  }

  // Pin 34, 34b: Compare version in code before checking for children
  if (household.version !== input.version) {
    throw new PeopleError("conflict");
  }

  // Pin 33: Check if any minor child is in the household
  const minors = await tx<{ id: string }[]>`
    select id::text as id
    from app.persons
    where household_id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = true
    limit 1
  `;

  if (minors.length > 0) {
    throw new PeopleError("household_has_children");
  }

  const updated = await tx<{ id: string; version: number; purge_after: Date }[]>`
    update app.households
    set
      deleted_at = now(),
      deleted_by = ${input.actorUserId}::uuid,
      version = version + 1
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    returning
      id::text as id,
      version,
      (deleted_at + interval '720 hours') as purge_after
  `;

  const row = updated[0];
  if (row === undefined) {
    throw new PeopleError("not_found");
  }

  // Pin 35: Deleted audit event, household id only
  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: HOUSEHOLD_DELETED,
    purpose: HOUSEHOLD_DELETED,
    targetIds: [input.householdId],
  });

  return {
    householdId: row.id,
    version: row.version,
    purgeAfter: row.purge_after,
  };
}

export async function restoreHousehold(
  tx: AppTransaction,
  input: RestoreHouseholdInput,
): Promise<RestoreHouseholdResult> {
  if (
    typeof input.householdId !== "string" ||
    !UUID_RE.test(input.householdId) ||
    typeof input.version !== "number" ||
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    typeof input.actorUserId !== "string" ||
    !UUID_RE.test(input.actorUserId)
  ) {
    throw new PeopleError("invalid_input");
  }

  // Pin 32: Lock FOR UPDATE; must have deleted_at set and deleted_at > now() - interval '720 hours'
  const rows = await tx<{ id: string; version: number }[]>`
    select id::text as id, version
    from app.households
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and deleted_at is not null
      and deleted_at > now() - interval '720 hours'
    for update
  `;

  const household = rows[0];
  if (household === undefined) {
    throw new PeopleError("not_found");
  }

  // Pin 34: Version checked in code
  if (household.version !== input.version) {
    throw new PeopleError("conflict");
  }

  const updated = await tx<{ id: string; version: number }[]>`
    update app.households
    set
      deleted_at = null,
      deleted_by = null,
      version = version + 1
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    returning id::text as id, version
  `;

  const row = updated[0];
  if (row === undefined) {
    throw new PeopleError("not_found");
  }

  // Pin 35: Restored audit event, household id only
  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: HOUSEHOLD_RESTORED,
    purpose: HOUSEHOLD_RESTORED,
    targetIds: [input.householdId],
  });

  return {
    householdId: row.id,
    version: row.version,
  };
}
