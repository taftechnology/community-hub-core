import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextPlatformSql } from "@community-hub/db/plaintext";
import { assignPlan, currentPlan, setPlanBilling, upsertPlan } from "@community-hub/entitlements";
import type { Sql } from "postgres";
import postgres from "postgres";

import type { StripeBilling, StripeSubscription } from "../domain/port.js";
import { linkSubscription, readAccount, setMode } from "./accounts.js";
import { applySubscription, syncQuantity } from "./apply.js";

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

function commSlug(): string {
  counter += 1;
  return `comm-${counter}-${newId().replaceAll("-", "").toLowerCase()}`;
}

async function createTestOrg(sql: Sql): Promise<string> {
  const orgId = newId();
  await sql`
    insert into platform.organisations (id, slug, region, kind)
    values (${orgId}::uuid, ${orgSlug()}, 'au', 'explicit')
  `;
  return orgId;
}

async function createTestCommunity(sql: Sql, orgId: string): Promise<string> {
  const commId = newId();
  await sql`
    insert into platform.communities (id, organisation_id, slug, region)
    values (${commId}::uuid, ${orgId}::uuid, ${commSlug()}, 'au')
  `;
  return commId;
}

describe("apply subscription integration", () => {
  let platformSql: Sql;
  let runtime: Runtime;

  beforeAll(async () => {
    runtime = loadRuntime();
    const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }
    platformSql = createPlaintextPlatformSql(platformUrl(runtime));

    // Ensure starter and growth test plans exist with expected lookup keys
    await upsertPlan(platformSql, {
      key: "starter",
      entitlements: [{ key: "members.view", limit: null }],
    });
    await setPlanBilling(platformSql, "starter", {
      stripeLookupKey: "starter_monthly",
      trialEligible: true,
    });

    await upsertPlan(platformSql, {
      key: "growth",
      entitlements: [
        { key: "members.view", limit: null },
        { key: "members.manage", limit: null },
      ],
    });
    await setPlanBilling(platformSql, "growth", {
      stripeLookupKey: "growth_monthly",
      trialEligible: false,
    });
  });

  afterAll(async () => {
    await platformSql.end({ timeout: 1 });
  });

  it("mirrored columns equal the port's answer, and unlinked returns unlinked", async () => {
    const orgId = await createTestOrg(platformSql);
    await setMode(platformSql, orgId, "self_serve");

    const customerId = token("cus");
    const subscriptionId = token("sub");
    await linkSubscription(platformSql, orgId, customerId, subscriptionId, "active");

    const now = new Date("2026-10-17T12:00:00.000Z");
    const periodEnd = new Date("2026-11-17T12:00:00.000Z");
    const trialEnd = new Date("2026-10-25T12:00:00.000Z");

    const fakeSubscription: StripeSubscription = {
      id: subscriptionId,
      customerId,
      status: "active",
      lookupKey: "starter_monthly",
      quantity: 3,
      currentPeriodEnd: periodEnd,
      trialEnd,
      taxRateId: "txr_mirrored",
      organisationIdMetadata: orgId,
    };

    const port: Pick<StripeBilling, "retrieveSubscription"> = {
      retrieveSubscription: async (subId: string) => {
        expect(subId).toBe(subscriptionId);
        return fakeSubscription;
      },
    };

    const result = await applySubscription(platformSql, port, subscriptionId, now);
    expect(result).toBe("applied");

    const account = await readAccount(platformSql, orgId);
    expect(account).not.toBeNull();
    expect(account?.stripeCustomerId).toBe(customerId);
    expect(account?.stripeSubscriptionId).toBe(subscriptionId);
    expect(account?.stripeStatus).toBe("active");
    expect(account?.planLookupKey).toBe("starter_monthly");
    expect(account?.quantity).toBe(3);
    expect(account?.currentPeriodEnd?.getTime()).toBe(periodEnd.getTime());
    expect(account?.trialEnd?.getTime()).toBe(trialEnd.getTime());
    expect(account?.taxRateId).toBe("txr_mirrored");
    expect(account?.syncedAt?.getTime()).toBe(now.getTime());

    // Unlinked subscription returns unlinked
    const unlinkedResult = await applySubscription(platformSql, port, token("sub_unlinked"), now);
    expect(unlinkedResult).toBe("unlinked");
  });

  it("lock: A holds via afterLock, B waits — prove B blocked by pg_stat_activity Lock, B port spy 0 calls, release A, B synced_at later, grace_until set once", async () => {
    const orgId = await createTestOrg(platformSql);
    await setMode(platformSql, orgId, "self_serve");

    const customerId = token("cus");
    const subscriptionId = token("sub");
    await linkSubscription(platformSql, orgId, customerId, subscriptionId, "active");

    const bSql = postgres(platformUrl(runtime), {
      max: 1,
      prepare: true,
      onnotice: () => undefined,
    });

    try {
      const bPidRows = await bSql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const bPid = bPidRows[0]!.pid;

      const nowA = new Date("2026-10-17T10:00:00.000Z");
      const nowB = new Date("2026-10-17T11:00:00.000Z");

      let resolveLocked!: () => void;
      const lockedPromise = new Promise<void>((resolve) => {
        resolveLocked = resolve;
      });

      let resolveRelease!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });

      let bPortCalls = 0;

      const portA: Pick<StripeBilling, "retrieveSubscription"> = {
        retrieveSubscription: async (subId) => ({
          id: subId,
          customerId,
          status: "unpaid",
          lookupKey: "starter_monthly",
          quantity: 1,
          currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
          trialEnd: null,
          taxRateId: null,
          organisationIdMetadata: orgId,
        }),
      };

      const portB: Pick<StripeBilling, "retrieveSubscription"> = {
        retrieveSubscription: async (subId) => {
          bPortCalls += 1;
          return {
            id: subId,
            customerId,
            status: "unpaid",
            lookupKey: "starter_monthly",
            quantity: 1,
            currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
            trialEnd: null,
            taxRateId: null,
            organisationIdMetadata: orgId,
          };
        },
      };

      const applyAPromise = applySubscription(platformSql, portA, subscriptionId, nowA, {
        afterLock: async () => {
          resolveLocked();
          await releasePromise;
        },
      });

      await lockedPromise;

      const applyBPromise = applySubscription(bSql, portB, subscriptionId, nowB);

      let lockSeen = false;
      for (let i = 0; i < 200; i++) {
        if (bPortCalls > 0) {
          break;
        }
        const rows = await platformSql<{ wait_event_type: string | null }[]>`
          select wait_event_type
          from pg_stat_activity
          where pid = ${bPid}
        `;
        if (rows[0]?.wait_event_type === "Lock") {
          lockSeen = true;
          break;
        }
      }

      expect(bPortCalls).toBe(0);
      expect(lockSeen).toBe(true);

      resolveRelease();

      const [resA, resB] = await Promise.all([applyAPromise, applyBPromise]);
      expect(resA).toBe("applied");
      expect(resB).toBe("applied");

      const finalAccount = await readAccount(platformSql, orgId);
      expect(finalAccount).not.toBeNull();
      expect(finalAccount?.syncedAt?.getTime()).toBe(nowB.getTime());

      // Grace until set once on entry into unpaid by A
      const expectedGrace = new Date(nowA.getTime() + 7 * 86_400_000);
      expect(finalAccount?.graceUntil?.getTime()).toBe(expectedGrace.getTime());
      expect(finalAccount?.unpaidSince?.getTime()).toBe(nowA.getTime());
    } finally {
      await bSql.end({ timeout: 1 });
    }
  });

  it("plans: self_serve plan change calls assignPlan once, same key twice leaves custom allocation intact, invoiced org never changes organisation_plans or allocations, unknown key returns unknown_price", async () => {
    // 1. self_serve organisation going from starter_monthly to growth_monthly calls assignPlan once
    const orgId = await createTestOrg(platformSql);
    const commId = await createTestCommunity(platformSql, orgId);
    await setMode(platformSql, orgId, "self_serve");

    // Initially assign starter plan
    await assignPlan(platformSql, {
      organisationId: orgId,
      planKey: "starter",
      now: new Date("2026-10-17T09:00:00.000Z"),
    });

    const subId = token("sub");
    await linkSubscription(platformSql, orgId, token("cus"), subId, "active");

    const portGrowth: Pick<StripeBilling, "retrieveSubscription"> = {
      retrieveSubscription: async (id) => ({
        id,
        customerId: token("cus"),
        status: "active",
        lookupKey: "growth_monthly",
        quantity: 1,
        currentPeriodEnd: new Date("2026-11-17T00:00:00.000Z"),
        trialEnd: null,
        taxRateId: null,
        organisationIdMetadata: orgId,
      }),
    };

    const res1 = await applySubscription(
      platformSql,
      portGrowth,
      subId,
      new Date("2026-10-17T10:00:00.000Z"),
    );
    expect(res1).toBe("applied");

    const planAfterGrowth = await currentPlan(platformSql, orgId);
    expect(planAfterGrowth?.key).toBe("growth");

    // 2. Second apply with same key leaves a custom community_allocations row intact
    await platformSql`
      insert into platform.community_allocations (community_id, entitlement_key)
      values (${commId}::uuid, 'members.manage')
      on conflict do nothing
    `;
    // Insert custom allocation outside the plan
    await platformSql`
      insert into platform.community_allocations (community_id, entitlement_key)
      values (${commId}::uuid, 'custom.feature')
    `;

    const res2 = await applySubscription(
      platformSql,
      portGrowth,
      subId,
      new Date("2026-10-17T11:00:00.000Z"),
    );
    expect(res2).toBe("applied");

    const customAllocRows = await platformSql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_allocations
      where community_id = ${commId}::uuid and entitlement_key = 'custom.feature'
    `;
    expect(customAllocRows.length).toBe(1);

    // 3. An invoiced organisation with a linked subscription never changes its organisation_plans or allocations
    const orgInvoiced = await createTestOrg(platformSql);
    const commInvoiced = await createTestCommunity(platformSql, orgInvoiced);
    await setMode(platformSql, orgInvoiced, "invoiced");

    await assignPlan(platformSql, {
      organisationId: orgInvoiced,
      planKey: "starter",
      now: new Date("2026-10-17T09:00:00.000Z"),
    });

    await platformSql`
      insert into platform.community_allocations (community_id, entitlement_key)
      values (${commInvoiced}::uuid, 'custom.invoiced_feature')
    `;

    const subInvoiced = token("sub");
    // Link directly in platformSql with mode invoiced
    await platformSql`
      update platform.billing_accounts
      set
        stripe_customer_id = ${token("cus")},
        stripe_subscription_id = ${subInvoiced},
        stripe_status = 'active'
      where organisation_id = ${orgInvoiced}::uuid
    `;

    const resInvoiced = await applySubscription(
      platformSql,
      portGrowth,
      subInvoiced,
      new Date("2026-10-17T12:00:00.000Z"),
    );
    expect(resInvoiced).toBe("applied");

    const planInvoicedAfter = await currentPlan(platformSql, orgInvoiced);
    expect(planInvoicedAfter?.key).toBe("starter"); // UNCHANGED

    const invoicedAllocRows = await platformSql<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.community_allocations
      where community_id = ${commInvoiced}::uuid and entitlement_key = 'custom.invoiced_feature'
    `;
    expect(invoicedAllocRows.length).toBe(1); // INTACT

    // 4. An unknown key returns unknown_price
    const orgUnknown = await createTestOrg(platformSql);
    await setMode(platformSql, orgUnknown, "self_serve");
    const subUnknown = token("sub");
    await linkSubscription(platformSql, orgUnknown, token("cus"), subUnknown, "active");

    const portUnknown: Pick<StripeBilling, "retrieveSubscription"> = {
      retrieveSubscription: async (id) => ({
        id,
        customerId: token("cus"),
        status: "active",
        lookupKey: "unknown_lookup_key_xyz",
        quantity: 1,
        currentPeriodEnd: new Date("2026-11-17T00:00:00.000Z"),
        trialEnd: null,
        taxRateId: null,
        organisationIdMetadata: orgUnknown,
      }),
    };

    const resUnknown = await applySubscription(
      platformSql,
      portUnknown,
      subUnknown,
      new Date("2026-10-17T13:00:00.000Z"),
    );
    expect(resUnknown).toBe("unknown_price");
  });

  it("trial: trialing apply sets trial_used_at; a later apply leaves it unchanged", async () => {
    const orgId = await createTestOrg(platformSql);
    await setMode(platformSql, orgId, "self_serve");

    const subId = token("sub");
    await linkSubscription(platformSql, orgId, token("cus"), subId, "trialing");

    const now1 = new Date("2026-10-17T10:00:00.000Z");
    const portTrialing: Pick<StripeBilling, "retrieveSubscription"> = {
      retrieveSubscription: async (id) => ({
        id,
        customerId: token("cus"),
        status: "trialing",
        lookupKey: "starter_monthly",
        quantity: 1,
        currentPeriodEnd: new Date("2026-11-17T00:00:00.000Z"),
        trialEnd: new Date("2026-11-17T00:00:00.000Z"),
        taxRateId: null,
        organisationIdMetadata: orgId,
      }),
    };

    const res1 = await applySubscription(platformSql, portTrialing, subId, now1);
    expect(res1).toBe("applied");

    const accountAfter1 = await readAccount(platformSql, orgId);
    expect(accountAfter1?.trialUsedAt?.getTime()).toBe(now1.getTime());

    // Later apply with active status (or later trialing) leaves trial_used_at unchanged
    const now2 = new Date("2026-10-25T10:00:00.000Z");
    const portActive: Pick<StripeBilling, "retrieveSubscription"> = {
      retrieveSubscription: async (id) => ({
        id,
        customerId: token("cus"),
        status: "active",
        lookupKey: "starter_monthly",
        quantity: 1,
        currentPeriodEnd: new Date("2026-11-17T00:00:00.000Z"),
        trialEnd: null,
        taxRateId: null,
        organisationIdMetadata: orgId,
      }),
    };

    const res2 = await applySubscription(platformSql, portActive, subId, now2);
    expect(res2).toBe("applied");

    const accountAfter2 = await readAccount(platformSql, orgId);
    expect(accountAfter2?.trialUsedAt?.getTime()).toBe(now1.getTime());
  });

  it("two organisations: applying A's subscription never changes B's row", async () => {
    const orgA = await createTestOrg(platformSql);
    const orgB = await createTestOrg(platformSql);
    await setMode(platformSql, orgA, "self_serve");
    await setMode(platformSql, orgB, "self_serve");

    const subA = token("sub_a");
    const subB = token("sub_b");
    const cusA = token("cus_a");
    const cusB = token("cus_b");

    await linkSubscription(platformSql, orgA, cusA, subA, "active");
    await linkSubscription(platformSql, orgB, cusB, subB, "active");

    const initialB = await readAccount(platformSql, orgB);
    expect(initialB?.stripeSubscriptionId).toBe(subB);

    const now = new Date("2026-10-17T15:00:00.000Z");
    const portA: Pick<StripeBilling, "retrieveSubscription"> = {
      retrieveSubscription: async (id) => ({
        id,
        customerId: cusA,
        status: "active",
        lookupKey: "starter_monthly",
        quantity: 5,
        currentPeriodEnd: new Date("2026-11-17T00:00:00.000Z"),
        trialEnd: null,
        taxRateId: "txr_a",
        organisationIdMetadata: orgA,
      }),
    };

    const resA = await applySubscription(platformSql, portA, subA, now);
    expect(resA).toBe("applied");

    const currentB = await readAccount(platformSql, orgB);
    expect(currentB).toEqual(initialB);
  });

  it("syncQuantity reads community count and calls port.updateQuantity with create_prorations; rejects if unlinked", async () => {
    const orgId = await createTestOrg(platformSql);
    await setMode(platformSql, orgId, "self_serve");

    await createTestCommunity(platformSql, orgId);
    await createTestCommunity(platformSql, orgId);
    await createTestCommunity(platformSql, orgId);

    const subId = token("sub");
    await linkSubscription(platformSql, orgId, token("cus"), subId, "active");

    let updatedInput: unknown = null;
    const port: Pick<StripeBilling, "updateQuantity"> = {
      updateQuantity: async (input) => {
        updatedInput = input;
      },
    };

    const idempotencyKey = token("key");
    await syncQuantity(platformSql, port, orgId, idempotencyKey);

    expect(updatedInput).toEqual({
      subscriptionId: subId,
      quantity: 3,
      prorationBehavior: "create_prorations",
      idempotencyKey,
    });

    // Rejects if org has no linked subscription
    const orgUnlinked = await createTestOrg(platformSql);
    await expect(syncQuantity(platformSql, port, orgUnlinked, token("key"))).rejects.toThrow();
  });
});
