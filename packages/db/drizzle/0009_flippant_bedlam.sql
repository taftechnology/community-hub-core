CREATE TABLE "platform"."add_on_entitlements" (
	"add_on_id" uuid NOT NULL,
	"entitlement_key" text NOT NULL,
	"limit_value" integer,
	CONSTRAINT "add_on_entitlements_add_on_id_entitlement_key_pk" PRIMARY KEY("add_on_id","entitlement_key"),
	CONSTRAINT "add_on_entitlements_key" CHECK (char_length("platform"."add_on_entitlements"."entitlement_key") <= 64 and "platform"."add_on_entitlements"."entitlement_key" ~ '^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$'),
	CONSTRAINT "add_on_entitlements_limit" CHECK ("platform"."add_on_entitlements"."limit_value" is null or "platform"."add_on_entitlements"."limit_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."add_ons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "add_ons_key_unique" UNIQUE("key"),
	CONSTRAINT "add_ons_key" CHECK ("platform"."add_ons"."key" ~ '^[a-z][a-z0-9_]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "platform"."community_allocations" (
	"community_id" uuid NOT NULL,
	"entitlement_key" text NOT NULL,
	CONSTRAINT "community_allocations_community_id_entitlement_key_pk" PRIMARY KEY("community_id","entitlement_key"),
	CONSTRAINT "community_allocations_key" CHECK (char_length("platform"."community_allocations"."entitlement_key") <= 64 and "platform"."community_allocations"."entitlement_key" ~ '^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$')
);
--> statement-breakpoint
CREATE TABLE "platform"."community_toggles" (
	"community_id" uuid NOT NULL,
	"entitlement_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "community_toggles_community_id_entitlement_key_pk" PRIMARY KEY("community_id","entitlement_key"),
	CONSTRAINT "community_toggles_key" CHECK (char_length("platform"."community_toggles"."entitlement_key") <= 64 and "platform"."community_toggles"."entitlement_key" ~ '^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$'),
	CONSTRAINT "community_toggles_enabled_false" CHECK ("platform"."community_toggles"."enabled" = false)
);
--> statement-breakpoint
CREATE TABLE "platform"."entitlement_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"entitlement_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "entitlement_overrides_organisation_key_unique" UNIQUE("organisation_id","entitlement_key"),
	CONSTRAINT "entitlement_overrides_key" CHECK (char_length("platform"."entitlement_overrides"."entitlement_key") <= 64 and "platform"."entitlement_overrides"."entitlement_key" ~ '^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$')
);
--> statement-breakpoint
CREATE TABLE "platform"."feature_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"organisation_id" uuid,
	"community_id" uuid,
	"plan_key" text,
	"region" text,
	CONSTRAINT "feature_flags_target_unique" UNIQUE NULLS NOT DISTINCT("key","organisation_id","community_id","plan_key","region"),
	CONSTRAINT "feature_flags_key" CHECK (char_length("platform"."feature_flags"."key") <= 64 and "platform"."feature_flags"."key" ~ '^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$'),
	CONSTRAINT "feature_flags_plan_key" CHECK ("platform"."feature_flags"."plan_key" is null or "platform"."feature_flags"."plan_key" ~ '^[a-z][a-z0-9_]{1,31}$'),
	CONSTRAINT "feature_flags_region" CHECK ("platform"."feature_flags"."region" is null or "platform"."feature_flags"."region" = 'au')
);
--> statement-breakpoint
CREATE TABLE "platform"."organisation_add_ons" (
	"organisation_id" uuid NOT NULL,
	"add_on_id" uuid NOT NULL,
	CONSTRAINT "organisation_add_ons_organisation_id_add_on_id_pk" PRIMARY KEY("organisation_id","add_on_id")
);
--> statement-breakpoint
CREATE TABLE "platform"."organisation_plans" (
	"organisation_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	CONSTRAINT "organisation_plans_organisation_id_pk" PRIMARY KEY("organisation_id")
);
--> statement-breakpoint
CREATE TABLE "platform"."plan_entitlements" (
	"plan_id" uuid NOT NULL,
	"entitlement_key" text NOT NULL,
	"limit_value" integer,
	CONSTRAINT "plan_entitlements_plan_id_entitlement_key_pk" PRIMARY KEY("plan_id","entitlement_key"),
	CONSTRAINT "plan_entitlements_key" CHECK (char_length("platform"."plan_entitlements"."entitlement_key") <= 64 and "platform"."plan_entitlements"."entitlement_key" ~ '^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$'),
	CONSTRAINT "plan_entitlements_limit" CHECK ("platform"."plan_entitlements"."limit_value" is null or "platform"."plan_entitlements"."limit_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "plans_key_unique" UNIQUE("key"),
	CONSTRAINT "plans_key" CHECK ("platform"."plans"."key" ~ '^[a-z][a-z0-9_]{1,31}$')
);
--> statement-breakpoint
ALTER TABLE "platform"."add_on_entitlements" ADD CONSTRAINT "add_on_entitlements_add_on_fk" FOREIGN KEY ("add_on_id") REFERENCES "platform"."add_ons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."community_allocations" ADD CONSTRAINT "community_allocations_community_fk" FOREIGN KEY ("community_id") REFERENCES "platform"."communities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."community_toggles" ADD CONSTRAINT "community_toggles_community_fk" FOREIGN KEY ("community_id") REFERENCES "platform"."communities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "platform"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."feature_flags" ADD CONSTRAINT "feature_flags_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "platform"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."feature_flags" ADD CONSTRAINT "feature_flags_community_fk" FOREIGN KEY ("community_id") REFERENCES "platform"."communities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."organisation_add_ons" ADD CONSTRAINT "organisation_add_ons_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "platform"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."organisation_add_ons" ADD CONSTRAINT "organisation_add_ons_add_on_fk" FOREIGN KEY ("add_on_id") REFERENCES "platform"."add_ons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."organisation_plans" ADD CONSTRAINT "organisation_plans_organisation_fk" FOREIGN KEY ("organisation_id") REFERENCES "platform"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."organisation_plans" ADD CONSTRAINT "organisation_plans_plan_fk" FOREIGN KEY ("plan_id") REFERENCES "platform"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_fk" FOREIGN KEY ("plan_id") REFERENCES "platform"."plans"("id") ON DELETE restrict ON UPDATE no action;