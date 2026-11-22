import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

const PERSON_PURGED = "people.person.purged";

export async function purgeDeletedPersons(tx: AppTransaction, limit: number): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    select app.purge_deleted_persons(${limit}) as id
  `;
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await appendAuditEvent(tx, {
      actorKind: "system",
      actorId: null,
      action: PERSON_PURGED,
      purpose: PERSON_PURGED,
      targetIds: ids,
    });
  }
  return ids;
}
