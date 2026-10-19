import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRequest } from "@community-hub/kernel";
import { BillingReadOnly, BillingUnavailable } from "@community-hub/billing";
import {
  bannerStatusResponse,
  fullStatusResponse,
  plansResponse,
} from "@community-hub/contracts/billing";
import { bundle } from "@community-hub/policy";

import { createGate } from "./gate.js";
import type { Role } from "./checkout.js";

const identity = vi.hoisted(() => ({
  readSession: vi.fn(),
}));

const tenancy = vi.hoisted(() => ({
  findCommunityBySlug: vi.fn(),
  listCommunityIds: vi.fn(),
}));

const access = vi.hoisted(() => ({
  holdsPermission: vi.fn(),
  holdsAnyGrant: vi.fn(),
}));

const billing = vi.hoisted(() => ({
  readAccount: vi.fn(),
  currentSettings: vi.fn(),
  assertWritable: vi.fn(),
}));

const entitlements = vi.hoisted(() => ({
  planBilling: vi.fn(),
  planByLookupKey: vi.fn(),
  currentPlan: vi.fn(),
  listCheckoutPlans: vi.fn(),
}));

const db = vi.hoisted(() => ({
  withAppTransaction: vi.fn(),
  appendAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("@community-hub/identity", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/identity")>("@community-hub/identity");
  return { ...actual, readSession: identity.readSession };
});

vi.mock("@community-hub/tenancy", () => tenancy);

vi.mock("@community-hub/access", () => ({
  holdsPermission: access.holdsPermission,
  holdsAnyGrant: access.holdsAnyGrant,
}));

vi.mock("@community-hub/billing", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/billing")>("@community-hub/billing");
  return {
    ...actual,
    readAccount: billing.readAccount,
    currentSettings: billing.currentSettings,
    assertWritable: billing.assertWritable,
  };
});

vi.mock("@community-hub/entitlements", () => ({
  planBilling: entitlements.planBilling,
  planByLookupKey: entitlements.planByLookupKey,
  currentPlan: entitlements.currentPlan,
  listCheckoutPlans: entitlements.listCheckoutPlans,
}));

vi.mock("@community-hub/db", async () => {
  const actual = await vi.importActual<typeof import("@community-hub/db")>("@community-hub/db");
  return {
    ...actual,
    withAppTransaction: db.withAppTransaction,
    appendAuditEvent: db.appendAuditEvent,
  };
});

import { billingRoutes, type BillingRoutesDeps } from "./billing-routes.js";

const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const WEBHOOKS_HOSTNAME = "webhooks.au.example.test";
const OPS_HOSTNAME = "ops.au.example.test";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const USER = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-000000000010";
const COMMUNITY = "00000000-0000-4000-8000-000000000011";
const ADMIN_ORIGIN = "https://admin.example.test";

const port = {
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  findPriceByLookupKey: vi.fn(),
};

const checkoutCalls: { role: Role }[] = [];
const logCalls: { message: string; fields?: Record<string, unknown> | undefined }[] = [];

function deps(overrides: Partial<BillingRoutesDeps> = {}): BillingRoutesDeps {
  return {
    checkout: (role, run) => {
      checkoutCalls.push({ role });
      return run({} as never);
    },
    kms: {} as BillingRoutesDeps["kms"],
    keyArn: "arn:aws:kms:ap-southeast-2:123456789012:key/mrk-test",
    now: () => new Date("2026-10-18T00:00:00.000Z"),
    apiHostname: API_HOSTNAME,
    adminOrigin: ADMIN_ORIGIN,
    port: port as unknown as BillingRoutesDeps["port"],
    log: (message, fields) => {
      logCalls.push({ message, fields });
    },
    ...overrides,
  };
}

function request(
  pathName: string,
  hostname: string,
  body: unknown,
  authorization?: string,
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "x-community-hub-hostname": hostname,
  });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request(`http://127.0.0.1${pathName}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function route(pathName: string, bound: BillingRoutesDeps = deps()) {
  const found = billingRoutes(bound).find((item) => item.pattern === pathName);
  if (found === undefined) {
    throw new Error(`Route not found: ${pathName}`);
  }
  return {
    ...found,
    handle: (request: Request, context = { billing: found.billing, pattern: found.pattern }) =>
      found.handle(request, context),
  };
}

function testGate(bound: BillingRoutesDeps = deps()) {
  return createGate({
    hostnames: {
      api: API_HOSTNAME,
      auth: AUTH_HOSTNAME,
      webhooks: WEBHOOKS_HOSTNAME,
      ops: OPS_HOSTNAME,
    },
    routes: billingRoutes(bound),
    info: () => undefined,
  });
}

describe("billing routes", () => {
  beforeEach(() => {
    checkoutCalls.length = 0;
    logCalls.length = 0;
    identity.readSession.mockReset();
    tenancy.findCommunityBySlug.mockReset();
    tenancy.listCommunityIds.mockReset();
    access.holdsPermission.mockReset();
    access.holdsAnyGrant.mockReset();
    billing.readAccount.mockReset();
    billing.currentSettings.mockReset();
    billing.assertWritable.mockReset();
    entitlements.planBilling.mockReset();
    entitlements.planByLookupKey.mockReset();
    entitlements.currentPlan.mockReset();
    entitlements.listCheckoutPlans.mockReset();
    db.withAppTransaction.mockReset();
    db.appendAuditEvent.mockReset();
    port.createCheckoutSession.mockReset();
    port.createPortalSession.mockReset();
    port.findPriceByLookupKey.mockReset();

    db.withAppTransaction.mockImplementation(
      async (_sql: unknown, _scope: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    );
    identity.readSession.mockResolvedValue({ userId: USER });
    tenancy.findCommunityBySlug.mockResolvedValue({
      id: COMMUNITY,
      organisationId: ORG,
      slug: "parish",
      region: "au",
    });
    tenancy.listCommunityIds.mockResolvedValue([COMMUNITY, "00000000-0000-4000-8000-000000000012"]);
    // holdsPermission answers per permission
    access.holdsPermission.mockImplementation(
      async (_tx: unknown, _userId: string, permission: string) => {
        return permission === "billing.manage" || permission === "billing.view";
      },
    );
    access.holdsAnyGrant.mockResolvedValue(true);

    billing.readAccount.mockResolvedValue({
      organisationId: ORG,
      mode: "self_serve",
      stripeCustomerId: "cus_test1",
      stripeSubscriptionId: null,
      stripeStatus: null,
      planLookupKey: "starter_monthly",
      quantity: 2,
      currentPeriodEnd: null,
      trialEnd: null,
      trialUsedAt: null,
      unpaidSince: null,
      graceUntil: null,
      taxRateId: null,
      syncedAt: null,
    });

    billing.currentSettings.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000099",
      gstRateBps: 1000,
      pricesIncludeGst: true,
      trialDays: 14,
      graceDays: 7,
      stripeTaxRateId: "txr_test1",
      note: "GST settings",
      createdAt: new Date("2026-10-18T00:00:00.000Z"),
    });

    entitlements.planBilling.mockResolvedValue({
      stripeLookupKey: "starter_monthly",
      trialEligible: true,
    });

    entitlements.planByLookupKey.mockResolvedValue({
      key: "starter",
    });

    entitlements.currentPlan.mockResolvedValue({
      key: "starter",
      stripeLookupKey: "starter_monthly",
      trialEligible: true,
    });

    entitlements.listCheckoutPlans.mockResolvedValue([
      { key: "growth", trialEligible: false },
      { key: "starter", trialEligible: true },
    ]);

    port.findPriceByLookupKey.mockResolvedValue({
      id: "price_starter",
      lookupKey: "starter_monthly",
    });

    port.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_test1",
    });

    port.createPortalSession.mockResolvedValue({
      url: "https://billing.stripe.com/p/session/portal_test1",
    });
  });

  it("serves checkout, portal, status, and plans on the tenant surface", () => {
    expect(
      billingRoutes(deps()).map((item) => ({
        method: item.method,
        pattern: item.pattern,
        surface: item.surface,
      })),
    ).toEqual([
      { method: "POST", pattern: "/v1/billing/checkout", surface: "tenant" },
      { method: "POST", pattern: "/v1/billing/portal", surface: "tenant" },
      { method: "POST", pattern: "/v1/billing/status", surface: "tenant" },
      { method: "POST", pattern: "/v1/billing/plans", surface: "tenant" },
    ]);
  });

  describe("common guards (checkout, portal, status & plans)", () => {
    it.each([
      "/v1/billing/checkout",
      "/v1/billing/portal",
      "/v1/billing/status",
      "/v1/billing/plans",
    ])("answers 404 on a foreign hostname for %s", async (path) => {
      const target = route(path);
      const payload =
        path === "/v1/billing/checkout"
          ? { communitySlug: "parish", planKey: "starter" }
          : { communitySlug: "parish" };

      const authHostRes = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(request(path, AUTH_HOSTNAME, payload, "Bearer token")),
      );
      expect(authHostRes.status).toBe(404);
      expect(await authHostRes.text()).toBe("");

      const webhooksHostRes = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(request(path, WEBHOOKS_HOSTNAME, payload, "Bearer token")),
      );
      expect(webhooksHostRes.status).toBe(404);
      expect(await webhooksHostRes.text()).toBe("");
    });

    it.each([
      "/v1/billing/checkout",
      "/v1/billing/portal",
      "/v1/billing/status",
      "/v1/billing/plans",
    ])("answers 400 on an extra field including organisationId for %s", async (path) => {
      const target = route(path);
      const payload =
        path === "/v1/billing/checkout"
          ? {
              communitySlug: "parish",
              planKey: "starter",
              organisationId: "00000000-0000-4000-8000-000000000099",
            }
          : {
              communitySlug: "parish",
              organisationId: "00000000-0000-4000-8000-000000000099",
            };

      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(request(path, API_HOSTNAME, payload, "Bearer token")),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    });

    it.each([
      "/v1/billing/checkout",
      "/v1/billing/portal",
      "/v1/billing/status",
      "/v1/billing/plans",
    ])("answers 401 with no session for %s", async (path) => {
      const target = route(path);
      const payload =
        path === "/v1/billing/checkout"
          ? { communitySlug: "parish", planKey: "starter" }
          : { communitySlug: "parish" };

      const noTokenRes = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(request(path, API_HOSTNAME, payload)),
      );
      expect(noTokenRes.status).toBe(401);
      expect(await noTokenRes.text()).toBe("");

      identity.readSession.mockResolvedValueOnce(null);
      const invalidSessionRes = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(request(path, API_HOSTNAME, payload, "Bearer token")),
      );
      expect(invalidSessionRes.status).toBe(401);
      expect(await invalidSessionRes.text()).toBe("");
    });

    it.each([
      "/v1/billing/checkout",
      "/v1/billing/portal",
      "/v1/billing/status",
      "/v1/billing/plans",
    ])("answers 403 for an unknown slug with no audit append for %s", async (path) => {
      tenancy.findCommunityBySlug.mockResolvedValueOnce(null);
      const target = route(path);
      const payload =
        path === "/v1/billing/checkout"
          ? { communitySlug: "unknown-slug", planKey: "starter" }
          : { communitySlug: "unknown-slug" };

      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(request(path, API_HOSTNAME, payload, "Bearer token")),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(db.appendAuditEvent).not.toHaveBeenCalled();
    });

    it.each(["/v1/billing/checkout", "/v1/billing/portal", "/v1/billing/status"])(
      "answers 403 for a stranger with one audit append for %s",
      async (path) => {
        access.holdsPermission.mockResolvedValue(false);
        access.holdsAnyGrant.mockResolvedValue(false);
        const target = route(path);
        const payload =
          path === "/v1/billing/checkout"
            ? { communitySlug: "parish", planKey: "starter" }
            : { communitySlug: "parish" };

        const res = await withRequest({ requestId: REQUEST_ID }, async () =>
          target.handle(request(path, API_HOSTNAME, payload, "Bearer token")),
        );
        expect(res.status).toBe(403);
        expect(await res.text()).toBe("");
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "billing.permission.denied",
            purpose: "billing.permission.denied",
            targetIds: [ORG, COMMUNITY],
          }),
        );
      },
    );

    it.each(["/v1/billing/checkout", "/v1/billing/portal"])(
      "answers 403 on checkout and portal for a caller holding billing.view but not billing.manage for %s",
      async (path) => {
        access.holdsPermission.mockImplementation(
          async (_tx: unknown, _userId: string, permission: string) => {
            return permission === "billing.view"; // has view, lacks manage
          },
        );
        const target = route(path);
        const payload =
          path === "/v1/billing/checkout"
            ? { communitySlug: "parish", planKey: "starter" }
            : { communitySlug: "parish" };

        const res = await withRequest({ requestId: REQUEST_ID }, async () =>
          target.handle(request(path, API_HOSTNAME, payload, "Bearer token")),
        );
        expect(res.status).toBe(403);
        expect(await res.text()).toBe("");
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "billing.permission.denied",
            purpose: "billing.permission.denied",
            targetIds: [ORG, COMMUNITY],
          }),
        );
      },
    );
  });

  describe("Checkout", () => {
    it.each([
      ["missing account row", null],
      ["mode invoiced", { mode: "invoiced" }],
      [
        "mode self_serve with active subscription",
        { mode: "self_serve", stripeSubscriptionId: "sub_1", stripeStatus: "active" },
      ],
      [
        "mode self_serve with trialing subscription",
        { mode: "self_serve", stripeSubscriptionId: "sub_1", stripeStatus: "trialing" },
      ],
      [
        "mode self_serve with past_due subscription",
        { mode: "self_serve", stripeSubscriptionId: "sub_1", stripeStatus: "past_due" },
      ],
      [
        "mode self_serve with unpaid subscription",
        { mode: "self_serve", stripeSubscriptionId: "sub_1", stripeStatus: "unpaid" },
      ],
      [
        "mode self_serve with incomplete subscription",
        { mode: "self_serve", stripeSubscriptionId: "sub_1", stripeStatus: "incomplete" },
      ],
    ])("answers 409 for conflict state: %s", async (_label, accountOverride) => {
      billing.readAccount.mockResolvedValueOnce(
        accountOverride === null
          ? null
          : {
              organisationId: ORG,
              stripeCustomerId: "cus_test1",
              stripeSubscriptionId: null,
              stripeStatus: null,
              planLookupKey: null,
              quantity: null,
              currentPeriodEnd: null,
              trialEnd: null,
              trialUsedAt: null,
              unpaidSince: null,
              graceUntil: null,
              taxRateId: null,
              syncedAt: null,
              ...accountOverride,
            },
      );

      const target = route("/v1/billing/checkout");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request(
            "/v1/billing/checkout",
            API_HOSTNAME,
            { communitySlug: "parish", planKey: "starter" },
            "Bearer token",
          ),
        ),
      );
      expect(res.status).toBe(409);
      expect(await res.text()).toBe("");
      expect(port.createCheckoutSession).not.toHaveBeenCalled();
    });

    it("answers 422 when the plan has no lookup key (or plan not found)", async () => {
      entitlements.planBilling.mockResolvedValueOnce(null);
      const target = route("/v1/billing/checkout");
      const res1 = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request(
            "/v1/billing/checkout",
            API_HOSTNAME,
            { communitySlug: "parish", planKey: "starter" },
            "Bearer token",
          ),
        ),
      );
      expect(res1.status).toBe(422);
      expect(await res1.text()).toBe("");

      entitlements.planBilling.mockResolvedValueOnce({
        stripeLookupKey: null,
        trialEligible: false,
      });
      const res2 = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request(
            "/v1/billing/checkout",
            API_HOSTNAME,
            { communitySlug: "parish", planKey: "starter" },
            "Bearer token",
          ),
        ),
      );
      expect(res2.status).toBe(422);
      expect(await res2.text()).toBe("");
      expect(port.createCheckoutSession).not.toHaveBeenCalled();
    });

    it("answers 503 when there is no TaxRate in settings", async () => {
      billing.currentSettings.mockResolvedValueOnce(null);
      const target = route("/v1/billing/checkout");
      const res1 = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request(
            "/v1/billing/checkout",
            API_HOSTNAME,
            { communitySlug: "parish", planKey: "starter" },
            "Bearer token",
          ),
        ),
      );
      expect(res1.status).toBe(503);
      expect(await res1.text()).toBe("");

      billing.currentSettings.mockResolvedValueOnce({
        id: "00000000-0000-4000-8000-000000000099",
        gstRateBps: 1000,
        pricesIncludeGst: true,
        trialDays: 14,
        graceDays: 7,
        stripeTaxRateId: null,
        note: "no tax rate yet",
        createdAt: new Date(),
      });
      const res2 = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request(
            "/v1/billing/checkout",
            API_HOSTNAME,
            { communitySlug: "parish", planKey: "starter" },
            "Bearer token",
          ),
        ),
      );
      expect(res2.status).toBe(503);
      expect(await res2.text()).toBe("");
      expect(port.createCheckoutSession).not.toHaveBeenCalled();
    });

    it("answers 503 with an empty body when the port throws BillingUnavailable", async () => {
      port.createCheckoutSession.mockRejectedValueOnce(new BillingUnavailable("STRIPE_API"));
      const target = route("/v1/billing/checkout");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request(
            "/v1/billing/checkout",
            API_HOSTNAME,
            { communitySlug: "parish", planKey: "starter" },
            "Bearer token",
          ),
        ),
      );
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("");
    });

    it("answers 500 with empty body via gate when readAccount rejects", async () => {
      billing.readAccount.mockRejectedValueOnce(
        new Error("unexpected db error for user@example.test"),
      );
      const gate = testGate();
      const res = await gate({
        request: request(
          "/v1/billing/checkout",
          API_HOSTNAME,
          { communitySlug: "parish", planKey: "starter" },
          "Bearer token",
        ),
        remoteAddress: "127.0.0.1",
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("");
      expect(text).not.toContain("user@example.test");
    });

    it("logs BILLING_UNKNOWN_PRICE before answering 503 when findPriceByLookupKey returns null", async () => {
      port.findPriceByLookupKey.mockResolvedValueOnce(null);
      const target = route("/v1/billing/checkout");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request(
            "/v1/billing/checkout",
            API_HOSTNAME,
            { communitySlug: "parish", planKey: "starter" },
            "Bearer token",
          ),
        ),
      );
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("");
      expect(logCalls).toContainEqual(
        expect.objectContaining({
          fields: expect.objectContaining({
            errorCode: "BILLING_UNKNOWN_PRICE",
          }),
        }),
      );
    });

    it("sends exact Checkout inputs to the port and returns url (newest TaxRate wins)", async () => {
      // Account has old taxRateId, settings has newer one
      billing.readAccount.mockResolvedValueOnce({
        organisationId: ORG,
        mode: "self_serve",
        stripeCustomerId: "cus_test1",
        stripeSubscriptionId: null,
        stripeStatus: null,
        planLookupKey: null,
        quantity: null,
        currentPeriodEnd: null,
        trialEnd: null,
        trialUsedAt: null,
        unpaidSince: null,
        graceUntil: null,
        taxRateId: "txr_old_on_account",
        syncedAt: null,
      });

      const target = route("/v1/billing/checkout");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request(
            "/v1/billing/checkout",
            API_HOSTNAME,
            { communitySlug: "parish", planKey: "starter" },
            "Bearer token",
          ),
        ),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        url: "https://checkout.stripe.com/pay/cs_test1",
      });

      expect(port.findPriceByLookupKey).toHaveBeenCalledWith("starter_monthly");
      // TaxRate from settings (txr_test1) is sent, NOT txr_old_on_account
      expect(port.createCheckoutSession).toHaveBeenCalledWith({
        priceId: "price_starter",
        quantity: 2, // listCommunityIds length
        taxRateId: "txr_test1",
        trialDays: 14,
        customerId: "cus_test1",
        organisationId: ORG,
        successUrl: "https://admin.example.test/?billing=done",
        cancelUrl: "https://admin.example.test/?billing=cancelled",
        idempotencyKey: `checkout:${ORG}:${REQUEST_ID}`,
      });
    });

    it("allows Checkout when account status is canceled, passing existing customer", async () => {
      billing.readAccount.mockResolvedValueOnce({
        organisationId: ORG,
        mode: "self_serve",
        stripeCustomerId: "cus_recheckout",
        stripeSubscriptionId: "sub_canceled_old",
        stripeStatus: "canceled",
        planLookupKey: null,
        quantity: null,
        currentPeriodEnd: null,
        trialEnd: null,
        trialUsedAt: null,
        unpaidSince: null,
        graceUntil: null,
        taxRateId: null,
        syncedAt: null,
      });

      const target = route("/v1/billing/checkout");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request(
            "/v1/billing/checkout",
            API_HOSTNAME,
            { communitySlug: "parish", planKey: "starter" },
            "Bearer token",
          ),
        ),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        url: "https://checkout.stripe.com/pay/cs_test1",
      });
      expect(port.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cus_recheckout",
          organisationId: ORG,
        }),
      );
    });

    it("omits trialDays when not eligible and customerId when not known", async () => {
      entitlements.planBilling.mockResolvedValueOnce({
        stripeLookupKey: "starter_monthly",
        trialEligible: false,
      });
      billing.readAccount.mockResolvedValueOnce({
        organisationId: ORG,
        mode: "self_serve",
        stripeCustomerId: null, // no existing customer
        stripeSubscriptionId: null,
        stripeStatus: null,
        planLookupKey: null,
        quantity: null,
        currentPeriodEnd: null,
        trialEnd: null,
        trialUsedAt: null,
        unpaidSince: null,
        graceUntil: null,
        taxRateId: null,
        syncedAt: null,
      });

      const target = route("/v1/billing/checkout");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request(
            "/v1/billing/checkout",
            API_HOSTNAME,
            { communitySlug: "parish", planKey: "starter" },
            "Bearer token",
          ),
        ),
      );

      expect(res.status).toBe(200);
      expect(port.createCheckoutSession).toHaveBeenCalledWith({
        priceId: "price_starter",
        quantity: 2,
        taxRateId: "txr_test1",
        organisationId: ORG,
        successUrl: "https://admin.example.test/?billing=done",
        cancelUrl: "https://admin.example.test/?billing=cancelled",
        idempotencyKey: `checkout:${ORG}:${REQUEST_ID}`,
      });
      const callArg = port.createCheckoutSession.mock.calls[0]?.[0];
      expect(callArg).not.toHaveProperty("trialDays");
      expect(callArg).not.toHaveProperty("customerId");
    });
  });

  describe("Portal", () => {
    it("answers 409 when there is no Stripe customer", async () => {
      billing.readAccount.mockResolvedValueOnce({
        organisationId: ORG,
        mode: "self_serve",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeStatus: null,
        planLookupKey: null,
        quantity: null,
        currentPeriodEnd: null,
        trialEnd: null,
        trialUsedAt: null,
        unpaidSince: null,
        graceUntil: null,
        taxRateId: null,
        syncedAt: null,
      });

      const target = route("/v1/billing/portal");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/portal", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(409);
      expect(await res.text()).toBe("");
      expect(port.createPortalSession).not.toHaveBeenCalled();
    });

    it("answers 409 when account row is missing", async () => {
      billing.readAccount.mockResolvedValueOnce(null);

      const target = route("/v1/billing/portal");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/portal", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(409);
      expect(await res.text()).toBe("");
      expect(port.createPortalSession).not.toHaveBeenCalled();
    });

    it("sends exact Portal inputs with portal key and returns url", async () => {
      const target = route("/v1/billing/portal");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/portal", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        url: "https://billing.stripe.com/p/session/portal_test1",
      });

      expect(port.createPortalSession).toHaveBeenCalledWith({
        customerId: "cus_test1",
        returnUrl: "https://admin.example.test/?billing=portal",
        idempotencyKey: `portal:${ORG}:${REQUEST_ID}`,
      });
    });

    it("answers 503 with an empty body when the port throws BillingUnavailable", async () => {
      port.createPortalSession.mockRejectedValueOnce(new BillingUnavailable("STRIPE_API"));
      const target = route("/v1/billing/portal");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/portal", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("");
    });

    it("answers 500 with empty body via gate when readAccount rejects in portal", async () => {
      billing.readAccount.mockRejectedValueOnce(
        new Error("portal db error with user@example.test"),
      );
      const gate = testGate();
      const res = await gate({
        request: request(
          "/v1/billing/portal",
          API_HOSTNAME,
          { communitySlug: "parish" },
          "Bearer token",
        ),
        remoteAddress: "127.0.0.1",
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("");
      expect(text).not.toContain("user@example.test");
    });
  });

  describe("Status", () => {
    it("returns full status object when caller holds billing.view", async () => {
      billing.readAccount.mockResolvedValueOnce({
        organisationId: ORG,
        mode: "self_serve",
        stripeCustomerId: "cus_test1",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "active",
        planLookupKey: "starter_monthly",
        quantity: 2,
        currentPeriodEnd: new Date("2026-11-18T00:00:00.000Z"),
        trialEnd: new Date("2026-11-01T00:00:00.000Z"),
        trialUsedAt: new Date("2026-10-18T00:00:00.000Z"),
        unpaidSince: null,
        graceUntil: null,
        taxRateId: "txr_test1",
        syncedAt: new Date("2026-10-18T00:00:00.000Z"),
      });

      const target = route("/v1/billing/status");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/status", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(fullStatusResponse.parse(data)).toEqual({
        state: "ok",
        planKey: "starter",
        quantity: 2,
        current_period_end: "2026-11-18T00:00:00.000Z",
        trial_end: "2026-11-01T00:00:00.000Z",
        grace_until: null,
        canView: true,
        canManage: true,
      });
      expect(db.appendAuditEvent).not.toHaveBeenCalled();
    });

    it("returns banner fields only for a member (grant-holder without billing.view) with no audit append", async () => {
      access.holdsPermission.mockResolvedValue(false);
      access.holdsAnyGrant.mockResolvedValue(true);

      billing.readAccount.mockResolvedValueOnce({
        organisationId: ORG,
        mode: "self_serve",
        stripeCustomerId: "cus_test1",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "active",
        planLookupKey: "starter_monthly",
        quantity: 2,
        currentPeriodEnd: new Date("2026-11-18T00:00:00.000Z"),
        trialEnd: new Date("2026-11-01T00:00:00.000Z"),
        trialUsedAt: null,
        unpaidSince: null,
        graceUntil: null,
        taxRateId: null,
        syncedAt: null,
      });

      const target = route("/v1/billing/status");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/status", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(bannerStatusResponse.parse(data)).toEqual({
        state: "ok",
        trial_end: "2026-11-01T00:00:00.000Z",
        grace_until: null,
        canView: false,
        canManage: false,
      });
      expect(data).not.toHaveProperty("planKey");
      expect(data).not.toHaveProperty("quantity");
      expect(data).not.toHaveProperty("current_period_end");
      expect(db.appendAuditEvent).not.toHaveBeenCalled();
    });

    it.each([
      "org_owner",
      "org_admin",
      "org_billing",
      "org_auditor",
      "community_admin",
      "staff",
      "finance",
      "safeguarding_officer",
      "volunteer_coordinator",
      "content_editor",
      "member",
    ])("returns correct canView and canManage for role in bundle table: %s", async (roleKey) => {
      const b = bundle(roleKey) ?? [];
      const expectedCanView = b.includes("billing.view");
      const expectedCanManage = b.includes("billing.manage");

      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, permission: string) => {
          return b.includes(permission);
        },
      );
      access.holdsAnyGrant.mockResolvedValue(true);

      const target = route("/v1/billing/status");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/status", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.canView).toBe(expectedCanView);
      expect(data.canManage).toBe(expectedCanManage);

      if (expectedCanView) {
        expect(fullStatusResponse.safeParse(data).success).toBe(true);
        expect(data).toHaveProperty("planKey");
      } else {
        expect(bannerStatusResponse.safeParse(data).success).toBe(true);
        expect(data).not.toHaveProperty("planKey");
      }
    });

    it("derives state invoiced when account row is missing", async () => {
      billing.readAccount.mockResolvedValueOnce(null);

      const target = route("/v1/billing/status");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/status", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(fullStatusResponse.parse(data)).toEqual({
        state: "invoiced",
        planKey: "starter",
        quantity: null,
        current_period_end: null,
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: true,
      });
    });
  });

  describe("pinning role and scope", () => {
    it("pins scope passed to withAppTransaction and roles passed to checkout", async () => {
      const target = route("/v1/billing/checkout");
      await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request(
            "/v1/billing/checkout",
            API_HOSTNAME,
            { communitySlug: "parish", planKey: "starter" },
            "Bearer token",
          ),
        ),
      );

      expect(db.withAppTransaction).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        expect.anything(),
      );

      // Verify checkout roles: identity for session, app for permissions, platform for billing data
      expect(checkoutCalls).toEqual([
        { role: "identity" }, // readSession
        { role: "platform" }, // findCommunityBySlug
        { role: "app" }, // withAppTransaction (permission checks)
        { role: "platform" }, // readAccount
        { role: "platform" }, // planBilling
        { role: "platform" }, // currentSettings
        { role: "platform" }, // listCommunityIds
      ]);
    });

    it("pins roles and scope for portal success", async () => {
      checkoutCalls.length = 0;
      db.withAppTransaction.mockClear();

      const target = route("/v1/billing/portal");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/portal", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(200);

      expect(db.withAppTransaction).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        expect.anything(),
      );

      expect(checkoutCalls.map((c) => c.role)).toEqual(["identity", "platform", "app", "platform"]);
    });

    it("pins roles and scope for status full path with planLookupKey", async () => {
      checkoutCalls.length = 0;
      db.withAppTransaction.mockClear();

      billing.readAccount.mockResolvedValueOnce({
        organisationId: ORG,
        mode: "self_serve",
        stripeCustomerId: "cus_test1",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "active",
        planLookupKey: "starter_monthly",
        quantity: 2,
        currentPeriodEnd: new Date("2026-11-18T00:00:00.000Z"),
        trialEnd: null,
        trialUsedAt: null,
        unpaidSince: null,
        graceUntil: null,
        taxRateId: null,
        syncedAt: null,
      });

      const target = route("/v1/billing/status");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/status", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(200);

      expect(db.withAppTransaction).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        expect.anything(),
      );

      expect(checkoutCalls.map((c) => c.role)).toEqual([
        "identity",
        "platform",
        "app",
        "platform",
        "platform",
      ]);
    });

    it("pins roles and scope for status full path when planByLookupKey resolves null", async () => {
      checkoutCalls.length = 0;
      db.withAppTransaction.mockClear();

      billing.readAccount.mockResolvedValueOnce({
        organisationId: ORG,
        mode: "self_serve",
        stripeCustomerId: "cus_test1",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "active",
        planLookupKey: "starter_monthly",
        quantity: 2,
        currentPeriodEnd: new Date("2026-11-18T00:00:00.000Z"),
        trialEnd: null,
        trialUsedAt: null,
        unpaidSince: null,
        graceUntil: null,
        taxRateId: null,
        syncedAt: null,
      });
      entitlements.planByLookupKey.mockResolvedValueOnce(null);

      const target = route("/v1/billing/status");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/status", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(200);

      expect(db.withAppTransaction).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        expect.anything(),
      );

      expect(checkoutCalls.map((c) => c.role)).toEqual([
        "identity",
        "platform",
        "app",
        "platform",
        "platform",
        "platform",
      ]);
    });

    it("pins roles and scope for status banner path", async () => {
      checkoutCalls.length = 0;
      db.withAppTransaction.mockClear();

      access.holdsPermission.mockResolvedValue(false);
      access.holdsAnyGrant.mockResolvedValue(true);

      const target = route("/v1/billing/status");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/status", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(200);

      expect(db.withAppTransaction).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        expect.anything(),
      );

      expect(checkoutCalls.map((c) => c.role)).toEqual(["identity", "platform", "app", "platform"]);
    });
  });

  describe("POST /v1/billing/plans", () => {
    it("returns the plans list for caller with billing.manage", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, permission: string) => {
          return permission === "billing.manage";
        },
      );
      entitlements.listCheckoutPlans.mockResolvedValue([
        { key: "growth", trialEligible: false },
        { key: "starter", trialEligible: true },
      ]);
      const target = route("/v1/billing/plans");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/plans", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        plans: [
          { key: "growth", trialAvailable: false },
          { key: "starter", trialAvailable: true },
        ],
      });
    });

    it("answers 403 with one audit append for a caller holding billing.view but not billing.manage (pin 8)", async () => {
      const auditor = bundle("org_auditor") ?? [];
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, permission: string) => {
          return auditor.includes(permission as never);
        },
      );
      const target = route("/v1/billing/plans");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/plans", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
      expect(db.appendAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorKind: "user",
          actorId: USER,
          action: "billing.permission.denied",
          purpose: "billing.permission.denied",
          targetIds: [ORG, COMMUNITY],
        }),
      );
    });

    it("answers 403 for a stranger with one audit append", async () => {
      access.holdsPermission.mockImplementation(async () => false);
      access.holdsAnyGrant.mockImplementation(async () => false);
      const target = route("/v1/billing/plans");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/plans", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
      expect(db.appendAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorKind: "user",
          actorId: USER,
          action: "billing.permission.denied",
          purpose: "billing.permission.denied",
          targetIds: [ORG, COMMUNITY],
        }),
      );
    });

    it("a trial-eligible plan reads trialAvailable: false when trial_used_at is set and true when it is not (pin 9)", async () => {
      entitlements.listCheckoutPlans.mockResolvedValue([{ key: "starter", trialEligible: true }]);
      const target = route("/v1/billing/plans");

      // Case 1: trialUsedAt is null -> trialAvailable: true
      billing.readAccount.mockResolvedValueOnce({
        organisationId: ORG,
        mode: "self_serve",
        stripeCustomerId: "cus_test1",
        stripeSubscriptionId: null,
        stripeStatus: null,
        planLookupKey: "starter_monthly",
        quantity: 2,
        currentPeriodEnd: null,
        trialEnd: null,
        trialUsedAt: null,
        unpaidSince: null,
        graceUntil: null,
        taxRateId: null,
        syncedAt: null,
      });
      const resTrue = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/plans", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(resTrue.status).toBe(200);
      expect(await resTrue.json()).toEqual({
        plans: [{ key: "starter", trialAvailable: true }],
      });

      // Case 2: trialUsedAt is set -> trialAvailable: false
      billing.readAccount.mockResolvedValueOnce({
        organisationId: ORG,
        mode: "self_serve",
        stripeCustomerId: "cus_test1",
        stripeSubscriptionId: null,
        stripeStatus: null,
        planLookupKey: "starter_monthly",
        quantity: 2,
        currentPeriodEnd: null,
        trialEnd: null,
        trialUsedAt: new Date("2026-09-01T00:00:00.000Z"),
        unpaidSince: null,
        graceUntil: null,
        taxRateId: null,
        syncedAt: null,
      });
      const resFalse = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/plans", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(resFalse.status).toBe(200);
      expect(await resFalse.json()).toEqual({
        plans: [{ key: "starter", trialAvailable: false }],
      });
    });

    it("with currentSettings null every plan reads trialAvailable: false without 503", async () => {
      entitlements.listCheckoutPlans.mockResolvedValue([
        { key: "starter", trialEligible: true },
        { key: "growth", trialEligible: false },
      ]);
      billing.currentSettings.mockResolvedValueOnce(null);
      const target = route("/v1/billing/plans");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/plans", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        plans: [
          { key: "starter", trialAvailable: false },
          { key: "growth", trialAvailable: false },
        ],
      });
    });

    it("calls readAccount with the organisationId returned by findCommunityBySlug and ignores another organisation's account", async () => {
      const OTHER_ORG = "00000000-0000-4000-8000-000000000099";
      entitlements.listCheckoutPlans.mockResolvedValue([{ key: "starter", trialEligible: true }]);
      billing.readAccount.mockImplementation(async (_sql: unknown, orgId: string) => {
        if (orgId === ORG) {
          return {
            organisationId: ORG,
            mode: "self_serve",
            stripeCustomerId: "cus_test1",
            stripeSubscriptionId: null,
            stripeStatus: null,
            planLookupKey: "starter_monthly",
            quantity: 2,
            currentPeriodEnd: null,
            trialEnd: null,
            trialUsedAt: null,
            unpaidSince: null,
            graceUntil: null,
            taxRateId: null,
            syncedAt: null,
          };
        }
        if (orgId === OTHER_ORG) {
          return {
            organisationId: OTHER_ORG,
            mode: "self_serve",
            stripeCustomerId: "cus_test2",
            stripeSubscriptionId: null,
            stripeStatus: null,
            planLookupKey: "starter_monthly",
            quantity: 1,
            currentPeriodEnd: null,
            trialEnd: null,
            trialUsedAt: new Date("2026-01-01T00:00:00.000Z"),
            unpaidSince: null,
            graceUntil: null,
            taxRateId: null,
            syncedAt: null,
          };
        }
        return null;
      });

      const target = route("/v1/billing/plans");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/plans", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(200);
      expect(billing.readAccount).toHaveBeenCalledWith(expect.anything(), ORG);
      expect(await res.json()).toEqual({
        plans: [{ key: "starter", trialAvailable: true }],
      });
    });

    it("the response parses with plansResponse and each plan's keys are exactly key and trialAvailable (pin 19)", async () => {
      entitlements.listCheckoutPlans.mockResolvedValue([
        { key: "starter", trialEligible: true },
        { key: "growth", trialEligible: false },
      ]);
      const target = route("/v1/billing/plans");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/plans", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(200);
      const json: unknown = await res.json();
      const parseResult = plansResponse.safeParse(json);
      expect(parseResult.success).toBe(true);
      if (parseResult.success) {
        expect(parseResult.data.plans.length).toBe(2);
        for (const plan of parseResult.data.plans) {
          expect(Object.keys(plan).sort()).toEqual(["key", "trialAvailable"].sort());
        }
      }
    });

    it("pins roles and scope for plans success", async () => {
      checkoutCalls.length = 0;
      db.withAppTransaction.mockClear();

      const target = route("/v1/billing/plans");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/plans", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(200);

      expect(db.withAppTransaction).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        expect.anything(),
      );

      expect(checkoutCalls.map((c) => c.role)).toEqual([
        "identity",
        "platform",
        "app",
        "platform",
        "platform",
        "platform",
      ]);
    });

    it("status, portal, checkout and plans never call assertWritable in read_only", async () => {
      billing.assertWritable.mockRejectedValue(new BillingReadOnly("read_only"));
      for (const path of [
        "/v1/billing/status",
        "/v1/billing/portal",
        "/v1/billing/checkout",
        "/v1/billing/plans",
      ]) {
        const target = route(path);
        const payload =
          path === "/v1/billing/checkout"
            ? { communitySlug: "parish", planKey: "starter" }
            : { communitySlug: "parish" };
        const res = await withRequest({ requestId: REQUEST_ID }, async () =>
          target.handle(request(path, API_HOSTNAME, payload, "Bearer token")),
        );
        expect(res.status).toBe(200);
      }
      expect(billing.assertWritable).not.toHaveBeenCalled();
    });
  });
});
