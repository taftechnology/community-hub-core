import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUSEHOLD_STATUS_CHANGED = "people.household.status_changed";

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
}

export type HouseholdStatus = "active" | "inactive";

export type SetHouseholdStatusInput = {
  householdId: string;
  version: number;
  status: HouseholdStatus;
  actorUserId: string | null;
};

export type SetHouseholdStatusResult = {
  householdId: string;
  version: number;
  status: HouseholdStatus;
};

export async function setHouseholdStatus(
  tx: AppTransaction,
  input: SetHouseholdStatusInput,
): Promise<SetHouseholdStatusResult> {
  if (typeof input.householdId !== "string" || !UUID_RE.test(input.householdId)) {
    throw new PeopleError("invalid_input");
  }
  if (typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) {
    throw new PeopleError("invalid_input");
  }
  if (input.status !== "active" && input.status !== "inactive") {
    throw new PeopleError("invalid_input");
  }
  if (
    input.actorUserId !== null &&
    (typeof input.actorUserId !== "string" || !UUID_RE.test(input.actorUserId))
  ) {
    throw new PeopleError("invalid_input");
  }

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

  // Pin 36: Compare version in code
  if (household.version !== input.version) {
    throw new PeopleError("conflict");
  }

  const updated = await tx<{ id: string; version: number; status: string }[]>`
    update app.households
    set
      status = ${input.status},
      version = version + 1
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    returning id::text as id, version, status
  `;

  const row = updated[0];
  if (row === undefined) {
    throw new PeopleError("not_found");
  }

  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: HOUSEHOLD_STATUS_CHANGED,
    purpose: HOUSEHOLD_STATUS_CHANGED,
    targetIds: [input.householdId],
  });

  return {
    householdId: row.id,
    version: row.version,
    status: row.status as HouseholdStatus,
  };
}
