CREATE TABLE "identity"."invitation_emails" (
	"invitation_id" uuid PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"email" "bytea",
	"email_bidx" "bytea",
	"dedupe_key" "bytea",
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "invitation_emails_region_au" CHECK ("identity"."invitation_emails"."region" = 'au'),
	CONSTRAINT "invitation_emails_payload_set" CHECK (("identity"."invitation_emails"."email" is null and "identity"."invitation_emails"."email_bidx" is null and "identity"."invitation_emails"."dedupe_key" is null) or ("identity"."invitation_emails"."email" is not null and "identity"."invitation_emails"."email_bidx" is not null and "identity"."invitation_emails"."dedupe_key" is not null)),
	CONSTRAINT "invitation_emails_email_bidx_len" CHECK ("identity"."invitation_emails"."email_bidx" is null or octet_length("identity"."invitation_emails"."email_bidx") = 32),
	CONSTRAINT "invitation_emails_dedupe_key_len" CHECK ("identity"."invitation_emails"."dedupe_key" is null or octet_length("identity"."invitation_emails"."dedupe_key") = 32)
);
--> statement-breakpoint
CREATE TABLE "app"."invitations" (
	"org_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"invited_by" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"role_key" text,
	"custom_role_id" uuid,
	"person_id" uuid,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resend_count" integer NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL,
	"accepted_user_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "invitations_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "invitations_status" CHECK ("app"."invitations"."status" in ('pending', 'accepted', 'revoked', 'void')),
	CONSTRAINT "invitations_role_key" CHECK ("app"."invitations"."role_key" is null or "app"."invitations"."role_key" in ('org_owner', 'org_admin', 'org_billing', 'org_auditor', 'community_admin', 'staff', 'finance', 'safeguarding_officer', 'volunteer_coordinator', 'content_editor', 'member')),
	CONSTRAINT "invitations_at_most_one_role" CHECK ("app"."invitations"."role_key" is null or "app"."invitations"."custom_role_id" is null),
	CONSTRAINT "invitations_role_or_contact_while_pending" CHECK ("app"."invitations"."status" <> 'pending' or "app"."invitations"."role_key" is not null or "app"."invitations"."custom_role_id" is not null or "app"."invitations"."person_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "app"."invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."organisation_members" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"invitation_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "organisation_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "organisation_members_source" CHECK ("app"."organisation_members"."source" in ('invitation', 'provision', 'backfill'))
);
--> statement-breakpoint
ALTER TABLE "app"."organisation_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."invitations" ADD CONSTRAINT "invitations_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "app"."persons"("org_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "app"."invitations" ADD CONSTRAINT "invitations_custom_role_fk" FOREIGN KEY ("org_id","custom_role_id") REFERENCES "app"."custom_roles"("org_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_emails_dedupe_key_unique" ON "identity"."invitation_emails" USING btree ("dedupe_key");--> statement-breakpoint
CREATE POLICY "community_isolation" ON "app"."invitations" AS PERMISSIVE FOR ALL TO public USING ("app"."invitations"."org_id" = current_setting('app.org_id')::uuid and "app"."invitations"."community_id" = current_setting('app.community_id')::uuid) WITH CHECK ("app"."invitations"."org_id" = current_setting('app.org_id')::uuid and "app"."invitations"."community_id" = current_setting('app.community_id')::uuid);--> statement-breakpoint
CREATE POLICY "org_isolation" ON "app"."organisation_members" AS PERMISSIVE FOR ALL TO public USING ("app"."organisation_members"."org_id" = current_setting('app.org_id')::uuid) WITH CHECK ("app"."organisation_members"."org_id" = current_setting('app.org_id')::uuid);--> statement-breakpoint
ALTER TABLE "app"."organisation_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON app.organisation_members FROM app;--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON app.invitations FROM app;--> statement-breakpoint
GRANT UPDATE (status, token_hash, expires_at, resend_count, last_sent_at, accepted_user_id, person_id, custom_role_id, closed_at) ON app.invitations TO app;--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON identity.invitation_emails FROM identity;--> statement-breakpoint
GRANT UPDATE (email, email_bidx, dedupe_key, expires_at, closed_at) ON identity.invitation_emails TO identity;--> statement-breakpoint
REVOKE ALL ON identity.invitation_emails FROM app, platform;--> statement-breakpoint
-- Recovery note: the tables are new, and a later contract PR may drop them.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN SELECT id, organisation_id FROM platform.communities LOOP
    PERFORM set_config('app.org_id', c.organisation_id::text, true);
    PERFORM set_config('app.community_id', c.id::text, true);

    INSERT INTO app.organisation_members (org_id, user_id, source, created_at)
    SELECT DISTINCT c.organisation_id, candidate.user_id, 'backfill', now()
    FROM (
      SELECT user_id FROM app.organisation_role_grants WHERE org_id = c.organisation_id
      UNION
      SELECT user_id FROM app.community_role_grants WHERE org_id = c.organisation_id AND community_id = c.id
      UNION
      SELECT user_id FROM app.user_links WHERE org_id = c.organisation_id AND community_id = c.id
    ) candidate
    JOIN identity.users u ON u.id = candidate.user_id
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.org_id', '', true);
  PERFORM set_config('app.community_id', '', true);
END $$;