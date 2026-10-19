import { describe, expect, it } from "vitest";

import { transition } from "./transition.js";

describe("transition", () => {
  const t0 = new Date("2026-10-01T00:00:00.000Z");
  const t1 = new Date("2026-10-05T00:00:00.000Z");
  const t2 = new Date("2026-10-10T00:00:00.000Z");
  const t3 = new Date("2026-10-12T00:00:00.000Z");
  const t4 = new Date("2026-10-15T00:00:00.000Z");
  const t5 = new Date("2026-10-20T00:00:00.000Z");
  const t6 = new Date("2026-11-01T00:00:00.000Z");

  const graceDays = 7;
  const t2Grace = new Date(t2.getTime() + graceDays * 86_400_000);
  const t6Grace = new Date(t6.getTime() + graceDays * 86_400_000);

  it("handles the sequence: active → past_due → unpaid → unpaid → active", () => {
    // 1. Initial / active
    const step1 = transition(null, "active", t0, graceDays);
    expect(step1.unpaidSince).toBeNull();
    expect(step1.graceUntil).toBeNull();

    // 2. Transition to past_due
    const step2 = transition(
      { stripeStatus: "active", unpaidSince: null, graceUntil: null },
      "past_due",
      t1,
      graceDays,
    );
    expect(step2.unpaidSince).toBeNull();
    expect(step2.graceUntil).toBeNull();

    // 3. Transition to unpaid (first entry into unpaid) -> sets unpaidSince and graceUntil
    const step3 = transition(
      { stripeStatus: "past_due", unpaidSince: null, graceUntil: null },
      "unpaid",
      t2,
      graceDays,
    );
    expect(step3.unpaidSince).toEqual(t2);
    expect(step3.graceUntil).toEqual(t2Grace);

    // 4. Stays in unpaid at t3 -> kept while still unpaid (does not advance unpaidSince or graceUntil)
    const step4 = transition(
      { stripeStatus: "unpaid", unpaidSince: step3.unpaidSince, graceUntil: step3.graceUntil },
      "unpaid",
      t3,
      graceDays,
    );
    expect(step4.unpaidSince).toEqual(t2);
    expect(step4.graceUntil).toEqual(t2Grace);

    // 5. Recovery to active -> cleared
    const step5 = transition(
      { stripeStatus: "unpaid", unpaidSince: step4.unpaidSince, graceUntil: step4.graceUntil },
      "active",
      t4,
      graceDays,
    );
    expect(step5.unpaidSince).toBeNull();
    expect(step5.graceUntil).toBeNull();
  });

  it("handles transition: unpaid → canceled (cleared)", () => {
    const res = transition(
      { stripeStatus: "unpaid", unpaidSince: t2, graceUntil: t2Grace },
      "canceled",
      t5,
      graceDays,
    );
    expect(res.unpaidSince).toBeNull();
    expect(res.graceUntil).toBeNull();
  });

  it("handles a second entry into unpaid after a recovery (sets a new grace)", () => {
    // Organistion previously recovered to active (unpaidSince and graceUntil are null)
    const res = transition(
      { stripeStatus: "active", unpaidSince: null, graceUntil: null },
      "unpaid",
      t6,
      graceDays,
    );
    expect(res.unpaidSince).toEqual(t6);
    expect(res.graceUntil).toEqual(t6Grace);
  });

  it("resets unpaidSince and graceUntil on unpaid when prev was active with stale grace", () => {
    const res = transition(
      { stripeStatus: "active", unpaidSince: t2, graceUntil: t2Grace },
      "unpaid",
      t6,
      graceDays,
    );
    expect(res.unpaidSince).toEqual(t6);
    expect(res.graceUntil).toEqual(t6Grace);
  });

  it("resets unpaidSince and graceUntil on unpaid when prev was past_due with stale grace", () => {
    const res = transition(
      { stripeStatus: "past_due", unpaidSince: t2, graceUntil: t2Grace },
      "unpaid",
      t6,
      graceDays,
    );
    expect(res.unpaidSince).toEqual(t6);
    expect(res.graceUntil).toEqual(t6Grace);
  });

  it("sets graceUntil equal to now when graceDays is 0", () => {
    const res = transition(
      { stripeStatus: "active", unpaidSince: null, graceUntil: null },
      "unpaid",
      t0,
      0,
    );
    expect(res.unpaidSince).toEqual(t0);
    expect(res.graceUntil).toEqual(t0);
  });

  it("handles null prev on entry into unpaid", () => {
    const res = transition(null, "unpaid", t0, graceDays);
    expect(res.unpaidSince).toEqual(t0);
    expect(res.graceUntil).toEqual(new Date(t0.getTime() + graceDays * 86_400_000));
  });

  it("clears on transition into incomplete or trialing", () => {
    const stepIncomplete = transition(
      { stripeStatus: "unpaid", unpaidSince: t2, graceUntil: t2Grace },
      "incomplete",
      t3,
      graceDays,
    );
    expect(stepIncomplete.unpaidSince).toBeNull();
    expect(stepIncomplete.graceUntil).toBeNull();

    const stepTrialing = transition(
      { stripeStatus: "unpaid", unpaidSince: t2, graceUntil: t2Grace },
      "trialing",
      t3,
      graceDays,
    );
    expect(stepTrialing.unpaidSince).toBeNull();
    expect(stepTrialing.graceUntil).toBeNull();
  });
});
