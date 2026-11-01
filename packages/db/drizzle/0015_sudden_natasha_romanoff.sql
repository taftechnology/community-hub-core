ALTER TABLE "app"."custom_role_permissions" DROP CONSTRAINT "custom_role_permissions_permission";--> statement-breakpoint
ALTER TABLE "app"."persons" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."custom_role_permissions" ADD CONSTRAINT "custom_role_permissions_permission" CHECK ("app"."custom_role_permissions"."permission" in ('access.users.view', 'access.users.manage', 'access.roles.view', 'access.roles.manage', 'people.view', 'people.manage', 'people.restricted.read', 'entitlements.view', 'entitlements.manage'));--> statement-breakpoint
GRANT UPDATE (given_name, family_name, email, email_bidx, phone, phone_bidx, date_of_birth, birthday_md, age_basis, version) ON app.persons TO app;

