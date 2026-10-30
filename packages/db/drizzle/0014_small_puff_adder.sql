CREATE TABLE "app"."group_members" (
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	CONSTRAINT "group_members_org_id_group_id_person_id_pk" PRIMARY KEY("org_id","group_id","person_id"),
	CONSTRAINT "group_members_role" CHECK ("app"."group_members"."role" in ('leader', 'member'))
);
--> statement-breakpoint
ALTER TABLE "app"."group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."groups" (
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "groups_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "groups_name_len" CHECK (char_length("app"."groups"."name") between 1 and 120),
	CONSTRAINT "groups_description_len" CHECK ("app"."groups"."description" is null or char_length("app"."groups"."description") <= 2000),
	CONSTRAINT "groups_kind" CHECK ("app"."groups"."kind" in ('ministry', 'group')),
	CONSTRAINT "groups_status" CHECK ("app"."groups"."status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "app"."groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."group_members" ADD CONSTRAINT "group_members_group_fk" FOREIGN KEY ("org_id","group_id") REFERENCES "app"."groups"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_members" ADD CONSTRAINT "group_members_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "app"."persons"("org_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "groups_active_name_key_unique" ON "app"."groups" USING btree ("org_id","community_id","name_key") WHERE "app"."groups"."status" = 'active';--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."group_members" AS PERMISSIVE FOR ALL TO public USING ("app"."group_members"."org_id" = current_setting('app.org_id')::uuid and "app"."group_members"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."group_members"."org_id" = current_setting('app.org_id')::uuid and "app"."group_members"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."groups" AS PERMISSIVE FOR ALL TO public USING ("app"."groups"."org_id" = current_setting('app.org_id')::uuid and "app"."groups"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."groups"."org_id" = current_setting('app.org_id')::uuid and "app"."groups"."community_id" = current_setting('app.community_id')::uuid);

--> statement-breakpoint
ALTER TABLE app.groups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.group_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE TRUNCATE ON app.groups, app.group_members FROM app;
--> statement-breakpoint
REVOKE DELETE ON app.groups FROM app;

