import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  integer,
  text,
  timestamp,
  unique,
  uuid,
  type PgSchema,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

function tz(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" });
}

export function identityTables(identity: PgSchema) {
  const users = identity.table(
    "users",
    {
      id: uuid("id").primaryKey(),
      region: text("region").notNull(),
      email: bytea("email").notNull(),
      emailBidx: bytea("email_bidx").notNull(),
    },
    (t) => [
      unique("users_email_bidx_unique").on(t.emailBidx),
      check("users_region_au", sql`${t.region} = 'au'`),
    ],
  );

  const identityKeys = identity.table(
    "identity_keys",
    {
      id: uuid("id").primaryKey(),
      region: text("region").notNull(),
      wrapped: bytea("wrapped").notNull(),
      keyVersion: text("key_version").notNull(),
    },
    (t) => [
      unique("identity_keys_region_unique").on(t.region),
      check("identity_keys_region_au", sql`${t.region} = 'au'`),
    ],
  );

  const otpChallenges = identity.table(
    "otp_challenges",
    {
      id: uuid("id").primaryKey(),
      emailBidx: bytea("email_bidx").notNull(),
      codeHash: bytea("code_hash").notNull(),
      attempts: integer("attempts").notNull(),
      expiresAt: tz("expires_at").notNull(),
      consumedAt: tz("consumed_at"),
      purpose: text("purpose").notNull().default("sign_in"),
    },
    (t) => [
      check("otp_challenges_attempts", sql`${t.attempts} >= 0 and ${t.attempts} <= 5`),
      check("otp_challenges_purpose", sql`${t.purpose} in ('sign_in', 'operator_enrolment')`),
      index("otp_challenges_email_bidx_idx").on(t.emailBidx),
      index("otp_challenges_email_bidx_purpose_idx").on(t.emailBidx, t.purpose),
    ],
  );

  const passkeyCredentials = identity.table(
    "passkey_credentials",
    {
      id: uuid("id").primaryKey(),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id),
      credentialId: bytea("credential_id").notNull(),
      coseKey: bytea("cose_key").notNull(),
      signCount: bigint("sign_count", { mode: "number" }).notNull(),
      rpId: text("rp_id"),
    },
    (t) => [
      unique("passkey_credentials_credential_id_unique").on(t.credentialId),
      check("passkey_credentials_sign_count", sql`${t.signCount} >= 0`),
    ],
  );

  const passkeyChallenges = identity.table(
    "passkey_challenges",
    {
      id: uuid("id").primaryKey(),
      userId: uuid("user_id"),
      kind: text("kind").notNull(),
      challenge: bytea("challenge").notNull(),
      expiresAt: tz("expires_at").notNull(),
      consumedAt: tz("consumed_at"),
      rpId: text("rp_id"),
      userVerification: text("user_verification").notNull().default("preferred"),
    },
    (t) => [
      unique("passkey_challenges_challenge_unique").on(t.challenge),
      check("passkey_challenges_kind", sql`${t.kind} in ('register', 'authenticate')`),
      check(
        "passkey_challenges_user_verification",
        sql`${t.userVerification} in ('preferred', 'required')`,
      ),
    ],
  );

  const sessions = identity.table(
    "sessions",
    {
      id: uuid("id").primaryKey(),
      userId: uuid("user_id")
        .notNull()
        .references(() => users.id),
      refreshFamily: uuid("refresh_family").notNull(),
      accessHash: bytea("access_hash").notNull(),
      refreshHash: bytea("refresh_hash").notNull(),
      accessExpiresAt: tz("access_expires_at").notNull(),
      refreshExpiresAt: tz("refresh_expires_at").notNull(),
      replacedBy: uuid("replaced_by"),
      revokedAt: tz("revoked_at"),
      kind: text("kind").notNull().default("tenant"),
      absoluteExpiresAt: tz("absolute_expires_at"),
    },
    (t) => [
      unique("sessions_access_hash_unique").on(t.accessHash),
      unique("sessions_refresh_hash_unique").on(t.refreshHash),
      index("sessions_refresh_family_idx").on(t.refreshFamily),
      check("sessions_kind", sql`${t.kind} in ('tenant', 'operator', 'enrolment')`),
      check(
        "sessions_absolute_expiry",
        sql`(${t.kind} = 'operator') = (${t.absoluteExpiresAt} is not null)`,
      ),
    ],
  );

  return {
    users,
    identityKeys,
    otpChallenges,
    passkeyCredentials,
    passkeyChallenges,
    sessions,
  };
}
