import type { AppTransaction } from "@community-hub/db";

type ActivityView = {
  id: string;
  kind: string;
  actorUserId: string | null;
  occurredAt: Date;
};

async function personExists(tx: AppTransaction, personId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    select id::text as id from app.persons where id = ${personId}::uuid
  `;
  return rows[0] !== undefined;
}

function timeThenId(left: ActivityView, right: ActivityView): number {
  const difference = left.occurredAt.getTime() - right.occurredAt.getTime();
  if (difference !== 0) {
    return difference;
  }
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

export async function listPersonActivity(
  tx: AppTransaction,
  personId: string,
): Promise<ActivityView[] | null> {
  if (!(await personExists(tx, personId))) {
    return null;
  }
  const rows = await tx<
    { id: string; kind: string; actor_user_id: string | null; occurred_at: Date }[]
  >`
    select id::text as id, kind, actor_user_id::text as actor_user_id, occurred_at
    from app.person_activity
    where person_id = ${personId}::uuid
  `;
  return rows
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      actorUserId: row.actor_user_id,
      occurredAt: row.occurred_at,
    }))
    .sort(timeThenId);
}
