CREATE TABLE "identity"."identity_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"wrapped" "bytea" NOT NULL,
	"key_version" text NOT NULL,
	CONSTRAINT "identity_keys_region_unique" UNIQUE("region"),
	CONSTRAINT "identity_keys_region_au" CHECK ("identity"."identity_keys"."region" = 'au')
);
--> statement-breakpoint
CREATE TABLE "identity"."sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_family" uuid NOT NULL,
	"access_hash" "bytea" NOT NULL,
	"refresh_hash" "bytea" NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"replaced_by" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_access_hash_unique" UNIQUE("access_hash"),
	CONSTRAINT "sessions_refresh_hash_unique" UNIQUE("refresh_hash")
);
--> statement-breakpoint
CREATE TABLE "identity"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"email" "bytea" NOT NULL,
	"email_bidx" "bytea" NOT NULL,
	CONSTRAINT "users_email_bidx_unique" UNIQUE("email_bidx"),
	CONSTRAINT "users_region_au" CHECK ("identity"."users"."region" = 'au')
);
--> statement-breakpoint
CREATE TABLE "identity"."otp_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email_bidx" "bytea" NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "otp_challenges_attempts" CHECK ("identity"."otp_challenges"."attempts" >= 0 and "identity"."otp_challenges"."attempts" <= 5)
);
--> statement-breakpoint
CREATE TABLE "identity"."passkey_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"challenge" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "passkey_challenges_challenge_unique" UNIQUE("challenge"),
	CONSTRAINT "passkey_challenges_kind" CHECK ("identity"."passkey_challenges"."kind" in ('register', 'authenticate'))
);
--> statement-breakpoint
CREATE TABLE "identity"."passkey_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" "bytea" NOT NULL,
	"cose_key" "bytea" NOT NULL,
	"sign_count" bigint NOT NULL,
	CONSTRAINT "passkey_credentials_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "passkey_credentials_sign_count" CHECK ("identity"."passkey_credentials"."sign_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."passkey_credentials" ADD CONSTRAINT "passkey_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_refresh_family_idx" ON "identity"."sessions" USING btree ("refresh_family");--> statement-breakpoint
CREATE INDEX "otp_challenges_email_bidx_idx" ON "identity"."otp_challenges" USING btree ("email_bidx");