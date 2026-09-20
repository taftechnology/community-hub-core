import type { Sql, TransactionSql } from "postgres";

declare const appTxBrand: unique symbol;
declare const orgTxBrand: unique symbol;
export type AppTransaction = TransactionSql & { readonly [appTxBrand]: "app" };
export type OrgTransaction = TransactionSql & { readonly [orgTxBrand]: "org" };

export async function withOrgTransaction<T>(
  sql: Sql,
  orgId: string,
  fn: (tx: OrgTransaction) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${orgId}, ${true})`;
    return fn(tx as OrgTransaction);
  }) as Promise<T>;
}
