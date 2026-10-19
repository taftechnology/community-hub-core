import { defineAuditAction, defineAuditPurpose } from "@community-hub/kernel/module";

defineAuditAction("billing.permission.denied");
defineAuditPurpose("billing.permission.denied");

export { deriveState, type Account, type BillingMode, type BillingState } from "../domain/state.js";

export { BillingReadOnly, isWritable } from "../domain/writable.js";

export { checkoutDecision, type CheckoutDecision } from "../domain/checkout.js";

export { trialDaysFor, type TrialPlanInput, type TrialSettingsInput } from "../domain/trial.js";

export {
  transition,
  type TransitionPrevious,
  type TransitionResult,
} from "../domain/transition.js";

export {
  BillingUnavailable,
  type BillingErrorCode,
  type CheckoutSessionResult,
  type CreateCheckoutSessionInput,
  type CreatePortalSessionInput,
  type CreateTaxRateInput,
  type EnsurePriceInput,
  type EnsureProductInput,
  type PortalSessionResult,
  type StripeBilling,
  type StripePrice,
  type StripeProduct,
  type StripeSubscription,
  type StripeTaxRate,
  type StripeWebhookEvent,
  type UpdateDefaultTaxRateInput,
  type UpdateQuantityInput,
} from "../domain/port.js";

export {
  findByCustomer,
  findBySubscription,
  linkSubscription,
  readAccount,
  setAccountTaxRate,
  setMode,
  type BillingAccount,
  type LinkSubscriptionResult,
} from "../infrastructure/accounts.js";

export { assertWritable } from "../infrastructure/writable.js";

export {
  isReplayOutcome,
  markOutcome,
  recordReceived,
  type BillingEventOutcome,
} from "../infrastructure/events.js";

export {
  currentSettings,
  insertSettings,
  type BillingSettings,
  type InsertSettingsInput,
} from "../infrastructure/settings.js";

export {
  applySubscription,
  syncQuantity,
  type ApplySubscriptionHooks,
  type ApplySubscriptionResult,
} from "../infrastructure/apply.js";
