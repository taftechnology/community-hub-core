import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import { createImplicitOrganisation } from "@community-hub/tenancy";
import type { Sql } from "postgres";

import { assignPlan, setFeatureFlag, setToggle, upsertPlan } from "../public/index.js";

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

function token(prefix: string): string {
  return `${prefix}${newId().replaceAll("-", "").slice(0, 12)}`;
}

describe("community toggle", () => {
  let sql: Sql;

  beforeAll(async () => {
    const runtime = loadRuntime();
    const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }
    sql = createPlaintextPlatformSql(platformUrl(runtime));
  });

  afterAll(async () => {
    await sql.end({ timeout: 1 });
  });

  it("stores off, deletes on, and rejects a key the organisation does not have", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const slug = token("t");
    const plan = token("p");
    const created = await createImplicitOrganisation(sql, {
      organisationSlug: slug,
      communitySlug: slug,
    });
    await upsertPlan(sql, {
      key: plan,
      entitlements: [{ key: "people.directory", limit: null }],
    });
    await assignPlan(sql, {
      organisationId: created.organisationId,
      planKey: plan,
      now,
    });

    expect(
      await setToggle(sql, {
        organisationId: created.organisationId,
        communityId: created.communityId,
        key: "people.directory",
        enabled: false,
        now,
      }),
    ).toBe("changed");
    expect(
      await setToggle(sql, {
        organisationId: created.organisationId,
        communityId: created.communityId,
        key: "people.directory",
        enabled: false,
        now,
      }),
    ).toBe("unchanged");
    const stored = await sql<{ enabled: boolean }[]>`
      select enabled
      from platform.community_toggles
      where community_id = ${created.communityId}::uuid
        and entitlement_key = 'people.directory'
    `;
    expect(stored).toEqual([{ enabled: false }]);

    expect(
      await setToggle(sql, {
        organisationId: created.organisationId,
        communityId: created.communityId,
        key: "people.directory",
        enabled: true,
        now,
      }),
    ).toBe("changed");
    expect(
      await setToggle(sql, {
        organisationId: created.organisationId,
        communityId: created.communityId,
        key: "people.directory",
        enabled: true,
        now,
      }),
    ).toBe("unchanged");
    const removed = await sql<{ enabled: boolean }[]>`
      select enabled
      from platform.community_toggles
      where community_id = ${created.communityId}::uuid
        and entitlement_key = 'people.directory'
    `;
    expect(removed).toEqual([]);

    await expect(
      setToggle(sql, {
        organisationId: created.organisationId,
        communityId: created.communityId,
        key: "people.households",
        enabled: false,
        now,
      }),
    ).rejects.toMatchObject({ code: "not_allocated" });
    const absent = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_toggles
      where community_id = ${created.communityId}::uuid
        and entitlement_key = 'people.households'
    `;
    expect(absent).toEqual([]);

    await setFeatureFlag(sql, {
      key: "people.directory",
      enabled: false,
      organisationId: created.organisationId,
      communityId: created.communityId,
      planKey: plan,
      region: "au",
    });
    await expect(
      setToggle(sql, {
        organisationId: created.organisationId,
        communityId: created.communityId,
        key: "people.directory",
        enabled: false,
        now,
      }),
    ).rejects.toMatchObject({ code: "not_allocated" });
    const afterFlag = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_toggles
      where community_id = ${created.communityId}::uuid
    `;
    expect(afterFlag).toEqual([]);
  });
});
