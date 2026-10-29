import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, withAppTransaction } from "@community-hub/db";
import { createPlaintextAppSql, createPlaintextDirectSql } from "@community-hub/db/plaintext";

import { createSyntheticScopes } from "../test/fixtures/scopes.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "identity" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

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

beforeAll(async () => {
  const runtime = loadRuntime();
  const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

describe("groups schema and privileges", () => {
  it("forces row level security on both tables (pin 1)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      for (const table of ["groups", "group_members"]) {
        const [rel] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
          select c.relrowsecurity, c.relforcerowsecurity
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relname = ${table}
        `;
        expect(rel, `${table} rls`).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("the app role cannot delete a group (pin 2)", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const scopes = createSyntheticScopes();
    try {
      await expect(
        withAppTransaction(appSql, scopes.orgA.community1, async (tx) => {
          await tx`delete from app.groups`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await appSql.end({ timeout: 1 });
    }
  });

  it("gives app select, insert and update on groups, but takes delete and truncate (pin 2)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      expect(await privilege(sql, "app", "groups", "SELECT")).toBe(true);
      expect(await privilege(sql, "app", "groups", "INSERT")).toBe(true);
      expect(await privilege(sql, "app", "groups", "UPDATE")).toBe(true);
      expect(await privilege(sql, "app", "groups", "DELETE")).toBe(false);
      expect(await privilege(sql, "app", "groups", "TRUNCATE")).toBe(false);

      expect(await privilege(sql, "app", "group_members", "SELECT")).toBe(true);
      expect(await privilege(sql, "app", "group_members", "INSERT")).toBe(true);
      expect(await privilege(sql, "app", "group_members", "UPDATE")).toBe(true);
      expect(await privilege(sql, "app", "group_members", "DELETE")).toBe(true);
      expect(await privilege(sql, "app", "group_members", "TRUNCATE")).toBe(false);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("identity and platform have no privileges on either table (pin 2)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      for (const table of ["groups", "group_members"]) {
        for (const role of ["identity", "platform"] as const) {
          for (const kind of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const) {
            expect(await privilege(sql, role, table, kind), `${role} on ${table} ${kind}`).toBe(
              false,
            );
          }
        }
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
