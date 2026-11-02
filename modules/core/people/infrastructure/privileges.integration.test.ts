import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { createHousehold, createPerson } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-11-01T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
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
  "life_events",
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
        "household_id",
      ] as const;
      const forbiddenColumns = [
        "id",
        "is_minor",
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

      const updatableRows = await sql<{ attname: string }[]>`
        select attname
        from pg_attribute
        where attrelid = 'app.persons'::regclass
          and attnum > 0
          and not attisdropped
          and has_column_privilege('app', 'app.persons', attname, 'UPDATE')
        order by attname
      `;
      const updatableColumns = updatableRows.map((r) => r.attname);
      expect(updatableColumns).toEqual([...allowedColumns].sort());
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("grants app update on app.households only by column for label and version (Pin 2)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const allowedColumns = ["label", "version"] as const;
      const forbiddenColumns = ["id", "org_id", "community_id"] as const;

      for (const col of allowedColumns) {
        const [row] = await sql<{ granted: boolean }[]>`
          select has_column_privilege('app', 'app.households', ${col}, 'UPDATE') as granted
        `;
        expect(row?.granted, `expected column households.${col} to be updatable by app`).toBe(true);
      }

      for (const col of forbiddenColumns) {
        const [row] = await sql<{ granted: boolean }[]>`
          select has_column_privilege('app', 'app.households', ${col}, 'UPDATE') as granted
        `;
        expect(row?.granted, `expected column households.${col} NOT to be updatable by app`).toBe(
          false,
        );
      }

      const updatableRows = await sql<{ attname: string }[]>`
        select attname
        from pg_attribute
        where attrelid = 'app.households'::regclass
          and attnum > 0
          and not attisdropped
          and has_column_privilege('app', 'app.households', attname, 'UPDATE')
        order by attname
      `;
      const updatableColumns = updatableRows.map((r) => r.attname);
      expect(updatableColumns).toEqual([...allowedColumns].sort());
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("defines households.version as integer not null default 1 with RLS, FORCE RLS, and no DELETE (Pin 2)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const [col] = await sql<
        {
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }[]
      >`
        select data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'app'
          and table_name = 'households'
          and column_name = 'version'
      `;
      expect(col).toBeDefined();
      expect(col?.data_type).toBe("integer");
      expect(col?.is_nullable).toBe("NO");
      expect(col?.column_default).toMatch(/^1\b/);

      for (const table of ["households", "persons"] as const) {
        const [rel] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
          select c.relrowsecurity, c.relforcerowsecurity
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relname = ${table}
        `;
        expect(rel, `${table} RLS`).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      }

      for (const table of ["households", "persons", "household_keys"] as const) {
        const canDelete = await privilege(sql, "app", table, "DELETE");
        expect(canDelete, `app should not have DELETE on ${table}`).toBe(false);
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("defines life_events table with RLS, FORCE RLS, and no DELETE (Pin 1, Pin 2)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const [rel] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'life_events'
      `;
      expect(rel, "life_events RLS").toEqual({ relrowsecurity: true, relforcerowsecurity: true });

      const canDelete = await privilege(sql, "app", "life_events", "DELETE");
      expect(canDelete, "app should not have DELETE on life_events").toBe(false);

      const [pk] = await sql<{ constraint_name: string }[]>`
        select tc.constraint_name
        from information_schema.table_constraints tc
        where tc.table_schema = 'app'
          and tc.table_name = 'life_events'
          and tc.constraint_type = 'PRIMARY KEY'
      `;
      expect(pk).toBeDefined();

      const pkName = pk?.constraint_name ?? "";
      const pkCols = await sql<{ column_name: string; ordinal_position: number }[]>`
        select kcu.column_name, kcu.ordinal_position
        from information_schema.key_column_usage kcu
        where kcu.table_schema = 'app'
          and kcu.table_name = 'life_events'
          and kcu.constraint_name = ${pkName}
        order by kcu.ordinal_position
      `;
      expect(pkCols.map((c: { column_name: string }) => c.column_name)).toEqual(["org_id", "id"]);

      const [idx] = await sql<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef
        from pg_indexes
        where schemaname = 'app'
          and tablename = 'life_events'
          and indexname = 'life_events_person_idx'
      `;
      expect(idx).toBeDefined();
      expect(idx?.indexdef).toContain("(org_id, person_id)");
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("grants app update on app.life_events only by column for event_type, event_date, place, notes, version (Pin 2)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const allowedColumns = ["event_date", "event_type", "notes", "place", "version"] as const;
      const forbiddenColumns = ["id", "org_id", "community_id", "person_id"] as const;

      for (const col of allowedColumns) {
        const [row] = await sql<{ granted: boolean }[]>`
          select has_column_privilege('app', 'app.life_events', ${col}, 'UPDATE') as granted
        `;
        expect(row?.granted, `expected column life_events.${col} to be updatable by app`).toBe(
          true,
        );
      }

      for (const col of forbiddenColumns) {
        const [row] = await sql<{ granted: boolean }[]>`
          select has_column_privilege('app', 'app.life_events', ${col}, 'UPDATE') as granted
        `;
        expect(row?.granted, `expected column life_events.${col} NOT to be updatable by app`).toBe(
          false,
        );
      }

      const updatableRows = await sql<{ attname: string }[]>`
        select attname
        from pg_attribute
        where attrelid = 'app.life_events'::regclass
          and attnum > 0
          and not attisdropped
          and has_column_privilege('app', 'app.life_events', attname, 'UPDATE')
        order by attname
      `;
      const updatableColumns = updatableRows.map((r) => r.attname);
      expect(updatableColumns).toEqual([...allowedColumns].sort());
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

  it("enforces trigger on app.persons stopping household_id update on a minor, allowing on an adult (Pin 1)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const orgId = newId();
    const communityId = newId();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${orgId}, ${`scope-${orgId}`}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${orgId}, ${`comm-${communityId}`}, 'au')
        `;
      });

      let minorId = "";
      let adultId = "";
      let householdAId = "";
      let householdBId = "";

      await withAppTransaction(app, { orgId, communityId }, async (tx) => {
        await withRequest({ requestId: REQUEST_ID }, async () => {
          const hhA = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Household A",
            actorUserId: null,
          });
          const hhB = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Household B",
            actorUserId: null,
          });
          householdAId = hhA.householdId;
          householdBId = hhB.householdId;

          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: householdAId,
            dateOfBirth: "2015-01-01",
            givenName: "Minor",
            familyName: "Person",
            email: null,
            phone: null,
            actorUserId: null,
          });
          minorId = minor.personId;

          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: householdAId,
            dateOfBirth: null,
            givenName: "Adult",
            familyName: "Person",
            email: "adult@example.com",
            phone: null,
            actorUserId: null,
          });
          adultId = adult.personId;
        });
      });

      // Updating household_id on minor raises from trigger
      await expect(
        withAppTransaction(
          app,
          { orgId, communityId },
          (tx) =>
            tx`update app.persons set household_id = ${householdBId}::uuid where id = ${minorId}::uuid`,
        ),
      ).rejects.toThrow(/cannot change household of a minor/);

      // Updating household_id on adult succeeds
      await withAppTransaction(app, { orgId, communityId }, async (tx) => {
        await expect(
          tx`update app.persons set household_id = ${householdBId}::uuid where id = ${adultId}::uuid`,
        ).resolves.toBeDefined();
      });
    } finally {
      await directSql`delete from app.audit_events where org_id = ${orgId}::uuid`.catch(() => {});
      await directSql`delete from app.person_activity where org_id = ${orgId}::uuid`.catch(
        () => {},
      );
      await directSql`delete from app.persons where org_id = ${orgId}::uuid`.catch(() => {});
      await directSql`delete from app.household_keys where org_id = ${orgId}::uuid`.catch(() => {});
      await directSql`delete from app.households where org_id = ${orgId}::uuid`.catch(() => {});
      await directSql`delete from app.community_keys where org_id = ${orgId}::uuid`.catch(() => {});
      await directSql`delete from app.organisation_keys where org_id = ${orgId}::uuid`.catch(
        () => {},
      );
      await directSql`delete from platform.communities where organisation_id = ${orgId}::uuid`.catch(
        () => {},
      );
      await directSql`delete from platform.organisations where id = ${orgId}::uuid`.catch(() => {});
      await app.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });
});
