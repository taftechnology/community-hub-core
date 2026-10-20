import { describe, expect, it, vi, beforeEach } from "vitest";
import Stripe from "stripe";
import { createLogger, type Logger } from "@community-hub/observability";
import {
  BillingUnavailable,
  type BillingEventOutcome,
  type LinkSubscriptionResult,
  type ApplySubscriptionResult,
  type StripeBilling,
  type StripeSubscription,
  type StripeWebhookEvent,
} from "@community-hub/billing";
import type { createPlatformSql } from "@community-hub/db";

type Sql = ReturnType<typeof createPlatformSql>;

import {
  billingWebhookRoutes as rawBillingWebhookRoutes,
  type BillingWebhookDeps,
} from "./billing-webhook.js";

function billingWebhookRoutes(deps: BillingWebhookDeps) {
  return rawBillingWebhookRoutes(deps).map((route) => ({
    ...route,
    handle: (req: Request, context = { billing: route.billing, pattern: route.pattern }) =>
      route.handle(req, context),
  }));
}
import { createStripeBilling } from "./billing/stripe-adapter.js";
import type { BillingSecret } from "./billing/secret.js";

const billingRepo = vi.hoisted(() => ({
  recordReceived:
    vi.fn<(sql: Sql, eventId: string, type: string) => Promise<BillingEventOutcome>>(),
  markOutcome:
    vi.fn<(sql: Sql, eventId: string, outcome: "processed" | "ignored") => Promise<void>>(),
  linkSubscription:
    vi.fn<
      (
        sql: Sql,
        organisationId: string,
        customerId: string,
        subscriptionId: string,
        status: string,
      ) => Promise<LinkSubscriptionResult>
    >(),
  applySubscription:
    vi.fn<
      (
        sql: Sql,
        port: Pick<StripeBilling, "retrieveSubscription">,
        subscriptionId: string,
        now: Date,
      ) => Promise<ApplySubscriptionResult>
    >(),
}));

vi.mock("@community-hub/billing", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/billing")>("@community-hub/billing");
  return {
    ...actual,
    recordReceived: billingRepo.recordReceived,
    markOutcome: billingRepo.markOutcome,
    linkSubscription: billingRepo.linkSubscription,
    applySubscription: billingRepo.applySubscription,
  };
});

const WEBHOOKS_HOST = "webhooks.au.example.test";
const SYNTHETIC_SECRET = "whsec_synthetic_test_secret_for_webhook_12345";
const FROZEN_NOW = new Date("2026-10-18T09:00:00.000Z");

function fakeSecret(whSecret = SYNTHETIC_SECRET): BillingSecret {
  return {
    async get() {
      return {
        secretKey: "sk_test_synthetic_key_12345",
        webhookSecret: whSecret,
      };
    },
    invalidate() {},
  };
}

function fakeCheckout() {
  const fakeSql = {} as Sql;
  return vi.fn(async (_role: string, run: (sql: Sql) => Promise<unknown>) => {
    return run(fakeSql);
  });
}

function createFakePort(overrides?: Partial<StripeBilling>): StripeBilling {
  return {
    createCheckoutSession: vi.fn(),
    createPortalSession: vi.fn(),
    retrieveSubscription: vi.fn(async (id: string): Promise<StripeSubscription> => ({
      id,
      customerId: "cus_test1",
      status: "active",
      lookupKey: "starter_monthly",
      quantity: 1,
      currentPeriodEnd: new Date("2026-11-18T09:00:00Z"),
      trialEnd: null,
      taxRateId: "txr_test1",
      organisationIdMetadata: "12345678-1234-4234-8234-1234567890ab",
    })),
    subscriptionForInvoice: vi.fn(async () => "sub_test1"),
    findPriceByLookupKey: vi.fn(),
    createTaxRate: vi.fn(),
    updateQuantity: vi.fn(),
    updateDefaultTaxRate: vi.fn(),
    verifyEvent: vi.fn(async (): Promise<StripeWebhookEvent> => ({
      id: "evt_test1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_test1",
        },
      },
    })),
    ensureProduct: vi.fn(),
    ensurePrice: vi.fn(),
    ...overrides,
  };
}

function createTestDeps(options?: {
  port?: StripeBilling;
  logger?: Logger;
  checkout?: ReturnType<typeof fakeCheckout>;
  now?: () => Date;
  webhooksHostname?: string;
}): {
  deps: BillingWebhookDeps;
  loggedLines: Record<string, unknown>[];
  logger: Logger;
} {
  const loggedLines: Record<string, unknown>[] = [];
  const logger =
    options?.logger ??
    createLogger({
      write: (line) => {
        loggedLines.push(JSON.parse(line));
      },
    });

  const deps: BillingWebhookDeps = {
    checkout: (options?.checkout ?? fakeCheckout()) as unknown as BillingWebhookDeps["checkout"],
    port: options?.port ?? createFakePort(),
    now: options?.now ?? (() => FROZEN_NOW),
    webhooksHostname: options?.webhooksHostname ?? WEBHOOKS_HOST,
    log: (message, fields) => logger.info(message, fields),
  };

  return { deps, loggedLines, logger };
}

function makeWebhookRequest(body: string | Uint8Array, headers?: Record<string, string>): Request {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const reqHeaders = new Headers({
    "content-type": "application/json",
    "x-community-hub-hostname": WEBHOOKS_HOST,
    ...headers,
  });
  return new Request("http://127.0.0.1/v1/stripe/webhook", {
    method: "POST",
    headers: reqHeaders,
    body: bytes,
  });
}

describe("billing-webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("signature verification (Security pin 21)", () => {
    const realAdapter = createStripeBilling({
      secret: fakeSecret(SYNTHETIC_SECRET),
    });

    const testPayload = JSON.stringify(
      {
        id: "evt_testSig",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_test1" } },
      },
      null,
      2,
    );
    const testBytes = new TextEncoder().encode(testPayload);

    it("missing header returns 400 and nothing is recorded", async () => {
      const { deps } = createTestDeps({ port: realAdapter });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest(testBytes);
      // no stripe-signature header
      const res = await route.handle(req);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
      expect(billingRepo.recordReceived).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).not.toHaveBeenCalled();
    });

    it("bad signature returns 400 and nothing is recorded", async () => {
      const { deps } = createTestDeps({ port: realAdapter });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const badHeader = "t=1700000000,v1=invalid_synthetic_signature_hex";
      const req = makeWebhookRequest(testBytes, { "stripe-signature": badHeader });
      const res = await route.handle(req);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
      expect(billingRepo.recordReceived).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).not.toHaveBeenCalled();
    });

    it("old timestamp (301 seconds ago) returns 400 and nothing is recorded", async () => {
      const { deps } = createTestDeps({ port: realAdapter });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const nowSec = Math.floor(Date.now() / 1000);
      const oldHeader = Stripe.webhooks.generateTestHeaderString({
        payload: testPayload,
        secret: SYNTHETIC_SECRET,
        timestamp: nowSec - 301,
      });

      const req = makeWebhookRequest(testBytes, { "stripe-signature": oldHeader });
      const res = await route.handle(req);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
      expect(billingRepo.recordReceived).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).not.toHaveBeenCalled();
    });

    it("BillingUnavailable returns 503 and nothing is recorded", async () => {
      const failingPort = createFakePort({
        verifyEvent: vi.fn(async () => {
          throw new BillingUnavailable("BILLING_KEY_UNAVAILABLE");
        }),
      });
      const { deps } = createTestDeps({ port: failingPort });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest(testBytes, { "stripe-signature": "any" });
      const res = await route.handle(req);

      expect(res.status).toBe(503);
      expect(await res.text()).toBe("");
      expect(billingRepo.recordReceived).not.toHaveBeenCalled();
    });
  });

  describe("replay handling", () => {
    it("processed event gives 200 with no port call", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("processed");
      const port = createFakePort();
      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      expect(billingRepo.recordReceived).toHaveBeenCalledTimes(1);
      expect(port.retrieveSubscription).not.toHaveBeenCalled();
      expect(port.subscriptionForInvoice).not.toHaveBeenCalled();
      expect(billingRepo.applySubscription).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).not.toHaveBeenCalled();
    });

    it("ignored event on replay gives 200 with no port call", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("ignored");
      const port = createFakePort();
      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      expect(port.retrieveSubscription).not.toHaveBeenCalled();
      expect(billingRepo.applySubscription).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).not.toHaveBeenCalled();
    });

    it("received event is processed again", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.applySubscription.mockResolvedValueOnce("applied");
      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_test1",
          type: "customer.subscription.updated",
          data: { object: { id: "sub_test1" } },
        })),
      });
      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.applySubscription).toHaveBeenCalledTimes(1);
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_test1",
        "processed",
      );
    });
  });

  describe("out of order handling (Security pin 22)", () => {
    it("the event object says past_due while port says active, and apply uses port re-read", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.applySubscription.mockResolvedValueOnce("applied");

      // Event payload says "past_due"
      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testOutOfOrder",
          type: "customer.subscription.updated",
          data: {
            object: {
              id: "sub_test1",
              status: "past_due",
            },
          },
        })),
        // Port retrieveSubscription returns "active"
        retrieveSubscription: vi.fn(async () => ({
          id: "sub_test1",
          customerId: "cus_test1",
          status: "active",
          lookupKey: "starter_monthly",
          quantity: 1,
          currentPeriodEnd: new Date("2026-11-18T09:00:00Z"),
          trialEnd: null,
          taxRateId: "txr_test1",
          organisationIdMetadata: "12345678-1234-4234-8234-1234567890ab",
        })),
      });

      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      // applySubscription is passed the subscription id and port, which re-reads from Stripe
      expect(billingRepo.applySubscription).toHaveBeenCalledWith(
        expect.anything(),
        port,
        "sub_test1",
        FROZEN_NOW,
      );
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testOutOfOrder",
        "processed",
      );
    });
  });

  describe("invoice events", () => {
    it("resolves subscription through subscriptionForInvoice and calls apply", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.applySubscription.mockResolvedValueOnce("applied");
      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testInvPaid",
          type: "invoice.paid",
          data: { object: { id: "in_test1" } },
        })),
        subscriptionForInvoice: vi.fn(async (id: string) => `sub_from_${id}`),
      });

      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(port.subscriptionForInvoice).toHaveBeenCalledWith("in_test1");
      expect(billingRepo.applySubscription).toHaveBeenCalledWith(
        expect.anything(),
        port,
        "sub_from_in_test1",
        FROZEN_NOW,
      );
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testInvPaid",
        "processed",
      );
    });

    it("null subscription from invoice is ignored", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testInvFailed",
          type: "invoice.payment_failed",
          data: { object: { id: "in_test2" } },
        })),
        subscriptionForInvoice: vi.fn(async () => null),
      });

      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(port.subscriptionForInvoice).toHaveBeenCalledWith("in_test2");
      expect(billingRepo.applySubscription).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testInvFailed",
        "ignored",
      );
    });

    it("an invoice event whose apply returns unknown_price is processed and logged BILLING_UNKNOWN_PRICE", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.applySubscription.mockResolvedValueOnce("unknown_price");
      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testInvUnknownPrice",
          type: "invoice.paid",
          data: { object: { id: "in_test_up" } },
        })),
        subscriptionForInvoice: vi.fn(async () => "sub_test_up"),
      });

      const { deps, loggedLines } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.applySubscription).toHaveBeenCalledWith(
        expect.anything(),
        port,
        "sub_test_up",
        FROZEN_NOW,
      );
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testInvUnknownPrice",
        "processed",
      );
      expect(loggedLines).toHaveLength(1);
      expect(loggedLines[0]).toMatchObject({
        operation: "stripe_webhook",
        stripeEventId: "evt_testInvUnknownPrice",
        stripeEventType: "invoice.paid",
        outcome: "processed",
        errorCode: "BILLING_UNKNOWN_PRICE",
      });
    });
  });

  describe("event types and outcomes", () => {
    it("an unknown event type is ignored", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testUnknown",
          type: "customer.created",
          data: { object: { id: "cus_test1" } },
        })),
      });

      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.applySubscription).not.toHaveBeenCalled();
      expect(billingRepo.linkSubscription).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testUnknown",
        "ignored",
      );
    });

    it("a subscription event before link is ignored", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.applySubscription.mockResolvedValueOnce("unlinked");
      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testSubCreated",
          type: "customer.subscription.created",
          data: { object: { id: "sub_unlinked" } },
        })),
      });

      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.applySubscription).toHaveBeenCalledWith(
        expect.anything(),
        port,
        "sub_unlinked",
        FROZEN_NOW,
      );
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testSubCreated",
        "ignored",
      );
    });

    it("a subscription event with unknown_price is processed and logged BILLING_UNKNOWN_PRICE", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.applySubscription.mockResolvedValueOnce("unknown_price");
      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testUnknownPrice",
          type: "customer.subscription.updated",
          data: { object: { id: "sub_test1" } },
        })),
      });

      const { deps, loggedLines } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testUnknownPrice",
        "processed",
      );
      expect(loggedLines).toHaveLength(1);
      expect(loggedLines[0]).toMatchObject({
        operation: "stripe_webhook",
        stripeEventId: "evt_testUnknownPrice",
        stripeEventType: "customer.subscription.updated",
        outcome: "processed",
        errorCode: "BILLING_UNKNOWN_PRICE",
      });
    });
  });

  describe("checkout.session.completed", () => {
    const validOrgId = "12345678-1234-4234-8234-1234567890ab";

    it("valid session links with status from retrieveSubscription, then applies", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.linkSubscription.mockResolvedValueOnce("linked");
      billingRepo.applySubscription.mockResolvedValueOnce("applied");

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testCheckout",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test1",
              client_reference_id: validOrgId,
              customer: "cus_test1",
              subscription: "sub_test1",
              status: "complete",
            },
          },
        })),
        retrieveSubscription: vi.fn(async (id: string) => ({
          id,
          customerId: "cus_test1",
          status: "trialing",
          lookupKey: "starter_monthly",
          quantity: 1,
          currentPeriodEnd: new Date("2026-11-18T09:00:00Z"),
          trialEnd: new Date("2026-11-18T09:00:00Z"),
          taxRateId: "txr_test1",
          organisationIdMetadata: validOrgId,
        })),
      });

      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      // Status for linkSubscription MUST come from retrieveSubscription re-read ("trialing")
      expect(port.retrieveSubscription).toHaveBeenCalledWith("sub_test1");
      expect(billingRepo.linkSubscription).toHaveBeenCalledWith(
        expect.anything(),
        validOrgId,
        "cus_test1",
        "sub_test1",
        "trialing",
      );
      expect(billingRepo.applySubscription).toHaveBeenCalledWith(
        expect.anything(),
        port,
        "sub_test1",
        FROZEN_NOW,
      );
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testCheckout",
        "processed",
      );
    });

    it("links the re-read subscription customer when the event customer differs", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.linkSubscription.mockResolvedValueOnce("linked");
      billingRepo.applySubscription.mockResolvedValueOnce("applied");

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testCheckoutCustomerDiff",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_customer_diff",
              client_reference_id: validOrgId,
              customer: "cus_event_only",
              subscription: "sub_test1",
              status: "complete",
            },
          },
        })),
        retrieveSubscription: vi.fn(async (id: string) => ({
          id,
          customerId: "cus_from_subscription",
          status: "trialing",
          lookupKey: "starter_monthly",
          quantity: 1,
          currentPeriodEnd: new Date("2026-11-18T09:00:00Z"),
          trialEnd: new Date("2026-11-18T09:00:00Z"),
          taxRateId: "txr_test1",
          organisationIdMetadata: validOrgId,
        })),
      });

      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.linkSubscription).toHaveBeenCalledWith(
        expect.anything(),
        validOrgId,
        "cus_from_subscription",
        "sub_test1",
        "trialing",
      );
      expect(billingRepo.linkSubscription).not.toHaveBeenCalledWith(
        expect.anything(),
        validOrgId,
        "cus_event_only",
        expect.anything(),
        expect.anything(),
      );
      expect(billingRepo.applySubscription).toHaveBeenCalled();
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testCheckoutCustomerDiff",
        "processed",
      );
    });

    it("refuses to link when the re-read subscription customer is empty, same as a metadata mismatch", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testCheckoutEmptyCustomer",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_empty_customer",
              client_reference_id: validOrgId,
              customer: "cus_event_only",
              subscription: "sub_test1",
              status: "complete",
            },
          },
        })),
        retrieveSubscription: vi.fn(async (id: string) => ({
          id,
          customerId: "",
          status: "trialing",
          lookupKey: "starter_monthly",
          quantity: 1,
          currentPeriodEnd: new Date("2026-11-18T09:00:00Z"),
          trialEnd: new Date("2026-11-18T09:00:00Z"),
          taxRateId: "txr_test1",
          organisationIdMetadata: validOrgId,
        })),
      });

      const { deps, loggedLines } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.linkSubscription).not.toHaveBeenCalled();
      expect(billingRepo.applySubscription).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testCheckoutEmptyCustomer",
        "ignored",
      );
      expect(loggedLines).toHaveLength(1);
      expect(loggedLines[0]).toMatchObject({
        operation: "stripe_webhook",
        stripeEventId: "evt_testCheckoutEmptyCustomer",
        stripeEventType: "checkout.session.completed",
        organisationId: validOrgId,
        outcome: "ignored",
        errorCode: "BILLING_ORGANISATION_MISMATCH",
      });
    });

    it("mismatched organisationIdMetadata in re-read is ignored without linking, code logged", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testCheckoutMismatch",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_mismatch",
              client_reference_id: validOrgId,
              customer: "cus_test1",
              subscription: "sub_test1",
              status: "complete",
            },
          },
        })),
        retrieveSubscription: vi.fn(async (id: string) => ({
          id,
          customerId: "cus_test1",
          status: "trialing",
          lookupKey: "starter_monthly",
          quantity: 1,
          currentPeriodEnd: new Date("2026-11-18T09:00:00Z"),
          trialEnd: new Date("2026-11-18T09:00:00Z"),
          taxRateId: "txr_test1",
          organisationIdMetadata: "87654321-4321-4234-8234-1234567890ab",
        })),
      });

      const { deps, loggedLines } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.linkSubscription).not.toHaveBeenCalled();
      expect(billingRepo.applySubscription).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testCheckoutMismatch",
        "ignored",
      );
      expect(loggedLines).toHaveLength(1);
      expect(loggedLines[0]).toMatchObject({
        operation: "stripe_webhook",
        stripeEventId: "evt_testCheckoutMismatch",
        stripeEventType: "checkout.session.completed",
        organisationId: validOrgId,
        outcome: "ignored",
        errorCode: "BILLING_ORGANISATION_MISMATCH",
      });
    });

    it("missing organisationIdMetadata in re-read is ignored without linking, code logged", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testCheckoutMissingMeta",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_missing_meta",
              client_reference_id: validOrgId,
              customer: "cus_test1",
              subscription: "sub_test1",
              status: "complete",
            },
          },
        })),
        retrieveSubscription: vi.fn(async (id: string) => ({
          id,
          customerId: "cus_test1",
          status: "trialing",
          lookupKey: "starter_monthly",
          quantity: 1,
          currentPeriodEnd: new Date("2026-11-18T09:00:00Z"),
          trialEnd: new Date("2026-11-18T09:00:00Z"),
          taxRateId: "txr_test1",
          organisationIdMetadata: null,
        })),
      });

      const { deps, loggedLines } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.linkSubscription).not.toHaveBeenCalled();
      expect(billingRepo.applySubscription).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testCheckoutMissingMeta",
        "ignored",
      );
      expect(loggedLines).toHaveLength(1);
      expect(loggedLines[0]).toMatchObject({
        operation: "stripe_webhook",
        stripeEventId: "evt_testCheckoutMissingMeta",
        stripeEventType: "checkout.session.completed",
        organisationId: validOrgId,
        outcome: "ignored",
        errorCode: "BILLING_ORGANISATION_MISMATCH",
      });
    });

    it("a linked checkout whose apply returns unknown_price is processed and logged BILLING_UNKNOWN_PRICE", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.linkSubscription.mockResolvedValueOnce("linked");
      billingRepo.applySubscription.mockResolvedValueOnce("unknown_price");

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testCheckoutUnknownPrice",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_unknown_price",
              client_reference_id: validOrgId,
              customer: "cus_test1",
              subscription: "sub_test1",
              status: "complete",
            },
          },
        })),
        retrieveSubscription: vi.fn(async (id: string) => ({
          id,
          customerId: "cus_test1",
          status: "active",
          lookupKey: "starter_monthly",
          quantity: 1,
          currentPeriodEnd: new Date("2026-11-18T09:00:00Z"),
          trialEnd: null,
          taxRateId: "txr_test1",
          organisationIdMetadata: validOrgId,
        })),
      });

      const { deps, loggedLines } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.linkSubscription).toHaveBeenCalledWith(
        expect.anything(),
        validOrgId,
        "cus_test1",
        "sub_test1",
        "active",
      );
      expect(billingRepo.applySubscription).toHaveBeenCalledWith(
        expect.anything(),
        port,
        "sub_test1",
        FROZEN_NOW,
      );
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testCheckoutUnknownPrice",
        "processed",
      );
      expect(loggedLines).toHaveLength(1);
      expect(loggedLines[0]).toMatchObject({
        operation: "stripe_webhook",
        stripeEventId: "evt_testCheckoutUnknownPrice",
        stripeEventType: "checkout.session.completed",
        organisationId: validOrgId,
        outcome: "processed",
        errorCode: "BILLING_UNKNOWN_PRICE",
      });
    });

    it("a duplicate is ignored, with the code logged BILLING_DUPLICATE_SUBSCRIPTION", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.linkSubscription.mockResolvedValueOnce("duplicate");

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testCheckoutDup",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_dup",
              client_reference_id: validOrgId,
              customer: "cus_test1",
              subscription: "sub_test2",
            },
          },
        })),
      });

      const { deps, loggedLines } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.applySubscription).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testCheckoutDup",
        "ignored",
      );
      expect(loggedLines).toHaveLength(1);
      expect(loggedLines[0]).toMatchObject({
        operation: "stripe_webhook",
        stripeEventId: "evt_testCheckoutDup",
        stripeEventType: "checkout.session.completed",
        organisationId: validOrgId,
        outcome: "ignored",
        errorCode: "BILLING_DUPLICATE_SUBSCRIPTION",
      });
    });

    it("invoiced or missing organisation is ignored", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.linkSubscription.mockResolvedValueOnce("invoiced");

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testCheckoutInv",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_inv",
              client_reference_id: validOrgId,
              customer: "cus_test1",
              subscription: "sub_test3",
            },
          },
        })),
      });

      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.applySubscription).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testCheckoutInv",
        "ignored",
      );
    });

    it("an invalid client_reference_id is ignored", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testBadRef",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_bad",
              client_reference_id: "not-a-valid-uuid",
              customer: "cus_test1",
              subscription: "sub_test1",
            },
          },
        })),
      });

      const { deps, loggedLines } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(billingRepo.linkSubscription).not.toHaveBeenCalled();
      expect(billingRepo.applySubscription).not.toHaveBeenCalled();
      expect(billingRepo.markOutcome).toHaveBeenCalledWith(
        expect.anything(),
        "evt_testBadRef",
        "ignored",
      );
      // organisationId not logged when invalid UUID
      expect(loggedLines[0]?.organisationId).toBeUndefined();
    });
  });

  describe("hostname gating (Security pin 23)", () => {
    it.each([
      ["au.api.example.test"],
      ["auth.au.example.test"],
      ["ops.au.example.test"],
      ["unknown.example.test"],
    ])("answers 404 on hostname %s", async (hostname) => {
      const port = createFakePort();
      const { deps } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", {
        "x-community-hub-hostname": hostname,
        "stripe-signature": "dummy",
      });
      const res = await route.handle(req);

      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
      expect(port.verifyEvent).not.toHaveBeenCalled();
      expect(billingRepo.recordReceived).not.toHaveBeenCalled();
    });
  });

  describe("failures and leakage prevention", () => {
    it("a thrown error whose message holds a synthetic email gives 500 with an empty body and row stays received", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      const syntheticEmail = "sensitive.donor.leak@example.test";
      billingRepo.applySubscription.mockRejectedValueOnce(
        new Error(`database connection error for ${syntheticEmail}`),
      );

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testErr",
          type: "customer.subscription.updated",
          data: { object: { id: "sub_test1" } },
        })),
      });

      const { deps, loggedLines, logger } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(500);
      const bodyText = await res.text();
      expect(bodyText).toBe("");
      expect(bodyText).not.toContain(syntheticEmail);

      // markOutcome was NOT called, so the row stays 'received'
      expect(billingRepo.markOutcome).not.toHaveBeenCalled();

      // Assert that failed event is logged and 0 fields are dropped
      expect(logger.getDroppedFieldCount()).toBe(0);
      expect(loggedLines).toHaveLength(1);
      expect(loggedLines[0]).toMatchObject({
        operation: "stripe_webhook",
        stripeEventId: "evt_testErr",
        stripeEventType: "customer.subscription.updated",
        outcome: "failed",
      });

      // Check all logged lines
      for (const line of loggedLines) {
        const str = JSON.stringify(line);
        expect(str).not.toContain(syntheticEmail);
        expect(str).not.toContain("example.test");
      }
    });

    it("a thrown error in recordReceived gives 500 and logs failed with 0 dropped fields", async () => {
      billingRepo.recordReceived.mockRejectedValueOnce(new Error("database connection timeout"));

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testRecvErr",
          type: "customer.subscription.updated",
          data: { object: { id: "sub_test1" } },
        })),
      });

      const { deps, loggedLines, logger } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");
      expect(billingRepo.markOutcome).not.toHaveBeenCalled();
      expect(logger.getDroppedFieldCount()).toBe(0);
      expect(loggedLines).toHaveLength(1);
      expect(loggedLines[0]).toMatchObject({
        operation: "stripe_webhook",
        stripeEventId: "evt_testRecvErr",
        stripeEventType: "customer.subscription.updated",
        outcome: "failed",
      });
    });

    it("a thrown error during checkout session handling logs failed with organisationId and 0 dropped fields", async () => {
      const validOrgId = "12345678-1234-4234-8234-1234567890ab";
      billingRepo.recordReceived.mockResolvedValueOnce("received");

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testCheckoutErr",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_err",
              client_reference_id: validOrgId,
              customer: "cus_test1",
              subscription: "sub_test1",
              status: "complete",
            },
          },
        })),
        retrieveSubscription: vi.fn(async () => {
          throw new Error("Stripe network error");
        }),
      });

      const { deps, loggedLines, logger } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest("{}", { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");
      expect(billingRepo.markOutcome).not.toHaveBeenCalled();
      expect(logger.getDroppedFieldCount()).toBe(0);
      expect(loggedLines).toHaveLength(1);
      expect(loggedLines[0]).toMatchObject({
        operation: "stripe_webhook",
        stripeEventId: "evt_testCheckoutErr",
        stripeEventType: "checkout.session.completed",
        organisationId: validOrgId,
        outcome: "failed",
      });
    });

    it("every log line parses with 0 dropped fields and contains no part of the body", async () => {
      billingRepo.recordReceived.mockResolvedValueOnce("received");
      billingRepo.applySubscription.mockResolvedValueOnce("applied");

      const syntheticEmail = "donor.secret.body@example.test";
      const payloadString = JSON.stringify({
        id: "evt_testClean",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_test1",
            customer_email: syntheticEmail,
          },
        },
      });

      const port = createFakePort({
        verifyEvent: vi.fn(async () => ({
          id: "evt_testClean",
          type: "customer.subscription.updated",
          data: { object: { id: "sub_test1" } },
        })),
      });

      const { deps, loggedLines, logger } = createTestDeps({ port });
      const routes = billingWebhookRoutes(deps);
      const route = routes.find((r) => r.pattern === "/v1/stripe/webhook")!;

      const req = makeWebhookRequest(payloadString, { "stripe-signature": "dummy" });
      const res = await route.handle(req);

      expect(res.status).toBe(200);
      expect(logger.getDroppedFieldCount()).toBe(0);
      expect(loggedLines).toHaveLength(1);

      for (const line of loggedLines) {
        const lineStr = JSON.stringify(line);
        expect(lineStr).not.toContain(syntheticEmail);
        expect(lineStr).not.toContain("donor.secret.body");
        expect(lineStr).not.toContain(payloadString);
      }
    });
  });
});
