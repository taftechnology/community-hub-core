import type { TransactionSql } from "postgres";

export async function lockSecondFactor(tx: TransactionSql, userId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('2fa:' || ${userId}::text, 0))`;
}
