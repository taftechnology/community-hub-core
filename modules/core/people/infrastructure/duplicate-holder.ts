import type { AppTransaction } from "@community-hub/db";

export type DuplicateHolder = {
  field: "email" | "phone";
  hidden: boolean;
};

// Finds who holds a blind index that a write just collided on, in the current scope. Email is
// checked first, then phone. Runs after the failed statement's savepoint was rolled back. The
// answer carries no personal data: which field, and whether the holder is a deleted contact.
export async function findDuplicateHolder(
  tx: AppTransaction,
  input: {
    emailBidx: Uint8Array | null | undefined;
    phoneBidx: Uint8Array | null | undefined;
    excludePersonId: string | null;
  },
): Promise<DuplicateHolder | null> {
  if (input.emailBidx !== null && input.emailBidx !== undefined) {
    const rows = await tx<{ hidden: boolean }[]>`
      select deleted_at is not null as hidden
      from app.persons
      where email_bidx = ${input.emailBidx}
        and is_minor = false
        and (${input.excludePersonId}::uuid is null or id <> ${input.excludePersonId}::uuid)
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
      limit 1
    `;
    if (rows[0] !== undefined) {
      return { field: "email", hidden: rows[0].hidden };
    }
  }
  if (input.phoneBidx !== null && input.phoneBidx !== undefined) {
    const rows = await tx<{ hidden: boolean }[]>`
      select deleted_at is not null as hidden
      from app.persons
      where phone_bidx = ${input.phoneBidx}
        and is_minor = false
        and (${input.excludePersonId}::uuid is null or id <> ${input.excludePersonId}::uuid)
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
      limit 1
    `;
    if (rows[0] !== undefined) {
      return { field: "phone", hidden: rows[0].hidden };
    }
  }
  return null;
}
