import { describe, expect, it } from "vitest";

import { trialDaysFor } from "./trial.js";

describe("trialDaysFor", () => {
  const trialUsedDate = new Date("2026-05-01T00:00:00.000Z");

  it("eligible and never trialled -> returns settings.trialDays", () => {
    const plan = { trialEligible: true };
    const account = { trialUsedAt: null };
    const settings = { trialDays: 30 };

    expect(trialDaysFor(plan, account, settings)).toBe(30);
  });

  it("eligible and never trialled with null account -> returns settings.trialDays", () => {
    const plan = { trialEligible: true };
    const account = null;
    const settings = { trialDays: 30 };

    expect(trialDaysFor(plan, account, settings)).toBe(30);
  });

  it("eligible and already trialled -> returns undefined (Security pin 8)", () => {
    const plan = { trialEligible: true };
    const account = { trialUsedAt: trialUsedDate };
    const settings = { trialDays: 30 };

    expect(trialDaysFor(plan, account, settings)).toBeUndefined();
  });

  it("ineligible plan -> returns undefined", () => {
    const plan = { trialEligible: false };
    const account = { trialUsedAt: null };
    const settings = { trialDays: 30 };

    expect(trialDaysFor(plan, account, settings)).toBeUndefined();
  });

  it("settings at 0 days -> returns undefined", () => {
    const plan = { trialEligible: true };
    const account = { trialUsedAt: null };
    const settings = { trialDays: 0 };

    expect(trialDaysFor(plan, account, settings)).toBeUndefined();
  });
});
