import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import { createPlaintextAppSql, createPlaintextDirectSql } from "@community-hub/db/plaintext";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

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

async function privilege(
  sql: ReturnType<typeof createPlaintextDirectSql>,
  role: "app" | "identity" | "platform",
  table: string,
  kind: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE",
): Promise<boolean> {
  const rows = await sql<{ granted: boolean }[]>`
    select has_table_privilege(${role}, ${`app.${table}`}, ${kind}) as granted
  `;
  return rows[0]?.granted ?? false;
}

describe("access grant privileges", () => {
  it("lets app select and delete community grants, and not update them", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      expect(await privilege(sql, "app", "community_role_grants", "SELECT")).toBe(true);
      expect(await privilege(sql, "app", "community_role_grants", "UPDATE")).toBe(false);
      expect(await privilege(sql, "app", "community_role_grants", "DELETE")).toBe(true);
      expect(await privilege(sql, "identity", "community_role_grants", "SELECT")).toBe(false);
      expect(await privilege(sql, "platform", "community_role_grants", "SELECT")).toBe(false);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("enforces RLS and FORCE RLS on organisation_members and invitations (pin 1)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      for (const table of ["organisation_members", "invitations"] as const) {
        const [rel] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
          select c.relrowsecurity, c.relforcerowsecurity
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relname = ${table}
        `;
        expect(rel, `${table} RLS`).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      }

      const orgA = newId();
      const orgB = newId();
      const commA1 = newId();
      const commA2 = newId();
      const commB1 = newId();

      const userA = newId();
      const userB = newId();
      const invA1Id = newId();
      const invA2Id = newId();

      await sql`
        insert into platform.organisations (id, slug, region, kind) values
          (${orgA}, ${`org-${orgA}`}, 'au', 'implicit'),
          (${orgB}, ${`org-${orgB}`}, 'au', 'implicit')
      `;
      await sql`
        insert into platform.communities (id, organisation_id, slug, region) values
          (${commA1}, ${orgA}, ${`comm-${commA1}`}, 'au'),
          (${commA2}, ${orgA}, ${`comm-${commA2}`}, 'au'),
          (${commB1}, ${orgB}, ${`comm-${commB1}`}, 'au')
      `;

      await sql`
        insert into app.organisation_members (org_id, user_id, source, created_at) values
          (${orgA}, ${userA}, 'provision', now()),
          (${orgB}, ${userB}, 'provision', now())
      `;
      await sql`
        insert into app.invitations (org_id, community_id, id, invited_by, email, email_bidx, role_key, token_hash, status, expires_at, resend_count, last_sent_at, created_at) values
          (${orgA}, ${commA1}, ${invA1Id}, ${userA}, ${Buffer.from("inv1")}, ${Buffer.alloc(32)}, 'staff', ${Buffer.alloc(32)}, 'pending', now() + interval '7 days', 0, now(), now()),
          (${orgA}, ${commA2}, ${invA2Id}, ${userA}, ${Buffer.from("inv2")}, ${Buffer.alloc(32)}, 'staff', ${Buffer.alloc(32)}, 'pending', now() + interval '7 days', 0, now(), now())
      `;

      const app = createPlaintextAppSql(roleUrl(runtime, "app"));
      try {
        await withAppTransaction(app, { orgId: orgA, communityId: commA1 }, async (tx) => {
          const members = await tx<{ user_id: string }[]>`
            select user_id from app.organisation_members where user_id in (${userA}, ${userB})
          `;
          expect(members.map((r) => r.user_id)).toEqual([userA]);

          const invs = await tx<{ id: string }[]>`
            select id from app.invitations where id in (${invA1Id}, ${invA2Id})
          `;
          expect(invs.map((r) => r.id)).toEqual([invA1Id]);
        });
      } finally {
        await app.end({ timeout: 1 });
        await sql`delete from app.invitations where org_id in (${orgA}, ${orgB})`.catch(() => {});
        await sql`delete from app.organisation_members where org_id in (${orgA}, ${orgB})`.catch(
          () => {},
        );
        await sql`delete from platform.communities where organisation_id in (${orgA}, ${orgB})`.catch(
          () => {},
        );
        await sql`delete from platform.organisations where id in (${orgA}, ${orgB})`.catch(
          () => {},
        );
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("enforces column privileges on organisation_members and invitations (pin 2)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      expect(await privilege(sql, "app", "organisation_members", "SELECT")).toBe(true);
      expect(await privilege(sql, "app", "organisation_members", "INSERT")).toBe(true);
      expect(await privilege(sql, "app", "organisation_members", "UPDATE")).toBe(false);
      expect(await privilege(sql, "app", "organisation_members", "DELETE")).toBe(false);
      expect(await privilege(sql, "app", "organisation_members", "TRUNCATE")).toBe(false);

      expect(await privilege(sql, "app", "invitations", "SELECT")).toBe(true);
      expect(await privilege(sql, "app", "invitations", "INSERT")).toBe(true);
      expect(await privilege(sql, "app", "invitations", "DELETE")).toBe(true);
      expect(await privilege(sql, "app", "invitations", "TRUNCATE")).toBe(false);
      expect(await privilege(sql, "app", "invitations", "UPDATE")).toBe(false);

      const allowedColumns = [
        "status",
        "email",
        "email_bidx",
        "token_hash",
        "expires_at",
        "resend_count",
        "last_sent_at",
        "accepted_user_id",
        "person_id",
        "custom_role_id",
        "closed_at",
      ] as const;

      const forbiddenColumns = [
        "org_id",
        "community_id",
        "id",
        "invited_by",
        "role_key",
        "created_at",
      ] as const;

      for (const col of allowedColumns) {
        const [row] = await sql<{ granted: boolean }[]>`
          select has_column_privilege('app', 'app.invitations', ${col}, 'UPDATE') as granted
        `;
        expect(row?.granted, `expected column invitations.${col} to be updatable by app`).toBe(
          true,
        );
      }

      for (const col of forbiddenColumns) {
        const [row] = await sql<{ granted: boolean }[]>`
          select has_column_privilege('app', 'app.invitations', ${col}, 'UPDATE') as granted
        `;
        expect(row?.granted, `expected column invitations.${col} NOT to be updatable by app`).toBe(
          false,
        );
      }

      const updatableRows = await sql<{ attname: string }[]>`
        select attname
        from pg_attribute
        where attrelid = 'app.invitations'::regclass
          and attnum > 0
          and not attisdropped
          and has_column_privilege('app', 'app.invitations', attname, 'UPDATE')
        order by attname
      `;
      const updatableColumns = updatableRows.map((r) => r.attname);
      expect(updatableColumns).toEqual([...allowedColumns].sort());
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
