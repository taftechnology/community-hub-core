import type { AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";

export type SummarisePersonsInput = {
  addedSince: Date;
};

export type SummarisePersonsResult = {
  total: number;
  active: number;
  inactive: number;
  addedSince: number;
};

export async function summarisePersons(
  tx: AppTransaction,
  input: SummarisePersonsInput,
): Promise<SummarisePersonsResult> {
  if (!(input.addedSince instanceof Date) || Number.isNaN(input.addedSince.getTime())) {
    throw new PeopleError("invalid_date");
  }

  const rows = await tx<
    {
      total: number;
      active: number;
      inactive: number;
      added_since: number;
    }[]
  >`
    select
      count(*)::int as total,
      count(*) filter (where status = 'active')::int as active,
      count(*) filter (where status = 'inactive')::int as inactive,
      count(*) filter (where created_at >= ${input.addedSince})::int as added_since
    from app.persons
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = false
  `;

  const row = rows[0];
  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
    inactive: row?.inactive ?? 0,
    addedSince: row?.added_since ?? 0,
  };
}
