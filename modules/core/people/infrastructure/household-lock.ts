import { type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";

export async function lockVisibleHousehold(
  tx: AppTransaction,
  householdId: string,
): Promise<{ id: string }> {
  const rows = await tx<{ id: string }[]>`
    select id::text as id
    from app.households
    where id = ${householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and deleted_at is null
    for share
  `;
  const household = rows[0];
  if (household === undefined) {
    throw new PeopleError("not_found");
  }
  return household;
}
