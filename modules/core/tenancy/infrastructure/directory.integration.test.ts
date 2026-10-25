import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";

import { listDirectory } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function platformUrl(runtime: Runtime): string {
  const password = encodeURIComponent(runtime.passwords.platform);
  return `postgres://platform:${password}@127.0.0.1:5432/hub_product_only`;
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

describe("listDirectory", () => {
  it("listDirectory returns only the directory fields", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextPlatformSql(platformUrl(runtime));
    const prefix = `dir-${newId().replaceAll("-", "").slice(0, 10)}`;
    const org1Id = newId();
    const org2Id = newId();
    const comm1Id = newId();
    const comm2Id = newId();
    const comm3Id = newId();

    try {
      const sentinel = new Error("rollback-sentinel");
      try {
        await sql.begin(async (tx) => {
          await tx`
            insert into platform.organisations (id, slug, region, kind) values
              (${org1Id}, ${`${prefix}-b`}, 'au', 'explicit'),
              (${org2Id}, ${`${prefix}-a`}, 'au', 'implicit')
          `;
          await tx`
            insert into platform.communities (id, organisation_id, slug, region) values
              (${comm1Id}, ${org1Id}, ${`${prefix}-b-2`}, 'au'),
              (${comm2Id}, ${org1Id}, ${`${prefix}-b-1`}, 'au'),
              (${comm3Id}, ${org2Id}, ${`${prefix}-a-1`}, 'au')
          `;

          const result = await listDirectory(tx);
          const orgs = result.organisations.filter((o) => o.slug.startsWith(prefix));

          expect(orgs).toHaveLength(2);
          expect(orgs[0]?.slug).toBe(`${prefix}-a`);
          expect(orgs[1]?.slug).toBe(`${prefix}-b`);

          for (const org of orgs) {
            expect(Object.keys(org)).toEqual(["id", "slug", "kind", "region", "communities"]);
          }

          expect(orgs[0]?.communities).toHaveLength(1);
          expect(orgs[0]?.communities[0]?.slug).toBe(`${prefix}-a-1`);
          expect(Object.keys(orgs[0]!.communities[0]!)).toEqual(["id", "slug"]);

          expect(orgs[1]?.communities).toHaveLength(2);
          expect(orgs[1]?.communities[0]?.slug).toBe(`${prefix}-b-1`);
          expect(orgs[1]?.communities[1]?.slug).toBe(`${prefix}-b-2`);
          expect(Object.keys(orgs[1]!.communities[0]!)).toEqual(["id", "slug"]);
          expect(Object.keys(orgs[1]!.communities[1]!)).toEqual(["id", "slug"]);

          throw sentinel;
        });
      } catch (error) {
        if (error !== sentinel) {
          throw error;
        }
      }

      const capSentinel = new Error("rollback-sentinel");
      const capPrefix = `cap-${newId().replaceAll("-", "").slice(0, 10)}`;
      try {
        await sql.begin(async (tx) => {
          const ids = Array.from({ length: 501 }, () => newId());
          const slugs = Array.from(
            { length: 501 },
            (_, i) => `${capPrefix}-${i.toString(36).padStart(4, "0")}`,
          );
          await tx`
            insert into platform.organisations (id, slug, region, kind)
            select u.id, u.slug, 'au', 'implicit'
            from unnest(${ids}::uuid[], ${slugs}::text[]) as u(id, slug)
          `;
          const capResult = await listDirectory(tx);
          expect(capResult.organisations).toHaveLength(500);
          expect(capResult.truncated).toBe(true);
          throw capSentinel;
        });
      } catch (error) {
        if (error !== capSentinel) {
          throw error;
        }
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
