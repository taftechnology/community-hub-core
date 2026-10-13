import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
});
