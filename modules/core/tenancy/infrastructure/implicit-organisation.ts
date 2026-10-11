import { newId } from "@community-hub/db";
import type { Sql } from "postgres";

import { ImplicitOrganisationError, type ImplicitOrganisationCode } from "../domain/error.js";
import { implicitPair } from "../domain/slug.js";

function duplicateCode(error: unknown): ImplicitOrganisationCode | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "23505" && "constraint_name" in current) {
      if (current.constraint_name === "organisations_slug_unique") {
        return "duplicate_organisation_slug";
      }
      if (current.constraint_name === "communities_slug_unique") {
        return "duplicate_community_slug";
      }
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export async function createImplicitOrganisation(
  sql: Sql,
  input: { organisationSlug: string; communitySlug: string },
): Promise<{ organisationId: string; communityId: string }> {
  const pair = implicitPair(input);
  const organisationId = newId();
  const communityId = newId();
  try {
    await sql.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${organisationId}, ${pair.organisationSlug}, ${pair.region}, ${pair.kind})
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${organisationId}, ${pair.communitySlug}, ${pair.region})
      `;
    });
  } catch (error) {
    const code = duplicateCode(error);
    if (code !== undefined) {
      throw new ImplicitOrganisationError(code);
    }
    throw error;
  }
  return { organisationId, communityId };
}

export async function findCommunityBySlug(
  sql: Sql,
  slug: string,
): Promise<{ id: string; organisationId: string; slug: string; region: string } | null> {
  const rows = await sql<{ id: string; organisation_id: string; slug: string; region: string }[]>`
    select id, organisation_id, slug, region
    from platform.communities
    where slug = ${slug}
    limit 1
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    organisationId: row.organisation_id,
    slug: row.slug,
    region: row.region,
  };
}
