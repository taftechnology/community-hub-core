import type { Sql } from "postgres";

import { EntitlementError } from "../domain/error.js";
import { parsePlanKey } from "../domain/keys.js";

export type PlanLookupResult = {
  key: string;
};

export type CurrentPlanResult = {
  key: string;
  stripeLookupKey: string | null;
  trialEligible: boolean;
};

export type PlanBillingResult = {
  stripeLookupKey: string | null;
  trialEligible: boolean;
};

export type SetPlanBillingInput = {
  stripeLookupKey: string | null;
  trialEligible: boolean;
};

export async function planByLookupKey(
  sql: Sql,
  lookupKey: string,
): Promise<PlanLookupResult | null> {
  const rows = await sql<{ key: string }[]>`
    select key
    from platform.plans
    where stripe_lookup_key = ${lookupKey}
    limit 1
  `;
  if (rows.length === 0 || !rows[0]) {
    return null;
  }
  return { key: rows[0].key };
}

export async function currentPlan(
  sql: Sql,
  organisationId: string,
): Promise<CurrentPlanResult | null> {
  const rows = await sql<
    {
      key: string;
      stripe_lookup_key: string | null;
      trial_eligible: boolean;
    }[]
  >`
    select
      p.key,
      p.stripe_lookup_key,
      p.trial_eligible
    from platform.organisation_plans op
    inner join platform.plans p on op.plan_id = p.id
    where op.organisation_id = ${organisationId}::uuid
    limit 1
  `;
  if (rows.length === 0 || !rows[0]) {
    return null;
  }
  return {
    key: rows[0].key,
    stripeLookupKey: rows[0].stripe_lookup_key,
    trialEligible: rows[0].trial_eligible,
  };
}

export async function planBilling(sql: Sql, planKey: string): Promise<PlanBillingResult | null> {
  const key = parsePlanKey(planKey);
  const rows = await sql<
    {
      stripe_lookup_key: string | null;
      trial_eligible: boolean;
    }[]
  >`
    select stripe_lookup_key, trial_eligible
    from platform.plans
    where key = ${key}
    limit 1
  `;
  if (rows.length === 0 || !rows[0]) {
    return null;
  }
  return {
    stripeLookupKey: rows[0].stripe_lookup_key,
    trialEligible: rows[0].trial_eligible,
  };
}

export async function setPlanBilling(
  sql: Sql,
  planKey: string,
  input: SetPlanBillingInput,
): Promise<void> {
  const key = parsePlanKey(planKey);
  const result = await sql`
    update platform.plans
    set
      stripe_lookup_key = ${input.stripeLookupKey},
      trial_eligible = ${input.trialEligible}
    where key = ${key}
  `;
  if (result.count === 0) {
    throw new EntitlementError("not_found");
  }
}
