CREATE TABLE "app"."synthetic" (
	"org_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	CONSTRAINT "synthetic_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."synthetic" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."synthetic" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "app"."synthetic" AS PERMISSIVE FOR ALL TO public USING ("app"."synthetic"."org_id" = current_setting('app.org_id')::uuid);
