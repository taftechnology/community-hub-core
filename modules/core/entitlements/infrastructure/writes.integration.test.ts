import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import { createImplicitOrganisation, listCommunityIds } from "@community-hub/tenancy";
import type { Sql } from "postgres";

import {
  allocate,
  assignPlan,
  grantOverride,
  setFeatureFlag,
  upsertAddOn,
  upsertPlan,
} from "../public/index.js";

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

function rowId(rows: { id: string }[]): string {
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error("missing id");
  }
  return id;
}

describe("platform plan writes", () => {
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

  it("replaces plan keys, assigns one community, and leaves a toggle when the plan is empty", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const slug = token("w");
    const created = await createImplicitOrganisation(sql, {
      organisationSlug: slug,
      communitySlug: slug,
    });

    await upsertPlan(sql, {
      key: "starter",
      entitlements: [{ key: "people.directory", limit: null }],
    });
    const inserted = await sql<{ id: string }[]>`
      select id from platform.plans where key = 'starter'
    `;
    expect(inserted).toHaveLength(1);
    const planId = rowId(inserted);
    const firstKeys = await sql<{ entitlement_key: string; limit_value: number | null }[]>`
      select entitlement_key, limit_value
      from platform.plan_entitlements
      where plan_id = ${planId}::uuid
    `;
    expect(firstKeys).toEqual([{ entitlement_key: "people.directory", limit_value: null }]);

    await upsertPlan(sql, {
      key: "starter",
      entitlements: [{ key: "people.households", limit: 2 }],
    });
    const replaced = await sql<{ id: string }[]>`
      select id from platform.plans where key = 'starter'
    `;
    expect(replaced[0]?.id).toBe(planId);
    const secondKeys = await sql<{ entitlement_key: string; limit_value: number | null }[]>`
      select entitlement_key, limit_value
      from platform.plan_entitlements
      where plan_id = ${planId}::uuid
    `;
    expect(secondKeys).toEqual([{ entitlement_key: "people.households", limit_value: 2 }]);

    await expect(
      upsertPlan(sql, {
        key: "starter",
        entitlements: [{ key: "people.directory", limit: -1 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_limit" });
    const afterLimit = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.plan_entitlements
      where plan_id = ${planId}::uuid
    `;
    expect(afterLimit).toEqual([{ entitlement_key: "people.households" }]);

    const plansBeforeInvalid = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.plans
    `;
    await expect(
      upsertPlan(sql, {
        key: "starter",
        entitlements: [{ key: "starter", limit: null }],
      }),
    ).rejects.toMatchObject({ code: "invalid_key" });
    const plansAfterInvalid = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.plans
    `;
    expect(plansAfterInvalid).toEqual(plansBeforeInvalid);
    const keysAfterInvalid = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.plan_entitlements
      where plan_id = ${planId}::uuid
    `;
    expect(keysAfterInvalid).toEqual([{ entitlement_key: "people.households" }]);

    await assignPlan(sql, {
      organisationId: created.organisationId,
      planKey: "starter",
      now,
    });
    const allocations = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_allocations
      where community_id = ${created.communityId}::uuid
    `;
    expect(allocations).toEqual([{ entitlement_key: "people.households" }]);
    expect(await listCommunityIds(sql, created.organisationId)).toEqual([created.communityId]);

    await sql`
      insert into platform.community_toggles (community_id, entitlement_key, enabled)
      values (${created.communityId}::uuid, 'people.households', false)
    `;
    await upsertPlan(sql, { key: "bare", entitlements: [] });
    await assignPlan(sql, {
      organisationId: created.organisationId,
      planKey: "bare",
      now,
    });
    const remaining = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_allocations
      where community_id = ${created.communityId}::uuid
    `;
    expect(remaining).toEqual([]);
    const toggles = await sql<{ entitlement_key: string; enabled: boolean }[]>`
      select entitlement_key, enabled
      from platform.community_toggles
      where community_id = ${created.communityId}::uuid
    `;
    expect(toggles).toEqual([{ entitlement_key: "people.households", enabled: false }]);

    const plansBefore = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.plans
    `;
    const assignmentBefore = await sql<{ plan_id: string }[]>`
      select plan_id
      from platform.organisation_plans
      where organisation_id = ${created.organisationId}::uuid
    `;
    await expect(
      assignPlan(sql, {
        organisationId: created.organisationId,
        planKey: "missingplan",
        now,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const plansAfter = await sql<{ n: number }[]>`
      select count(*)::int as n from platform.plans
    `;
    const assignmentAfter = await sql<{ plan_id: string }[]>`
      select plan_id
      from platform.organisation_plans
      where organisation_id = ${created.organisationId}::uuid
    `;
    expect(plansAfter).toEqual(plansBefore);
    expect(assignmentAfter).toEqual(assignmentBefore);
  });

  it("allocates add-on keys and overrides that are still in the future", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const expiresAt = new Date("2026-10-13T00:00:00.000Z");
    const slug = token("a");
    const plan = token("p");
    const addOn = token("o");
    const created = await createImplicitOrganisation(sql, {
      organisationSlug: slug,
      communitySlug: slug,
    });

    await upsertPlan(sql, {
      key: plan,
      entitlements: [{ key: "people.directory", limit: null }],
    });
    await upsertAddOn(sql, {
      key: addOn,
      entitlements: [{ key: "people.directory", limit: 1 }],
    });
    const first = await sql<{ id: string }[]>`
      select id from platform.add_ons where key = ${addOn}
    `;
    const firstId = rowId(first);
    await upsertAddOn(sql, {
      key: addOn,
      entitlements: [{ key: "people.households", limit: 4 }],
    });
    const second = await sql<{ id: string }[]>`
      select id from platform.add_ons where key = ${addOn}
    `;
    const secondId = rowId(second);
    expect(secondId).toBe(firstId);
    const addOnKeys = await sql<{ entitlement_key: string; limit_value: number | null }[]>`
      select entitlement_key, limit_value
      from platform.add_on_entitlements
      where add_on_id = ${secondId}::uuid
    `;
    expect(addOnKeys).toEqual([{ entitlement_key: "people.households", limit_value: 4 }]);
    await sql`
      insert into platform.organisation_add_ons (organisation_id, add_on_id)
      values (${created.organisationId}::uuid, ${secondId}::uuid)
    `;
    await grantOverride(sql, {
      organisationId: created.organisationId,
      key: "people.custom_fields",
      expiresAt,
      now,
    });

    await assignPlan(sql, {
      organisationId: created.organisationId,
      planKey: plan,
      now,
    });
    const allocated = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_allocations
      where community_id = ${created.communityId}::uuid
      order by entitlement_key
    `;
    expect(allocated.map((row) => row.entitlement_key)).toEqual([
      "people.custom_fields",
      "people.directory",
      "people.households",
    ]);

    await assignPlan(sql, {
      organisationId: created.organisationId,
      planKey: plan,
      now: expiresAt,
    });
    const afterExpiry = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_allocations
      where community_id = ${created.communityId}::uuid
      order by entitlement_key
    `;
    expect(afterExpiry.map((row) => row.entitlement_key)).toEqual([
      "people.directory",
      "people.households",
    ]);
  });

  it("rejects a second allocation and a missing community", async () => {
    const slug = token("c");
    const created = await createImplicitOrganisation(sql, {
      organisationSlug: slug,
      communitySlug: slug,
    });
    await allocate(sql, { communityId: created.communityId, key: "people.directory" });
    await expect(
      allocate(sql, { communityId: created.communityId, key: "people.directory" }),
    ).rejects.toMatchObject({ code: "duplicate_allocation" });
    const rows = await sql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_allocations
      where community_id = ${created.communityId}::uuid
        and entitlement_key = 'people.directory'
    `;
    expect(rows).toHaveLength(1);
    await expect(
      allocate(sql, { communityId: newId(), key: "people.directory" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects an override that expires now and replaces a later one", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const slug = token("g");
    const created = await createImplicitOrganisation(sql, {
      organisationSlug: slug,
      communitySlug: slug,
    });
    await expect(
      grantOverride(sql, {
        organisationId: created.organisationId,
        key: "people.directory",
        expiresAt: now,
        now,
      }),
    ).rejects.toMatchObject({ code: "invalid_expiry" });
    const none = await sql<{ id: string }[]>`
      select id
      from platform.entitlement_overrides
      where organisation_id = ${created.organisationId}::uuid
    `;
    expect(none).toEqual([]);

    const expiresAt = new Date(now.getTime() + 60_000);
    await grantOverride(sql, {
      organisationId: created.organisationId,
      key: "people.directory",
      expiresAt,
      now,
    });
    const replacedAt = new Date(now.getTime() + 120_000);
    await grantOverride(sql, {
      organisationId: created.organisationId,
      key: "people.directory",
      expiresAt: replacedAt,
      now,
    });
    const rows = await sql<{ expires_at: Date }[]>`
      select expires_at
      from platform.entitlement_overrides
      where organisation_id = ${created.organisationId}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expires_at).toEqual(replacedAt);
  });

  it("updates one flag for the same targets and rejects another region", async () => {
    const slug = token("f");
    const plan = token("p");
    const flagKey = `people.f${newId().replaceAll("-", "").slice(0, 8)}`;
    const nullKey = `people.n${newId().replaceAll("-", "").slice(0, 8)}`;
    const rejectedKey = `people.r${newId().replaceAll("-", "").slice(0, 8)}`;
    const created = await createImplicitOrganisation(sql, {
      organisationSlug: slug,
      communitySlug: slug,
    });
    await upsertPlan(sql, { key: plan, entitlements: [] });

    await setFeatureFlag(sql, {
      key: flagKey,
      enabled: true,
      organisationId: created.organisationId,
      communityId: created.communityId,
      planKey: plan,
      region: "au",
    });
    await setFeatureFlag(sql, {
      key: flagKey,
      enabled: false,
      organisationId: created.organisationId,
      communityId: created.communityId,
      planKey: plan,
      region: "au",
    });
    const targeted = await sql<{ enabled: boolean }[]>`
      select enabled from platform.feature_flags where key = ${flagKey}
    `;
    expect(targeted).toEqual([{ enabled: false }]);

    await setFeatureFlag(sql, {
      key: nullKey,
      enabled: true,
      organisationId: null,
      communityId: null,
      planKey: null,
      region: null,
    });
    await setFeatureFlag(sql, {
      key: nullKey,
      enabled: false,
      organisationId: null,
      communityId: null,
      planKey: null,
      region: null,
    });
    const nullTargets = await sql<{ enabled: boolean }[]>`
      select enabled from platform.feature_flags where key = ${nullKey}
    `;
    expect(nullTargets).toEqual([{ enabled: false }]);

    await expect(
      setFeatureFlag(sql, {
        key: rejectedKey,
        enabled: true,
        organisationId: null,
        communityId: null,
        planKey: null,
        region: "eu",
      }),
    ).rejects.toMatchObject({ code: "invalid_region" });
    const rejected = await sql<{ id: string }[]>`
      select id from platform.feature_flags where key = ${rejectedKey}
    `;
    expect(rejected).toEqual([]);
  });
});
