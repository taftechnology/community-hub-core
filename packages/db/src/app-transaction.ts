import type { Sql } from "postgres";

import type { AppTransaction } from "./tx.js";

export async function withAppTransaction<T>(
  sql: Sql,
  scope: { orgId: string; communityId: string },
  fn: (tx: AppTransaction) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${scope.orgId}, ${true})`;
    await tx`select set_config('app.community_id', ${scope.communityId}, ${true})`;
    return fn(tx as AppTransaction);
  }) as Promise<T>;
}
