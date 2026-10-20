import type { Sql } from "postgres";

import { deriveState, type BillingState } from "../domain/state.js";
import { BillingReadOnly, isWritable } from "../domain/writable.js";
import { readAccount } from "./accounts.js";

export async function assertWritable(
  sql: Sql,
  organisationId: string,
  now: Date,
): Promise<BillingState> {
  const account = await readAccount(sql, organisationId);
  const state = deriveState(account, now);
  if (!isWritable(state)) {
    throw new BillingReadOnly(state);
  }
  return state;
}
