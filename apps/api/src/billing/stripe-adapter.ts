import Stripe from "stripe";
import {
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
} from "@community-hub/billing";

import type { BillingSecret, BillingSecretValues } from "./secret.js";

export const PINNED_STRIPE_API_VERSION = "2026-09-30.endive" as const;

export class WebhookSignatureInvalid extends Error {
  constructor() {
    super("WEBHOOK_SIGNATURE_INVALID");
    this.name = "WebhookSignatureInvalid";
  }
}

export interface StripeClient {
  readonly checkout: {
    readonly sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ): Promise<Stripe.Checkout.Session>;
    };
  };
  readonly billingPortal: {
    readonly sessions: {
      create(
        params: Stripe.BillingPortal.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ): Promise<Stripe.BillingPortal.Session>;
    };
  };
  readonly subscriptions: {
    retrieve(
      id: string,
      params?: Stripe.SubscriptionRetrieveParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Subscription>;
    update(
      id: string,
      params?: Stripe.SubscriptionUpdateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Subscription>;
  };
  readonly invoices: {
    retrieve(
      id: string,
      params?: Stripe.InvoiceRetrieveParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Invoice>;
  };
  readonly prices: {
    list(
      params?: Stripe.PriceListParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.ApiList<Stripe.Price>>;
    create(
      params: Stripe.PriceCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Price>;
  };
  readonly taxRates: {
    create(
      params: Stripe.TaxRateCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.TaxRate>;
  };
  readonly products: {
    search(
      params: Stripe.ProductSearchParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.ApiSearchResult<Stripe.Product>>;
    create(
      params: Stripe.ProductCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Product>;
  };
}

export function defaultStripeClient(secretKey: string): StripeClient {
  return new Stripe(secretKey, {
    apiVersion: PINNED_STRIPE_API_VERSION,
    maxNetworkRetries: 1,
    timeout: 10000,
  });
}

export type StripeCallLogFields = {
  readonly operation: "stripe_call";
  readonly outcome: "ok" | "failed";
  readonly errorCode?: string;
};

export interface CreateStripeBillingOptions {
  readonly secret: BillingSecret;
  readonly clientFor?: (secretKey: string) => StripeClient;
  readonly info?: (fields: StripeCallLogFields) => void;
}

function mapStripeError(error: unknown): BillingErrorCode {
  if (error instanceof BillingUnavailable) {
    return error.code;
  }
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    const type = typeof err.type === "string" ? err.type : "";
    const name = typeof err.name === "string" ? err.name : "";

    if (
      type === "StripeAuthenticationError" ||
      type === "authentication_error" ||
      name === "StripeAuthenticationError" ||
      err.statusCode === 401
    ) {
      return "STRIPE_AUTH";
    }
    if (
      type === "StripeRateLimitError" ||
      type === "rate_limit_error" ||
      name === "StripeRateLimitError" ||
      err.statusCode === 429
    ) {
      return "STRIPE_RATE_LIMIT";
    }
    if (
      type === "StripeInvalidRequestError" ||
      type === "invalid_request_error" ||
      name === "StripeInvalidRequestError" ||
      type === "StripeIdempotencyError" ||
      type === "idempotency_error" ||
      name === "StripeIdempotencyError" ||
      type === "StripeCardError" ||
      type === "card_error" ||
      name === "StripeCardError" ||
      err.statusCode === 400
    ) {
      return "STRIPE_INVALID_REQUEST";
    }
    if (
      type === "StripeConnectionError" ||
      type === "connection_error" ||
      name === "StripeConnectionError"
    ) {
      return "STRIPE_CONNECTION";
    }
    if (type === "StripeAPIError" || type === "api_error" || name === "StripeAPIError") {
      return "STRIPE_API";
    }
  }
  return "STRIPE_API";
}

export const rejectingStripeBilling: StripeBilling = {
  async createCheckoutSession() {
    throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
  },
  async createPortalSession() {
    throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
  },
  async retrieveSubscription() {
    throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
  },
  async subscriptionForInvoice() {
    throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
  },
  async findPriceByLookupKey() {
    throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
  },
  async createTaxRate() {
    throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
  },
  async updateQuantity() {
    throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
  },
  async updateDefaultTaxRate() {
    throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
  },
  async verifyEvent() {
    throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
  },
  async ensureProduct() {
    throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
  },
  async ensurePrice() {
    throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
  },
};

export function createStripeBilling(options: CreateStripeBillingOptions): StripeBilling {
  const clientFor = options.clientFor ?? defaultStripeClient;
  const info = options.info ?? (() => undefined);

  async function runStripeCall<T>(fn: (client: StripeClient) => Promise<T>): Promise<T> {
    let secretValues: BillingSecretValues;
    try {
      secretValues = await options.secret.get();
    } catch (error) {
      if (error instanceof BillingUnavailable) {
        info({ operation: "stripe_call", outcome: "failed", errorCode: error.code });
        throw error;
      }
      info({ operation: "stripe_call", outcome: "failed", errorCode: "BILLING_KEY_UNAVAILABLE" });
      throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
    }

    try {
      const client = clientFor(secretValues.secretKey);
      const result = await fn(client);
      info({ operation: "stripe_call", outcome: "ok" });
      return result;
    } catch (error) {
      const errorCode = mapStripeError(error);
      if (errorCode === "STRIPE_AUTH") {
        options.secret.invalidate();
      }
      info({ operation: "stripe_call", outcome: "failed", errorCode });
      throw new BillingUnavailable(errorCode);
    }
  }

  return {
    async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult> {
      return runStripeCall(async (client) => {
        const session = await client.checkout.sessions.create(
          {
            mode: "subscription",
            payment_method_collection: "always",
            line_items: [
              {
                price: input.priceId,
                quantity: input.quantity,
              },
            ],
            client_reference_id: input.organisationId,
            metadata: {
              organisation_id: input.organisationId,
            },
            subscription_data: {
              metadata: {
                organisation_id: input.organisationId,
              },
              default_tax_rates: [input.taxRateId],
              ...(input.trialDays !== undefined ? { trial_period_days: input.trialDays } : {}),
            },
            ...(input.customerId ? { customer: input.customerId } : {}),
            success_url: input.successUrl,
            cancel_url: input.cancelUrl,
          },
          { idempotencyKey: input.idempotencyKey },
        );
        if (!session.url) {
          throw new BillingUnavailable("STRIPE_API");
        }
        return { url: session.url };
      });
    },

    async createPortalSession(input: CreatePortalSessionInput): Promise<PortalSessionResult> {
      return runStripeCall(async (client) => {
        const session = await client.billingPortal.sessions.create(
          {
            customer: input.customerId,
            return_url: input.returnUrl,
          },
          { idempotencyKey: input.idempotencyKey },
        );
        return { url: session.url };
      });
    },

    async retrieveSubscription(subscriptionId: string): Promise<StripeSubscription> {
      return runStripeCall(async (client) => {
        const sub = await client.subscriptions.retrieve(subscriptionId);
        const firstItem = sub.items?.data?.[0];
        const price = firstItem?.price;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? "");
        const taxRate = sub.default_tax_rates?.[0];
        const taxRateId = typeof taxRate === "string" ? taxRate : (taxRate?.id ?? null);
        const currentPeriodEnd = firstItem?.current_period_end
          ? new Date(firstItem.current_period_end * 1000)
          : null;
        const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
        return {
          id: sub.id,
          customerId,
          status: sub.status,
          lookupKey: price?.lookup_key ?? null,
          quantity: firstItem?.quantity ?? null,
          currentPeriodEnd,
          trialEnd,
          taxRateId,
          organisationIdMetadata: sub.metadata?.organisation_id ?? null,
        };
      });
    },

    async subscriptionForInvoice(invoiceId: string): Promise<string | null> {
      return runStripeCall(async (client) => {
        const invoice = await client.invoices.retrieve(invoiceId);
        const parent = invoice.parent;
        if (parent?.type === "subscription_details" && parent.subscription_details?.subscription) {
          const sub = parent.subscription_details.subscription;
          return typeof sub === "string" ? sub : sub.id;
        }
        return null;
      });
    },

    async findPriceByLookupKey(lookupKey: string): Promise<StripePrice | null> {
      return runStripeCall(async (client) => {
        const list = await client.prices.list({
          lookup_keys: [lookupKey],
          active: true,
          limit: 1,
        });
        const item = list.data[0];
        if (!item) {
          return null;
        }
        return {
          id: item.id,
          lookupKey: item.lookup_key ?? null,
        };
      });
    },

    async createTaxRate(input: CreateTaxRateInput): Promise<StripeTaxRate> {
      return runStripeCall(async (client) => {
        const rate = await client.taxRates.create(
          {
            percentage: input.percentage,
            inclusive: input.inclusive,
            country: input.country,
            display_name: input.displayName ?? "GST",
          },
          { idempotencyKey: input.idempotencyKey },
        );
        return { id: rate.id };
      });
    },

    async updateQuantity(input: UpdateQuantityInput): Promise<void> {
      return runStripeCall(async (client) => {
        const sub = await client.subscriptions.retrieve(input.subscriptionId);
        const itemId = sub.items?.data?.[0]?.id;
        if (!itemId) {
          throw new BillingUnavailable("STRIPE_API");
        }
        await client.subscriptions.update(
          input.subscriptionId,
          {
            items: [{ id: itemId, quantity: input.quantity }],
            proration_behavior: (input.prorationBehavior ??
              "create_prorations") as Stripe.SubscriptionUpdateParams.ProrationBehavior,
          },
          { idempotencyKey: input.idempotencyKey },
        );
      });
    },

    async updateDefaultTaxRate(input: UpdateDefaultTaxRateInput): Promise<void> {
      return runStripeCall(async (client) => {
        await client.subscriptions.update(
          input.subscriptionId,
          {
            default_tax_rates: [input.taxRateId],
          },
          { idempotencyKey: input.idempotencyKey },
        );
      });
    },

    async ensureProduct(input: EnsureProductInput): Promise<StripeProduct> {
      return runStripeCall(async (client) => {
        const search = await client.products.search({
          query: `metadata['lookup_key']:'${input.lookupKey}'`,
        });
        const existing = search.data[0];
        if (existing) {
          return { id: existing.id };
        }
        const created = await client.products.create(
          {
            name: input.name,
            metadata: { lookup_key: input.lookupKey },
          },
          { idempotencyKey: input.idempotencyKey },
        );
        return { id: created.id };
      });
    },

    async ensurePrice(input: EnsurePriceInput): Promise<StripePrice> {
      return runStripeCall(async (client) => {
        const existing = await client.prices.list({
          lookup_keys: [input.lookupKey],
          active: true,
          limit: 1,
        });
        const item = existing.data[0];
        if (item) {
          return { id: item.id, lookupKey: item.lookup_key ?? null };
        }
        const created = await client.prices.create(
          {
            product: input.productId,
            lookup_key: input.lookupKey,
            currency: input.currency,
            unit_amount: input.unitAmount,
            recurring: { interval: input.interval as Stripe.PriceCreateParams.Recurring.Interval },
            tax_behavior: input.taxBehavior as Stripe.PriceCreateParams.TaxBehavior,
          },
          { idempotencyKey: input.idempotencyKey },
        );
        return { id: created.id, lookupKey: created.lookup_key ?? null };
      });
    },

    async verifyEvent(rawBody: Uint8Array, header: string): Promise<StripeWebhookEvent> {
      const secretValues = await options.secret.get();
      try {
        const event = Stripe.webhooks.constructEvent(
          Buffer.from(rawBody),
          header,
          secretValues.webhookSecret,
          300,
        );
        return {
          id: event.id,
          type: event.type,
          data: {
            object: event.data.object as unknown as Record<string, unknown> & { id: string },
          },
        };
      } catch (error) {
        if (error instanceof BillingUnavailable) {
          throw error;
        }
        throw new WebhookSignatureInvalid();
      }
    },
  };
}
