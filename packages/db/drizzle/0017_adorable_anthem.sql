CREATE TABLE "app"."life_events" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"event_type" "bytea" NOT NULL,
	"event_date" "bytea" NOT NULL,
	"place" "bytea",
	"notes" "bytea",
	CONSTRAINT "life_events_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."life_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."life_events" ADD CONSTRAINT "life_events_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "app"."persons"("org_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "life_events_person_idx" ON "app"."life_events" USING btree ("org_id","person_id");--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."life_events" AS PERMISSIVE FOR ALL TO public USING ("app"."life_events"."org_id" = current_setting('app.org_id')::uuid and "app"."life_events"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."life_events"."org_id" = current_setting('app.org_id')::uuid and "app"."life_events"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
ALTER TABLE "app"."life_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app.life_events FROM app;--> statement-breakpoint
GRANT SELECT, INSERT ON app.life_events TO app;--> statement-breakpoint
GRANT UPDATE (event_type, event_date, place, notes, version) ON app.life_events TO app;
