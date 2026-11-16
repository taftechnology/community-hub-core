import type { AppTransaction } from "@community-hub/db";

import { parseUuid } from "../domain/role.js";

export type MembershipSource = "invitation" | "provision" | "backfill";

export interface InsertMembershipInput {
  readonly userId: string;
  readonly source: MembershipSource;
  readonly invitationId?: string | null;
  readonly now?: Date;
}

export async function lockOrganisation(tx: AppTransaction): Promise<void> {
  await tx`
    select pg_advisory_xact_lock(
      hashtextextended('access.org:' || current_setting('app.org_id'), 0)
    )
  `;
}

export async function isMember(tx: AppTransaction, userId: string): Promise<boolean> {
  const parsedUserId = parseUuid(userId);
  const rows = await tx<{ exists: boolean }[]>`
    select exists(
      select 1
      from app.organisation_members
      where org_id = current_setting('app.org_id')::uuid
        and user_id = ${parsedUserId}::uuid
    ) as exists
  `;
  return rows[0]?.exists ?? false;
}

export async function insertMembership(
  tx: AppTransaction,
  input: InsertMembershipInput,
): Promise<void> {
  const userId = parseUuid(input.userId);
  const invitationId = input.invitationId ? parseUuid(input.invitationId) : null;
  const createdAt = input.now ?? new Date();
  await tx`
    insert into app.organisation_members (org_id, user_id, source, invitation_id, created_at)
    values (
      current_setting('app.org_id')::uuid,
      ${userId}::uuid,
      ${input.source},
      ${invitationId}::uuid,
      ${createdAt}
    )
    on conflict do nothing
  `;
}
