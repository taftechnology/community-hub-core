import { describe, expect, it } from "vitest";

import { checkoutDecision } from "./checkout.js";
import type { Account } from "./state.js";

describe("checkoutDecision", () => {
  const future = new Date("2026-10-25T12:00:00.000Z");
  const past = new Date("2026-10-10T12:00:00.000Z");

  const cases: Array<{
    readonly name: string;
    readonly account: Account | null;
    readonly expected: "allowed" | "conflict";
  }> = [
    // 1. Missing account (null) -> conflict (Security pin 7)
    {
      name: "missing account row (null) -> conflict",
      account: null,
      expected: "conflict",
    },
    // 2. Invoiced mode -> conflict (Security pin 7)
    {
      name: "invoiced mode without subscription -> conflict",
      account: { mode: "invoiced", stripeSubscriptionId: null },
      expected: "conflict",
    },
    {
      name: "invoiced mode with active subscription -> conflict",
      account: { mode: "invoiced", stripeSubscriptionId: "sub_test1", stripeStatus: "active" },
      expected: "conflict",
    },
    {
      name: "invoiced mode with canceled subscription -> conflict",
      account: { mode: "invoiced", stripeSubscriptionId: "sub_test1", stripeStatus: "canceled" },
      expected: "conflict",
    },
    {
      name: "invoiced mode with unpaid subscription -> conflict",
      account: { mode: "invoiced", stripeSubscriptionId: "sub_test1", stripeStatus: "unpaid" },
      expected: "conflict",
    },
    // 3. self_serve: no subscription -> allowed
    {
      name: "self_serve with null stripeSubscriptionId -> allowed",
      account: { mode: "self_serve", stripeSubscriptionId: null },
      expected: "allowed",
    },
    {
      name: "self_serve with undefined stripeSubscriptionId -> allowed",
      account: { mode: "self_serve" },
      expected: "allowed",
    },
    // 4. self_serve: canceled -> allowed
    {
      name: "self_serve with canceled subscription -> allowed",
      account: { mode: "self_serve", stripeSubscriptionId: "sub_test1", stripeStatus: "canceled" },
      expected: "allowed",
    },
    // 5. self_serve: incomplete_expired -> allowed
    {
      name: "self_serve with incomplete_expired subscription -> allowed",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "incomplete_expired",
      },
      expected: "allowed",
    },
    // 6. self_serve: incomplete -> conflict
    {
      name: "self_serve with incomplete subscription -> conflict",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "incomplete",
      },
      expected: "conflict",
    },
    // 7. self_serve: trialing -> conflict
    {
      name: "self_serve with trialing subscription -> conflict",
      account: { mode: "self_serve", stripeSubscriptionId: "sub_test1", stripeStatus: "trialing" },
      expected: "conflict",
    },
    // 8. self_serve: active -> conflict
    {
      name: "self_serve with active subscription -> conflict",
      account: { mode: "self_serve", stripeSubscriptionId: "sub_test1", stripeStatus: "active" },
      expected: "conflict",
    },
    // 9. self_serve: past_due -> conflict
    {
      name: "self_serve with past_due subscription -> conflict",
      account: { mode: "self_serve", stripeSubscriptionId: "sub_test1", stripeStatus: "past_due" },
      expected: "conflict",
    },
    // 10. self_serve: unpaid (during grace) -> conflict (Security pin 7)
    {
      name: "self_serve with unpaid subscription (within grace) -> conflict",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "unpaid",
        graceUntil: future,
      },
      expected: "conflict",
    },
    // 11. self_serve: unpaid (after grace / read_only) -> conflict (Security pin 7)
    {
      name: "self_serve with unpaid subscription (after grace) -> conflict",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "unpaid",
        graceUntil: past,
      },
      expected: "conflict",
    },
    // 12. self_serve: unknown statuses (e.g. paused, some_future_status) -> conflict
    {
      name: "self_serve with paused subscription -> conflict",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "paused",
      },
      expected: "conflict",
    },
    {
      name: "self_serve with some_future_status subscription -> conflict",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "some_future_status",
      },
      expected: "conflict",
    },
  ];

  it.each(cases)("$name", ({ account, expected }) => {
    expect(checkoutDecision(account)).toBe(expected);
  });
});
