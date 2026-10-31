import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations } from "@community-hub/db";
import { createPlaintextDirectSql } from "@community-hub/db/plaintext";

type Runtime = {
  productOnlyUrl: string;
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

beforeAll(async () => {
  const runtime = loadRuntime();
  const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

const PEOPLE_TABLES = [
  "organisation_keys",
  "community_keys",
  "household_keys",
  "households",
  "persons",
  "guardian_links",
  "person_tags",
  "person_tag_links",
  "person_activity",
] as const;

const DELETABLE = new Set(["guardian_links", "person_tag_links"]);
const UPDATABLE = new Set<string>();

type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE";

async function privilege(
  sql: ReturnType<typeof createPlaintextDirectSql>,
  role: "app" | "identity" | "platform",
  table: string,
  kind: Privilege,
): Promise<boolean> {
  const rows = await sql<{ granted: boolean }[]>`
    select has_table_privilege(${role}, ${`app.${table}`}, ${kind}) as granted
  `;
  return rows[0]?.granted ?? false;
}

describe("people table privileges", () => {
  it("gives app select and insert on every people table", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const granted: Record<string, boolean> = {};
      for (const table of PEOPLE_TABLES) {
        granted[`${table} select`] = await privilege(sql, "app", table, "SELECT");
        granted[`${table} insert`] = await privilege(sql, "app", table, "INSERT");
      }
      expect(granted).toEqual(
        Object.fromEntries(
          PEOPLE_TABLES.flatMap((table) => [
            [`${table} select`, true],
            [`${table} insert`, true],
          ]),
        ),
      );
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("takes update and truncate from app everywhere, and delete except on the two link tables", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const granted: Record<string, boolean> = {};
      for (const table of PEOPLE_TABLES) {
        for (const kind of ["UPDATE", "DELETE", "TRUNCATE"] as const) {
          granted[`${table} ${kind.toLowerCase()}`] = await privilege(sql, "app", table, kind);
        }
      }
      expect(granted).toEqual(
        Object.fromEntries(
          PEOPLE_TABLES.flatMap((table) => [
            [`${table} update`, UPDATABLE.has(table)],
            [`${table} delete`, DELETABLE.has(table)],
            [`${table} truncate`, false],
          ]),
        ),
      );
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("gives identity and platform no select on any people table", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const granted: Record<string, boolean> = {};
      for (const role of ["identity", "platform"] as const) {
        for (const table of PEOPLE_TABLES) {
          granted[`${role} ${table}`] = await privilege(sql, role, table, "SELECT");
        }
      }
      expect(granted).toEqual(
        Object.fromEntries(
          (["identity", "platform"] as const).flatMap((role) =>
            PEOPLE_TABLES.map((table) => [`${role} ${table}`, false]),
          ),
        ),
      );
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("grants app update on app.persons only by column for allowed columns (Deviation 3)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const allowedColumns = [
        "given_name",
        "family_name",
        "email",
        "email_bidx",
        "phone",
        "phone_bidx",
        "date_of_birth",
        "birthday_md",
        "age_basis",
        "version",
      ] as const;
      const forbiddenColumns = [
        "is_minor",
        "household_id",
        "org_id",
        "community_id",
        "given_name_restricted",
        "family_name_restricted",
      ] as const;

      for (const col of allowedColumns) {
        const [row] = await sql<{ granted: boolean }[]>`
          select has_column_privilege('app', 'app.persons', ${col}, 'UPDATE') as granted
        `;
        expect(row?.granted, `expected column ${col} to be updatable by app`).toBe(true);
      }

      for (const col of forbiddenColumns) {
        const [row] = await sql<{ granted: boolean }[]>`
          select has_column_privilege('app', 'app.persons', ${col}, 'UPDATE') as granted
        `;
        expect(row?.granted, `expected column ${col} NOT to be updatable by app`).toBe(false);
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("enforces RLS and FORCE ROW LEVEL SECURITY on persons with no DELETE for app", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const canDelete = await privilege(sql, "app", "persons", "DELETE");
      expect(canDelete).toBe(false);

      const [rel] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'persons'
      `;
      expect(rel).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
