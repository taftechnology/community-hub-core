SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "app"."outbox" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"event_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "outbox_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "outbox_org_id_event_name_idempotency_key_unique" UNIQUE("org_id","event_name","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "app"."outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."outbox" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "app"."outbox" AS PERMISSIVE FOR ALL TO public USING ("app"."outbox"."org_id" = current_setting('app.org_id')::uuid);
