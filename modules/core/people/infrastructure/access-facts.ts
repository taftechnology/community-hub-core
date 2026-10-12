import type { AppTransaction } from "@community-hub/db";

export async function personIsMinor(tx: AppTransaction, personId: string): Promise<boolean | null> {
  const rows = await tx<{ is_minor: boolean }[]>`
    select is_minor
    from app.persons
    where id = ${personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const row = rows[0];
  return row === undefined ? null : row.is_minor;
}

export async function hasGuardianView(
  tx: AppTransaction,
  guardianPersonId: string,
  childPersonId: string,
): Promise<boolean> {
  const rows = await tx<{ view: boolean }[]>`
    select view
    from app.guardian_links
    where guardian_person_id = ${guardianPersonId}::uuid
      and child_person_id = ${childPersonId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  return rows[0]?.view === true;
}
