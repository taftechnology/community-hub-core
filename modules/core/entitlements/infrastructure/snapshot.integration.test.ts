import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import { evaluate } from "@community-hub/entitlements-eval";
import { createImplicitOrganisation } from "@community-hub/tenancy";
import type { Sql } from "postgres";

import { assignPlan, readSnapshot, setToggle, upsertPlan } from "../public/index.js";

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

describe("snapshot cache", () => {
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

  it("keeps a snapshot for 59 seconds and reloads at 60", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const slug = token("s");
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

    const loaded = await readSnapshot(sql, {
      organisationId: created.organisationId,
      communityId: created.communityId,
      now,
    });
    expect(evaluate(loaded, "people.directory", now)).toEqual({ ok: true });
    expect(loaded.planEntitlements).toEqual([{ key: "people.directory", limit: null }]);
    expect(loaded.region).toBe("au");

    const plans = await sql<{ id: string }[]>`
      select id from platform.plans where key = ${plan}
    `;
    await sql`
      update platform.plan_entitlements
      set limit_value = 9
      where plan_id = ${rowId(plans)}::uuid
        and entitlement_key = 'people.directory'
    `;

    const within = new Date(now.getTime() + 59_000);
    const cached = await readSnapshot(sql, {
      organisationId: created.organisationId,
      communityId: created.communityId,
      now: within,
    });
    expect(cached.planEntitlements).toEqual([{ key: "people.directory", limit: null }]);

    const expired = new Date(now.getTime() + 60_000);
    const reloaded = await readSnapshot(sql, {
      organisationId: created.organisationId,
      communityId: created.communityId,
      now: expired,
    });
    expect(reloaded.planEntitlements).toEqual([{ key: "people.directory", limit: 9 }]);

    await setToggle(sql, {
      organisationId: created.organisationId,
      communityId: created.communityId,
      key: "people.directory",
      enabled: false,
      now: expired,
    });
    const toggled = await readSnapshot(sql, {
      organisationId: created.organisationId,
      communityId: created.communityId,
      now: expired,
    });
    expect(toggled.toggles).toEqual([{ key: "people.directory", enabled: false }]);

    await upsertPlan(sql, {
      key: plan,
      entitlements: [{ key: "people.households", limit: 1 }],
    });
    const cleared = await readSnapshot(sql, {
      organisationId: created.organisationId,
      communityId: created.communityId,
      now: expired,
    });
    expect(cleared.planEntitlements).toEqual([{ key: "people.households", limit: 1 }]);
  });
});
