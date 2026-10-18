import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRequest } from "@community-hub/kernel";
import { BillingUnavailable } from "@community-hub/billing";

const identity = vi.hoisted(() => ({
  readSession: vi.fn(),
}));

const tenancy = vi.hoisted(() => ({
  findCommunityBySlug: vi.fn(),
  listCommunityIds: vi.fn(),
}));

const access = vi.hoisted(() => ({
  holdsPermission: vi.fn(),
}));

const billing = vi.hoisted(() => ({
  readAccount: vi.fn(),
  currentSettings: vi.fn(),
}));

const entitlements = vi.hoisted(() => ({
  planBilling: vi.fn(),
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
}));

vi.mock("@community-hub/billing", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/billing")>("@community-hub/billing");
  return {
    ...actual,
    readAccount: billing.readAccount,
    currentSettings: billing.currentSettings,
  };
});

vi.mock("@community-hub/entitlements", () => ({
  planBilling: entitlements.planBilling,
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

function deps(overrides: Partial<BillingRoutesDeps> = {}): BillingRoutesDeps {
  return {
    checkout: (_role, run) => run({} as never),
    kms: {} as BillingRoutesDeps["kms"],
    keyArn: "arn:aws:kms:ap-southeast-2:123456789012:key/mrk-test",
    now: () => new Date("2026-10-18T00:00:00.000Z"),
    apiHostname: API_HOSTNAME,
    adminOrigin: ADMIN_ORIGIN,
    port: port as unknown as BillingRoutesDeps["port"],
    log: () => undefined,
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
  return found;
}

describe("billing routes", () => {
  beforeEach(() => {
    identity.readSession.mockReset();
    tenancy.findCommunityBySlug.mockReset();
    tenancy.listCommunityIds.mockReset();
    access.holdsPermission.mockReset();
    billing.readAccount.mockReset();
    billing.currentSettings.mockReset();
    entitlements.planBilling.mockReset();
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

    billing.readAccount.mockResolvedValue({
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

  it("serves checkout and portal on the tenant surface", () => {
    expect(
      billingRoutes(deps()).map((item) => ({
        method: item.method,
        pattern: item.pattern,
        surface: item.surface,
      })),
    ).toEqual([
      { method: "POST", pattern: "/v1/billing/checkout", surface: "tenant" },
      { method: "POST", pattern: "/v1/billing/portal", surface: "tenant" },
    ]);
  });

  describe("common guards (checkout & portal)", () => {
    it.each(["/v1/billing/checkout", "/v1/billing/portal"])(
      "answers 404 on a foreign hostname for %s",
      async (path) => {
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
      },
    );

    it.each(["/v1/billing/checkout", "/v1/billing/portal"])(
      "answers 400 on an extra field including organisationId for %s",
      async (path) => {
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
      },
    );

    it.each(["/v1/billing/checkout", "/v1/billing/portal"])(
      "answers 401 with no session for %s",
      async (path) => {
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
      },
    );

    it.each(["/v1/billing/checkout", "/v1/billing/portal"])(
      "answers 403 for an unknown slug with no audit append for %s",
      async (path) => {
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
      },
    );

    it.each(["/v1/billing/checkout", "/v1/billing/portal"])(
      "answers 403 for a stranger with one audit append for %s",
      async (path) => {
        access.holdsPermission.mockResolvedValue(false);
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
      "answers 403 for a caller holding billing.view but not billing.manage for %s",
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

    it("answers 503 with an empty body when the port throws an error whose message holds a synthetic email", async () => {
      port.createCheckoutSession.mockRejectedValueOnce(
        new Error("Stripe error for synthetic customer user@example.test"),
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
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toBe("");
      expect(text).not.toContain("user@example.test");
    });

    it("sends exact Checkout inputs to the port and returns url", async () => {
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

    it("answers 503 with an empty body when the port throws an error whose message holds a synthetic email", async () => {
      port.createPortalSession.mockRejectedValueOnce(
        new Error("Portal error for synthetic email customer@example.test"),
      );
      const target = route("/v1/billing/portal");
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        target.handle(
          request("/v1/billing/portal", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        ),
      );
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toBe("");
      expect(text).not.toContain("customer@example.test");
    });
  });
});
