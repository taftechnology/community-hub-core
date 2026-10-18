import Stripe from "stripe";
import { BillingUnavailable } from "@community-hub/billing";
import { describe, expect, it, vi } from "vitest";

import {
  createStripeBilling,
  defaultStripeClient,
  WebhookSignatureInvalid,
  type StripeCallLogFields,
  type StripeClient,
} from "./stripe-adapter.js";
import type { BillingSecret, BillingSecretValues } from "./secret.js";

function createFakeStripeClient(): {
  client: StripeClient;
  spies: {
    checkoutCreate: ReturnType<typeof vi.fn>;
    portalCreate: ReturnType<typeof vi.fn>;
    subRetrieve: ReturnType<typeof vi.fn>;
    subUpdate: ReturnType<typeof vi.fn>;
    invoiceRetrieve: ReturnType<typeof vi.fn>;
    pricesList: ReturnType<typeof vi.fn>;
    pricesCreate: ReturnType<typeof vi.fn>;
    taxRatesCreate: ReturnType<typeof vi.fn>;
    productsSearch: ReturnType<typeof vi.fn>;
    productsCreate: ReturnType<typeof vi.fn>;
  };
} {
  const checkoutCreate = vi.fn();
  const portalCreate = vi.fn();
  const subRetrieve = vi.fn();
  const subUpdate = vi.fn();
  const invoiceRetrieve = vi.fn();
  const pricesList = vi.fn();
  const pricesCreate = vi.fn();
  const taxRatesCreate = vi.fn();
  const productsSearch = vi.fn();
  const productsCreate = vi.fn();

  const client: StripeClient = {
    checkout: {
      sessions: {
        create: checkoutCreate as unknown as StripeClient["checkout"]["sessions"]["create"],
      },
    },
    billingPortal: {
      sessions: {
        create: portalCreate as unknown as StripeClient["billingPortal"]["sessions"]["create"],
      },
    },
    subscriptions: {
      retrieve: subRetrieve as unknown as StripeClient["subscriptions"]["retrieve"],
      update: subUpdate as unknown as StripeClient["subscriptions"]["update"],
    },
    invoices: {
      retrieve: invoiceRetrieve as unknown as StripeClient["invoices"]["retrieve"],
    },
    prices: {
      list: pricesList as unknown as StripeClient["prices"]["list"],
      create: pricesCreate as unknown as StripeClient["prices"]["create"],
    },
    taxRates: {
      create: taxRatesCreate as unknown as StripeClient["taxRates"]["create"],
    },
    products: {
      search: productsSearch as unknown as StripeClient["products"]["search"],
      create: productsCreate as unknown as StripeClient["products"]["create"],
    },
  };

  return {
    client,
    spies: {
      checkoutCreate,
      portalCreate,
      subRetrieve,
      subUpdate,
      invoiceRetrieve,
      pricesList,
      pricesCreate,
      taxRatesCreate,
      productsSearch,
      productsCreate,
    },
  };
}

function fakeBillingSecret(overrides?: Partial<BillingSecretValues>): BillingSecret & {
  isInvalidated: boolean;
} {
  let invalidated = false;
  return {
    async get() {
      return {
        secretKey: overrides?.secretKey ?? "sk_test_synthetic_key_12345",
        webhookSecret: overrides?.webhookSecret ?? "whsec_synthetic_secret_67890",
      };
    },
    invalidate() {
      invalidated = true;
    },
    get isInvalidated() {
      return invalidated;
    },
  };
}

describe("stripe-adapter", () => {
  it("exports defaultStripeClient factory", () => {
    const client = defaultStripeClient("sk_test_synthetic_client_key");
    expect(client).toBeDefined();
    expect(client.checkout).toBeDefined();
  });

  describe("createCheckoutSession", () => {
    it("asserts every parameter field by field including idempotencyKey", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.checkoutCreate.mockResolvedValueOnce({
        url: "https://checkout.stripe.test/c/pay/cs_test_session_1",
      });

      const secret = fakeBillingSecret();
      const logs: StripeCallLogFields[] = [];
      const billing = createStripeBilling({
        secret,
        clientFor: () => client,
        info: (f) => logs.push(f),
      });

      const input = {
        priceId: "price_monthly_plan",
        quantity: 2,
        taxRateId: "txr_au_gst",
        trialDays: 30,
        customerId: "cus_test1",
        organisationId: "12345678-1234-4234-8234-1234567890ab",
        successUrl: "https://admin.example.test/?billing=done",
        cancelUrl: "https://admin.example.test/?billing=cancelled",
        idempotencyKey: "checkout:12345678-1234-4234-8234-1234567890ab:req_checkout_1",
      };

      const result = await billing.createCheckoutSession(input);
      expect(result).toEqual({ url: "https://checkout.stripe.test/c/pay/cs_test_session_1" });

      expect(spies.checkoutCreate).toHaveBeenCalledTimes(1);
      expect(spies.checkoutCreate).toHaveBeenCalledWith(
        {
          mode: "subscription",
          line_items: [
            {
              price: "price_monthly_plan",
              quantity: 2,
            },
          ],
          client_reference_id: "12345678-1234-4234-8234-1234567890ab",
          metadata: {
            organisation_id: "12345678-1234-4234-8234-1234567890ab",
          },
          subscription_data: {
            metadata: {
              organisation_id: "12345678-1234-4234-8234-1234567890ab",
            },
            default_tax_rates: ["txr_au_gst"],
            trial_period_days: 30,
          },
          customer: "cus_test1",
          success_url: "https://admin.example.test/?billing=done",
          cancel_url: "https://admin.example.test/?billing=cancelled",
        },
        {
          idempotencyKey: "checkout:12345678-1234-4234-8234-1234567890ab:req_checkout_1",
        },
      );

      expect(logs).toEqual([{ operation: "stripe_call", outcome: "ok" }]);
    });

    it("omits customer and trial_period_days when not provided", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.checkoutCreate.mockResolvedValueOnce({
        url: "https://checkout.stripe.test/c/pay/cs_test_session_2",
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      await billing.createCheckoutSession({
        priceId: "price_2",
        quantity: 1,
        taxRateId: "txr_2",
        organisationId: "12345678-1234-4234-8234-1234567890ab",
        successUrl: "https://admin.example.test/?billing=done",
        cancelUrl: "https://admin.example.test/?billing=cancelled",
        idempotencyKey: "checkout:12345678-1234-4234-8234-1234567890ab:req_checkout_2",
      });

      const callArgs = spies.checkoutCreate.mock.calls[0];
      const params = callArgs?.[0] as Record<string, unknown>;
      expect(params.customer).toBeUndefined();
      const subData = params.subscription_data as Record<string, unknown>;
      expect(subData.trial_period_days).toBeUndefined();
    });
  });

  describe("createPortalSession", () => {
    it("asserts every parameter field by field including idempotencyKey", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.portalCreate.mockResolvedValueOnce({
        url: "https://billing.stripe.test/p/session/bps_test1",
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.createPortalSession({
        customerId: "cus_test1",
        returnUrl: "https://admin.example.test/?billing=portal",
        idempotencyKey: "portal:12345678-1234-4234-8234-1234567890ab:req_portal_1",
      });

      expect(result).toEqual({ url: "https://billing.stripe.test/p/session/bps_test1" });
      expect(spies.portalCreate).toHaveBeenCalledWith(
        {
          customer: "cus_test1",
          return_url: "https://admin.example.test/?billing=portal",
        },
        {
          idempotencyKey: "portal:12345678-1234-4234-8234-1234567890ab:req_portal_1",
        },
      );
    });
  });

  describe("retrieveSubscription", () => {
    it("maps fields correctly with period end from items.data[0].current_period_end", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.subRetrieve.mockResolvedValueOnce({
        id: "sub_test1",
        customer: "cus_test1",
        status: "active",
        items: {
          data: [
            {
              id: "si_item1",
              quantity: 4,
              current_period_end: 1770000000,
              price: {
                lookup_key: "growth_monthly",
              },
            },
          ],
        },
        trial_end: 1765000000,
        default_tax_rates: [{ id: "txr_test1" }],
        metadata: {
          organisation_id: "12345678-1234-4234-8234-1234567890ab",
        },
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.retrieveSubscription("sub_test1");

      expect(spies.subRetrieve).toHaveBeenCalledWith("sub_test1");
      expect(result).toEqual({
        id: "sub_test1",
        customerId: "cus_test1",
        status: "active",
        lookupKey: "growth_monthly",
        quantity: 4,
        currentPeriodEnd: new Date(1770000000 * 1000),
        trialEnd: new Date(1765000000 * 1000),
        taxRateId: "txr_test1",
        organisationIdMetadata: "12345678-1234-4234-8234-1234567890ab",
      });
    });

    it("handles customer object and missing optional fields", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.subRetrieve.mockResolvedValueOnce({
        id: "sub_test2",
        customer: { id: "cus_expanded" },
        status: "incomplete",
        items: { data: [] },
        trial_end: null,
        default_tax_rates: null,
        metadata: {},
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.retrieveSubscription("sub_test2");
      expect(result).toEqual({
        id: "sub_test2",
        customerId: "cus_expanded",
        status: "incomplete",
        lookupKey: null,
        quantity: null,
        currentPeriodEnd: null,
        trialEnd: null,
        taxRateId: null,
        organisationIdMetadata: null,
      });
    });
  });

  describe("subscriptionForInvoice", () => {
    it("returns subscription id when parent.type === 'subscription_details'", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.invoiceRetrieve.mockResolvedValueOnce({
        id: "in_test1",
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: "sub_test1",
          },
        },
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.subscriptionForInvoice("in_test1");
      expect(spies.invoiceRetrieve).toHaveBeenCalledWith("in_test1");
      expect(result).toBe("sub_test1");
    });

    it("returns subscription id when subscription is an expanded object", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.invoiceRetrieve.mockResolvedValueOnce({
        id: "in_test2",
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: { id: "sub_test_expanded" },
          },
        },
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.subscriptionForInvoice("in_test2");
      expect(result).toBe("sub_test_expanded");
    });

    it("returns null for non-subscription parent", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.invoiceRetrieve.mockResolvedValueOnce({
        id: "in_test3",
        parent: {
          type: "quote_details",
          quote_details: {},
        },
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.subscriptionForInvoice("in_test3");
      expect(result).toBeNull();
    });

    it("returns null when parent is null or undefined", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.invoiceRetrieve.mockResolvedValueOnce({
        id: "in_test4",
        parent: null,
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.subscriptionForInvoice("in_test4");
      expect(result).toBeNull();
    });
  });

  describe("findPriceByLookupKey", () => {
    it("calls prices.list with lookup key and returns price if found", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.pricesList.mockResolvedValueOnce({
        data: [{ id: "price_starter", lookup_key: "starter_monthly" }],
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.findPriceByLookupKey("starter_monthly");
      expect(spies.pricesList).toHaveBeenCalledWith({
        lookup_keys: ["starter_monthly"],
        active: true,
        limit: 1,
      });
      expect(result).toEqual({ id: "price_starter", lookupKey: "starter_monthly" });
    });

    it("returns null when price is not found", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.pricesList.mockResolvedValueOnce({ data: [] });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.findPriceByLookupKey("unknown_key");
      expect(result).toBeNull();
    });
  });

  describe("createTaxRate", () => {
    it("calls taxRates.create with all fields and idempotencyKey", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.taxRatesCreate.mockResolvedValueOnce({ id: "txr_new_1" });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.createTaxRate({
        percentage: 10,
        inclusive: true,
        country: "AU",
        displayName: "GST",
        idempotencyKey: "taxrate:settings_row_1",
      });

      expect(spies.taxRatesCreate).toHaveBeenCalledWith(
        {
          percentage: 10,
          inclusive: true,
          country: "AU",
          display_name: "GST",
        },
        {
          idempotencyKey: "taxrate:settings_row_1",
        },
      );
      expect(result).toEqual({ id: "txr_new_1" });
    });
  });

  describe("updateQuantity", () => {
    it("retrieves subscription for item id and updates quantity with proration_behavior: create_prorations", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.subRetrieve.mockResolvedValueOnce({
        id: "sub_test1",
        items: {
          data: [{ id: "si_item_existing" }],
        },
      });
      spies.subUpdate.mockResolvedValueOnce({ id: "sub_test1" });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      await billing.updateQuantity({
        subscriptionId: "sub_test1",
        quantity: 5,
        prorationBehavior: "create_prorations",
        idempotencyKey: "qty:sub_test1:5:uuid_1",
      });

      expect(spies.subRetrieve).toHaveBeenCalledWith("sub_test1");
      expect(spies.subUpdate).toHaveBeenCalledWith(
        "sub_test1",
        {
          items: [{ id: "si_item_existing", quantity: 5 }],
          proration_behavior: "create_prorations",
        },
        {
          idempotencyKey: "qty:sub_test1:5:uuid_1",
        },
      );
    });
  });

  describe("updateDefaultTaxRate", () => {
    it("calls subscriptions.update with default_tax_rates and idempotencyKey", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.subUpdate.mockResolvedValueOnce({ id: "sub_test1" });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      await billing.updateDefaultTaxRate({
        subscriptionId: "sub_test1",
        taxRateId: "txr_updated",
        idempotencyKey: "taxmove:sub_test1:settings_1",
      });

      expect(spies.subUpdate).toHaveBeenCalledWith(
        "sub_test1",
        {
          default_tax_rates: ["txr_updated"],
        },
        {
          idempotencyKey: "taxmove:sub_test1:settings_1",
        },
      );
    });
  });

  describe("ensureProduct", () => {
    it("searches first and returns existing product without creating", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.productsSearch.mockResolvedValueOnce({
        data: [{ id: "prod_existing_1" }],
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.ensureProduct({
        name: "Growth",
        lookupKey: "growth_monthly",
        idempotencyKey: "seed:product:growth_monthly",
      });

      expect(spies.productsSearch).toHaveBeenCalledWith({
        query: "metadata['lookup_key']:'growth_monthly'",
      });
      expect(spies.productsCreate).not.toHaveBeenCalled();
      expect(result).toEqual({ id: "prod_existing_1" });
    });

    it("creates product if not found by search", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.productsSearch.mockResolvedValueOnce({ data: [] });
      spies.productsCreate.mockResolvedValueOnce({ id: "prod_new_1" });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.ensureProduct({
        name: "Growth",
        lookupKey: "growth_monthly",
        idempotencyKey: "seed:product:growth_monthly",
      });

      expect(spies.productsCreate).toHaveBeenCalledWith(
        {
          name: "Growth",
          metadata: { lookup_key: "growth_monthly" },
        },
        {
          idempotencyKey: "seed:product:growth_monthly",
        },
      );
      expect(result).toEqual({ id: "prod_new_1" });
    });
  });

  describe("ensurePrice", () => {
    it("searches first and returns existing price without creating", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.pricesList.mockResolvedValueOnce({
        data: [{ id: "price_existing_1", lookup_key: "starter_monthly" }],
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.ensurePrice({
        productId: "prod_1",
        lookupKey: "starter_monthly",
        currency: "aud",
        // Obviously non-price sentinel; real placeholder amounts live only in Task 12's map.
        unitAmount: 1,
        interval: "month",
        taxBehavior: "inclusive",
        idempotencyKey: "seed:price:starter_monthly",
      });

      expect(spies.pricesList).toHaveBeenCalledWith({
        lookup_keys: ["starter_monthly"],
        active: true,
        limit: 1,
      });
      expect(spies.pricesCreate).not.toHaveBeenCalled();
      expect(result).toEqual({ id: "price_existing_1", lookupKey: "starter_monthly" });
    });

    it("creates price if not found by search", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.pricesList.mockResolvedValueOnce({ data: [] });
      spies.pricesCreate.mockResolvedValueOnce({
        id: "price_new_1",
        lookup_key: "starter_monthly",
      });

      const billing = createStripeBilling({
        secret: fakeBillingSecret(),
        clientFor: () => client,
      });

      const result = await billing.ensurePrice({
        productId: "prod_1",
        lookupKey: "starter_monthly",
        currency: "aud",
        // Obviously non-price sentinel; real placeholder amounts live only in Task 12's map.
        unitAmount: 1,
        interval: "month",
        taxBehavior: "inclusive",
        idempotencyKey: "seed:price:starter_monthly",
      });

      expect(spies.pricesCreate).toHaveBeenCalledWith(
        {
          product: "prod_1",
          lookup_key: "starter_monthly",
          currency: "aud",
          unit_amount: 1,
          recurring: { interval: "month" },
          tax_behavior: "inclusive",
        },
        {
          idempotencyKey: "seed:price:starter_monthly",
        },
      );
      expect(result).toEqual({ id: "price_new_1", lookupKey: "starter_monthly" });
    });
  });

  describe("verifyEvent", () => {
    const webhookSecret = "whsec_synthetic_webhook_secret_for_tests";
    const payloadObj = {
      id: "evt_test1",
      object: "event",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_test1",
        },
      },
    };
    const prettyJson = JSON.stringify(payloadObj, null, 2);
    const rawBytes = new TextEncoder().encode(prettyJson);

    it("passes for pretty-printed JSON payload signed with real constructEvent", async () => {
      const billing = createStripeBilling({
        secret: fakeBillingSecret({ webhookSecret }),
      });

      const header = Stripe.webhooks.generateTestHeaderString({
        payload: prettyJson,
        secret: webhookSecret,
      });

      const event = await billing.verifyEvent(rawBytes, header);
      expect(event.id).toBe("evt_test1");
      expect(event.type).toBe("customer.subscription.updated");
      expect(event.data.object.id).toBe("sub_test1");
    });

    it("fails when one byte is changed", async () => {
      const billing = createStripeBilling({
        secret: fakeBillingSecret({ webhookSecret }),
      });

      const header = Stripe.webhooks.generateTestHeaderString({
        payload: prettyJson,
        secret: webhookSecret,
      });

      const corrupted = new Uint8Array(rawBytes);
      corrupted[10] = corrupted[10]! ^ 0xff;

      await expect(billing.verifyEvent(corrupted, header)).rejects.toBeInstanceOf(
        WebhookSignatureInvalid,
      );
    });

    it("fails when payload is re-serialised through JSON.stringify(JSON.parse(...))", async () => {
      const billing = createStripeBilling({
        secret: fakeBillingSecret({ webhookSecret }),
      });

      const header = Stripe.webhooks.generateTestHeaderString({
        payload: prettyJson,
        secret: webhookSecret,
      });

      // Compact JSON instead of pretty-printed raw bytes
      const reserialised = new TextEncoder().encode(JSON.stringify(JSON.parse(prettyJson)));

      await expect(billing.verifyEvent(reserialised, header)).rejects.toBeInstanceOf(
        WebhookSignatureInvalid,
      );
    });

    it("fails when timestamp is 301 seconds old", async () => {
      const billing = createStripeBilling({
        secret: fakeBillingSecret({ webhookSecret }),
      });

      const now = Math.floor(Date.now() / 1000);
      const oldHeader = Stripe.webhooks.generateTestHeaderString({
        payload: prettyJson,
        secret: webhookSecret,
        timestamp: now - 301,
      });

      await expect(billing.verifyEvent(rawBytes, oldHeader)).rejects.toBeInstanceOf(
        WebhookSignatureInvalid,
      );
    });

    it("signature failures carry no payload or header in JSON, stack, or own properties (M2)", async () => {
      const billing = createStripeBilling({
        secret: fakeBillingSecret({ webhookSecret }),
      });

      const syntheticEmail = "subscriber.leak.test@example.test";
      const payloadWithEmail = JSON.stringify({
        id: "evt_test_synthetic",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_test_synthetic",
            customer_email: syntheticEmail,
          },
        },
      });
      const rawPayload = new TextEncoder().encode(payloadWithEmail);
      const badHeader = "t=12345678,v1=synthetic_invalid_signature_header_abc123";

      let caughtError: unknown;
      try {
        await billing.verifyEvent(rawPayload, badHeader);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(WebhookSignatureInvalid);
      const err = caughtError as WebhookSignatureInvalid;
      expect(err.message).toBe("WEBHOOK_SIGNATURE_INVALID");
      expect(err.name).toBe("WebhookSignatureInvalid");
      expect((err as Error & { cause?: unknown }).cause).toBeUndefined();

      // JSON.stringify, String(stack), and getOwnPropertyNames contain neither body nor header
      const jsonStr = JSON.stringify(err);
      expect(jsonStr).not.toContain(syntheticEmail);
      expect(jsonStr).not.toContain("example.test");
      expect(jsonStr).not.toContain("synthetic_invalid_signature_header_abc123");

      const stackStr = String(err.stack);
      expect(stackStr).not.toContain(syntheticEmail);
      expect(stackStr).not.toContain("example.test");
      expect(stackStr).not.toContain("synthetic_invalid_signature_header_abc123");

      const ownProps = Object.getOwnPropertyNames(err);
      expect(ownProps).not.toContain("payload");
      expect(ownProps).not.toContain("header");
      for (const prop of ownProps) {
        expect(prop).not.toContain(syntheticEmail);
        expect(prop).not.toContain("synthetic_invalid_signature_header_abc123");
      }
      expect(ownProps.sort()).toEqual(["message", "name", "stack"]);
    });
  });

  describe("leakage case (Security pin 16)", () => {
    it("maps fake client error to fixed code without leaking message, email, or amount", async () => {
      const { client, spies } = createFakeStripeClient();
      const syntheticEmail = "ada.lovelace@example.test";
      const sensitiveAmount = "$450.00";
      const secretErrorMsg = `Failed payment of ${sensitiveAmount} for customer ${syntheticEmail} due to card error`;

      class CustomFakeStripeError extends Error {
        readonly type = "api_error";
        constructor() {
          super(secretErrorMsg);
          this.name = "StripeAPIError";
        }
      }

      spies.checkoutCreate.mockRejectedValueOnce(new CustomFakeStripeError());

      const secret = fakeBillingSecret();
      const loggedFields: StripeCallLogFields[] = [];
      const billing = createStripeBilling({
        secret,
        clientFor: () => client,
        info: (f) => loggedFields.push(f),
      });

      let caughtError: unknown;
      try {
        await billing.createCheckoutSession({
          priceId: "price_1",
          quantity: 1,
          taxRateId: "txr_1",
          organisationId: "12345678-1234-4234-8234-1234567890ab",
          successUrl: "https://admin.example.test/?billing=done",
          cancelUrl: "https://admin.example.test/?billing=cancelled",
          idempotencyKey: "checkout:12345678-1234-4234-8234-1234567890ab:req_1",
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(BillingUnavailable);
      const billingError = caughtError as BillingUnavailable;
      expect(billingError.code).toBe("STRIPE_API");
      expect((billingError as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(Object.getOwnPropertyNames(billingError).sort()).toEqual([
        "code",
        "message",
        "name",
        "stack",
      ]);

      // Verify thrown error does not contain any sensitive strings
      const errorString = `${billingError.name}: ${billingError.message} ${JSON.stringify(billingError)}`;
      expect(errorString).not.toContain("ada.lovelace@example.test");
      expect(errorString).not.toContain("example.test");
      expect(errorString).not.toContain("$450");
      expect(errorString).not.toContain("Failed payment");

      // Verify info payload does not contain any sensitive strings
      expect(loggedFields).toHaveLength(1);
      const logLine = JSON.stringify(loggedFields[0]);
      expect(logLine).not.toContain("ada.lovelace@example.test");
      expect(logLine).not.toContain("example.test");
      expect(logLine).not.toContain("$450");
      expect(logLine).not.toContain("Failed payment");
      expect(loggedFields[0]).toEqual({
        operation: "stripe_call",
        outcome: "failed",
        errorCode: "STRIPE_API",
      });
    });
  });

  describe("error mapping and secret invalidation", () => {
    it("invalidates secret and logs STRIPE_AUTH on StripeAuthenticationError", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.subRetrieve.mockRejectedValueOnce({
        type: "StripeAuthenticationError",
        message: "Invalid API Key provided",
      });

      const secret = fakeBillingSecret();
      const loggedFields: StripeCallLogFields[] = [];
      const billing = createStripeBilling({
        secret,
        clientFor: () => client,
        info: (f) => loggedFields.push(f),
      });

      await expect(billing.retrieveSubscription("sub_test1")).rejects.toThrow(
        new BillingUnavailable("STRIPE_AUTH"),
      );
      expect(secret.isInvalidated).toBe(true);
      expect(loggedFields).toEqual([
        {
          operation: "stripe_call",
          outcome: "failed",
          errorCode: "STRIPE_AUTH",
        },
      ]);
    });

    it("maps StripeRateLimitError to STRIPE_RATE_LIMIT", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.subRetrieve.mockRejectedValueOnce({
        type: "rate_limit_error",
        message: "Too Many Requests",
      });

      const secret = fakeBillingSecret();
      const billing = createStripeBilling({
        secret,
        clientFor: () => client,
      });

      await expect(billing.retrieveSubscription("sub_test1")).rejects.toThrow(
        new BillingUnavailable("STRIPE_RATE_LIMIT"),
      );
      expect(secret.isInvalidated).toBe(false);
    });

    it("maps StripeInvalidRequestError to STRIPE_INVALID_REQUEST", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.subRetrieve.mockRejectedValueOnce({
        type: "invalid_request_error",
        message: "No such subscription",
      });

      const secret = fakeBillingSecret();
      const billing = createStripeBilling({
        secret,
        clientFor: () => client,
      });

      await expect(billing.retrieveSubscription("sub_test1")).rejects.toThrow(
        new BillingUnavailable("STRIPE_INVALID_REQUEST"),
      );
    });

    it("maps StripeConnectionError to STRIPE_CONNECTION", async () => {
      const { client, spies } = createFakeStripeClient();
      spies.subRetrieve.mockRejectedValueOnce({
        type: "StripeConnectionError",
        message: "Network error",
      });

      const secret = fakeBillingSecret();
      const billing = createStripeBilling({
        secret,
        clientFor: () => client,
      });

      await expect(billing.retrieveSubscription("sub_test1")).rejects.toThrow(
        new BillingUnavailable("STRIPE_CONNECTION"),
      );
    });

    it("handles client factory throw: maps to STRIPE_API, logs once, and serialised error does not leak message (M1)", async () => {
      const syntheticEmail = "factory.leak.test@example.test";
      const factoryError = new Error(`Connection to Stripe client failed for ${syntheticEmail}`);

      const secret = fakeBillingSecret();
      const loggedFields: StripeCallLogFields[] = [];
      const billing = createStripeBilling({
        secret,
        clientFor: () => {
          throw factoryError;
        },
        info: (f) => loggedFields.push(f),
      });

      let caughtError: unknown;
      try {
        await billing.retrieveSubscription("sub_test1");
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(BillingUnavailable);
      const billingError = caughtError as BillingUnavailable;
      expect(billingError.code).toBe("STRIPE_API");

      // Verify one info line logged
      expect(loggedFields).toHaveLength(1);
      expect(loggedFields[0]).toEqual({
        operation: "stripe_call",
        outcome: "failed",
        errorCode: "STRIPE_API",
      });

      // Verify no email in serialised error or string
      const serialized = JSON.stringify(billingError);
      expect(serialized).not.toContain(syntheticEmail);
      expect(serialized).not.toContain("example.test");
      const errStr = `${billingError.name}: ${billingError.message} ${String(billingError.stack)}`;
      expect(errStr).not.toContain(syntheticEmail);
      expect(errStr).not.toContain("example.test");
    });
  });
});
