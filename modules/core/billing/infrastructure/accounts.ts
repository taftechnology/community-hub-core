import type { Sql } from "postgres";

import type { BillingMode } from "../domain/state.js";

export type LinkSubscriptionResult = "linked" | "duplicate" | "invoiced" | "missing";

export interface BillingAccount {
  readonly organisationId: string;
  readonly mode: BillingMode;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripeStatus: string | null;
  readonly planLookupKey: string | null;
  readonly quantity: number | null;
  readonly currentPeriodEnd: Date | null;
  readonly trialEnd: Date | null;
  readonly trialUsedAt: Date | null;
  readonly unpaidSince: Date | null;
  readonly graceUntil: Date | null;
  readonly taxRateId: string | null;
  readonly syncedAt: Date | null;
}

type BillingAccountRow = {
  organisation_id: string;
  mode: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_status: string | null;
  plan_lookup_key: string | null;
  quantity: number | null;
  current_period_end: Date | null;
  trial_end: Date | null;
  trial_used_at: Date | null;
  unpaid_since: Date | null;
  grace_until: Date | null;
  tax_rate_id: string | null;
  synced_at: Date | null;
};

function toBillingAccount(row: BillingAccountRow): BillingAccount {
  return {
    organisationId: row.organisation_id,
    mode: row.mode as BillingMode,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripeStatus: row.stripe_status,
    planLookupKey: row.plan_lookup_key,
    quantity: row.quantity,
    currentPeriodEnd: row.current_period_end,
    trialEnd: row.trial_end,
    trialUsedAt: row.trial_used_at,
    unpaidSince: row.unpaid_since,
    graceUntil: row.grace_until,
    taxRateId: row.tax_rate_id,
    syncedAt: row.synced_at,
  };
}

export async function readAccount(
  sql: Sql,
  organisationId: string,
): Promise<BillingAccount | null> {
  const rows = await sql<BillingAccountRow[]>`
    select
      organisation_id,
      mode,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_status,
      plan_lookup_key,
      quantity,
      current_period_end,
      trial_end,
      trial_used_at,
      unpaid_since,
      grace_until,
      tax_rate_id,
      synced_at
    from platform.billing_accounts
    where organisation_id = ${organisationId}::uuid
    limit 1
  `;
  if (rows.length === 0 || !rows[0]) {
    return null;
  }
  return toBillingAccount(rows[0]);
}

export async function findBySubscription(
  sql: Sql,
  subscriptionId: string,
): Promise<BillingAccount | null> {
  const rows = await sql<BillingAccountRow[]>`
    select
      organisation_id,
      mode,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_status,
      plan_lookup_key,
      quantity,
      current_period_end,
      trial_end,
      trial_used_at,
      unpaid_since,
      grace_until,
      tax_rate_id,
      synced_at
    from platform.billing_accounts
    where stripe_subscription_id = ${subscriptionId}
    limit 1
  `;
  if (rows.length === 0 || !rows[0]) {
    return null;
  }
  return toBillingAccount(rows[0]);
}

export async function findByCustomer(sql: Sql, customerId: string): Promise<BillingAccount | null> {
  const rows = await sql<BillingAccountRow[]>`
    select
      organisation_id,
      mode,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_status,
      plan_lookup_key,
      quantity,
      current_period_end,
      trial_end,
      trial_used_at,
      unpaid_since,
      grace_until,
      tax_rate_id,
      synced_at
    from platform.billing_accounts
    where stripe_customer_id = ${customerId}
    limit 1
  `;
  if (rows.length === 0 || !rows[0]) {
    return null;
  }
  return toBillingAccount(rows[0]);
}

export async function setMode(
  sql: Sql,
  organisationId: string,
  mode: BillingMode,
): Promise<BillingAccount> {
  const rows = await sql<BillingAccountRow[]>`
    insert into platform.billing_accounts (
      organisation_id,
      mode
    ) values (
      ${organisationId}::uuid,
      ${mode}
    )
    on conflict (organisation_id) do update
      set mode = excluded.mode
    returning
      organisation_id,
      mode,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_status,
      plan_lookup_key,
      quantity,
      current_period_end,
      trial_end,
      trial_used_at,
      unpaid_since,
      grace_until,
      tax_rate_id,
      synced_at
  `;
  return toBillingAccount(rows[0]!);
}

export async function linkSubscription(
  sql: Sql,
  organisationId: string,
  customerId: string,
  subscriptionId: string,
  status: string,
): Promise<LinkSubscriptionResult> {
  if (!status || status.trim() === "") {
    throw new Error("status is required when linking a subscription");
  }

  return sql.begin(async (tx) => {
    const orgRows = await tx<{ id: string }[]>`
      select id
      from platform.organisations
      where id = ${organisationId}::uuid
    `;
    if (orgRows.length === 0) {
      return "missing";
    }

    const accountRows = await tx<
      {
        mode: string;
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        stripe_status: string | null;
      }[]
    >`
      select
        mode,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_status
      from platform.billing_accounts
      where organisation_id = ${organisationId}::uuid
      for update
    `;

    if (accountRows.length === 0) {
      return "invoiced";
    }

    const account = accountRows[0]!;
    if (account.mode === "invoiced") {
      return "invoiced";
    }

    const storedSubId = account.stripe_subscription_id;
    const storedStatus = account.stripe_status;

    if (storedSubId === subscriptionId) {
      await tx`
        update platform.billing_accounts
        set
          stripe_customer_id = ${customerId},
          stripe_subscription_id = ${subscriptionId},
          stripe_status = coalesce(stripe_status, ${status})
        where organisation_id = ${organisationId}::uuid
      `;
      return "linked";
    }

    if (storedStatus === "canceled" || storedStatus === "incomplete_expired") {
      await tx`
        update platform.billing_accounts
        set
          stripe_customer_id = ${customerId},
          stripe_subscription_id = ${subscriptionId},
          stripe_status = ${status},
          unpaid_since = null,
          grace_until = null
        where organisation_id = ${organisationId}::uuid
      `;
      return "linked";
    }

    if (storedSubId === null) {
      await tx`
        update platform.billing_accounts
        set
          stripe_customer_id = ${customerId},
          stripe_subscription_id = ${subscriptionId},
          stripe_status = ${status}
        where organisation_id = ${organisationId}::uuid
      `;
      return "linked";
    }

    return "duplicate";
  });
}
