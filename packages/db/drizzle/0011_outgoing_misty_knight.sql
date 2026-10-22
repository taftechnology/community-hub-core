ALTER TABLE "identity"."sessions" ADD COLUMN "kind" text DEFAULT 'tenant' NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD COLUMN "absolute_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity"."otp_challenges" ADD COLUMN "purpose" text DEFAULT 'sign_in' NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."passkey_challenges" ADD COLUMN "rp_id" text;--> statement-breakpoint
ALTER TABLE "identity"."passkey_challenges" ADD COLUMN "user_verification" text DEFAULT 'preferred' NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."passkey_credentials" ADD COLUMN "rp_id" text;--> statement-breakpoint
CREATE INDEX "otp_challenges_email_bidx_purpose_idx" ON "identity"."otp_challenges" USING btree ("email_bidx","purpose");--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_kind" CHECK ("identity"."sessions"."kind" in ('tenant', 'operator', 'enrolment'));--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_absolute_expiry" CHECK (("identity"."sessions"."kind" = 'operator') = ("identity"."sessions"."absolute_expires_at" is not null));--> statement-breakpoint
ALTER TABLE "identity"."otp_challenges" ADD CONSTRAINT "otp_challenges_purpose" CHECK ("identity"."otp_challenges"."purpose" in ('sign_in', 'operator_enrolment'));--> statement-breakpoint
ALTER TABLE "identity"."passkey_challenges" ADD CONSTRAINT "passkey_challenges_user_verification" CHECK ("identity"."passkey_challenges"."user_verification" in ('preferred', 'required'));