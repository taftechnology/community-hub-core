import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import type { Sql } from "postgres";

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

describe("billing schema integration", () => {
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

  it("privilege: platform can insert and select from billing_settings, UPDATE and DELETE fail with 42501", async () => {
    const id = newId();
    await platformSql`
      insert into platform.billing_settings (
        id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at
      ) values (
        ${id}::uuid, 1000, true, 30, 7, 'txr_test', 'test note', now()
      )
    `;

    const rows = await platformSql<{ id: string; note: string }[]>`
      select id, note from platform.billing_settings where id = ${id}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.note).toBe("test note");

    await expect(
      platformSql`update platform.billing_settings set note = 'fail' where id = ${id}::uuid`,
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      platformSql`delete from platform.billing_settings where id = ${id}::uuid`,
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("seed row has the D5 values", async () => {
    const rows = await platformSql<
      {
        gst_rate_bps: number;
        prices_include_gst: boolean;
        trial_days: number;
        grace_days: number;
        stripe_tax_rate_id: string | null;
        note: string;
      }[]
    >`
      select gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note
      from platform.billing_settings
      where note = 'seed'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      gst_rate_bps: 1000,
      prices_include_gst: true,
      trial_days: 30,
      grace_days: 7,
      stripe_tax_rate_id: null,
      note: "seed",
    });
  });

  it("checks reject gst_rate_bps = 5001, trial_days = 91, grace_days = 31, 201-char note, and mode free", async () => {
    // gst_rate_bps = 5001
    await expect(
      platformSql`
        insert into platform.billing_settings (
          id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at
        ) values (
          ${newId()}::uuid, 5001, true, 30, 7, null, 'check', now()
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // trial_days = 91
    await expect(
      platformSql`
        insert into platform.billing_settings (
          id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at
        ) values (
          ${newId()}::uuid, 1000, true, 91, 7, null, 'check', now()
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // grace_days = 31
    await expect(
      platformSql`
        insert into platform.billing_settings (
          id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at
        ) values (
          ${newId()}::uuid, 1000, true, 30, 31, null, 'check', now()
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // 201-character note
    const longNote = "a".repeat(201);
    await expect(
      platformSql`
        insert into platform.billing_settings (
          id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at
        ) values (
          ${newId()}::uuid, 1000, true, 30, 7, null, ${longNote}, now()
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // billing_accounts mode = free
    const orgId = newId();
    await platformSql`
      insert into platform.organisations (id, slug, region, kind)
      values (${orgId}::uuid, ${`org-${newId().replaceAll("-", "")}`}, 'au', 'explicit')
    `;
    await expect(
      platformSql`
        insert into platform.billing_accounts (organisation_id, mode)
        values (${orgId}::uuid, 'free')
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects duplicate stripe_customer_id as unique", async () => {
    const org1 = newId();
    const org2 = newId();
    await platformSql`
      insert into platform.organisations (id, slug, region, kind)
      values (${org1}::uuid, ${`org-${newId().replaceAll("-", "")}`}, 'au', 'explicit')
    `;
    await platformSql`
      insert into platform.organisations (id, slug, region, kind)
      values (${org2}::uuid, ${`org-${newId().replaceAll("-", "")}`}, 'au', 'explicit')
    `;

    const customerId = `cus_${newId().replaceAll("-", "").slice(0, 14)}`;
    await platformSql`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id)
      values (${org1}::uuid, 'self_serve', ${customerId})
    `;

    await expect(
      platformSql`
        insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id)
        values (${org2}::uuid, 'self_serve', ${customerId})
      `,
    ).rejects.toMatchObject({ code: "23505" });
  });
});
