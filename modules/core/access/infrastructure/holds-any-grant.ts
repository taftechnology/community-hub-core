import type { AppTransaction } from "@community-hub/db";

export async function holdsAnyGrant(tx: AppTransaction, userId: string): Promise<boolean> {
  const organisationRows = await tx<{ role_key: string }[]>`
    select role_key
    from app.organisation_role_grants
    where user_id = ${userId}::uuid
      and org_id = current_setting('app.org_id')::uuid
  `;
  if (organisationRows.length > 0) {
    return true;
  }
  const communityRows = await tx<{ role_key: string | null; custom_role_id: string | null }[]>`
    select role_key, custom_role_id::text as custom_role_id
    from app.community_role_grants
    where user_id = ${userId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  return communityRows.length > 0;
}
