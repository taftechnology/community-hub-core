import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { catalogue } from "@community-hub/policy";
import { applyProductMigrations } from "@community-hub/db";
import { createPlaintextDirectSql } from "@community-hub/db/plaintext";

const DRIZZLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle",
);

const TABLES = [
  "organisation_role_grants",
  "community_role_grants",
  "custom_roles",
  "custom_role_permissions",
  "user_links",
] as const;

const CATALOGUE = [
  "access.users.view",
  "access.users.manage",
  "access.roles.view",
  "access.roles.manage",
  "people.restricted.read",
] as const;

function accessSql(): string {
  const files = readdirSync(DRIZZLE).filter((name) => name.endsWith(".sql"));
  const matches = files.filter((name) => {
    const text = readFileSync(path.join(DRIZZLE, name), "utf8");
    return text.includes('"app"."user_links"');
  });
  expect(matches).toHaveLength(1);
  return readFileSync(path.join(DRIZZLE, matches[0] ?? ""), "utf8");
}

function createBody(sql: string, table: string): string {
  const marker = `CREATE TABLE "app"."${table}"`;
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

function statements(sql: string): string[] {
  return sql.split("--> statement-breakpoint").map((statement) => statement.replace(/\s+/g, " "));
}

function clause(statement: string, kind: "USING" | "WITH CHECK"): string {
  const marker = ` ${kind} `;
  const start = statement.indexOf(marker);
  expect(start, kind).toBeGreaterThanOrEqual(0);
  const open = statement.indexOf("(", start);
  let depth = 0;
  for (let i = open; i < statement.length; i += 1) {
    if (statement[i] === "(") {
      depth += 1;
    } else if (statement[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return statement.slice(open, i + 1);
      }
    }
  }
  throw new Error(`unclosed ${kind}`);
}

beforeAll(async () => {
  const runtime = JSON.parse(
    readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../../packages/db/test/.runtime.json",
      ),
      "utf8",
    ),
  ) as { productOnlyUrl: string };
  const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(sql);
  } finally {
    await sql.end({ timeout: 1 });
  }
});

describe("access grant tables", () => {
  it("forces row level security and keeps organisation grants free of community_id", () => {
    const sql = accessSql();
    for (const table of TABLES) {
      expect(sql).toContain(`CREATE TABLE "app"."${table}"`);
      expect(sql).toContain(`REVOKE UPDATE, TRUNCATE ON TABLE app.${table} FROM app`);
    }
    expect(sql.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(TABLES.length);
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(TABLES.length);
    expect(createBody(sql, "organisation_role_grants")).not.toContain("community_id");
    for (const table of TABLES) {
      if (table === "organisation_role_grants") {
        continue;
      }
      expect(createBody(sql, table), table).toContain("community_id");
    }

    const policies = statements(sql).filter((statement) => statement.includes("CREATE POLICY"));
    const userLinks = policies.filter((statement) => statement.includes('"app"."user_links"'));
    expect(userLinks).toHaveLength(1);
    expect(userLinks[0]).toContain("app.community_id");
    const organisation = policies.filter((statement) =>
      statement.includes('"app"."organisation_role_grants"'),
    );
    expect(organisation).toHaveLength(1);
    expect(organisation[0]).toContain("app.org_id");
    expect(organisation[0]).not.toContain("app.community_id");

    expect(sql).not.toContain("ON DELETE CASCADE");
    expect(sql).not.toContain("DEFAULT");

    const uniqueTargets = [
      ...sql.matchAll(/UNIQUE\(([^)]+)\)/g),
      ...sql.matchAll(/CREATE UNIQUE INDEX \S+ ON \S+ USING btree \(([^)]+)\)/g),
    ].map((match) => match[1] ?? "");
    expect(uniqueTargets.length).toBeGreaterThan(0);
    for (const target of uniqueTargets) {
      expect(target.replaceAll('"', "").split(",")[0]?.trim(), target).toBe("org_id");
    }

    const orgPredicate = `("app"."organisation_role_grants"."org_id" = current_setting('app.org_id')::uuid)`;
    function communityPredicate(table: string): string {
      return `("app"."${table}"."org_id" = current_setting('app.org_id')::uuid and "app"."${table}"."community_id" = current_setting('app.community_id')::uuid)`;
    }
    for (const statement of policies) {
      const using = clause(statement, "USING");
      const check = clause(statement, "WITH CHECK");
      expect(check).toBe(using);
      if (statement.includes('"app"."organisation_role_grants"')) {
        expect(using).toBe(orgPredicate);
      } else {
        const table = TABLES.find((name) => statement.includes(`"app"."${name}"`));
        expect(table).toBeDefined();
        expect(using).toBe(communityPredicate(table ?? ""));
      }
    }

    const oneTarget = `CONSTRAINT "community_role_grants_one_target" CHECK (("app"."community_role_grants"."role_key" is null) <> ("app"."community_role_grants"."custom_role_id" is null))`;
    expect(createBody(sql, "community_role_grants")).toContain(oneTarget);
    const personFk = `ALTER TABLE "app"."user_links" ADD CONSTRAINT "user_links_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "app"."persons"("org_id","id") ON DELETE restrict ON UPDATE no action NOT VALID`;
    expect(
      statements(sql).some((statement) => statement.trim().replace(/;$/, "") === personFk),
    ).toBe(true);

    const permissionCheck = statements(sql).filter((statement) =>
      statement.includes("custom_role_permissions_permission"),
    );
    expect(permissionCheck).toHaveLength(1);
    for (const permission of CATALOGUE) {
      expect(permissionCheck[0], permission).toContain(permission);
    }
  });

  it("widens the custom_role_permissions CHECK for entitlements permissions", () => {
    const files = readdirSync(DRIZZLE).filter(
      (name) => name.startsWith("0008_") && name.endsWith(".sql"),
    );
    expect(files).toHaveLength(1);
    const sql = readFileSync(path.join(DRIZZLE, files[0] ?? ""), "utf8");
    expect(sql).toContain("custom_role_permissions_permission");
    expect(sql).toContain("entitlements.view");
    expect(sql).toContain("entitlements.manage");
  });

  it("widens the custom_role_permissions CHECK for people permissions in 0015", () => {
    const files = readdirSync(DRIZZLE).filter(
      (name) => name.startsWith("0015_") && name.endsWith(".sql"),
    );
    expect(files).toHaveLength(1);
    const sql = readFileSync(path.join(DRIZZLE, files[0] ?? ""), "utf8");
    expect(sql).toContain("custom_role_permissions_permission");
    expect(sql).toContain("people.view");
    expect(sql).toContain("people.manage");
  });

  it("widens the custom_role_permissions CHECK for service_times permissions in 0018", () => {
    const files = readdirSync(DRIZZLE).filter(
      (name) => name.startsWith("0018_") && name.endsWith(".sql"),
    );
    expect(files).toHaveLength(1);
    const sql = readFileSync(path.join(DRIZZLE, files[0] ?? ""), "utf8");
    expect(sql).toContain("custom_role_permissions_permission");
    expect(sql).toContain("service_times.manage");
  });

  it("pins that the schema custom_role_permissions CHECK list matches the policy catalogue (pin 14)", () => {
    const schemaSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schema.ts"),
      "utf8",
    );
    const match = schemaSource.match(
      /custom_role_permissions_permission["'],\s*sql`\$\{t\.permission\}\s+in\s*\(([^)]+)\)`/,
    );
    expect(match).not.toBeNull();
    const permissionsInCheck = [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(permissionsInCheck).toHaveLength(10);
    expect(permissionsInCheck).toContain("service_times.manage");
    expect(new Set(permissionsInCheck)).toEqual(new Set(catalogue()));
  });

  it("custom_role_permissions CHECK allows service_times.manage and rejects a bogus permission on the live database", async () => {
    const runtime = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../../../packages/db/test/.runtime.json",
        ),
        "utf8",
      ),
    ) as { productOnlyUrl: string };
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const orgId = "11111111-1111-4111-8111-111111111111";
    const communityId = "22222222-2222-4222-8222-222222222222";
    const customRoleId = "33333333-3333-4333-8333-333333333333";
    try {
      await sql`insert into app.custom_roles (id, org_id, community_id, key) values (${customRoleId}, ${orgId}, ${communityId}, 'service_role') on conflict do nothing`;

      await sql`insert into app.custom_role_permissions (org_id, community_id, custom_role_id, permission) values (${orgId}, ${communityId}, ${customRoleId}, 'service_times.manage')`;

      await expect(
        sql`insert into app.custom_role_permissions (org_id, community_id, custom_role_id, permission) values (${orgId}, ${communityId}, ${customRoleId}, 'bogus.permission')`,
      ).rejects.toThrow();
    } finally {
      await sql`delete from app.custom_role_permissions where custom_role_id = ${customRoleId}`.catch(
        () => {},
      );
      await sql`delete from app.custom_roles where id = ${customRoleId}`.catch(() => {});
      await sql.end({ timeout: 1 });
    }
  });

  it("creates organisation_members and invitations with RLS, FORCE RLS, symmetric policies and unique keys starting with org_id (pin 6)", () => {
    const files = readdirSync(DRIZZLE).filter(
      (name) => name.startsWith("0019_") && name.endsWith(".sql"),
    );
    expect(files).toHaveLength(1);
    const sql = readFileSync(path.join(DRIZZLE, files[0] ?? ""), "utf8");

    expect(sql).toContain('CREATE TABLE "app"."organisation_members"');
    expect(sql).toContain('CREATE TABLE "app"."invitations"');

    expect(sql).toMatch(
      /ALTER TABLE (?:app|"app")\.(?:organisation_members|"organisation_members") FORCE ROW LEVEL SECURITY/,
    );
    expect(sql).toMatch(
      /ALTER TABLE (?:app|"app")\.(?:invitations|"invitations") FORCE ROW LEVEL SECURITY/,
    );

    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).toContain(
      '"invitations_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "app"."persons"("org_id","id") ON DELETE restrict',
    );
    expect(sql).toContain(
      '"invitations_custom_role_fk" FOREIGN KEY ("org_id","custom_role_id") REFERENCES "app"."custom_roles"("org_id","id") ON DELETE restrict',
    );

    const appSql = [createBody(sql, "organisation_members"), createBody(sql, "invitations")].join(
      "\n",
    );
    const uniqueTargets = [
      ...appSql.matchAll(/PRIMARY KEY\s*\(([^)]+)\)/g),
      ...appSql.matchAll(/UNIQUE\s*\(([^)]+)\)/g),
      ...sql.matchAll(/CREATE UNIQUE INDEX \S+ ON (?:app|"app")\.\S+ USING btree \(([^)]+)\)/g),
    ].map((match) => match[1] ?? "");
    expect(uniqueTargets.length).toBeGreaterThan(0);
    for (const target of uniqueTargets) {
      expect(target.replaceAll('"', "").split(",")[0]?.trim(), target).toBe("org_id");
    }

    const policies = statements(sql).filter((statement) => statement.includes("CREATE POLICY"));
    const orgMembersPolicy = policies.filter((statement) =>
      statement.includes('"app"."organisation_members"'),
    );
    expect(orgMembersPolicy).toHaveLength(1);
    const orgPolicyUsing = clause(orgMembersPolicy[0] ?? "", "USING");
    const orgPolicyCheck = clause(orgMembersPolicy[0] ?? "", "WITH CHECK");
    expect(orgPolicyCheck).toBe(orgPolicyUsing);
    expect(orgPolicyUsing).toBe(
      `("app"."organisation_members"."org_id" = current_setting('app.org_id')::uuid)`,
    );

    const invitationsPolicy = policies.filter((statement) =>
      statement.includes('"app"."invitations"'),
    );
    expect(invitationsPolicy).toHaveLength(1);
    const invPolicyUsing = clause(invitationsPolicy[0] ?? "", "USING");
    const invPolicyCheck = clause(invitationsPolicy[0] ?? "", "WITH CHECK");
    expect(invPolicyCheck).toBe(invPolicyUsing);
    expect(invPolicyUsing).toBe(
      `("app"."invitations"."org_id" = current_setting('app.org_id')::uuid and "app"."invitations"."community_id" = current_setting('app.community_id')::uuid)`,
    );
  });
});
