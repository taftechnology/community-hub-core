CREATE TABLE "identity"."backup_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "backup_codes_user_id_code_hash_unique" UNIQUE("user_id","code_hash")
);
--> statement-breakpoint
CREATE TABLE "identity"."second_factor_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"event" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "second_factor_events_event" CHECK ("identity"."second_factor_events"."event" in ('totp_enrolled', 'totp_removed', 'passkey_enrolled', 'passkey_removed', 'backup_codes_generated', 'backup_code_used', 'verify_failed'))
);
--> statement-breakpoint
CREATE TABLE "identity"."totp_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" "bytea" NOT NULL,
	"pending_secret" "bytea",
	"last_used_step" bigint,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "totp_credentials_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD COLUMN "factor" text;--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD COLUMN "fresh_factor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD COLUMN "recovery_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD COLUMN "second_factor_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."passkey_credentials" ADD COLUMN "user_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."passkey_credentials" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity"."backup_codes" ADD CONSTRAINT "backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."totp_credentials" ADD CONSTRAINT "totp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "second_factor_events_user_id_occurred_at_idx" ON "identity"."second_factor_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_kind_v2" CHECK ("identity"."sessions"."kind" in ('tenant', 'operator', 'enrolment', 'second_factor'));--> statement-breakpoint
ALTER TABLE "identity"."sessions" DROP CONSTRAINT "sessions_kind";--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_factor" CHECK ("identity"."sessions"."factor" is null or "identity"."sessions"."factor" in ('passkey_uv', 'otp_totp', 'otp_passkey', 'otp_backup_code'));--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_second_factor_attempts" CHECK ("identity"."sessions"."second_factor_attempts" >= 0 and "identity"."sessions"."second_factor_attempts" <= 5);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE identity.second_factor_events FROM identity;