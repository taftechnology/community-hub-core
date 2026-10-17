import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  text,
  timestamp,
  unique,
  uuid,
  type PgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";

export function billingTables(platform: PgSchema, refs: { organisationId: PgColumn }) {
  const billingAccounts = platform.table(
    "billing_accounts",
    {
      organisationId: uuid("organisation_id").primaryKey(),
      mode: text("mode").notNull(),
      stripeCustomerId: text("stripe_customer_id"),
      stripeSubscriptionId: text("stripe_subscription_id"),
      stripeStatus: text("stripe_status"),
      planLookupKey: text("plan_lookup_key"),
      quantity: integer("quantity"),
      currentPeriodEnd: timestamp("current_period_end", {
        withTimezone: true,
        mode: "date",
      }),
      trialEnd: timestamp("trial_end", {
        withTimezone: true,
        mode: "date",
      }),
      trialUsedAt: timestamp("trial_used_at", {
        withTimezone: true,
        mode: "date",
      }),
      unpaidSince: timestamp("unpaid_since", {
        withTimezone: true,
        mode: "date",
      }),
      graceUntil: timestamp("grace_until", {
        withTimezone: true,
        mode: "date",
      }),
      taxRateId: text("tax_rate_id"),
      syncedAt: timestamp("synced_at", {
        withTimezone: true,
        mode: "date",
      }),
    },
    (t) => [
      foreignKey({
        columns: [t.organisationId],
        foreignColumns: [refs.organisationId],
        name: "billing_accounts_organisation_fk",
      }).onDelete("restrict"),
      unique("billing_accounts_stripe_customer_id_unique").on(t.stripeCustomerId),
      unique("billing_accounts_stripe_subscription_id_unique").on(t.stripeSubscriptionId),
      check("billing_accounts_mode", sql`${t.mode} in ('self_serve', 'invoiced')`),
    ],
  );

  const billingSettings = platform.table(
    "billing_settings",
    {
      id: uuid("id").primaryKey(),
      gstRateBps: integer("gst_rate_bps").notNull(),
      pricesIncludeGst: boolean("prices_include_gst").notNull(),
      trialDays: integer("trial_days").notNull(),
      graceDays: integer("grace_days").notNull(),
      stripeTaxRateId: text("stripe_tax_rate_id"),
      note: text("note").notNull(),
      createdAt: timestamp("created_at", {
        withTimezone: true,
        mode: "date",
      }).notNull(),
    },
    (t) => [
      check("billing_settings_gst_rate_bps", sql`${t.gstRateBps} >= 0 and ${t.gstRateBps} <= 5000`),
      check("billing_settings_trial_days", sql`${t.trialDays} >= 0 and ${t.trialDays} <= 90`),
      check("billing_settings_grace_days", sql`${t.graceDays} >= 0 and ${t.graceDays} <= 30`),
      check("billing_settings_note", sql`char_length(${t.note}) <= 200 and ${t.note} ~ '^[ -~]+$'`),
    ],
  );

  const billingStripeEvents = platform.table(
    "billing_stripe_events",
    {
      eventId: text("event_id").primaryKey(),
      type: text("type").notNull(),
      outcome: text("outcome").notNull(),
      receivedAt: timestamp("received_at", {
        withTimezone: true,
        mode: "date",
      }).notNull(),
      processedAt: timestamp("processed_at", {
        withTimezone: true,
        mode: "date",
      }),
    },
    (t) => [
      check(
        "billing_stripe_events_outcome",
        sql`${t.outcome} in ('received', 'processed', 'ignored')`,
      ),
    ],
  );

  return {
    billingAccounts,
    billingSettings,
    billingStripeEvents,
    billing_accounts: billingAccounts,
    billing_settings: billingSettings,
    billing_stripe_events: billingStripeEvents,
  };
}
