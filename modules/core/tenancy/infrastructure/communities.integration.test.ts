import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";

import { createImplicitOrganisation, listCommunityIds } from "../public/index.js";

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

describe("listCommunityIds", () => {
  it("returns the community id of an implicit organisation and nothing else", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextPlatformSql(platformUrl(runtime));
    const slug = `ids-${newId().replaceAll("-", "").slice(0, 12)}`;
    try {
      const created = await createImplicitOrganisation(sql, {
        organisationSlug: slug,
        communitySlug: slug,
      });
      const ids = await listCommunityIds(sql, created.organisationId);
      expect(ids).toEqual([created.communityId]);
      expect(ids).not.toHaveProperty("slug");
      expect(await listCommunityIds(sql, newId())).toEqual([]);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
