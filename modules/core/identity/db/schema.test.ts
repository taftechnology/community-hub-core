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
});
