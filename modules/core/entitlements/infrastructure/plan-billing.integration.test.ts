import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import type { Sql } from "postgres";

import {
  assignPlan,
  currentPlan,
  planBilling,
  planByLookupKey,
  setPlanBilling,
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
  return `${prefix}_${newId().replaceAll("-", "").slice(0, 12)}`;
}

describe("plan-billing integration", () => {
  let platformSql: Sql;

  beforeAll(async () => {
    const runtime = loadRuntime();
    const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }
    platformSql = createPlaintextPlatformSql(platformUrl(runtime));
  });

  it("sets and reads back plan billing, lookups by key, currentPlan with/without plan, and unique lookup key", async () => {
    const planKey = token("plan");
    const lookupKey = token("lookup");

    await upsertPlan(platformSql, { key: planKey, entitlements: [] });

    // initially no lookup key
    const initial = await planBilling(platformSql, planKey);
    expect(initial).toEqual({ stripeLookupKey: null, trialEligible: false });

    // setPlanBilling
    await setPlanBilling(platformSql, planKey, {
      stripeLookupKey: lookupKey,
      trialEligible: true,
    });

    // read back
    const updated = await planBilling(platformSql, planKey);
    expect(updated).toEqual({ stripeLookupKey: lookupKey, trialEligible: true });

    // lookup by key
    const found = await planByLookupKey(platformSql, lookupKey);
    expect(found).toEqual({ key: planKey });

    const notFound = await planByLookupKey(platformSql, "non_existent_lookup");
    expect(notFound).toBeNull();

    // currentPlan for org without plan
    const orgId = newId();
    await platformSql`
      insert into platform.organisations (id, slug, region, kind)
      values (${orgId}::uuid, ${`org-${newId().replaceAll("-", "").slice(0, 10)}`}, 'au', 'explicit')
    `;

    const withoutPlan = await currentPlan(platformSql, orgId);
    expect(withoutPlan).toBeNull();

    // assign plan and check currentPlan
    await assignPlan(platformSql, {
      organisationId: orgId,
      planKey,
      now: new Date(),
    });

    const withPlan = await currentPlan(platformSql, orgId);
    expect(withPlan).toEqual({
      key: planKey,
      stripeLookupKey: lookupKey,
      trialEligible: true,
    });

    // two lookup keys cannot be the same (unique)
    const planKey2 = token("plan2");
    await upsertPlan(platformSql, { key: planKey2, entitlements: [] });
    await expect(
      setPlanBilling(platformSql, planKey2, {
        stripeLookupKey: lookupKey,
        trialEligible: false,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
