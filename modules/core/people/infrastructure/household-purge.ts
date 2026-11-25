import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

const HOUSEHOLD_PURGED = "people.household.purged";

export async function purgeDeletedHouseholds(tx: AppTransaction, limit: number): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    select app.purge_deleted_households(${limit}) as id
  `;
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await appendAuditEvent(tx, {
      actorKind: "system",
      actorId: null,
      action: HOUSEHOLD_PURGED,
      purpose: HOUSEHOLD_PURGED,
      targetIds: ids,
    });
  }
  return ids;
}
