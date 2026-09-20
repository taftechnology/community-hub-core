CREATE TABLE "app"."synthetic_community" (
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	CONSTRAINT "synthetic_community_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."synthetic_community" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."synthetic_community" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."synthetic_community" AS PERMISSIVE FOR ALL TO public USING ("app"."synthetic_community"."org_id" = current_setting('app.org_id')::uuid and "app"."synthetic_community"."community_id" = current_setting('app.community_id')::uuid);
