import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import { createImplicitOrganisation } from "@community-hub/tenancy";
import type { Sql } from "postgres";

import { EntitlementError } from "../domain/error.js";
import { assignPlan, readSnapshot, setToggle, upsertPlan } from "../public/index.js";
import { clearSnapshotCache } from "./snapshot.js";

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

describe("two organisations", () => {
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

  it("keeps snapshots and writes apart across organisations", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const slugA = token("a");
    const slugB = token("b");
    const planA = token("pa");
    const planB = token("pb");
    clearSnapshotCache();

    const orgA = await createImplicitOrganisation(sql, {
      organisationSlug: slugA,
      communitySlug: slugA,
    });
    const orgB = await createImplicitOrganisation(sql, {
      organisationSlug: slugB,
      communitySlug: slugB,
    });

    await upsertPlan(sql, {
      key: planA,
      entitlements: [
        { key: "people.directory", limit: null },
        { key: "people.custom_fields", limit: 1 },
      ],
    });
    await upsertPlan(sql, {
      key: planB,
      entitlements: [
        { key: "people.directory", limit: null },
        { key: "people.households", limit: null },
      ],
    });
    await assignPlan(sql, {
      organisationId: orgA.organisationId,
      planKey: planA,
      now,
    });
    await assignPlan(sql, {
      organisationId: orgB.organisationId,
      planKey: planB,
      now,
    });
    await setToggle(sql, {
      organisationId: orgB.organisationId,
      communityId: orgB.communityId,
      key: "people.households",
      enabled: false,
      now,
    });

    const mismatched = await readSnapshot(sql, {
      organisationId: orgA.organisationId,
      communityId: orgB.communityId,
      now,
    });
    expect(mismatched.planKey).toBe(planA);

    const forB = await readSnapshot(sql, {
      organisationId: orgB.organisationId,
      communityId: orgB.communityId,
      now,
    });
    expect(forB.planKey).toBe(planB);
    expect(forB.planEntitlements).toEqual([
      { key: "people.directory", limit: null },
      { key: "people.households", limit: null },
    ]);
    expect(forB.toggles).toEqual([{ key: "people.households", enabled: false }]);
    expect(forB.organisationId).toBe(orgB.organisationId);
    expect(forB.communityId).toBe(orgB.communityId);

    const beforeToggles = await sql<{ entitlement_key: string; enabled: boolean }[]>`
      select entitlement_key, enabled
      from platform.community_toggles
      where community_id = ${orgB.communityId}::uuid
      order by entitlement_key
    `;
    const beforePlanB = await sql<{ plan_key: string }[]>`
      select plans.key as plan_key
      from platform.organisation_plans assigned
      join platform.plans plans on plans.id = assigned.plan_id
      where assigned.organisation_id = ${orgB.organisationId}::uuid
    `;
    const beforeAllocB = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_allocations
      where community_id = ${orgB.communityId}::uuid
      order by entitlement_key
    `;

    await expect(
      setToggle(sql, {
        organisationId: orgA.organisationId,
        communityId: orgB.communityId,
        key: "people.directory",
        enabled: false,
        now,
      }),
    ).rejects.toMatchObject({ code: "not_found" } satisfies Partial<EntitlementError>);

    const afterToggles = await sql<{ entitlement_key: string; enabled: boolean }[]>`
      select entitlement_key, enabled
      from platform.community_toggles
      where community_id = ${orgB.communityId}::uuid
      order by entitlement_key
    `;
    expect(afterToggles).toEqual(beforeToggles);
    const crossToggle = await sql<{ n: number }[]>`
      select count(*)::int as n
      from platform.community_toggles
      where community_id = ${orgB.communityId}::uuid
        and entitlement_key = 'people.directory'
    `;
    expect(crossToggle).toEqual([{ n: 0 }]);

    await assignPlan(sql, {
      organisationId: orgA.organisationId,
      planKey: planA,
      now,
    });

    const afterPlanB = await sql<{ plan_key: string }[]>`
      select plans.key as plan_key
      from platform.organisation_plans assigned
      join platform.plans plans on plans.id = assigned.plan_id
      where assigned.organisation_id = ${orgB.organisationId}::uuid
    `;
    const afterAllocB = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_allocations
      where community_id = ${orgB.communityId}::uuid
      order by entitlement_key
    `;
    const afterAllocA = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_allocations
      where community_id = ${orgA.communityId}::uuid
      order by entitlement_key
    `;
    expect(afterPlanB).toEqual(beforePlanB);
    expect(afterAllocB).toEqual(beforeAllocB);
    expect(afterAllocA).toEqual([
      { entitlement_key: "people.custom_fields" },
      { entitlement_key: "people.directory" },
    ]);
    expect(afterPlanB).toEqual([{ plan_key: planB }]);
  });
});
