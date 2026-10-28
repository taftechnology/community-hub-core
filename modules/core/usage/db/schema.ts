import { sql, type SQL } from "drizzle-orm";
import {
  check,
  date,
  integer,
  pgPolicy,
  primaryKey,
  text,
  uuid,
  type PgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";

function communityPredicate(orgId: PgColumn, communityId: PgColumn): SQL {
  return sql`${orgId} = current_setting('app.org_id')::uuid and ${communityId} = current_setting('app.community_id')::uuid`;
}

export function usageTables(app: PgSchema) {
  const usageFactsDaily = app
    .table(
      "usage_facts_daily",
      {
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        featureKey: text("feature_key").notNull(),
        day: date("day").notNull(),
        successCount: integer("success_count").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.communityId, t.featureKey, t.day] }),
        check(
          "usage_facts_daily_feature_key",
          sql`char_length(${t.featureKey}) between 1 and 64 and ${t.featureKey} ~ '^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$'`,
        ),
        check("usage_facts_daily_success_count", sql`${t.successCount} >= 1`),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  return { usageFactsDaily };
}
