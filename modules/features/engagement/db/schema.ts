import { sql, type SQL } from "drizzle-orm";
import {
  check,
  integer,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  uuid,
  type PgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";

function communityPredicate(orgId: PgColumn, communityId: PgColumn): SQL {
  return sql`${orgId} = current_setting('app.org_id')::uuid and ${communityId} = current_setting('app.community_id')::uuid`;
}

export function engagementTables(app: PgSchema) {
  const serviceTimes = app
    .table(
      "service_times",
      {
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        contentHtml: text("content_html").default("").notNull(),
        version: integer("version").default(1).notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.communityId] }),
        check("service_times_content_html_len", sql`char_length(${t.contentHtml}) <= 20000`),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  return {
    serviceTimes,
  };
}
