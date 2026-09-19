import type { Sql, TransactionSql } from "postgres";

export async function withAppTransaction<T>(
  sql: Sql,
  scope: { orgId: string; communityId: string },
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${scope.orgId}, ${true})`;
    await tx`select set_config('app.community_id', ${scope.communityId}, ${true})`;
    return fn(tx);
  }) as Promise<T>;
}
