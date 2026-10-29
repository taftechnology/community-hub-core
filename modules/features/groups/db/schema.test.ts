import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { pgSchema, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { groupsTables } from "./schema.js";

const DRIZZLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle",
);

const SCHEMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "schema.ts");

function groupsMigrationSql(): string {
  const files = readdirSync(DRIZZLE).filter((name) => name.endsWith(".sql"));
  const matches = files.filter((name) => {
    const text = readFileSync(path.join(DRIZZLE, name), "utf8");
    return text.includes('CREATE TABLE "app"."groups"');
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

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function policyStatements(sql: string, table: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => normalise(statement))
    .filter(
      (statement) =>
        statement.startsWith(`CREATE POLICY `) && statement.includes(` ON "app"."${table}" `),
    );
}

const DB_PACKAGE_NAME = "@community-hub/" + "db";

export function hasDbImportOrExport(
  source: string,
  packageName: string = DB_PACKAGE_NAME,
): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b(?:import|export)\\s+(?!type\\b)(?:(?!\\bfrom\\b)[^;'"])*?\\bfrom\\s+['"]${escaped}(?:\\/[^'"]*)?['"]|\\bimport\\s+['"]${escaped}(?:\\/[^'"]*)?['"]`,
    "m",
  );
  return pattern.test(source);
}

describe("groups schema", () => {
  const dummyPersonsTable = pgSchema("app").table("dummy_persons", {
    orgId: uuid("org_id").notNull(),
    id: uuid("id").notNull(),
  });
  const dummyPersons = {
    orgId: dummyPersonsTable.orgId,
    id: dummyPersonsTable.id,
  };

  it("has exact column list for groups and group_members with no contact or minor names (pin 7)", () => {
    const tables = groupsTables(pgSchema("app"), { persons: dummyPersons });
    const groupsCols = Object.values(getTableColumns(tables.groups)).map((c) => c.name);
    expect(groupsCols).toEqual([
      "org_id",
      "community_id",
      "id",
      "name",
      "name_key",
      "description",
      "kind",
      "status",
      "created_at",
      "updated_at",
    ]);

    const memberCols = Object.values(getTableColumns(tables.groupMembers)).map((c) => c.name);
    expect(memberCols).toEqual([
      "org_id",
      "community_id",
      "group_id",
      "person_id",
      "role",
      "added_at",
    ]);
    expect(memberCols).not.toContain("name");
    expect(memberCols).not.toContain("given_name");
    expect(memberCols).not.toContain("family_name");
    expect(memberCols).not.toContain("email");
    expect(memberCols).not.toContain("phone");
    expect(memberCols).not.toContain("date_of_birth");

    const sql = groupsMigrationSql();
    const groupsBody = createBody(sql, "groups");
    const sqlGroupsCols = groupsBody
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"') && !line.startsWith("CONSTRAINT"))
      .map((line) => line.match(/^"([^"]+)"/)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(sqlGroupsCols).toEqual(groupsCols);

    const membersBody = createBody(sql, "group_members");
    const sqlMemberCols = membersBody
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"') && !line.startsWith("CONSTRAINT"))
      .map((line) => line.match(/^"([^"]+)"/)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(sqlMemberCols).toEqual(memberCols);
  });

  it("pins the keys and key column order starting with org_id (pin 7)", () => {
    const sql = groupsMigrationSql();

    // Primary keys start with org_id
    expect(sql).toContain('CONSTRAINT "groups_org_id_id_pk" PRIMARY KEY("org_id","id")');
    expect(sql).toContain(
      'CONSTRAINT "group_members_org_id_group_id_person_id_pk" PRIMARY KEY("org_id","group_id","person_id")',
    );

    // Partial unique index on (org_id, community_id, name_key) where status = 'active'
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "groups_active_name_key_unique" ON "app"\."groups" USING btree \("org_id","community_id","name_key"\) WHERE "app"\."groups"\."status" = 'active';/i,
    );

    // Both foreign keys start with org_id and are ON DELETE RESTRICT
    expect(sql).toContain(
      'ALTER TABLE "app"."group_members" ADD CONSTRAINT "group_members_group_fk" FOREIGN KEY ("org_id","group_id") REFERENCES "app"."groups"("org_id","id") ON DELETE restrict ON UPDATE no action;',
    );
    expect(sql).toContain(
      'ALTER TABLE "app"."group_members" ADD CONSTRAINT "group_members_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "app"."persons"("org_id","id") ON DELETE restrict ON UPDATE no action NOT VALID;',
    );
  });

  it("pins the CHECK constraints", () => {
    const sql = groupsMigrationSql();
    expect(sql).toContain(
      'CONSTRAINT "groups_name_len" CHECK (char_length("app"."groups"."name") between 1 and 120)',
    );
    expect(sql).toContain(
      'CONSTRAINT "groups_description_len" CHECK ("app"."groups"."description" is null or char_length("app"."groups"."description") <= 2000)',
    );
    expect(sql).toContain(
      'CONSTRAINT "groups_kind" CHECK ("app"."groups"."kind" in (\'ministry\', \'group\'))',
    );
    expect(sql).toContain(
      'CONSTRAINT "groups_status" CHECK ("app"."groups"."status" in (\'active\', \'archived\'))',
    );
    expect(sql).toContain(
      'CONSTRAINT "group_members_role" CHECK ("app"."group_members"."role" in (\'leader\', \'member\'))',
    );
  });

  it("pins the policy text (pin 6)", () => {
    const sql = groupsMigrationSql();

    for (const table of ["groups", "group_members"] as const) {
      const statements = policyStatements(sql, table);
      expect(statements).toHaveLength(1);
      const match = (statements[0] ?? "").match(
        new RegExp(
          `^CREATE POLICY "community_isolation" ON "app"\\."${table}" AS PERMISSIVE FOR ALL TO public USING \\((.*?)\\) WITH CHECK \\((.*)\\);?$`,
        ),
      );
      expect(match, `${table} policy shape`).not.toBeNull();
      const expected = `"app"."${table}"."org_id" = current_setting('app.org_id')::uuid and "app"."${table}"."community_id" = current_setting('app.community_id')::uuid`;
      expect(match?.[1], `${table} USING`).toBe(expected);
      expect(match?.[2], `${table} WITH CHECK`).toBe(expected);
      expect(match?.[1]).toBe(match?.[2]);
    }
  });

  it("forces row level security and revokes DELETE from groups and TRUNCATE from both", () => {
    const sql = groupsMigrationSql();
    expect(sql).toContain('ALTER TABLE "app"."groups" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "app"."group_members" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain("ALTER TABLE app.groups FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE app.group_members FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE TRUNCATE ON app.groups, app.group_members FROM app");
    expect(sql).toContain("REVOKE DELETE ON app.groups FROM app");
  });

  it("has no pgSchema and no db import in the schema source (pin 27)", () => {
    const text = readFileSync(SCHEMA, "utf8");
    expect(text).not.toContain("pgSchema(");
    expect(hasDbImportOrExport(text)).toBe(false);
  });

  it("pin 27 matcher catches multiline imports, side-effects, exports, and deep paths", () => {
    const pkg = "@community-hub/" + "db";
    const fixturesToCatch = [
      `import {\n  x\n} from "${pkg}"`,
      `import "${pkg}"`,
      `import "${pkg}/deep/path"`,
      `export { x } from "${pkg}"`,
      `export * from "${pkg}"`,
      `export { x } from "${pkg}/deep"`,
      `export * from "${pkg}/deep"`,
      `export {\n  x\n} from "${pkg}"`,
      `import x from "${pkg}"`,
      `import x from "${pkg}/sub"`,
    ];

    for (const fixture of fixturesToCatch) {
      expect(hasDbImportOrExport(fixture), `should catch: ${fixture.replace(/\n/g, "\\n")}`).toBe(
        true,
      );
    }

    const fixturesToAllow = [
      `import type { X } from "${pkg}"`,
      `import type { X } from "${pkg}/sub"`,
      `export type { X } from "${pkg}"`,
      `import { sql } from "drizzle-orm";`,
    ];

    for (const fixture of fixturesToAllow) {
      expect(hasDbImportOrExport(fixture), `should allow: ${fixture.replace(/\n/g, "\\n")}`).toBe(
        false,
      );
    }
  });
});
