import { describe, expect, it } from "vitest";

import {
  checkoutBody,
  portalBody,
  statusBody,
  plansBody,
  urlResponse,
  statusResponse,
  plansResponse,
} from "./billing.js";

describe("billing contracts", () => {
  describe("checkoutBody", () => {
    it("accepts valid communitySlug and planKey", () => {
      const parsed = checkoutBody.safeParse({
        communitySlug: "parish",
        planKey: "starter",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({
          communitySlug: "parish",
          planKey: "starter",
        });
      }
    });

    it("rejects an organisationId field", () => {
      const parsed = checkoutBody.safeParse({
        communitySlug: "parish",
        planKey: "starter",
        organisationId: "00000000-0000-4000-8000-000000000010",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects an extra field", () => {
      const parsed = checkoutBody.safeParse({
        communitySlug: "parish",
        planKey: "starter",
        extra: "forbidden",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects missing communitySlug or planKey", () => {
      expect(checkoutBody.safeParse({ communitySlug: "parish" }).success).toBe(false);
      expect(checkoutBody.safeParse({ planKey: "starter" }).success).toBe(false);
      expect(checkoutBody.safeParse({}).success).toBe(false);
    });

    it("rejects empty communitySlug", () => {
      expect(checkoutBody.safeParse({ communitySlug: "", planKey: "starter" }).success).toBe(false);
    });

    it("rejects invalid planKey format", () => {
      expect(checkoutBody.safeParse({ communitySlug: "parish", planKey: "Bad-Key!" }).success).toBe(
        false,
      );
    });
  });

  describe("portalBody", () => {
    it("accepts valid communitySlug", () => {
      const parsed = portalBody.safeParse({
        communitySlug: "parish",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({
          communitySlug: "parish",
        });
      }
    });

    it("rejects an organisationId field", () => {
      const parsed = portalBody.safeParse({
        communitySlug: "parish",
        organisationId: "00000000-0000-4000-8000-000000000010",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects extra fields", () => {
      const parsed = portalBody.safeParse({
        communitySlug: "parish",
        customerId: "cus_123",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects missing communitySlug", () => {
      expect(portalBody.safeParse({}).success).toBe(false);
    });
  });

  describe("statusBody", () => {
    it("accepts valid communitySlug", () => {
      const parsed = statusBody.safeParse({
        communitySlug: "parish",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects an organisationId field", () => {
      const parsed = statusBody.safeParse({
        communitySlug: "parish",
        organisationId: "00000000-0000-4000-8000-000000000010",
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("urlResponse", () => {
    it("accepts valid url", () => {
      const parsed = urlResponse.safeParse({
        url: "https://checkout.stripe.com/c/pay/cs_test_123",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects extra fields", () => {
      const parsed = urlResponse.safeParse({
        url: "https://checkout.stripe.com/c/pay/cs_test_123",
        extra: "field",
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("statusResponse", () => {
    it("accepts full status object", () => {
      const parsed = statusResponse.safeParse({
        state: "ok",
        planKey: "starter",
        quantity: 2,
        current_period_end: "2026-11-01T00:00:00.000Z",
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: true,
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts banner status object", () => {
      const parsed = statusResponse.safeParse({
        state: "ok",
        trial_end: null,
        grace_until: null,
        canView: false,
        canManage: false,
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects invalid state", () => {
      const parsed = statusResponse.safeParse({
        state: "invalid_state",
        trial_end: null,
        grace_until: null,
        canView: false,
        canManage: false,
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("plansBody", () => {
    it("accepts valid communitySlug", () => {
      const parsed = plansBody.safeParse({
        communitySlug: "parish",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({
          communitySlug: "parish",
        });
      }
    });

    it("rejects an organisationId field", () => {
      const parsed = plansBody.safeParse({
        communitySlug: "parish",
        organisationId: "00000000-0000-4000-8000-000000000010",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects extra fields", () => {
      const parsed = plansBody.safeParse({
        communitySlug: "parish",
        extra: "forbidden",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects missing communitySlug", () => {
      expect(plansBody.safeParse({}).success).toBe(false);
    });

    it("rejects empty communitySlug", () => {
      expect(plansBody.safeParse({ communitySlug: "" }).success).toBe(false);
    });
  });

  describe("plansResponse", () => {
    it("accepts valid plans array", () => {
      const parsed = plansResponse.safeParse({
        plans: [
          { key: "starter", trialAvailable: true },
          { key: "growth", trialAvailable: false },
        ],
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({
          plans: [
            { key: "starter", trialAvailable: true },
            { key: "growth", trialAvailable: false },
          ],
        });
      }
    });

    it("rejects extra field on root", () => {
      const parsed = plansResponse.safeParse({
        plans: [{ key: "starter", trialAvailable: true }],
        extra: "forbidden",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects extra field on plan item (including amount)", () => {
      const parsed = plansResponse.safeParse({
        plans: [{ key: "starter", trialAvailable: true, amount: 1000 }],
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects non-boolean trialAvailable", () => {
      const parsed = plansResponse.safeParse({
        plans: [{ key: "starter", trialAvailable: "yes" }],
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects missing plans key", () => {
      expect(plansResponse.safeParse({}).success).toBe(false);
    });
  });
});
