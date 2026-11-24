import type { AppTransaction } from "@community-hub/db";

export type DeleteBlockersResult = {
  userLink: boolean;
  pendingInvitation: boolean;
};

export async function deleteBlockers(
  tx: AppTransaction,
  personId: string,
): Promise<DeleteBlockersResult> {
  // Pin 32: User link blocks
  const userLinks = await tx<{ exists: boolean }[]>`
    select exists (
      select 1
      from app.user_links
      where person_id = ${personId}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
    ) as exists
  `;

  // Pin 31: Expired pending invitation does not block (expires_at > now())
  const invitations = await tx<{ exists: boolean }[]>`
    select exists (
      select 1
      from app.invitations
      where person_id = ${personId}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
        and status = 'pending'
        and expires_at > now()
    ) as exists
  `;

  return {
    userLink: userLinks[0]?.exists ?? false,
    pendingInvitation: invitations[0]?.exists ?? false,
  };
}
