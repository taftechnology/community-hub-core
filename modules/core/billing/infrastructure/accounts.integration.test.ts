import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import type { Sql } from "postgres";

import {
  findByCustomer,
  findBySubscription,
  linkSubscription,
  readAccount,
  setAccountTaxRate,
  setMode,
} from "./accounts.js";

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
  return `org-${counter}-${newId().replaceAll("-", "").toLowerCase()}`;
}

async function createTestOrg(sql: Sql): Promise<string> {
  const orgId = newId();
  await sql`
    insert into platform.organisations (id, slug, region, kind)
    values (${orgId}::uuid, ${orgSlug()}, 'au', 'explicit')
  `;
  return orgId;
}

describe("accounts repository integration", () => {
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

  it("readAccount returns null for org without account; setMode inserts and updates mode", async () => {
    const orgId = await createTestOrg(platformSql);

    const initial = await readAccount(platformSql, orgId);
    expect(initial).toBeNull();

    const created = await setMode(platformSql, orgId, "self_serve");
    expect(created.organisationId).toBe(orgId);
    expect(created.mode).toBe("self_serve");

    const read = await readAccount(platformSql, orgId);
    expect(read).not.toBeNull();
    expect(read?.organisationId).toBe(orgId);
    expect(read?.mode).toBe("self_serve");

    const updated = await setMode(platformSql, orgId, "invoiced");
    expect(updated.mode).toBe("invoiced");

    const readAgain = await readAccount(platformSql, orgId);
    expect(readAgain?.mode).toBe("invoiced");
  });

  it("an invoiced organisation and a missing row both return invoiced; an unknown organisation returns missing", async () => {
    // 1. Unknown organisation (not in platform.organisations)
    const unknownOrgId = newId();
    const missingRes = await linkSubscription(
      platformSql,
      unknownOrgId,
      token("cus"),
      token("sub"),
      "active",
    );
    expect(missingRes).toBe("missing");

    // 2. Existing organisation with no row in platform.billing_accounts (missing row = invoiced)
    const orgMissingAccount = await createTestOrg(platformSql);
    const noRowRes = await linkSubscription(
      platformSql,
      orgMissingAccount,
      token("cus"),
      token("sub"),
      "active",
    );
    expect(noRowRes).toBe("invoiced");

    // 3. Organisation with explicit mode = invoiced
    const orgInvoiced = await createTestOrg(platformSql);
    await setMode(platformSql, orgInvoiced, "invoiced");
    const invoicedRes = await linkSubscription(
      platformSql,
      orgInvoiced,
      token("cus"),
      token("sub"),
      "active",
    );
    expect(invoicedRes).toBe("invoiced");
  });

  it("link to an empty account, then link the same subscription again: both linked; satisfies extra id+status rule", async () => {
    const orgId = await createTestOrg(platformSql);
    await setMode(platformSql, orgId, "self_serve");

    const customerId = token("cus");
    const subscriptionId = token("sub");

    // Link to empty account
    const res1 = await linkSubscription(platformSql, orgId, customerId, subscriptionId, "active");
    expect(res1).toBe("linked");

    // Extra rule (L2): after linkSubscription returns linked, stripe_subscription_id and stripe_status are both non-null
    const row = await readAccount(platformSql, orgId);
    expect(row).not.toBeNull();
    expect(row?.stripeSubscriptionId).toBe(subscriptionId);
    expect(row?.stripeStatus).toBe("active");
    expect(row?.stripeCustomerId).toBe(customerId);

    // Link same subscription again: both linked
    const res2 = await linkSubscription(platformSql, orgId, customerId, subscriptionId, "active");
    expect(res2).toBe("linked");

    const rowAfter = await readAccount(platformSql, orgId);
    expect(rowAfter?.stripeSubscriptionId).toBe(subscriptionId);
    expect(rowAfter?.stripeStatus).toBe("active");

    // findBySubscription and findByCustomer find the account
    const foundBySub = await findBySubscription(platformSql, subscriptionId);
    expect(foundBySub?.organisationId).toBe(orgId);

    const foundByCus = await findByCustomer(platformSql, customerId);
    expect(foundByCus?.organisationId).toBe(orgId);

    const notFoundSub = await findBySubscription(platformSql, token("sub_none"));
    expect(notFoundSub).toBeNull();

    const notFoundCus = await findByCustomer(platformSql, token("cus_none"));
    expect(notFoundCus).toBeNull();
  });

  it("pin 9: a different subscription while stored is active returns duplicate, first link kept", async () => {
    const orgId = await createTestOrg(platformSql);
    await setMode(platformSql, orgId, "self_serve");

    const customer1 = token("cus");
    const sub1 = token("sub");
    await linkSubscription(platformSql, orgId, customer1, sub1, "active");

    const customer2 = token("cus");
    const sub2 = token("sub");
    const res = await linkSubscription(platformSql, orgId, customer2, sub2, "active");
    expect(res).toBe("duplicate");

    // First subscription kept
    const current = await readAccount(platformSql, orgId);
    expect(current?.stripeSubscriptionId).toBe(sub1);
    expect(current?.stripeCustomerId).toBe(customer1);
    expect(current?.stripeStatus).toBe("active");
  });

  it("pin 9: a different subscription while stored is past_due returns duplicate, first link kept", async () => {
    const orgId = await createTestOrg(platformSql);
    await setMode(platformSql, orgId, "self_serve");

    const customer1 = token("cus");
    const sub1 = token("sub");
    await linkSubscription(platformSql, orgId, customer1, sub1, "past_due");

    const customer2 = token("cus");
    const sub2 = token("sub");
    const res = await linkSubscription(platformSql, orgId, customer2, sub2, "active");
    expect(res).toBe("duplicate");

    // First subscription kept
    const current = await readAccount(platformSql, orgId);
    expect(current?.stripeSubscriptionId).toBe(sub1);
    expect(current?.stripeCustomerId).toBe(customer1);
    expect(current?.stripeStatus).toBe("past_due");
  });

  it("stored canceled, then incomplete_expired: new subscription replaces it (linked), clears unpaid_since and grace_until", async () => {
    const orgId = await createTestOrg(platformSql);
    await setMode(platformSql, orgId, "self_serve");

    const customer1 = token("cus");
    const sub1 = token("sub");
    await linkSubscription(platformSql, orgId, customer1, sub1, "canceled");

    // Artificially set unpaid_since and grace_until to simulate unpaid history
    const unpaidTime = new Date("2026-10-10T00:00:00.000Z");
    const graceTime = new Date("2026-10-17T00:00:00.000Z");
    await platformSql`
      update platform.billing_accounts
      set unpaid_since = ${unpaidTime}, grace_until = ${graceTime}
      where organisation_id = ${orgId}::uuid
    `;

    const customer2 = token("cus");
    const sub2 = token("sub");
    const res1 = await linkSubscription(platformSql, orgId, customer2, sub2, "active");
    expect(res1).toBe("linked");

    const rowAfterCanceled = await readAccount(platformSql, orgId);
    expect(rowAfterCanceled?.stripeSubscriptionId).toBe(sub2);
    expect(rowAfterCanceled?.stripeCustomerId).toBe(customer2);
    expect(rowAfterCanceled?.stripeStatus).toBe("active");
    expect(rowAfterCanceled?.unpaidSince).toBeNull();
    expect(rowAfterCanceled?.graceUntil).toBeNull();

    // Now set status to incomplete_expired and re-populate unpaid_since / grace_until
    await platformSql`
      update platform.billing_accounts
      set
        stripe_status = 'incomplete_expired',
        unpaid_since = ${unpaidTime},
        grace_until = ${graceTime}
      where organisation_id = ${orgId}::uuid
    `;

    const customer3 = token("cus");
    const sub3 = token("sub");
    const res2 = await linkSubscription(platformSql, orgId, customer3, sub3, "incomplete");
    expect(res2).toBe("linked");

    const rowAfterIncompleteExpired = await readAccount(platformSql, orgId);
    expect(rowAfterIncompleteExpired?.stripeSubscriptionId).toBe(sub3);
    expect(rowAfterIncompleteExpired?.stripeCustomerId).toBe(customer3);
    expect(rowAfterIncompleteExpired?.stripeStatus).toBe("incomplete");
    expect(rowAfterIncompleteExpired?.unpaidSince).toBeNull();
    expect(rowAfterIncompleteExpired?.graceUntil).toBeNull();
  });

  it("linkSubscription rejects empty or null status to enforce non-null status invariant", async () => {
    const orgId = await createTestOrg(platformSql);
    await setMode(platformSql, orgId, "self_serve");

    await expect(
      linkSubscription(platformSql, orgId, token("cus"), token("sub"), ""),
    ).rejects.toThrow();

    await expect(
      linkSubscription(platformSql, orgId, token("cus"), token("sub"), null as unknown as string),
    ).rejects.toThrow();
  });

  it("two organisations: linking in A never touches B", async () => {
    const orgA = await createTestOrg(platformSql);
    const orgB = await createTestOrg(platformSql);
    await setMode(platformSql, orgA, "self_serve");
    await setMode(platformSql, orgB, "self_serve");

    const cusA = token("cus");
    const subA = token("sub");
    const cusB = token("cus");
    const subB = token("sub");

    // Link A and B with their own subscriptions
    await linkSubscription(platformSql, orgA, cusA, subA, "active");
    await linkSubscription(platformSql, orgB, cusB, subB, "active");

    const accountBBefore = await readAccount(platformSql, orgB);
    expect(accountBBefore?.stripeSubscriptionId).toBe(subB);
    expect(accountBBefore?.stripeCustomerId).toBe(cusB);

    // Re-link or update org A (simulate A cancels and gets new sub)
    await platformSql`
      update platform.billing_accounts
      set stripe_status = 'canceled'
      where organisation_id = ${orgA}::uuid
    `;
    const cusA2 = token("cus");
    const subA2 = token("sub");
    const resA = await linkSubscription(platformSql, orgA, cusA2, subA2, "active");
    expect(resA).toBe("linked");

    // Org B is completely unchanged
    const accountBAfter = await readAccount(platformSql, orgB);
    expect(accountBAfter?.stripeSubscriptionId).toBe(subB);
    expect(accountBAfter?.stripeCustomerId).toBe(cusB);
    expect(accountBAfter?.stripeStatus).toBe("active");

    // Attempting duplicate in A leaves B untouched
    const cusA3 = token("cus");
    const subA3 = token("sub");
    await linkSubscription(platformSql, orgA, cusA3, subA3, "active");

    const accountBFinal = await readAccount(platformSql, orgB);
    expect(accountBFinal?.stripeSubscriptionId).toBe(subB);
    expect(accountBFinal?.stripeCustomerId).toBe(cusB);
  });

  it("linkSubscription serialises on row lock: concurrent link sees committed subscription as duplicate", async () => {
    const orgId = await createTestOrg(platformSql);
    await setMode(platformSql, orgId, "self_serve");

    const holder = await platformSql.reserve();
    let committed = false;
    try {
      await holder`begin`;
      await holder`
        select organisation_id
        from platform.billing_accounts
        where organisation_id = ${orgId}::uuid
        for update
      `;

      const cusB = token("cus");
      const subB = token("sub");
      const linkPromise = linkSubscription(platformSql, orgId, cusB, subB, "active");

      let lockCount = 0;
      for (let i = 0; i < 5000; i++) {
        const rows = await platformSql<{ count: string }[]>`
          select count(*)::text as count
          from pg_stat_activity
          where wait_event_type = 'Lock'
            and query like '%billing_accounts%'
            and pid != pg_backend_pid()
        `;
        lockCount = Number(rows[0]?.count ?? "0");
        if (lockCount === 1) {
          break;
        }
      }
      expect(lockCount).toBe(1);

      const cusA = token("cus");
      const subA = token("sub");
      await holder`
        update platform.billing_accounts
        set
          stripe_customer_id = ${cusA},
          stripe_subscription_id = ${subA},
          stripe_status = 'active'
        where organisation_id = ${orgId}::uuid
      `;
      await holder`commit`;
      committed = true;

      const res = await linkPromise;
      expect(res).toBe("duplicate");

      const stored = await readAccount(platformSql, orgId);
      expect(stored?.stripeSubscriptionId).toBe(subA);
      expect(stored?.stripeCustomerId).toBe(cusA);
    } finally {
      if (!committed) {
        try {
          await holder`rollback`;
        } catch {
          // ignore
        }
      }
      holder.release();
    }
  });

  it("setAccountTaxRate updates only that organisation's tax_rate_id; org B unchanged", async () => {
    const orgA = await createTestOrg(platformSql);
    const orgB = await createTestOrg(platformSql);
    await setMode(platformSql, orgA, "self_serve");
    await setMode(platformSql, orgB, "self_serve");

    const taxRateA = token("txr");
    await setAccountTaxRate(platformSql, orgA, taxRateA);

    const accountA = await readAccount(platformSql, orgA);
    expect(accountA?.taxRateId).toBe(taxRateA);

    const accountB = await readAccount(platformSql, orgB);
    expect(accountB?.taxRateId).toBeNull();
  });
});
