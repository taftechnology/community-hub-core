import type { AppTransaction } from "@community-hub/db";

import { insertMembership } from "./membership.js";

export async function addMember(tx: AppTransaction, userId: string): Promise<void> {
  await insertMembership(tx, {
    userId,
    source: "provision",
  });
}
