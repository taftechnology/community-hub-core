import type { Account } from "./state.js";

export interface TrialPlanInput {
  readonly trialEligible: boolean;
}

export interface TrialSettingsInput {
  readonly trialDays: number;
}

export function trialDaysFor(
  plan: TrialPlanInput,
  account: Account | { readonly trialUsedAt?: Date | null } | null,
  settings: TrialSettingsInput,
): number | undefined {
  if (!plan.trialEligible) {
    return undefined;
  }

  if (account?.trialUsedAt != null) {
    return undefined;
  }

  if (settings.trialDays <= 0) {
    return undefined;
  }

  return settings.trialDays;
}
