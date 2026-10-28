CREATE TABLE "app"."usage_facts_daily" (
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"feature_key" text NOT NULL,
	"day" date NOT NULL,
	"success_count" integer NOT NULL,
	CONSTRAINT "usage_facts_daily_org_id_community_id_feature_key_day_pk" PRIMARY KEY("org_id","community_id","feature_key","day"),
	CONSTRAINT "usage_facts_daily_feature_key" CHECK (char_length("app"."usage_facts_daily"."feature_key") between 1 and 64 and "app"."usage_facts_daily"."feature_key" ~ '^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$'),
	CONSTRAINT "usage_facts_daily_success_count" CHECK ("app"."usage_facts_daily"."success_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "app"."usage_facts_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."usage_facts_daily" AS PERMISSIVE FOR ALL TO public USING ("app"."usage_facts_daily"."org_id" = current_setting('app.org_id')::uuid and "app"."usage_facts_daily"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."usage_facts_daily"."org_id" = current_setting('app.org_id')::uuid and "app"."usage_facts_daily"."community_id" = current_setting('app.community_id')::uuid);
--> statement-breakpoint
ALTER TABLE "app"."usage_facts_daily" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE app.usage_facts_daily FROM app;
