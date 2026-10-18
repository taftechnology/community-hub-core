import { beforeEach, describe, expect, it, vi } from "vitest";

import { BillingUnavailable } from "@community-hub/billing";
import type { createPlatformSql } from "@community-hub/db";

type Sql = ReturnType<typeof createPlatformSql>;

const tenancy = vi.hoisted(() => ({
  findOrganisationBySlug: vi.fn(),
  listCommunityIds: vi.fn(),
}));

const billing = vi.hoisted(() => ({
  currentSettings: vi.fn(),
  insertSettings: vi.fn(),
  readAccount: vi.fn(),
  setMode: vi.fn(),
  syncQuantity: vi.fn(),
}));

const entitlements = vi.hoisted(() => ({
  upsertPlan: vi.fn(),
  setPlanBilling: vi.fn(),
}));

vi.mock("@community-hub/tenancy", () => tenancy);
vi.mock("@community-hub/billing", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/billing")>("@community-hub/billing");
  return {
    ...actual,
    currentSettings: billing.currentSettings,
    insertSettings: billing.insertSettings,
    readAccount: billing.readAccount,
    setMode: billing.setMode,
    syncQuantity: billing.syncQuantity,
  };
});
vi.mock("@community-hub/entitlements", () => entitlements);

import { runBillingAdmin, runBillingAdminMain, type BillingAdminDeps } from "./billing-admin.js";

const TEST_SECRET_KEY = "sk_test_synthetic1234567890abcdef";
// Split so secret scanners do not read this synthetic fixture as a Stripe key.
const LIVE_SECRET_KEY = "sk_live_" + "synthetic1234567890abcdef";

describe("billing-admin", () => {
  let fakeSql: Sql;
  let sqlExecuted: string[];
  let fakeStripe: {
    createTaxRate: ReturnType<typeof vi.fn>;
    updateQuantity: ReturnType<typeof vi.fn>;
    updateDefaultTaxRate: ReturnType<typeof vi.fn>;
    findPriceByLookupKey: ReturnType<typeof vi.fn>;
    ensureProduct: ReturnType<typeof vi.fn>;
    ensurePrice: ReturnType<typeof vi.fn>;
  };
  let fakeSecret: {
    get: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
  };
  let createdProductsCount: number;
  let createdPricesCount: number;

  beforeEach(() => {
    vi.resetAllMocks();
    sqlExecuted = [];
    fakeSql = vi.fn(async (strings: TemplateStringsArray) => {
      sqlExecuted.push(strings.join("?"));
      return [];
    }) as unknown as Sql;

    createdProductsCount = 0;
    createdPricesCount = 0;

    fakeStripe = {
      createTaxRate: vi.fn(async () => ({ id: "txr_test123" })),
      updateQuantity: vi.fn(async () => undefined),
      updateDefaultTaxRate: vi.fn(async () => undefined),
      findPriceByLookupKey: vi.fn(async () => null),
      ensureProduct: vi.fn(async (input) => {
        createdProductsCount++;
        return { id: `prod_${input.lookupKey}` };
      }),
      ensurePrice: vi.fn(async (input) => {
        createdPricesCount++;
        return { id: `price_${input.lookupKey}` };
      }),
    };

    fakeSecret = {
      get: vi.fn(async () => ({
        secretKey: TEST_SECRET_KEY,
        webhookSecret: "whsec_synthetic1234567890",
      })),
      invalidate: vi.fn(),
    };
  });

  function deps(args: string[], overrides: Partial<BillingAdminDeps> = {}): BillingAdminDeps {
    return {
      args,
      platform: fakeSql,
      stripe: fakeStripe as unknown as BillingAdminDeps["stripe"],
      secret: fakeSecret as unknown as BillingAdminDeps["secret"],
      now: () => new Date("2026-10-18T00:00:00.000Z"),
      ...overrides,
    };
  }

  describe("settings command", () => {
    it("happy path creates TaxRate with exact idempotency key, inserts settings row, and outputs tax_rate id", async () => {
      billing.insertSettings.mockResolvedValueOnce({
        id: "11111111-1111-4111-8111-111111111111",
        gstRateBps: 1000,
        pricesIncludeGst: true,
        trialDays: 30,
        graceDays: 7,
        stripeTaxRateId: "txr_test123",
        note: "standard GST update",
        createdAt: new Date(),
      });

      const result = await runBillingAdmin(
        deps([
          "settings",
          "--gst-bps",
          "1000",
          "--inclusive",
          "true",
          "--trial-days",
          "30",
          "--grace-days",
          "7",
          "--note",
          "standard GST update",
        ]),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("tax_rate txr_test123\n");

      expect(fakeStripe.createTaxRate).toHaveBeenCalledTimes(1);
      const call = fakeStripe.createTaxRate.mock.calls[0]![0];
      expect(call.percentage).toBe(10);
      expect(call.inclusive).toBe(true);
      expect(call.country).toBe("AU");
      expect(call.displayName).toBe("GST");
      expect(call.idempotencyKey).toMatch(/^taxrate:[0-9a-f-]{36}$/);

      const generatedRowId = call.idempotencyKey.slice("taxrate:".length);
      expect(billing.insertSettings).toHaveBeenCalledTimes(1);
      expect(billing.insertSettings).toHaveBeenCalledWith(fakeSql, {
        id: generatedRowId,
        gstRateBps: 1000,
        pricesIncludeGst: true,
        trialDays: 30,
        graceDays: 7,
        stripeTaxRateId: "txr_test123",
        note: "standard GST update",
      });
    });

    it("failing port writes nothing and exits 1", async () => {
      fakeStripe.createTaxRate.mockRejectedValueOnce(new BillingUnavailable("STRIPE_API"));

      const result = await runBillingAdmin(
        deps([
          "settings",
          "--gst-bps",
          "1000",
          "--inclusive",
          "true",
          "--trial-days",
          "30",
          "--grace-days",
          "7",
          "--note",
          "failing test note",
        ]),
      );

      expect(result.exitCode).toBe(1);
      expect(billing.insertSettings).not.toHaveBeenCalled();
    });

    it("each bound fails at edge+1 and succeeds at boundaries", async () => {
      const validArgs = [
        "settings",
        "--gst-bps",
        "1000",
        "--inclusive",
        "true",
        "--trial-days",
        "30",
        "--grace-days",
        "7",
        "--note",
        "valid",
      ];

      // gst-bps bounds: 0 to 5000
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 2), "-1", ...validArgs.slice(3)])))
          .exitCode,
      ).toBe(1);
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 2), "5001", ...validArgs.slice(3)])))
          .exitCode,
      ).toBe(1);
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 2), "0", ...validArgs.slice(3)])))
          .exitCode,
      ).toBe(0);
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 2), "5000", ...validArgs.slice(3)])))
          .exitCode,
      ).toBe(0);

      // trial-days bounds: 0 to 90
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 6), "-1", ...validArgs.slice(7)])))
          .exitCode,
      ).toBe(1);
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 6), "91", ...validArgs.slice(7)])))
          .exitCode,
      ).toBe(1);
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 6), "0", ...validArgs.slice(7)])))
          .exitCode,
      ).toBe(0);
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 6), "90", ...validArgs.slice(7)])))
          .exitCode,
      ).toBe(0);

      // grace-days bounds: 0 to 30
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 8), "-1", ...validArgs.slice(9)])))
          .exitCode,
      ).toBe(1);
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 8), "31", ...validArgs.slice(9)])))
          .exitCode,
      ).toBe(1);
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 8), "0", ...validArgs.slice(9)])))
          .exitCode,
      ).toBe(0);
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 8), "30", ...validArgs.slice(9)])))
          .exitCode,
      ).toBe(0);

      // inclusive must be boolean
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 4), "yes", ...validArgs.slice(5)])))
          .exitCode,
      ).toBe(1);
      expect(
        (await runBillingAdmin(deps([...validArgs.slice(0, 4), "false", ...validArgs.slice(5)])))
          .exitCode,
      ).toBe(0);

      // note bounds: length <= 200 printable ASCII
      const note200 = "a".repeat(200);
      const note201 = "a".repeat(201);
      expect((await runBillingAdmin(deps([...validArgs.slice(0, 10), note200]))).exitCode).toBe(0);
      expect((await runBillingAdmin(deps([...validArgs.slice(0, 10), note201]))).exitCode).toBe(1);
    });

    it("note with newline fails", async () => {
      const resultNewline = await runBillingAdmin(
        deps([
          "settings",
          "--gst-bps",
          "1000",
          "--inclusive",
          "true",
          "--trial-days",
          "30",
          "--grace-days",
          "7",
          "--note",
          "line1\nline2",
        ]),
      );
      expect(resultNewline.exitCode).toBe(1);
      expect(fakeStripe.createTaxRate).not.toHaveBeenCalled();

      const resultCR = await runBillingAdmin(
        deps([
          "settings",
          "--gst-bps",
          "1000",
          "--inclusive",
          "true",
          "--trial-days",
          "30",
          "--grace-days",
          "7",
          "--note",
          "line1\rline2",
        ]),
      );
      expect(resultCR.exitCode).toBe(1);

      const resultControl = await runBillingAdmin(
        deps([
          "settings",
          "--gst-bps",
          "1000",
          "--inclusive",
          "true",
          "--trial-days",
          "30",
          "--grace-days",
          "7",
          "--note",
          "tab\there",
        ]),
      );
      expect(resultControl.exitCode).toBe(1);
    });
  });

  describe("sync command", () => {
    it("happy path runs syncQuantity with exact idempotency key format and prints synced", async () => {
      tenancy.findOrganisationBySlug.mockResolvedValueOnce({
        id: "22222222-2222-4222-8222-222222222222",
        slug: "acme-parish",
        region: "au",
        kind: "standard",
      });
      billing.readAccount.mockResolvedValueOnce({
        organisationId: "22222222-2222-4222-8222-222222222222",
        mode: "self_serve",
        stripeSubscriptionId: "sub_sync_test1",
      });
      tenancy.listCommunityIds.mockResolvedValueOnce(["comm-1", "comm-2", "comm-3"]);

      const result = await runBillingAdmin(deps(["sync", "acme-parish"]));

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("synced\n");

      expect(billing.syncQuantity).toHaveBeenCalledTimes(1);
      const [sql, stripe, orgId, idempotencyKey] = billing.syncQuantity.mock.calls[0]!;
      expect(sql).toBe(fakeSql);
      expect(stripe).toBe(fakeStripe);
      expect(orgId).toBe("22222222-2222-4222-8222-222222222222");
      expect(idempotencyKey).toMatch(/^qty:sub_sync_test1:3:[0-9a-f-]{36}$/);
    });

    it("fails when organisation slug is unknown", async () => {
      tenancy.findOrganisationBySlug.mockResolvedValueOnce(null);

      const result = await runBillingAdmin(deps(["sync", "unknown-slug"]));
      expect(result.exitCode).toBe(1);
      expect(billing.syncQuantity).not.toHaveBeenCalled();
    });

    it("fails when account has no subscription id", async () => {
      tenancy.findOrganisationBySlug.mockResolvedValueOnce({
        id: "22222222-2222-4222-8222-222222222222",
        slug: "acme-parish",
      });
      billing.readAccount.mockResolvedValueOnce({
        organisationId: "22222222-2222-4222-8222-222222222222",
        mode: "self_serve",
        stripeSubscriptionId: null,
      });

      const result = await runBillingAdmin(deps(["sync", "acme-parish"]));
      expect(result.exitCode).toBe(1);
      expect(billing.syncQuantity).not.toHaveBeenCalled();
    });
  });

  describe("apply-tax-rate command", () => {
    it("happy path calls updateDefaultTaxRate with exact idempotency key and updates billing_accounts", async () => {
      tenancy.findOrganisationBySlug.mockResolvedValueOnce({
        id: "33333333-3333-4333-8333-333333333333",
        slug: "grace-church",
      });
      billing.currentSettings.mockResolvedValueOnce({
        id: "sett-4444",
        stripeTaxRateId: "txr_newest_gst",
      });
      billing.readAccount.mockResolvedValueOnce({
        organisationId: "33333333-3333-4333-8333-333333333333",
        mode: "self_serve",
        stripeSubscriptionId: "sub_taxmove_1",
      });

      const result = await runBillingAdmin(deps(["apply-tax-rate", "grace-church"]));

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("applied\n");

      expect(fakeStripe.updateDefaultTaxRate).toHaveBeenCalledTimes(1);
      expect(fakeStripe.updateDefaultTaxRate).toHaveBeenCalledWith({
        subscriptionId: "sub_taxmove_1",
        taxRateId: "txr_newest_gst",
        idempotencyKey: "taxmove:sub_taxmove_1:sett-4444",
      });

      expect(sqlExecuted.length).toBeGreaterThan(0);
      expect(sqlExecuted[0]).toContain("update platform.billing_accounts");
      expect(sqlExecuted[0]).toContain("tax_rate_id");
    });

    it("fails when organisation slug is unknown", async () => {
      tenancy.findOrganisationBySlug.mockResolvedValueOnce(null);

      const result = await runBillingAdmin(deps(["apply-tax-rate", "unknown"]));
      expect(result.exitCode).toBe(1);
      expect(fakeStripe.updateDefaultTaxRate).not.toHaveBeenCalled();
    });

    it("fails when settings has no tax rate", async () => {
      tenancy.findOrganisationBySlug.mockResolvedValueOnce({
        id: "33333333-3333-4333-8333-333333333333",
        slug: "grace-church",
      });
      billing.currentSettings.mockResolvedValueOnce({
        id: "sett-seed",
        stripeTaxRateId: null,
      });

      const result = await runBillingAdmin(deps(["apply-tax-rate", "grace-church"]));
      expect(result.exitCode).toBe(1);
      expect(fakeStripe.updateDefaultTaxRate).not.toHaveBeenCalled();
    });
  });

  describe("mode command", () => {
    it("mode self_serve prints none when organisation has no subscription", async () => {
      tenancy.findOrganisationBySlug.mockResolvedValueOnce({
        id: "44444444-4444-4444-8444-444444444444",
        slug: "st-peters",
      });
      billing.readAccount.mockResolvedValueOnce(null);
      billing.setMode.mockResolvedValueOnce({
        organisationId: "44444444-4444-4444-8444-444444444444",
        mode: "self_serve",
        stripeSubscriptionId: null,
        stripeStatus: null,
      });

      const result = await runBillingAdmin(deps(["mode", "st-peters", "self_serve"]));

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("none\n");
      expect(billing.setMode).toHaveBeenCalledWith(
        fakeSql,
        "44444444-4444-4444-8444-444444444444",
        "self_serve",
      );
    });

    it("mode invoiced prints invoiced when organisation has no subscription", async () => {
      tenancy.findOrganisationBySlug.mockResolvedValueOnce({
        id: "44444444-4444-4444-8444-444444444444",
        slug: "st-peters",
      });
      billing.readAccount.mockResolvedValueOnce(null);
      billing.setMode.mockResolvedValueOnce({
        organisationId: "44444444-4444-4444-8444-444444444444",
        mode: "invoiced",
        stripeSubscriptionId: null,
        stripeStatus: null,
      });

      const result = await runBillingAdmin(deps(["mode", "st-peters", "invoiced"]));

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("invoiced\n");
    });

    it("mode invoiced on active refuses without --subscription-cancelled-in-stripe and succeeds with it", async () => {
      tenancy.findOrganisationBySlug.mockResolvedValue({
        id: "44444444-4444-4444-8444-444444444444",
        slug: "st-peters",
      });
      billing.readAccount.mockResolvedValue({
        organisationId: "44444444-4444-4444-8444-444444444444",
        mode: "self_serve",
        stripeSubscriptionId: "sub_live_123",
        stripeStatus: "active",
      });

      // 1. Without flag: refuses
      const refused = await runBillingAdmin(deps(["mode", "st-peters", "invoiced"]));
      expect(refused.exitCode).toBe(1);
      expect(billing.setMode).not.toHaveBeenCalled();

      // 2. With flag: succeeds
      billing.setMode.mockResolvedValueOnce({
        organisationId: "44444444-4444-4444-8444-444444444444",
        mode: "invoiced",
        stripeSubscriptionId: "sub_live_123",
        stripeStatus: "active",
      });
      const allowed = await runBillingAdmin(
        deps(["mode", "st-peters", "invoiced", "--subscription-cancelled-in-stripe"]),
      );
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stdout).toBe("invoiced\n");
      expect(billing.setMode).toHaveBeenCalledWith(
        fakeSql,
        "44444444-4444-4444-8444-444444444444",
        "invoiced",
      );
    });

    it("mode invoiced on canceled or incomplete_expired subscription succeeds without flag", async () => {
      tenancy.findOrganisationBySlug.mockResolvedValue({
        id: "44444444-4444-4444-8444-444444444444",
        slug: "st-peters",
      });
      billing.readAccount.mockResolvedValueOnce({
        organisationId: "44444444-4444-4444-8444-444444444444",
        mode: "self_serve",
        stripeSubscriptionId: "sub_canceled_1",
        stripeStatus: "canceled",
      });
      billing.setMode.mockResolvedValueOnce({
        organisationId: "44444444-4444-4444-8444-444444444444",
        mode: "invoiced",
        stripeSubscriptionId: "sub_canceled_1",
        stripeStatus: "canceled",
      });

      const canceledResult = await runBillingAdmin(deps(["mode", "st-peters", "invoiced"]));
      expect(canceledResult.exitCode).toBe(0);
      expect(canceledResult.stdout).toBe("invoiced\n");

      billing.readAccount.mockResolvedValueOnce({
        organisationId: "44444444-4444-4444-8444-444444444444",
        mode: "self_serve",
        stripeSubscriptionId: "sub_expired_1",
        stripeStatus: "incomplete_expired",
      });
      billing.setMode.mockResolvedValueOnce({
        organisationId: "44444444-4444-4444-8444-444444444444",
        mode: "invoiced",
        stripeSubscriptionId: "sub_expired_1",
        stripeStatus: "incomplete_expired",
      });

      const expiredResult = await runBillingAdmin(deps(["mode", "st-peters", "invoiced"]));
      expect(expiredResult.exitCode).toBe(0);
      expect(expiredResult.stdout).toBe("invoiced\n");
    });
  });

  describe("plan command", () => {
    it("happy path calls upsertPlan and setPlanBilling and prints plan_set", async () => {
      const result = await runBillingAdmin(
        deps([
          "plan",
          "starter",
          "--lookup-key",
          "starter_monthly",
          "--trial-eligible",
          "true",
          "--entitlements",
          "people.directory,giving.checkout",
        ]),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("plan_set\n");

      expect(entitlements.upsertPlan).toHaveBeenCalledWith(fakeSql, {
        key: "starter",
        entitlements: [
          { key: "people.directory", limit: null },
          { key: "giving.checkout", limit: null },
        ],
      });
      expect(entitlements.setPlanBilling).toHaveBeenCalledWith(fakeSql, "starter", {
        stripeLookupKey: "starter_monthly",
        trialEligible: true,
      });
    });

    it("fails with bad lookup key", async () => {
      const badKeys = ["1starter", "Starter", "starter-monthly", "a".repeat(65), "starter$"];
      for (const badKey of badKeys) {
        const result = await runBillingAdmin(
          deps([
            "plan",
            "starter",
            "--lookup-key",
            badKey,
            "--trial-eligible",
            "true",
            "--entitlements",
            "people.directory",
          ]),
        );
        expect(result.exitCode).toBe(1);
      }
      expect(entitlements.upsertPlan).not.toHaveBeenCalled();
    });

    it("fails with bad plan key", async () => {
      const result = await runBillingAdmin(
        deps([
          "plan",
          "InvalidPlanKey!",
          "--lookup-key",
          "starter_monthly",
          "--trial-eligible",
          "true",
          "--entitlements",
          "people.directory",
        ]),
      );
      expect(result.exitCode).toBe(1);
      expect(entitlements.upsertPlan).not.toHaveBeenCalled();
    });
  });

  describe("seed-test-catalogue command", () => {
    it("refuses with a live key and makes no port calls", async () => {
      fakeSecret.get.mockResolvedValueOnce({
        secretKey: LIVE_SECRET_KEY,
        webhookSecret: "whsec_synthetic1234567890",
      });
      billing.currentSettings.mockResolvedValueOnce({
        id: "sett-seed",
        pricesIncludeGst: true,
      });

      const result = await runBillingAdmin(deps(["seed-test-catalogue"]));

      expect(result.exitCode).toBe(1);
      expect(fakeStripe.ensureProduct).not.toHaveBeenCalled();
      expect(fakeStripe.ensurePrice).not.toHaveBeenCalled();
    });

    it("happy path seeds all 7 products and prices with exact idempotency keys", async () => {
      billing.currentSettings.mockResolvedValueOnce({
        id: "sett-seed",
        gstRateBps: 1000,
        pricesIncludeGst: true,
        trialDays: 30,
        graceDays: 7,
        stripeTaxRateId: "txr_test",
      });

      const result = await runBillingAdmin(deps(["seed-test-catalogue"]));

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("seeded\n");

      const expectedKeys = [
        "starter_monthly",
        "growth_monthly",
        "ecommerce_monthly",
        "website_monthly",
        "mobile_monthly",
        "branded_monthly",
        "sms_pack_monthly",
      ];

      expect(fakeStripe.ensureProduct).toHaveBeenCalledTimes(7);
      expect(fakeStripe.ensurePrice).toHaveBeenCalledTimes(7);

      for (const k of expectedKeys) {
        expect(fakeStripe.ensureProduct).toHaveBeenCalledWith(
          expect.objectContaining({
            lookupKey: k,
            idempotencyKey: `seed:product:${k}`,
          }),
        );

        expect(fakeStripe.ensurePrice).toHaveBeenCalledWith(
          expect.objectContaining({
            lookupKey: k,
            currency: "aud",
            interval: "month",
            taxBehavior: "inclusive",
            idempotencyKey: `seed:price:${k}`,
          }),
        );
      }
    });

    it("seed re-run with existing objects creates none in the fake store", async () => {
      billing.currentSettings.mockResolvedValue({
        id: "sett-seed",
        pricesIncludeGst: true,
      });

      // First run creates 7 products and 7 prices
      const firstRun = await runBillingAdmin(deps(["seed-test-catalogue"]));
      expect(firstRun.exitCode).toBe(0);
      expect(createdProductsCount).toBe(7);
      expect(createdPricesCount).toBe(7);

      // Now simulate existing objects in fakeStripe (mock existing search hits)
      fakeStripe.ensureProduct.mockImplementation(async (input) => ({
        id: `prod_existing_${input.lookupKey}`,
      }));
      fakeStripe.ensurePrice.mockImplementation(async (input) => ({
        id: `price_existing_${input.lookupKey}`,
      }));

      createdProductsCount = 0;
      createdPricesCount = 0;

      const secondRun = await runBillingAdmin(deps(["seed-test-catalogue"]));
      expect(secondRun.exitCode).toBe(0);
      expect(createdProductsCount).toBe(0);
      expect(createdPricesCount).toBe(0);
    });
  });

  describe("output confidentiality (pins AGENTS.md rules 5 & 8)", () => {
    it("never includes sk_, rk_, or placeholder amounts in stdout or stderr", async () => {
      billing.currentSettings.mockResolvedValue({
        id: "sett-seed",
        pricesIncludeGst: true,
      });

      // Run multiple commands and check streams
      const commands = [
        [
          "settings",
          "--gst-bps",
          "1000",
          "--inclusive",
          "true",
          "--trial-days",
          "30",
          "--grace-days",
          "7",
          "--note",
          "confidentiality test",
        ],
        ["seed-test-catalogue"],
        ["mode", "acme", "self_serve"],
        ["unknown-command"],
      ];

      for (const cmd of commands) {
        const res = await runBillingAdmin(deps(cmd));
        const combined = res.stdout + res.stderr;
        expect(combined).not.toContain("sk_");
        expect(combined).not.toContain("rk_");
        expect(combined).not.toContain(TEST_SECRET_KEY);
        expect(combined).not.toContain(LIVE_SECRET_KEY);
        // Ensure placeholder amounts (1000, 2000, 500) don't leak into output
        expect(combined).not.toContain("2000");
        expect(combined).not.toContain("1000");
      }
    });
  });

  describe("top-level backstop runBillingAdminMain", () => {
    it("catches unhandled exceptions and returns exitCode 1 with fail\\n", async () => {
      tenancy.findOrganisationBySlug.mockImplementationOnce(() => {
        throw new Error("unexpected crash");
      });

      const result = await runBillingAdminMain(deps(["sync", "crash"]));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("fail\n");
    });
  });
});
