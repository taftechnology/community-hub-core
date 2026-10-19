import { assignPlan, currentPlan, planByLookupKey } from "@community-hub/entitlements";
import { listCommunityIds } from "@community-hub/tenancy";
import type { Sql, TransactionSql } from "postgres";

import type { StripeBilling } from "../domain/port.js";
import { transition } from "../domain/transition.js";
import { readAccount } from "./accounts.js";
import { currentSettings } from "./settings.js";

export interface ApplySubscriptionHooks {
  afterLock?: () => Promise<void>;
}

export type ApplySubscriptionResult = "applied" | "unlinked" | "unknown_price";

type LockedAccountRow = {
  organisation_id: string;
  mode: string;
  stripe_status: string | null;
  unpaid_since: Date | null;
  grace_until: Date | null;
  trial_used_at: Date | null;
};

export async function applySubscription(
  sql: Sql,
  port: Pick<StripeBilling, "retrieveSubscription">,
  subscriptionId: string,
  now: Date,
  hooks?: ApplySubscriptionHooks,
): Promise<ApplySubscriptionResult> {
  const runTx =
    typeof sql.begin === "function"
      ? sql.begin.bind(sql)
      : (sql as unknown as TransactionSql).savepoint.bind(sql);

  const txResult = await runTx(async (tx) => {
    const rows = await tx<LockedAccountRow[]>`
      select
        organisation_id,
        mode,
        stripe_status,
        unpaid_since,
        grace_until,
        trial_used_at
      from platform.billing_accounts
      where stripe_subscription_id = ${subscriptionId}
      for update
    `;

    if (rows.length === 0 || !rows[0]) {
      return { outcome: "unlinked" as const };
    }

    const account = rows[0];

    await hooks?.afterLock?.();

    const settings = await currentSettings(tx);
    if (!settings) {
      throw new Error("BILLING_SETTINGS_MISSING");
    }
    const sub = await port.retrieveSubscription(subscriptionId);

    const graceDays = settings.graceDays;
    const trans = transition(
      {
        stripeStatus: account.stripe_status,
        unpaidSince: account.unpaid_since,
        graceUntil: account.grace_until,
      },
      sub.status,
      now,
      graceDays,
    );

    const isTrial = sub.status === "trialing" || sub.trialEnd !== null;

    await tx`
      update platform.billing_accounts
      set
        stripe_customer_id = coalesce(${sub.customerId}, stripe_customer_id),
        stripe_subscription_id = ${subscriptionId},
        stripe_status = ${sub.status},
        plan_lookup_key = ${sub.lookupKey},
        quantity = ${sub.quantity},
        current_period_end = ${sub.currentPeriodEnd},
        trial_end = ${sub.trialEnd},
        trial_used_at = ${isTrial ? tx`coalesce(trial_used_at, ${now})` : tx`trial_used_at`},
        unpaid_since = ${trans.unpaidSince},
        grace_until = ${trans.graceUntil},
        tax_rate_id = ${sub.taxRateId},
        synced_at = ${now}
      where organisation_id = ${account.organisation_id}::uuid
    `;

    return {
      outcome: "committed" as const,
      organisationId: account.organisation_id,
      mode: account.mode,
      lookupKey: sub.lookupKey,
    };
  });

  if (txResult.outcome === "unlinked") {
    return "unlinked";
  }

  if (txResult.mode === "self_serve") {
    if (!txResult.lookupKey) {
      return "unknown_price";
    }

    const matchedPlan = await planByLookupKey(sql, txResult.lookupKey);
    if (!matchedPlan) {
      return "unknown_price";
    }

    const current = await currentPlan(sql, txResult.organisationId);
    if (!current || current.key !== matchedPlan.key) {
      await assignPlan(sql, {
        organisationId: txResult.organisationId,
        planKey: matchedPlan.key,
        now,
      });
    }
  }

  return "applied";
}

export async function syncQuantity(
  sql: Sql,
  port: Pick<StripeBilling, "updateQuantity">,
  orgId: string,
  idempotencyKey: string,
): Promise<void> {
  const account = await readAccount(sql, orgId);
  if (!account || !account.stripeSubscriptionId) {
    throw new Error("BILLING_NOT_LINKED");
  }

  const communityIds = await listCommunityIds(sql, orgId);
  await port.updateQuantity({
    subscriptionId: account.stripeSubscriptionId,
    quantity: communityIds.length,
    prorationBehavior: "create_prorations",
    idempotencyKey,
  });
}
