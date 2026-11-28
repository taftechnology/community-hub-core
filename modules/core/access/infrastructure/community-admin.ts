import type { TransactionSql } from "postgres";

import { parseUuid } from "../domain/role.js";

/**
 * Checks whether `userId` holds a `community_admin` grant in the transaction's RLS scope.
 */
export async function isCommunityAdmin(tx: TransactionSql, userId: string): Promise<boolean> {
  const parsedUserId = parseUuid(userId);
  const rows = await tx<{ exists: boolean }[]>`
    select exists (
      select 1
      from app.community_role_grants
      where user_id = ${parsedUserId}::uuid
        and role_key = 'community_admin'
    ) as exists
  `;
  return rows[0]?.exists ?? false;
}
