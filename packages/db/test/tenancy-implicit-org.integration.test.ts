import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createImplicitOrganisation, findCommunityBySlug } from "@community-hub/tenancy";
import { applyProductMigrations } from "../src/migrate.js";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "../src/plaintext.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const DIR = path.dirname(fileURLToPath(import.meta.url));

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(path.join(DIR, ".runtime.json"), "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "identity" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

describe("implicit organisation", () => {
  it("creates one pair, rolls back duplicates, and denies the other logins", async () => {
    const runtime = loadRuntime();
    const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }

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

    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    try {
      await expect(app`select * from platform.organisations`).rejects.toMatchObject({
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
    } finally {
      await identity.end({ timeout: 1 });
    }
  });
});
