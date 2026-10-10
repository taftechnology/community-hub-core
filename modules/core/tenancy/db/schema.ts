import { platform } from "@community-hub/db";
import { sql } from "drizzle-orm";
import { check, index, text, unique, uuid } from "drizzle-orm/pg-core";

export const organisations = platform.table(
  "organisations",
  {
    id: uuid("id").primaryKey(),
    slug: text("slug").notNull(),
    region: text("region").notNull(),
    kind: text("kind").notNull(),
  },
  (t) => [
    unique("organisations_slug_unique").on(t.slug),
    check("organisations_region_au", sql`${t.region} = 'au'`),
    check("organisations_kind", sql`${t.kind} in ('implicit', 'explicit')`),
    check("organisations_slug_label", sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'`),
  ],
);

export const communities = platform.table(
  "communities",
  {
    id: uuid("id").primaryKey(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id),
    slug: text("slug").notNull(),
    region: text("region").notNull(),
  },
  (t) => [
    unique("communities_slug_unique").on(t.slug),
    index("communities_organisation_id_idx").on(t.organisationId),
    check("communities_region_au", sql`${t.region} = 'au'`),
    check("communities_slug_label", sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'`),
  ],
);
