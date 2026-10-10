import { newId } from "@community-hub/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";

import { communities, organisations } from "../db/schema.js";
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
      const client = tx as unknown as Sql;
      client.options = sql.options;
      const db = drizzle(client);
      await db.insert(organisations).values({
        id: organisationId,
        slug: pair.organisationSlug,
        region: pair.region,
        kind: pair.kind,
      });
      await db.insert(communities).values({
        id: communityId,
        organisationId,
        slug: pair.communitySlug,
        region: pair.region,
      });
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
  const rows = await drizzle(sql)
    .select({
      id: communities.id,
      organisationId: communities.organisationId,
      slug: communities.slug,
      region: communities.region,
    })
    .from(communities)
    .where(eq(communities.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}
