CREATE TABLE "app"."community_role_grants" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_key" text,
	"custom_role_id" uuid,
	CONSTRAINT "community_role_grants_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "community_role_grants_role_key" CHECK ("app"."community_role_grants"."role_key" is null or "app"."community_role_grants"."role_key" in ('community_admin', 'staff', 'finance', 'safeguarding_officer', 'volunteer_coordinator', 'content_editor', 'member')),
	CONSTRAINT "community_role_grants_one_target" CHECK (("app"."community_role_grants"."role_key" is null) <> ("app"."community_role_grants"."custom_role_id" is null))
);
--> statement-breakpoint
ALTER TABLE "app"."community_role_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."custom_role_permissions" (
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"custom_role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "custom_role_permissions_org_id_custom_role_id_permission_pk" PRIMARY KEY("org_id","custom_role_id","permission"),
	CONSTRAINT "custom_role_permissions_permission" CHECK ("app"."custom_role_permissions"."permission" in ('access.users.view', 'access.users.manage', 'access.roles.view', 'access.roles.manage', 'people.restricted.read'))
);
--> statement-breakpoint
ALTER TABLE "app"."custom_role_permissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."custom_roles" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "custom_roles_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "custom_roles_community_key_unique" UNIQUE("community_id","key"),
	CONSTRAINT "custom_roles_key" CHECK ("app"."custom_roles"."key" ~ '^[a-z][a-z0-9_]{1,31}$' and "app"."custom_roles"."key" not in ('org_owner', 'org_admin', 'org_billing', 'org_auditor', 'community_admin', 'staff', 'finance', 'safeguarding_officer', 'volunteer_coordinator', 'content_editor', 'member', 'platform_admin', 'platform_support', 'platform_security'))
);
--> statement-breakpoint
ALTER TABLE "app"."custom_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."organisation_role_grants" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	CONSTRAINT "organisation_role_grants_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "organisation_role_grants_user_role_unique" UNIQUE("org_id","user_id","role_key"),
	CONSTRAINT "organisation_role_grants_role_key" CHECK ("app"."organisation_role_grants"."role_key" in ('org_owner', 'org_admin', 'org_billing', 'org_auditor'))
);
--> statement-breakpoint
ALTER TABLE "app"."organisation_role_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."user_links" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	CONSTRAINT "user_links_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "user_links_community_user_unique" UNIQUE("community_id","user_id"),
	CONSTRAINT "user_links_community_person_unique" UNIQUE("community_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "app"."user_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."community_role_grants" ADD CONSTRAINT "community_role_grants_custom_role_fk" FOREIGN KEY ("org_id","custom_role_id") REFERENCES "app"."custom_roles"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."custom_role_permissions" ADD CONSTRAINT "custom_role_permissions_custom_role_fk" FOREIGN KEY ("org_id","custom_role_id") REFERENCES "app"."custom_roles"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_links" ADD CONSTRAINT "user_links_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "app"."persons"("org_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "community_role_grants_user_role_unique" ON "app"."community_role_grants" USING btree ("community_id","user_id","role_key") WHERE "app"."community_role_grants"."role_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "community_role_grants_user_custom_unique" ON "app"."community_role_grants" USING btree ("community_id","user_id","custom_role_id") WHERE "app"."community_role_grants"."custom_role_id" is not null;--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."community_role_grants" AS PERMISSIVE FOR ALL TO public USING ("app"."community_role_grants"."org_id" = current_setting('app.org_id')::uuid and "app"."community_role_grants"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."community_role_grants"."org_id" = current_setting('app.org_id')::uuid and "app"."community_role_grants"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."custom_role_permissions" AS PERMISSIVE FOR ALL TO public USING ("app"."custom_role_permissions"."org_id" = current_setting('app.org_id')::uuid and "app"."custom_role_permissions"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."custom_role_permissions"."org_id" = current_setting('app.org_id')::uuid and "app"."custom_role_permissions"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."custom_roles" AS PERMISSIVE FOR ALL TO public USING ("app"."custom_roles"."org_id" = current_setting('app.org_id')::uuid and "app"."custom_roles"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."custom_roles"."org_id" = current_setting('app.org_id')::uuid and "app"."custom_roles"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "org_isolation" ON "app"."organisation_role_grants" AS PERMISSIVE FOR ALL TO public USING ("app"."organisation_role_grants"."org_id" = current_setting('app.org_id')::uuid) WITH CHECK ("app"."organisation_role_grants"."org_id" = current_setting('app.org_id')::uuid);--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."user_links" AS PERMISSIVE FOR ALL TO public USING ("app"."user_links"."org_id" = current_setting('app.org_id')::uuid and "app"."user_links"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."user_links"."org_id" = current_setting('app.org_id')::uuid and "app"."user_links"."community_id" = current_setting('app.community_id')::uuid);
--> statement-breakpoint
ALTER TABLE "app"."organisation_role_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."community_role_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."custom_roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."custom_role_permissions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."user_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON TABLE app.organisation_role_grants FROM app;
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON TABLE app.community_role_grants FROM app;
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON TABLE app.custom_roles FROM app;
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON TABLE app.custom_role_permissions FROM app;
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON TABLE app.user_links FROM app;