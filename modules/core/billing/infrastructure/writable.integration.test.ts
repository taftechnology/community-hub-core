import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import type { Sql } from "postgres";

import { BillingReadOnly } from "../domain/writable.js";
import { assertWritable } from "./writable.js";

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
  return `${prefix}_${counter}_${newId().replaceAll("-", "")}`;
}

function orgSlug(): string {
  counter += 1;
  return `org-writable-${counter}-${newId().replaceAll("-", "").toLowerCase()}`;
}

async function createTestOrg(sql: Sql): Promise<string> {
  const orgId = newId();
  await sql`
    insert into platform.organisations (id, slug, region, kind)
    values (${orgId}::uuid, ${orgSlug()}, 'au', 'explicit')
  `;
  return orgId;
}

describe("assertWritable integration", () => {
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

  it("handles three organisations inserted in ok, read_only, retrying order, and missing row returns invoiced", async () => {
    const now = new Date("2026-10-19T12:00:00.000Z");

    const orgOk = await createTestOrg(platformSql);
    const orgReadOnly = await createTestOrg(platformSql);
    const orgRetrying = await createTestOrg(platformSql);
    const orgMissing = await createTestOrg(platformSql);

    const cusOk = token("cus");
    const subOk = token("sub");
    const cusRo = token("cus");
    const subRo = token("sub");
    const cusRetry = token("cus");
    const subRetry = token("sub");

    // Inserted in order (ok, read_only, retrying)
    await platformSql`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status)
      values (${orgOk}::uuid, 'self_serve', ${cusOk}, ${subOk}, 'active')
    `;

    await platformSql`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status)
      values (${orgReadOnly}::uuid, 'self_serve', ${cusRo}, ${subRo}, 'canceled')
    `;

    await platformSql`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status)
      values (${orgRetrying}::uuid, 'self_serve', ${cusRetry}, ${subRetry}, 'past_due')
    `;

    // orgOk returns "ok"
    const stateOk = await assertWritable(platformSql, orgOk, now);
    expect(stateOk).toBe("ok");

    // orgReadOnly (middle one) throws BillingReadOnly
    await expect(assertWritable(platformSql, orgReadOnly, now)).rejects.toThrow(BillingReadOnly);
    try {
      await assertWritable(platformSql, orgReadOnly, now);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingReadOnly);
      expect((err as BillingReadOnly).state).toBe("read_only");
    }

    // orgRetrying returns "retrying"
    const stateRetrying = await assertWritable(platformSql, orgRetrying, now);
    expect(stateRetrying).toBe("retrying");

    // orgMissing returns "invoiced"
    const stateMissing = await assertWritable(platformSql, orgMissing, now);
    expect(stateMissing).toBe("invoiced");
  });

  it("checks the grace_until boundary: equal to now throws, one millisecond before does not", async () => {
    const orgGrace = await createTestOrg(platformSql);
    const cusGrace = token("cus");
    const subGrace = token("sub");

    const graceUntil = new Date("2026-10-25T12:00:00.000Z");

    await platformSql`
      insert into platform.billing_accounts (
        organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status, grace_until
      ) values (
        ${orgGrace}::uuid, 'self_serve', ${cusGrace}, ${subGrace}, 'unpaid', ${graceUntil}
      )
    `;

    // 1 millisecond before grace_until: writable (returns "grace")
    const oneMsBefore = new Date(graceUntil.getTime() - 1);
    const stateBefore = await assertWritable(platformSql, orgGrace, oneMsBefore);
    expect(stateBefore).toBe("grace");

    // Exactly at grace_until: read_only (throws BillingReadOnly)
    const exactlyAt = new Date(graceUntil.getTime());
    await expect(assertWritable(platformSql, orgGrace, exactlyAt)).rejects.toThrow(BillingReadOnly);
    try {
      await assertWritable(platformSql, orgGrace, exactlyAt);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingReadOnly);
      expect((err as BillingReadOnly).state).toBe("read_only");
    }
  });
});
