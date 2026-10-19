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
        id: string;
        gst_rate_bps: number;
        prices_include_gst: boolean;
        trial_days: number;
        grace_days: number;
        stripe_tax_rate_id: string | null;
        note: string;
      }[]
    >`
      select id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note
      from platform.billing_settings
      where note = 'seed'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "00000000-0000-0000-0000-000000000001",
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

  it("checks reject negative lower bounds: gst_rate_bps = -1, trial_days = -1, grace_days = -1", async () => {
    // gst_rate_bps = -1
    await expect(
      platformSql`
        insert into platform.billing_settings (
          id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at
        ) values (
          ${newId()}::uuid, -1, true, 30, 7, null, 'check', now()
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // trial_days = -1
    await expect(
      platformSql`
        insert into platform.billing_settings (
          id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at
        ) values (
          ${newId()}::uuid, 1000, true, -1, 7, null, 'check', now()
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // grace_days = -1
    await expect(
      platformSql`
        insert into platform.billing_settings (
          id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at
        ) values (
          ${newId()}::uuid, 1000, true, 30, -1, null, 'check', now()
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("note check rejects newline, non-ASCII (é), and empty string", async () => {
    // note with newline
    await expect(
      platformSql`
        insert into platform.billing_settings (
          id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at
        ) values (
          ${newId()}::uuid, 1000, true, 30, 7, null, ${"hello\nworld"}, now()
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // note with é
    await expect(
      platformSql`
        insert into platform.billing_settings (
          id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at
        ) values (
          ${newId()}::uuid, 1000, true, 30, 7, null, ${"café"}, now()
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // empty note
    await expect(
      platformSql`
        insert into platform.billing_settings (
          id, gst_rate_bps, prices_include_gst, trial_days, grace_days, stripe_tax_rate_id, note, created_at
        ) values (
          ${newId()}::uuid, 1000, true, 30, 7, null, '', now()
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects duplicate stripe_subscription_id as unique across organisations", async () => {
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

    const subId = `sub_${newId().replaceAll("-", "").slice(0, 14)}`;
    const customer1 = `cus_${newId().replaceAll("-", "").slice(0, 14)}`;
    const customer2 = `cus_${newId().replaceAll("-", "").slice(0, 14)}`;
    await platformSql`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id)
      values (${org1}::uuid, 'self_serve', ${customer1}, ${subId})
    `;

    await expect(
      platformSql`
        insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id)
        values (${org2}::uuid, 'self_serve', ${customer2}, ${subId})
      `,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("enforces foreign key restrict on billing_accounts organisation_id", async () => {
    const orgId = newId();
    await platformSql`
      insert into platform.organisations (id, slug, region, kind)
      values (${orgId}::uuid, ${`org-${newId().replaceAll("-", "")}`}, 'au', 'explicit')
    `;
    await platformSql`
      insert into platform.billing_accounts (organisation_id, mode)
      values (${orgId}::uuid, 'self_serve')
    `;

    await expect(
      platformSql`delete from platform.organisations where id = ${orgId}::uuid`,
    ).rejects.toMatchObject({ code: "23503" });

    const rows = await platformSql<{ count: string }[]>`
      select count(*) as count from platform.billing_accounts where organisation_id = ${orgId}::uuid
    `;
    expect(Number(rows[0]?.count)).toBe(1);
  });
});
