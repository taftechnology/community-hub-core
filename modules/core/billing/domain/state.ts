export type BillingMode = "invoiced" | "self_serve";

export type BillingState = "invoiced" | "none" | "ok" | "retrying" | "grace" | "read_only";

export interface Account {
  readonly mode: BillingMode | string;
  readonly stripeSubscriptionId?: string | null;
  readonly stripeStatus?: string | null;
  readonly graceUntil?: Date | null;
  readonly trialUsedAt?: Date | null;
  readonly unpaidSince?: Date | null;
}

export function deriveState(account: Account | null, now: Date): BillingState {
  if (!account || account.mode === "invoiced") {
    return "invoiced";
  }

  if (account.mode === "self_serve") {
    if (!account.stripeSubscriptionId || !account.stripeStatus) {
      return "none";
    }

    switch (account.stripeStatus) {
      case "incomplete":
        return "none";
      case "trialing":
      case "active":
        return "ok";
      case "past_due":
        return "retrying";
      case "unpaid":
        if (account.graceUntil && now.getTime() < account.graceUntil.getTime()) {
          return "grace";
        }
        return "read_only";
      case "canceled":
      case "incomplete_expired":
        return "read_only";
      default:
        return "read_only";
    }
  }

  return "invoiced";
}
