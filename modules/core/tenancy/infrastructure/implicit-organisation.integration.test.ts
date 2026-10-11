import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";

import type { Sql } from "postgres";

import { createImplicitOrganisation, findCommunityBySlug } from "../public/index.js";

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

beforeAll(async () => {
  const runtime = loadRuntime();
  const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

describe("implicit organisation", () => {
  it("creates one pair, rolls back duplicates, and denies the other logins", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    try {
      const created = await createImplicitOrganisation(sql, {
        organisationSlug: "example-parish",
        communitySlug: "example-parish",
      });
      expect(created.organisationId).not.toBe(created.communityId);

      const organisations = await sql<{ kind: string; region: string }[]>`
        select kind, region from platform.organisations where slug = 'example-parish'
      `;
      expect(organisations).toEqual([{ kind: "implicit", region: "au" }]);

      const communities = await sql<{ organisation_id: string; slug: string; region: string }[]>`
        select organisation_id, slug, region
        from platform.communities
        where slug = 'example-parish'
      `;
      expect(communities).toEqual([
        {
          organisation_id: created.organisationId,
          slug: "example-parish",
          region: "au",
        },
      ]);

      const found = await findCommunityBySlug(sql, "example-parish");
      expect(found).toEqual({
        id: created.communityId,
        organisationId: created.organisationId,
        slug: "example-parish",
        region: "au",
      });
      expect(found).not.toHaveProperty("kind");

      const missing = await findCommunityBySlug(sql, "missing-parish");
      expect(missing).toBeNull();

      await expect(
        createImplicitOrganisation(sql, {
          organisationSlug: "example-parish",
          communitySlug: "example-parish",
        }),
      ).rejects.toMatchObject({ code: "duplicate_organisation_slug" });
      const sameSlug = await sql<{ n: number }[]>`
        select count(*)::int as n from platform.organisations where slug = 'example-parish'
      `;
      expect(Number(sameSlug[0]?.n)).toBe(1);

      await expect(
        createImplicitOrganisation(sql, {
          organisationSlug: "second-parish",
          communitySlug: "example-parish",
        }),
      ).rejects.toMatchObject({ code: "duplicate_community_slug" });
      const organisationCount = await sql<{ n: number }[]>`
        select count(*)::int as n from platform.organisations
      `;
      expect(Number(organisationCount[0]?.n)).toBe(1);
      const secondParish = await sql<{ n: number }[]>`
        select count(*)::int as n from platform.organisations where slug = 'second-parish'
      `;
      expect(Number(secondParish[0]?.n)).toBe(0);

      await expect(
        createImplicitOrganisation(sql, {
          organisationSlug: "Example",
          communitySlug: "example-parish",
        }),
      ).rejects.toMatchObject({ code: "invalid_slug" });
      const afterInvalid = await sql<{ n: number }[]>`
        select count(*)::int as n from platform.organisations
      `;
      expect(Number(afterInvalid[0]?.n)).toBe(1);
    } finally {
      await sql.end({ timeout: 1 });
    }

    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      for (const role of ["app", "identity"] as const) {
        const privileges = await direct<
          {
            schema_usage: boolean;
            organisations_select: boolean;
            communities_select: boolean;
          }[]
        >`
          select
            has_schema_privilege(${role}, 'platform', 'USAGE') as schema_usage,
            has_table_privilege(${role}, 'platform.organisations', 'SELECT') as organisations_select,
            has_table_privilege(${role}, 'platform.communities', 'SELECT') as communities_select
        `;
        expect(privileges).toEqual([
          {
            schema_usage: false,
            organisations_select: false,
            communities_select: false,
          },
        ]);
      }
    } finally {
      await direct.end({ timeout: 1 });
    }

    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    try {
      await expect(app`select * from platform.organisations`).rejects.toMatchObject({
        code: "42501",
      });
      await expect(app`select * from platform.communities`).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await app.end({ timeout: 1 });
    }

    const identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    try {
      await expect(identity`select * from platform.organisations`).rejects.toMatchObject({
        code: "42501",
      });
      await expect(identity`select * from platform.communities`).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await identity.end({ timeout: 1 });
    }

    const platformPrivileges = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const privileges = await platformPrivileges<
        { app_usage: boolean; identity_usage: boolean }[]
      >`
        select
          has_schema_privilege('platform', 'app', 'USAGE') as app_usage,
          has_schema_privilege('platform', 'identity', 'USAGE') as identity_usage
      `;
      expect(privileges).toEqual([{ app_usage: false, identity_usage: false }]);
    } finally {
      await platformPrivileges.end({ timeout: 1 });
    }

    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    try {
      await expect(platform`select id from app.outbox`).rejects.toMatchObject({ code: "42501" });
      await expect(platform`select id from identity.users`).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await platform.end({ timeout: 1 });
    }
  });

  it("refuses a direct insert that breaks a tenancy rule", async () => {
    const direct = createPlaintextDirectSql(loadRuntime().productOnlyUrl);
    const organisationId = "00000000-0000-4000-8000-000000000010";
    try {
      await expect(
        direct`
          insert into platform.communities (id, organisation_id, slug, region)
          values (
            '00000000-0000-4000-8000-000000000011',
            '00000000-0000-4000-8000-000000000099',
            'orphan-parish',
            'au'
          )
        `,
      ).rejects.toMatchObject({ code: "23503" });

      await expect(
        direct`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'region-parish', 'us', 'implicit')
        `,
      ).rejects.toMatchObject({ code: "23514" });

      await direct`
        insert into platform.organisations (id, slug, region, kind)
        values (${organisationId}, 'direct-parish', 'au', 'implicit')
      `;
      await expect(
        direct`
          insert into platform.communities (id, organisation_id, slug, region)
          values (
            '00000000-0000-4000-8000-000000000012',
            ${organisationId},
            'direct-parish',
            'nz'
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        direct`
          insert into platform.organisations (id, slug, region, kind)
          values ('00000000-0000-4000-8000-000000000013', 'kind-parish', 'au', 'other')
        `,
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        direct`
          insert into platform.organisations (id, slug, region, kind)
          values ('00000000-0000-4000-8000-000000000014', 'Bad', 'au', 'explicit')
        `,
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        direct`
          insert into platform.communities (id, organisation_id, slug, region)
          values (
            '00000000-0000-4000-8000-000000000015',
            ${organisationId},
            '-bad',
            'au'
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await direct`delete from platform.communities where organisation_id = ${organisationId}`;
      await direct`delete from platform.organisations where id = ${organisationId}`;
      await direct.end({ timeout: 1 });
    }
  });

  it("returns null for an invalid slug without querying", async () => {
    const sql = (() => {
      throw new Error("database was queried");
    }) as unknown as Sql;
    await expect(findCommunityBySlug(sql, "Example")).resolves.toBeNull();
    await expect(findCommunityBySlug(sql, "")).resolves.toBeNull();
    await expect(findCommunityBySlug(sql, "ab")).resolves.toBeNull();
  });

  it("leaves the caller's timestamp parsers unchanged", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    try {
      // postgres.js fills options.parsers on first use. Snapshot after that.
      await sql`select now(), ${"example"}::text, ${"00000000-0000-0000-0000-000000000000"}::uuid`;
      const parsers = { ...sql.options.parsers };
      await createImplicitOrganisation(sql, {
        organisationSlug: "parser-parish",
        communitySlug: "parser-parish",
      });
      await findCommunityBySlug(sql, "parser-parish");
      expect({ ...sql.options.parsers }).toEqual(parsers);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
