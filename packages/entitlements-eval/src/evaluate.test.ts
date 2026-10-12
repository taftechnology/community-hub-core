import { describe, expect, it } from "vitest";

import { evaluate, limit, type EntitlementSnapshot } from "./evaluate.js";

const now = new Date("2026-10-12T00:00:00.000Z");

function snapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    organisationId: "00000000-0000-4000-8000-000000000001",
    communityId: "00000000-0000-4000-8000-000000000002",
    region: "au",
    planKey: "starter",
    loadedAt: now,
    planEntitlements: [{ key: "people.directory", limit: null }],
    addOnEntitlements: [],
    allocations: ["people.directory"],
    toggles: [],
    overrides: [],
    flags: [],
    ...overrides,
  };
}

describe("evaluate", () => {
  it("passes when no flag matches and the key is allocated", () => {
    expect(evaluate(snapshot(), "people.directory", now)).toEqual({ ok: true });
  });

  it("fails step 1 when a matching flag is disabled", () => {
    const result = evaluate(
      snapshot({
        flags: [
          {
            key: "people.directory",
            enabled: false,
            organisationId: null,
            communityId: null,
            planKey: null,
            region: null,
          },
        ],
      }),
      "people.directory",
      now,
    );
    expect(result).toEqual({ ok: false, step: "flag" });
  });

  it("does not let a flag for another plan kill the key", () => {
    const result = evaluate(
      snapshot({
        flags: [
          {
            key: "people.directory",
            enabled: true,
            organisationId: null,
            communityId: null,
            planKey: "growth",
            region: null,
          },
        ],
      }),
      "people.directory",
      now,
    );
    expect(result).toEqual({ ok: true });
  });

  it("fails step 2 when the plan, add-ons, and overrides omit the key", () => {
    const result = evaluate(
      snapshot({
        planEntitlements: [],
        addOnEntitlements: [],
        overrides: [],
      }),
      "people.directory",
      now,
    );
    expect(result).toEqual({ ok: false, step: "entitlement" });
  });

  it("fails step 3 when an unexpired override is not allocated", () => {
    const result = evaluate(
      snapshot({
        planEntitlements: [],
        allocations: [],
        overrides: [{ key: "people.directory", expiresAt: new Date(now.getTime() + 1_000) }],
      }),
      "people.directory",
      now,
    );
    expect(result).toEqual({ ok: false, step: "allocation" });
  });

  it("does not treat an override that expires now as entitled", () => {
    const result = evaluate(
      snapshot({
        planEntitlements: [],
        overrides: [{ key: "people.directory", expiresAt: now }],
      }),
      "people.directory",
      now,
    );
    expect(result).toEqual({ ok: false, step: "entitlement" });
  });

  it("fails step 4 when the toggle is off", () => {
    const result = evaluate(
      snapshot({
        toggles: [{ key: "people.directory", enabled: false }],
      }),
      "people.directory",
      now,
    );
    expect(result).toEqual({ ok: false, step: "toggle" });
  });
});

describe("limit", () => {
  it("returns the plan limit, including null, ahead of an add-on", () => {
    const result = limit(
      snapshot({
        planEntitlements: [{ key: "people.directory", limit: null }],
        addOnEntitlements: [{ key: "people.directory", limit: 10 }],
      }),
      "people.directory",
    );
    expect(result).toBeNull();
  });

  it("returns the smallest add-on limit when the plan omits the key", () => {
    const result = limit(
      snapshot({
        planEntitlements: [],
        addOnEntitlements: [
          { key: "people.directory", limit: 10 },
          { key: "people.directory", limit: 4 },
          { key: "people.households", limit: 1 },
        ],
      }),
      "people.directory",
    );
    expect(result).toBe(4);
  });

  it("returns null when no row sets a number", () => {
    const result = limit(
      snapshot({
        planEntitlements: [],
        addOnEntitlements: [{ key: "people.directory", limit: null }],
      }),
      "people.directory",
    );
    expect(result).toBeNull();
  });
});
