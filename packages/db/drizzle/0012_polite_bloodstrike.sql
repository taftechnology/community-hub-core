CREATE TABLE "identity"."operator_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"role_key" text,
	"request_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_events_action" CHECK ("identity"."operator_events"."action" in ('granted', 'revoked', 'recovery_regrant', 'enrolment_started', 'passkey_registered', 'activated', 'signed_in', 'sign_in_refused', 'signed_out')),
	CONSTRAINT "operator_events_role_key" CHECK (("identity"."operator_events"."role_key" is not null) = ("identity"."operator_events"."action" in ('granted', 'revoked', 'activated')))
);
--> statement-breakpoint
CREATE TABLE "identity"."operator_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"enrolment_code_hash" "bytea" NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"enrolment_expires_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "operator_grants_role_key" CHECK ("identity"."operator_grants"."role_key" in ('platform_admin', 'platform_support', 'platform_security'))
);
--> statement-breakpoint
ALTER TABLE "identity"."operator_grants" ADD CONSTRAINT "operator_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_grants_user_role_live" ON "identity"."operator_grants" USING btree ("user_id","role_key") WHERE "identity"."operator_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "operator_grants_user_id_idx" ON "identity"."operator_grants" USING btree ("user_id");
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE identity.operator_events FROM identity;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE identity.operator_grants FROM identity;

