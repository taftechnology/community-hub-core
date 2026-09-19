CREATE TABLE "app"."synthetic_crypto" (
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"payload" bytea NOT NULL,
	"email_bidx" bytea NOT NULL,
	CONSTRAINT "synthetic_crypto_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."synthetic_crypto" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."synthetic_crypto" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "app"."synthetic_crypto" AS PERMISSIVE FOR ALL TO public USING ("app"."synthetic_crypto"."org_id" = current_setting('app.org_id')::uuid);
