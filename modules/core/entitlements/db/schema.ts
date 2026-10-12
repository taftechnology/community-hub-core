import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type PgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";

type PlatformRefs = {
  organisationId: PgColumn;
  communityId: PgColumn;
};

let platformRefs: PlatformRefs | undefined;

export function rememberPlatformTables(refs: PlatformRefs): void {
  platformRefs = refs;
}

function refs(): PlatformRefs {
  if (platformRefs === undefined) {
    throw new Error("platform tables are missing");
  }
  return platformRefs;
}

function entitlementKey(name: string, column: PgColumn) {
  return check(
    name,
    sql`char_length(${column}) <= 64 and ${column} ~ '^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$'`,
  );
}

function planKey(name: string, column: PgColumn) {
  return check(name, sql`${column} ~ '^[a-z][a-z0-9_]{1,31}$'`);
}

function limitValue(name: string, column: PgColumn) {
  return check(name, sql`${column} is null or ${column} >= 0`);
}

export function entitlementTables(platform: PgSchema) {
  const { organisationId, communityId } = refs();

  const plans = platform.table(
    "plans",
    {
      id: uuid("id").primaryKey(),
      key: text("key").notNull(),
    },
    (t) => [unique("plans_key_unique").on(t.key), planKey("plans_key", t.key)],
  );

  const planEntitlements = platform.table(
    "plan_entitlements",
    {
      planId: uuid("plan_id").notNull(),
      entitlementKey: text("entitlement_key").notNull(),
      limitValue: integer("limit_value"),
    },
    (t) => [
      primaryKey({ columns: [t.planId, t.entitlementKey] }),
      foreignKey({
        columns: [t.planId],
        foreignColumns: [plans.id],
        name: "plan_entitlements_plan_fk",
      }).onDelete("restrict"),
      entitlementKey("plan_entitlements_key", t.entitlementKey),
      limitValue("plan_entitlements_limit", t.limitValue),
    ],
  );

  const addOns = platform.table(
    "add_ons",
    {
      id: uuid("id").primaryKey(),
      key: text("key").notNull(),
    },
    (t) => [unique("add_ons_key_unique").on(t.key), planKey("add_ons_key", t.key)],
  );

  const addOnEntitlements = platform.table(
    "add_on_entitlements",
    {
      addOnId: uuid("add_on_id").notNull(),
      entitlementKey: text("entitlement_key").notNull(),
      limitValue: integer("limit_value"),
    },
    (t) => [
      primaryKey({ columns: [t.addOnId, t.entitlementKey] }),
      foreignKey({
        columns: [t.addOnId],
        foreignColumns: [addOns.id],
        name: "add_on_entitlements_add_on_fk",
      }).onDelete("restrict"),
      entitlementKey("add_on_entitlements_key", t.entitlementKey),
      limitValue("add_on_entitlements_limit", t.limitValue),
    ],
  );

  const organisationPlans = platform.table(
    "organisation_plans",
    {
      organisationId: uuid("organisation_id").notNull(),
      planId: uuid("plan_id").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.organisationId] }),
      foreignKey({
        columns: [t.organisationId],
        foreignColumns: [organisationId],
        name: "organisation_plans_organisation_fk",
      }).onDelete("restrict"),
      foreignKey({
        columns: [t.planId],
        foreignColumns: [plans.id],
        name: "organisation_plans_plan_fk",
      }).onDelete("restrict"),
    ],
  );

  const organisationAddOns = platform.table(
    "organisation_add_ons",
    {
      organisationId: uuid("organisation_id").notNull(),
      addOnId: uuid("add_on_id").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.organisationId, t.addOnId] }),
      foreignKey({
        columns: [t.organisationId],
        foreignColumns: [organisationId],
        name: "organisation_add_ons_organisation_fk",
      }).onDelete("restrict"),
      foreignKey({
        columns: [t.addOnId],
        foreignColumns: [addOns.id],
        name: "organisation_add_ons_add_on_fk",
      }).onDelete("restrict"),
    ],
  );

  const communityAllocations = platform.table(
    "community_allocations",
    {
      communityId: uuid("community_id").notNull(),
      entitlementKey: text("entitlement_key").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.communityId, t.entitlementKey] }),
      foreignKey({
        columns: [t.communityId],
        foreignColumns: [communityId],
        name: "community_allocations_community_fk",
      }).onDelete("restrict"),
      entitlementKey("community_allocations_key", t.entitlementKey),
    ],
  );

  const communityToggles = platform.table(
    "community_toggles",
    {
      communityId: uuid("community_id").notNull(),
      entitlementKey: text("entitlement_key").notNull(),
      enabled: boolean("enabled").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.communityId, t.entitlementKey] }),
      foreignKey({
        columns: [t.communityId],
        foreignColumns: [communityId],
        name: "community_toggles_community_fk",
      }).onDelete("restrict"),
      entitlementKey("community_toggles_key", t.entitlementKey),
      check("community_toggles_enabled_false", sql`${t.enabled} = false`),
    ],
  );

  const entitlementOverrides = platform.table(
    "entitlement_overrides",
    {
      id: uuid("id").primaryKey(),
      organisationId: uuid("organisation_id").notNull(),
      entitlementKey: text("entitlement_key").notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [
      unique("entitlement_overrides_organisation_key_unique").on(
        t.organisationId,
        t.entitlementKey,
      ),
      foreignKey({
        columns: [t.organisationId],
        foreignColumns: [organisationId],
        name: "entitlement_overrides_organisation_fk",
      }).onDelete("restrict"),
      entitlementKey("entitlement_overrides_key", t.entitlementKey),
    ],
  );

  const featureFlags = platform.table(
    "feature_flags",
    {
      id: uuid("id").primaryKey(),
      key: text("key").notNull(),
      enabled: boolean("enabled").notNull(),
      organisationId: uuid("organisation_id"),
      communityId: uuid("community_id"),
      planKey: text("plan_key"),
      region: text("region"),
    },
    (t) => [
      unique("feature_flags_target_unique")
        .on(t.key, t.organisationId, t.communityId, t.planKey, t.region)
        .nullsNotDistinct(),
      foreignKey({
        columns: [t.organisationId],
        foreignColumns: [organisationId],
        name: "feature_flags_organisation_fk",
      }).onDelete("restrict"),
      foreignKey({
        columns: [t.communityId],
        foreignColumns: [communityId],
        name: "feature_flags_community_fk",
      }).onDelete("restrict"),
      entitlementKey("feature_flags_key", t.key),
      check(
        "feature_flags_plan_key",
        sql`${t.planKey} is null or ${t.planKey} ~ '^[a-z][a-z0-9_]{1,31}$'`,
      ),
      check("feature_flags_region", sql`${t.region} is null or ${t.region} = 'au'`),
    ],
  );

  return {
    plans,
    planEntitlements,
    addOns,
    addOnEntitlements,
    organisationPlans,
    organisationAddOns,
    communityAllocations,
    communityToggles,
    entitlementOverrides,
    featureFlags,
  };
}
