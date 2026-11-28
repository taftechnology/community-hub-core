import type { AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChildLabel = {
  personId: string;
  householdId: string;
  label: string;
};

// The display label of each child in the given households: "Child n", numbered inside the child's
// own household over the children who are not hidden, in order of created_at and then id.
//
// It reads clear columns only (is_minor, household_id, deleted_at, created_at, id), so no key is
// opened and nothing is decrypted (AGENTS.md §1 rule 3). The label is a display label: it can
// change when a sibling is hidden, restored or added, and nothing may use it as an identifier.
// Every reader that shows a child to a Community Admin calls this, so a child has the same label
// on every screen at one moment.
export async function childLabels(
  tx: AppTransaction,
  householdIds: readonly string[],
): Promise<ChildLabel[]> {
  if (householdIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
    throw new PeopleError("invalid_input");
  }
  const ids = [...new Set(householdIds)];
  if (ids.length === 0) {
    return [];
  }
  const rows = await tx<{ person_id: string; household_id: string; position: number }[]>`
    select
      id::text as person_id,
      household_id::text as household_id,
      (row_number() over (partition by household_id order by created_at asc, id asc))::int as position
    from app.persons
    where household_id = any(${ids}::uuid[])
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = true
      and deleted_at is null
    order by household_id asc, position asc
  `;
  return rows.map((row) => ({
    personId: row.person_id,
    householdId: row.household_id,
    label: `Child ${row.position}`,
  }));
}
