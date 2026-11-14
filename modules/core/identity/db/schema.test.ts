import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DRIZZLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle",
);

function identitySql(): string {
  const files = readdirSync(DRIZZLE).filter((name) => name.endsWith(".sql"));
  const matches = files.filter((name) => {
    const text = readFileSync(path.join(DRIZZLE, name), "utf8");
    return text.includes('CREATE TABLE "identity"."users"');
  });
  expect(matches).toHaveLength(1);
  return readFileSync(path.join(DRIZZLE, matches[0] ?? ""), "utf8");
}

function migration0011Sql(): string {
  const files = readdirSync(DRIZZLE).filter(
    (name) => name.startsWith("0011_") && name.endsWith(".sql"),
  );
  expect(files).toHaveLength(1);
  return readFileSync(path.join(DRIZZLE, files[0] ?? ""), "utf8");
}

function migration0012Sql(): string {
  const files = readdirSync(DRIZZLE).filter(
    (name) => name.startsWith("0012_") && name.endsWith(".sql"),
  );
  expect(files).toHaveLength(1);
  return readFileSync(path.join(DRIZZLE, files[0] ?? ""), "utf8");
}

function migration0019Sql(): string {
  const files = readdirSync(DRIZZLE).filter(
    (name) => name.startsWith("0019_") && name.endsWith(".sql"),
  );
  expect(files).toHaveLength(1);
  return readFileSync(path.join(DRIZZLE, files[0] ?? ""), "utf8");
}

function createTableBody(sql: string, schema: string, table: string): string {
  const marker = `CREATE TABLE "${schema}"."${table}"`;
  const start = sql.indexOf(marker);
  expect(start, table).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("(", start);
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === "(") {
      depth += 1;
    } else if (sql[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return sql.slice(open + 1, i);
      }
    }
  }
  throw new Error(`unclosed create table ${table}`);
}

describe("identity tables", () => {
  it("creates the six tables without org_id or row level security", () => {
    const sql = identitySql();
    for (const table of [
      "users",
      "identity_keys",
      "otp_challenges",
      "passkey_credentials",
      "passkey_challenges",
      "sessions",
    ]) {
      expect(sql).toContain(`CREATE TABLE "identity"."${table}"`);
    }
    expect(sql).toContain("email_bidx");
    expect(sql).toContain("code_hash");
    expect(sql).toContain("cose_key");
    expect(sql).toContain("sign_count");
    expect(sql).toContain("access_hash");
    expect(sql).toContain("refresh_hash");
    expect(sql).toContain("refresh_family");
    expect(sql).toContain("replaced_by");
    expect(sql).toContain("'au'");
    expect(sql).toContain("'register'");
    expect(sql).toContain("'authenticate'");
    expect(sql).not.toMatch(/\borg_id\b/);
    expect(sql).not.toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).not.toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).not.toContain("ON DELETE CASCADE");
    expect(sql).not.toContain("DEFAULT");
    expect(sql).toContain(
      'CREATE INDEX "otp_challenges_email_bidx_idx" ON "identity"."otp_challenges" USING btree ("email_bidx")',
    );
    expect(sql).toContain(
      'CREATE INDEX "sessions_refresh_family_idx" ON "identity"."sessions" USING btree ("refresh_family")',
    );
    expect(sql).not.toContain("CREATE UNIQUE INDEX");
  });

  describe("migration 0011", () => {
    it("contains each column, check and index for operator identity primitives", () => {
      const sql = migration0011Sql();

      // Columns
      expect(sql).toContain('"kind"');
      expect(sql).toContain('"absolute_expires_at"');
      expect(sql).toContain('"purpose"');
      expect(sql).toContain('"rp_id"');
      expect(sql).toContain('"user_verification"');

      // Checks
      expect(sql).toContain("sessions_kind");
      expect(sql).toContain("sessions_absolute_expiry");
      expect(sql).toContain("otp_challenges_purpose");
      expect(sql).toContain("passkey_challenges_user_verification");

      // Index
      expect(sql).toContain("otp_challenges_email_bidx_purpose_idx");

      // Prohibited operations
      expect(sql).not.toMatch(/\bDROP\b/i);
      expect(sql).not.toMatch(/\bGRANT\b/i);
      expect(sql).not.toMatch(/\bREVOKE\b/i);
      expect(sql).not.toMatch(/ALTER\s+COLUMN\b.*?\bTYPE\b/i);
    });
  });

  describe("migration 0012", () => {
    it("contains each column, check, index and revokes for operator tables", () => {
      const sql = migration0012Sql();

      // Tables
      expect(sql).toContain('CREATE TABLE "identity"."operator_grants"');
      expect(sql).toContain('CREATE TABLE "identity"."operator_events"');

      // operator_grants columns
      expect(sql).toContain('"id" uuid');
      expect(sql).toContain('"user_id" uuid');
      expect(sql).toContain('"role_key" text');
      expect(sql).toContain('"enrolment_code_hash" "bytea"');
      expect(sql).toContain('"granted_at" timestamp with time zone');
      expect(sql).toContain('"enrolment_expires_at" timestamp with time zone');
      expect(sql).toContain('"activated_at" timestamp with time zone');
      expect(sql).toContain('"revoked_at" timestamp with time zone');

      // operator_events columns
      expect(sql).toContain('"action" text');
      expect(sql).toContain('"request_id" text');
      expect(sql).toContain('"occurred_at" timestamp with time zone');

      // Checks
      expect(sql).toContain("operator_grants_role_key");
      expect(sql).toContain("operator_events_action");
      expect(sql).toContain("operator_events_role_key");

      // Indexes
      expect(sql).toContain("operator_grants_user_role_live");
      expect(sql).toContain("operator_grants_user_id_idx");

      // Revokes
      expect(sql).toContain(
        "REVOKE UPDATE, DELETE, TRUNCATE ON TABLE identity.operator_events FROM identity;",
      );
      expect(sql).toContain(
        "REVOKE DELETE, TRUNCATE ON TABLE identity.operator_grants FROM identity;",
      );

      // Prohibited operations
      expect(sql).not.toMatch(/\bDROP\b/i);
      expect(sql).not.toMatch(/\bGRANT\b/i);
      expect(sql).not.toMatch(/ALTER TABLE (?!("identity"\.)?"operator_)/i);
      expect(sql).not.toMatch(/\borg_id\b/i);
      expect(sql).not.toContain("ROW LEVEL SECURITY");
    });
  });

  describe("migration 0019", () => {
    it("contains identity.invitation_emails with its columns, checks, unique index and privileges", () => {
      const sql = migration0019Sql();

      // Table
      expect(sql).toContain('CREATE TABLE "identity"."invitation_emails"');
      const body = createTableBody(sql, "identity", "invitation_emails");
      expect(body).not.toMatch(/\borg_id\b/);

      // Columns
      expect(body).toContain('"invitation_id" uuid PRIMARY KEY NOT NULL');
      expect(body).toContain('"region" text NOT NULL');
      expect(body).toContain('"email" "bytea"');
      expect(body).toContain('"email_bidx" "bytea"');
      expect(body).toContain('"dedupe_key" "bytea"');
      expect(body).toContain('"expires_at" timestamp with time zone NOT NULL');
      expect(body).toContain('"closed_at" timestamp with time zone');
      expect(body).toContain('"created_at" timestamp with time zone NOT NULL');

      // Checks
      expect(body).toContain("invitation_emails_region_au");
      expect(body).toContain("invitation_emails_payload_set");
      expect(body).toContain("invitation_emails_email_bidx_len");
      expect(body).toContain("invitation_emails_dedupe_key_len");

      // Unique index on dedupe_key
      expect(sql).toContain(
        'CREATE UNIQUE INDEX "invitation_emails_dedupe_key_unique" ON "identity"."invitation_emails" USING btree ("dedupe_key")',
      );

      // Privileges
      expect(sql).toContain("REVOKE UPDATE, TRUNCATE ON identity.invitation_emails FROM identity;");
      expect(sql).toContain(
        "GRANT UPDATE (email, email_bidx, dedupe_key, expires_at, closed_at) ON identity.invitation_emails TO identity;",
      );
      expect(sql).toContain("REVOKE ALL ON identity.invitation_emails FROM app, platform;");
    });
  });
});
