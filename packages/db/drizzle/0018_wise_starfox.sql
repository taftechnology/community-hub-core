CREATE TABLE "app"."service_times" (
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"content_html" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "service_times_org_id_community_id_pk" PRIMARY KEY("org_id","community_id"),
	CONSTRAINT "service_times_content_html_len" CHECK (char_length("app"."service_times"."content_html") <= 20000)
);
--> statement-breakpoint
ALTER TABLE "app"."service_times" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."custom_role_permissions" DROP CONSTRAINT "custom_role_permissions_permission";--> statement-breakpoint
ALTER TABLE "app"."custom_role_permissions" ADD CONSTRAINT "custom_role_permissions_permission" CHECK ("app"."custom_role_permissions"."permission" in ('access.users.view', 'access.users.manage', 'access.roles.view', 'access.roles.manage', 'people.view', 'people.manage', 'people.restricted.read', 'entitlements.view', 'entitlements.manage', 'service_times.manage'));--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."service_times" AS PERMISSIVE FOR ALL TO public USING ("app"."service_times"."org_id" = current_setting('app.org_id')::uuid and "app"."service_times"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."service_times"."org_id" = current_setting('app.org_id')::uuid and "app"."service_times"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
ALTER TABLE "app"."service_times" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Recovery note: re-creating custom_role_permissions_permission with the previous nine keys undoes the permission change.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app.service_times FROM app;--> statement-breakpoint
GRANT SELECT, INSERT ON app.service_times TO app;--> statement-breakpoint
GRANT UPDATE (content_html, version, updated_at) ON app.service_times TO app;
