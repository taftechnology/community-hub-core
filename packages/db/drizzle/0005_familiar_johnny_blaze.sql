CREATE TABLE "app"."community_keys" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"wrapped" "bytea" NOT NULL,
	"key_version" text NOT NULL,
	"parent_key_id" uuid NOT NULL,
	CONSTRAINT "community_keys_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "community_keys_community_id_unique" UNIQUE("community_id"),
	CONSTRAINT "community_keys_key_version" CHECK ("app"."community_keys"."key_version" = '1')
);
--> statement-breakpoint
ALTER TABLE "app"."community_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."guardian_links" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"guardian_person_id" uuid NOT NULL,
	"child_person_id" uuid NOT NULL,
	"consent" boolean NOT NULL,
	"pickup" boolean NOT NULL,
	"view" boolean NOT NULL,
	"manage" boolean NOT NULL,
	CONSTRAINT "guardian_links_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "guardian_links_triple_unique" UNIQUE("household_id","guardian_person_id","child_person_id"),
	CONSTRAINT "guardian_links_rights" CHECK ("app"."guardian_links"."consent" or "app"."guardian_links"."pickup" or "app"."guardian_links"."view" or "app"."guardian_links"."manage"),
	CONSTRAINT "guardian_links_distinct" CHECK ("app"."guardian_links"."guardian_person_id" <> "app"."guardian_links"."child_person_id")
);
--> statement-breakpoint
ALTER TABLE "app"."guardian_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."household_keys" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"wrapped" "bytea" NOT NULL,
	"key_version" text NOT NULL,
	"parent_key_id" uuid NOT NULL,
	CONSTRAINT "household_keys_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "household_keys_household_id_unique" UNIQUE("household_id"),
	CONSTRAINT "household_keys_key_version" CHECK ("app"."household_keys"."key_version" = '1')
);
--> statement-breakpoint
ALTER TABLE "app"."household_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."households" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"label" "bytea",
	CONSTRAINT "households_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."households" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."organisation_keys" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"wrapped" "bytea" NOT NULL,
	"key_version" text NOT NULL,
	CONSTRAINT "organisation_keys_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "organisation_keys_org_id_unique" UNIQUE("org_id"),
	CONSTRAINT "organisation_keys_key_version" CHECK ("app"."organisation_keys"."key_version" = '1')
);
--> statement-breakpoint
ALTER TABLE "app"."organisation_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."person_activity" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "person_activity_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "person_activity_kind" CHECK ("app"."person_activity"."kind" in ('created', 'tagged', 'untagged', 'guardian_linked', 'guardian_unlinked'))
);
--> statement-breakpoint
ALTER TABLE "app"."person_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."person_tag_links" (
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "person_tag_links_org_id_person_id_tag_id_pk" PRIMARY KEY("org_id","person_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "app"."person_tag_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."person_tags" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "person_tags_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "person_tags_community_label_unique" UNIQUE("community_id","label"),
	CONSTRAINT "person_tags_label" CHECK ("app"."person_tags"."label" ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "app"."person_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."persons" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"household_id" uuid,
	"is_minor" boolean NOT NULL,
	"age_basis" text NOT NULL,
	"birthday_md" smallint,
	"given_name" text,
	"family_name" text,
	"given_name_restricted" "bytea",
	"family_name_restricted" "bytea",
	"date_of_birth" "bytea",
	"email" "bytea",
	"email_bidx" "bytea",
	"phone" "bytea",
	"phone_bidx" "bytea",
	CONSTRAINT "persons_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "persons_age_basis" CHECK ("app"."persons"."age_basis" in ('date_of_birth', 'declared_adult', 'unknown')),
	CONSTRAINT "persons_age_basis_dob" CHECK (("app"."persons"."age_basis" = 'date_of_birth') = ("app"."persons"."date_of_birth" is not null)),
	CONSTRAINT "persons_age_basis_declared" CHECK ("app"."persons"."age_basis" <> 'declared_adult' or "app"."persons"."is_minor" = false),
	CONSTRAINT "persons_age_basis_unknown" CHECK ("app"."persons"."age_basis" <> 'unknown' or "app"."persons"."is_minor" = true),
	CONSTRAINT "persons_name_split" CHECK ((
            "app"."persons"."is_minor" = true
            and "app"."persons"."household_id" is not null
            and "app"."persons"."given_name" is null
            and "app"."persons"."family_name" is null
            and "app"."persons"."given_name_restricted" is not null
            and "app"."persons"."family_name_restricted" is not null
          ) or (
            "app"."persons"."is_minor" = false
            and "app"."persons"."given_name" is not null
            and "app"."persons"."family_name" is not null
            and "app"."persons"."given_name_restricted" is null
            and "app"."persons"."family_name_restricted" is null
          )),
	CONSTRAINT "persons_birthday_pair" CHECK (("app"."persons"."date_of_birth" is null) = ("app"."persons"."birthday_md" is null)),
	CONSTRAINT "persons_birthday_md_range" CHECK ("app"."persons"."birthday_md" is null or ("app"."persons"."birthday_md" / 100 between 1 and 12 and "app"."persons"."birthday_md" % 100 between 1 and 31)),
	CONSTRAINT "persons_email_pair" CHECK (("app"."persons"."email" is null) = ("app"."persons"."email_bidx" is null)),
	CONSTRAINT "persons_phone_pair" CHECK (("app"."persons"."phone" is null) = ("app"."persons"."phone_bidx" is null)),
	CONSTRAINT "persons_email_bidx_len" CHECK ("app"."persons"."email_bidx" is null or octet_length("app"."persons"."email_bidx") = 32),
	CONSTRAINT "persons_phone_bidx_len" CHECK ("app"."persons"."phone_bidx" is null or octet_length("app"."persons"."phone_bidx") = 32)
);
--> statement-breakpoint
ALTER TABLE "app"."persons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."guardian_links" ADD CONSTRAINT "guardian_links_household_fk" FOREIGN KEY ("org_id","household_id") REFERENCES "app"."households"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."guardian_links" ADD CONSTRAINT "guardian_links_guardian_fk" FOREIGN KEY ("org_id","guardian_person_id") REFERENCES "app"."persons"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."guardian_links" ADD CONSTRAINT "guardian_links_child_fk" FOREIGN KEY ("org_id","child_person_id") REFERENCES "app"."persons"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."household_keys" ADD CONSTRAINT "household_keys_household_fk" FOREIGN KEY ("org_id","household_id") REFERENCES "app"."households"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."person_activity" ADD CONSTRAINT "person_activity_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "app"."persons"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."person_tag_links" ADD CONSTRAINT "person_tag_links_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "app"."persons"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."person_tag_links" ADD CONSTRAINT "person_tag_links_tag_fk" FOREIGN KEY ("org_id","tag_id") REFERENCES "app"."person_tags"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."persons" ADD CONSTRAINT "persons_household_fk" FOREIGN KEY ("org_id","household_id") REFERENCES "app"."households"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "persons_adult_email_bidx" ON "app"."persons" USING btree ("community_id","email_bidx") WHERE "app"."persons"."is_minor" = false and "app"."persons"."email_bidx" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "persons_minor_email_bidx" ON "app"."persons" USING btree ("household_id","email_bidx") WHERE "app"."persons"."is_minor" = true and "app"."persons"."email_bidx" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "persons_adult_phone_bidx" ON "app"."persons" USING btree ("community_id","phone_bidx") WHERE "app"."persons"."is_minor" = false and "app"."persons"."phone_bidx" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "persons_minor_phone_bidx" ON "app"."persons" USING btree ("household_id","phone_bidx") WHERE "app"."persons"."is_minor" = true and "app"."persons"."phone_bidx" is not null;--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."community_keys" AS PERMISSIVE FOR ALL TO public USING ("app"."community_keys"."org_id" = current_setting('app.org_id')::uuid and "app"."community_keys"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."community_keys"."org_id" = current_setting('app.org_id')::uuid and "app"."community_keys"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."guardian_links" AS PERMISSIVE FOR ALL TO public USING ("app"."guardian_links"."org_id" = current_setting('app.org_id')::uuid and "app"."guardian_links"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."guardian_links"."org_id" = current_setting('app.org_id')::uuid and "app"."guardian_links"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."household_keys" AS PERMISSIVE FOR ALL TO public USING ("app"."household_keys"."org_id" = current_setting('app.org_id')::uuid and "app"."household_keys"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."household_keys"."org_id" = current_setting('app.org_id')::uuid and "app"."household_keys"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."households" AS PERMISSIVE FOR ALL TO public USING ("app"."households"."org_id" = current_setting('app.org_id')::uuid and "app"."households"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."households"."org_id" = current_setting('app.org_id')::uuid and "app"."households"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "app"."organisation_keys" AS PERMISSIVE FOR ALL TO public USING ("app"."organisation_keys"."org_id" = current_setting('app.org_id')::uuid) WITH CHECK ("app"."organisation_keys"."org_id" = current_setting('app.org_id')::uuid);--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."person_activity" AS PERMISSIVE FOR ALL TO public USING ("app"."person_activity"."org_id" = current_setting('app.org_id')::uuid and "app"."person_activity"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."person_activity"."org_id" = current_setting('app.org_id')::uuid and "app"."person_activity"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."person_tag_links" AS PERMISSIVE FOR ALL TO public USING ("app"."person_tag_links"."org_id" = current_setting('app.org_id')::uuid and "app"."person_tag_links"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."person_tag_links"."org_id" = current_setting('app.org_id')::uuid and "app"."person_tag_links"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."person_tags" AS PERMISSIVE FOR ALL TO public USING ("app"."person_tags"."org_id" = current_setting('app.org_id')::uuid and "app"."person_tags"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."person_tags"."org_id" = current_setting('app.org_id')::uuid and "app"."person_tags"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."persons" AS PERMISSIVE FOR ALL TO public USING ("app"."persons"."org_id" = current_setting('app.org_id')::uuid and "app"."persons"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."persons"."org_id" = current_setting('app.org_id')::uuid and "app"."persons"."community_id" = current_setting('app.community_id')::uuid);
--> statement-breakpoint
ALTER TABLE "app"."organisation_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."community_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."household_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."households" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."persons" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."guardian_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."person_tags" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."person_tag_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."person_activity" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app.organisation_keys FROM app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app.community_keys FROM app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app.household_keys FROM app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app.households FROM app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app.persons FROM app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app.person_tags FROM app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app.person_activity FROM app;
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON TABLE app.guardian_links FROM app;
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON TABLE app.person_tag_links FROM app;