import type { Sql } from "postgres";

export async function listCommunityIds(sql: Sql, organisationId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id
    from platform.communities
    where organisation_id = ${organisationId}::uuid
  `;
  return rows.map((row) => row.id);
}
