import type { Account } from "./state.js";

export type CheckoutDecision = "allowed" | "conflict";

export function checkoutDecision(account: Account | null): CheckoutDecision {
  if (!account || account.mode !== "self_serve") {
    return "conflict";
  }

  if (!account.stripeSubscriptionId) {
    return "allowed";
  }

  if (account.stripeStatus === "canceled" || account.stripeStatus === "incomplete_expired") {
    return "allowed";
  }

  return "conflict";
}
