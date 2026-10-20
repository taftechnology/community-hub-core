import type { Sql } from "postgres";

export type CheckoutPlan = {
  readonly key: string;
  readonly trialEligible: boolean;
};

export async function listCheckoutPlans(sql: Sql): Promise<readonly CheckoutPlan[]> {
  const rows = await sql<
    {
      key: string;
      trial_eligible: boolean;
    }[]
  >`
    select key, trial_eligible
    from platform.plans
    where stripe_lookup_key is not null
    order by key asc
  `;
  return rows.map((row) => ({
    key: row.key,
    trialEligible: row.trial_eligible,
  }));
}
