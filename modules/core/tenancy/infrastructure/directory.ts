import type { Sql, TransactionSql } from "postgres";

export type DirectoryCommunity = {
  id: string;
  slug: string;
};

export type DirectoryOrganisation = {
  id: string;
  slug: string;
  kind: string;
  region: string;
  communities: DirectoryCommunity[];
};

export type DirectoryResult = {
  organisations: DirectoryOrganisation[];
  truncated: boolean;
};

export async function listDirectory(platform: Sql | TransactionSql): Promise<DirectoryResult> {
  const orgRows = await platform<
    {
      id: string;
      slug: string;
      kind: string;
      region: string;
    }[]
  >`
    select id, slug, kind, region
    from platform.organisations
    order by slug collate "C"
    limit 501
  `;

  const truncated = orgRows.length > 500;
  const orgsToReturn = truncated ? orgRows.slice(0, 500) : orgRows;

  if (orgsToReturn.length === 0) {
    return {
      organisations: [],
      truncated: false,
    };
  }

  const orgIds = orgsToReturn.map((row) => row.id);
  const communityRows = await platform<
    {
      id: string;
      organisation_id: string;
      slug: string;
    }[]
  >`
    select id, organisation_id, slug
    from platform.communities
    where organisation_id = any(${orgIds}::uuid[])
    order by slug collate "C"
  `;

  const communitiesByOrg = new Map<string, DirectoryCommunity[]>();
  for (const row of communityRows) {
    let list = communitiesByOrg.get(row.organisation_id);
    if (list === undefined) {
      list = [];
      communitiesByOrg.set(row.organisation_id, list);
    }
    list.push({
      id: row.id,
      slug: row.slug,
    });
  }

  const organisations: DirectoryOrganisation[] = orgsToReturn.map((org) => ({
    id: org.id,
    slug: org.slug,
    kind: org.kind,
    region: org.region,
    communities: communitiesByOrg.get(org.id) ?? [],
  }));

  return {
    organisations,
    truncated,
  };
}
