import { describe, expect, it } from "vitest";

import { deriveState, type Account } from "./state.js";

describe("deriveState", () => {
  const now = new Date("2026-10-17T12:00:00.000Z");
  const earlier = new Date("2026-10-16T12:00:00.000Z");
  const later = new Date("2026-10-18T12:00:00.000Z");

  const cases: Array<{
    readonly name: string;
    readonly account: Account | null;
    readonly at: Date;
    readonly expected: string;
  }> = [
    // 1. Missing account row (null) -> invoiced (Security pin 6)
    {
      name: "missing account row (null) -> invoiced",
      account: null,
      at: now,
      expected: "invoiced",
    },
    // 2. Invoiced mode: any or none stripe status -> invoiced
    {
      name: "invoiced mode without subscription -> invoiced",
      account: { mode: "invoiced", stripeSubscriptionId: null, stripeStatus: null },
      at: now,
      expected: "invoiced",
    },
    {
      name: "invoiced mode with active stripe status -> invoiced",
      account: { mode: "invoiced", stripeSubscriptionId: "sub_test1", stripeStatus: "active" },
      at: now,
      expected: "invoiced",
    },
    {
      name: "invoiced mode with past_due stripe status -> invoiced",
      account: { mode: "invoiced", stripeSubscriptionId: "sub_test1", stripeStatus: "past_due" },
      at: now,
      expected: "invoiced",
    },
    {
      name: "invoiced mode with unpaid stripe status -> invoiced",
      account: { mode: "invoiced", stripeSubscriptionId: "sub_test1", stripeStatus: "unpaid" },
      at: now,
      expected: "invoiced",
    },
    {
      name: "invoiced mode with canceled stripe status -> invoiced",
      account: { mode: "invoiced", stripeSubscriptionId: "sub_test1", stripeStatus: "canceled" },
      at: now,
      expected: "invoiced",
    },
    // 3. self_serve: no subscription yet -> none
    {
      name: "self_serve with null stripeSubscriptionId -> none",
      account: { mode: "self_serve", stripeSubscriptionId: null, stripeStatus: null },
      at: now,
      expected: "none",
    },
    {
      name: "self_serve with undefined stripeSubscriptionId -> none",
      account: { mode: "self_serve" },
      at: now,
      expected: "none",
    },
    // 4. self_serve: incomplete -> none
    {
      name: "self_serve with incomplete subscription -> none",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "incomplete",
      },
      at: now,
      expected: "none",
    },
    // 5. self_serve: trialing, active -> ok
    {
      name: "self_serve with trialing subscription -> ok",
      account: { mode: "self_serve", stripeSubscriptionId: "sub_test1", stripeStatus: "trialing" },
      at: now,
      expected: "ok",
    },
    {
      name: "self_serve with active subscription -> ok",
      account: { mode: "self_serve", stripeSubscriptionId: "sub_test1", stripeStatus: "active" },
      at: now,
      expected: "ok",
    },
    // 6. self_serve: past_due -> retrying
    {
      name: "self_serve with past_due subscription -> retrying",
      account: { mode: "self_serve", stripeSubscriptionId: "sub_test1", stripeStatus: "past_due" },
      at: now,
      expected: "retrying",
    },
    // 7. self_serve: unpaid, now < grace_until -> grace
    {
      name: "self_serve with unpaid subscription and now < grace_until -> grace",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "unpaid",
        graceUntil: later,
      },
      at: now,
      expected: "grace",
    },
    // 8. self_serve: unpaid, now == grace_until -> read_only (Security pin 6 boundary)
    {
      name: "self_serve with unpaid subscription and grace_until equal to now -> read_only",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "unpaid",
        graceUntil: now,
      },
      at: now,
      expected: "read_only",
    },
    // 9. self_serve: unpaid, now > grace_until -> read_only
    {
      name: "self_serve with unpaid subscription and now > grace_until -> read_only",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "unpaid",
        graceUntil: earlier,
      },
      at: now,
      expected: "read_only",
    },
    // 10. self_serve: unpaid with null grace_until -> read_only
    {
      name: "self_serve with unpaid subscription and null grace_until -> read_only",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "unpaid",
        graceUntil: null,
      },
      at: now,
      expected: "read_only",
    },
    // 11. self_serve: canceled -> read_only
    {
      name: "self_serve with canceled subscription -> read_only",
      account: { mode: "self_serve", stripeSubscriptionId: "sub_test1", stripeStatus: "canceled" },
      at: now,
      expected: "read_only",
    },
    // 12. self_serve: incomplete_expired -> read_only
    {
      name: "self_serve with incomplete_expired subscription -> read_only",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "incomplete_expired",
      },
      at: now,
      expected: "read_only",
    },
    // 13. self_serve: unknown statuses (e.g. paused, some_future_status) -> read_only
    {
      name: "self_serve with paused subscription -> read_only",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "paused",
      },
      at: now,
      expected: "read_only",
    },
    {
      name: "self_serve with some_future_status subscription -> read_only",
      account: {
        mode: "self_serve",
        stripeSubscriptionId: "sub_test1",
        stripeStatus: "some_future_status",
      },
      at: now,
      expected: "read_only",
    },
  ];

  it.each(cases)("$name", ({ account, at, expected }) => {
    expect(deriveState(account, at)).toBe(expected);
  });
});
