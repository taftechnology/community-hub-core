export class BillingUnavailable extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "BillingUnavailable";
    this.code = code;
  }
}

export interface StripeSubscription {
  readonly id: string;
  readonly customerId: string;
  readonly status: string;
  readonly lookupKey: string | null;
  readonly quantity: number | null;
  readonly currentPeriodEnd: Date | null;
  readonly trialEnd: Date | null;
  readonly taxRateId: string | null;
  readonly organisationIdMetadata: string | null;
}

export interface StripePrice {
  readonly id: string;
  readonly lookupKey?: string | null;
}

export interface StripeTaxRate {
  readonly id: string;
}

export interface StripeProduct {
  readonly id: string;
}

export interface StripeWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly data: {
    readonly object: {
      readonly id: string;
      readonly [key: string]: unknown;
    };
  };
}

export interface CreateCheckoutSessionInput {
  readonly priceId: string;
  readonly quantity: number;
  readonly taxRateId: string;
  readonly trialDays?: number;
  readonly customerId?: string | null;
  readonly organisationId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
}

export interface CheckoutSessionResult {
  readonly url: string;
}

export interface CreatePortalSessionInput {
  readonly customerId: string;
  readonly returnUrl: string;
  readonly idempotencyKey: string;
}

export interface PortalSessionResult {
  readonly url: string;
}

export interface CreateTaxRateInput {
  readonly percentage: number;
  readonly inclusive: boolean;
  readonly country: string;
  readonly displayName?: string;
  readonly display_name?: string;
  readonly idempotencyKey: string;
}

export interface UpdateQuantityInput {
  readonly subscriptionId: string;
  readonly quantity: number;
  readonly prorationBehavior?: "create_prorations" | "none" | "always_invoice" | string;
  readonly proration_behavior?: "create_prorations" | "none" | "always_invoice" | string;
  readonly idempotencyKey: string;
}

export interface UpdateDefaultTaxRateInput {
  readonly subscriptionId: string;
  readonly taxRateId: string;
  readonly idempotencyKey: string;
}

export interface EnsureProductInput {
  readonly name: string;
  readonly lookupKey: string;
  readonly idempotencyKey: string;
}

export interface EnsurePriceInput {
  readonly productId: string;
  readonly lookupKey: string;
  readonly currency: string;
  readonly unitAmount: number;
  readonly interval: "month" | "year" | string;
  readonly taxBehavior: "inclusive" | "exclusive" | "unspecified" | string;
  readonly idempotencyKey: string;
}

export interface StripeBilling {
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult>;
  createPortalSession(input: CreatePortalSessionInput): Promise<PortalSessionResult>;
  retrieveSubscription(subscriptionId: string): Promise<StripeSubscription>;
  subscriptionForInvoice(invoiceId: string): Promise<string | null>;
  findPriceByLookupKey(lookupKey: string): Promise<StripePrice | null>;
  createTaxRate(input: CreateTaxRateInput): Promise<StripeTaxRate>;
  updateQuantity(input: UpdateQuantityInput): Promise<void>;
  updateDefaultTaxRate(input: UpdateDefaultTaxRateInput): Promise<void>;
  verifyEvent(
    rawBody: Uint8Array,
    header: string,
  ): Promise<StripeWebhookEvent> | StripeWebhookEvent;
  ensureProduct(input: EnsureProductInput): Promise<StripeProduct>;
  ensurePrice(input: EnsurePriceInput): Promise<StripePrice>;
}
