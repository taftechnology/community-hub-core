CREATE TABLE "platform"."billing_accounts" (
	"organisation_id" uuid PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_status" text,
	"plan_lookup_key" text,
	"quantity" integer,
	"current_period_end" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"trial_used_at" timestamp with time zone,
	"unpaid_since" timestamp with time zone,
	"grace_until" timestamp with time zone,
	"tax_rate_id" text,
	"synced_at" timestamp with time zone,
	CONSTRAINT "billing_accounts_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "billing_accounts_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "billing_accounts_mode" CHECK ("platform"."billing_accounts"."mode" in ('self_serve', 'invoiced'))
);
--> statement-breakpoint
CREATE TABLE "platform"."billing_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"prices_include_gst" boolean NOT NULL,
	"trial_days" integer NOT NULL,
	"grace_days" integer NOT NULL,
	"stripe_tax_rate_id" text,
	"note" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "billing_settings_gst_rate_bps" CHECK ("platform"."billing_settings"."gst_rate_bps" >= 0 and "platform"."billing_settings"."gst_rate_bps" <= 5000),
	CONSTRAINT "billing_settings_trial_days" CHECK ("platform"."billing_settings"."trial_days" >= 0 and "platform"."billing_settings"."trial_days" <= 90),
	CONSTRAINT "billing_settings_grace_days" CHECK ("platform"."billing_settings"."grace_days" >= 0 and "platform"."billing_settings"."grace_days" <= 30),
	CONSTRAINT "billing_settings_note" CHECK (char_length("platform"."billing_settings"."note") <= 200 and "platform"."billing_settings"."note" ~ '^[ -~]+$')
);
--> statement-breakpoint
CREATE TABLE "platform"."billing_stripe_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "billing_stripe_events_outcome" CHECK ("platform"."billing_stripe_events"."outcome" in ('received', 'processed', 'ignored'))
);
--> statement-breakpoint
ALTER TABLE "platform"."plans" ADD COLUMN "stripe_lookup_key" text;--> statement-breakpoint
ALTER TABLE "platform"."plans" ADD COLUMN "trial_eligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."billing_accounts" ADD CONSTRAINT "billing_accounts_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "platform"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."plans" ADD CONSTRAINT "plans_stripe_lookup_key_unique" UNIQUE("stripe_lookup_key");--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON platform.billing_settings FROM platform;--> statement-breakpoint
INSERT INTO platform.billing_settings (id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at) VALUES ('00000000-0000-0000-0000-000000000001', 1000, true, 30, 7, null, 'seed', now());--> statement-breakpoint
UPDATE platform.plans SET stripe_lookup_key = 'starter_monthly', trial_eligible = true WHERE key = 'starter';--> statement-breakpoint
UPDATE platform.plans SET stripe_lookup_key = 'growth_monthly' WHERE key = 'growth';