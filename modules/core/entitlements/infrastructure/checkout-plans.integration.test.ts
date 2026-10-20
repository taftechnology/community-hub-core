import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import type { Sql } from "postgres";

import { listCheckoutPlans } from "./checkout-plans.js";

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

let counter = 0;
function token(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}_${newId().replaceAll("-", "").slice(0, 10).toLowerCase()}`;
}

describe("listCheckoutPlans integration", () => {
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

  afterAll(async () => {
    await platformSql.end({ timeout: 1 });
  });

  it("lists only plans with stripe_lookup_key, ordered by key", async () => {
    const rawKeyA = token("pa");
    const rawKeyB = token("pb");
    const sorted = [rawKeyA, rawKeyB].sort();
    const keyA = sorted[0]!;
    const keyB = sorted[1]!;
    const keyC = token("pc");

    const lookupA = token("lookup");
    const lookupB = token("lookup");

    // Insert in reverse key order (keyB first, then keyA)
    await platformSql`
      insert into platform.plans (id, key, stripe_lookup_key, trial_eligible)
      values (${newId()}::uuid, ${keyB}, ${lookupB}, true)
    `;

    await platformSql`
      insert into platform.plans (id, key, stripe_lookup_key, trial_eligible)
      values (${newId()}::uuid, ${keyA}, ${lookupA}, false)
    `;

    // Insert third plan without lookup key
    await platformSql`
      insert into platform.plans (id, key, stripe_lookup_key, trial_eligible)
      values (${newId()}::uuid, ${keyC}, null, false)
    `;

    const allPlans = await listCheckoutPlans(platformSql);

    // (a) result filtered to these three keys equals the two, in key order, with right trialEligible
    const matching = allPlans.filter((p) => p.key === keyA || p.key === keyB || p.key === keyC);
    expect(matching).toEqual([
      { key: keyA, trialEligible: false },
      { key: keyB, trialEligible: true },
    ]);

    // (b) the whole result is sorted by key
    for (let i = 1; i < allPlans.length; i++) {
      expect(allPlans[i - 1]!.key.localeCompare(allPlans[i]!.key)).toBeLessThan(0);
    }

    // (c) the third key without lookup key is absent
    expect(allPlans.some((p) => p.key === keyC)).toBe(false);
  });
});
