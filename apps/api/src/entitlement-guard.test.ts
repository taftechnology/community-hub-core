import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntitlementSnapshot } from "@community-hub/entitlements-eval";

const entitlements = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
}));

vi.mock("@community-hub/entitlements", () => ({
  readSnapshot: entitlements.readSnapshot,
}));

import {
  guardEntitlement,
  isEntitlementEnabled,
  type CommunityScope,
  type EntitlementGuardDeps,
} from "./entitlement-guard.js";
import type { Role } from "./checkout.js";

const ORG = "00000000-0000-4000-8000-000000000001";
const COMMUNITY_A = "00000000-0000-4000-8000-000000000002";
const COMMUNITY_B = "00000000-0000-4000-8000-000000000003";
const FIXED_NOW = new Date("2026-10-31T12:00:00.000Z");

function createSnapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    organisationId: ORG,
    communityId: COMMUNITY_A,
    region: "au",
    planKey: "standard",
    loadedAt: FIXED_NOW,
    planEntitlements: [{ key: "people.directory", limit: null }],
    addOnEntitlements: [],
    allocations: ["people.directory"],
    toggles: [],
    overrides: [],
    flags: [],
    ...overrides,
  };
}

describe("entitlement-guard", () => {
  const checkoutRoles: Role[] = [];

  function makeDeps(overrides: Partial<EntitlementGuardDeps> = {}): EntitlementGuardDeps {
    return {
      checkout: async (role, run) => {
        checkoutRoles.push(role);
        return run({} as never);
      },
      now: () => FIXED_NOW,
      ...overrides,
    };
  }

  beforeEach(() => {
    checkoutRoles.length = 0;
    entitlements.readSnapshot.mockReset();
  });

  describe("isEntitlementEnabled", () => {
    it("returns true when key is enabled in snapshot", async () => {
      entitlements.readSnapshot.mockResolvedValueOnce(createSnapshot());
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const enabled = await isEntitlementEnabled({}, scope, "people.directory", FIXED_NOW);

      expect(enabled).toBe(true);
      expect(entitlements.readSnapshot).toHaveBeenCalledWith(expect.anything(), {
        organisationId: ORG,
        communityId: COMMUNITY_A,
        now: FIXED_NOW,
      });
    });

    it("returns false when disabled by toggle", async () => {
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({
          toggles: [{ key: "people.directory", enabled: false }],
        }),
      );
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const enabled = await isEntitlementEnabled({}, scope, "people.directory", FIXED_NOW);

      expect(enabled).toBe(false);
    });

    it("returns false when key is absent", async () => {
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({
          planEntitlements: [],
          allocations: [],
        }),
      );
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const enabled = await isEntitlementEnabled({}, scope, "people.directory", FIXED_NOW);

      expect(enabled).toBe(false);
    });

    it("returns false for expired override as evaluate defines it", async () => {
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({
          planEntitlements: [],
          allocations: ["people.directory"],
          overrides: [
            {
              key: "people.directory",
              expiresAt: new Date(FIXED_NOW.getTime() - 1000),
            },
          ],
        }),
      );
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const enabled = await isEntitlementEnabled({}, scope, "people.directory", FIXED_NOW);

      expect(enabled).toBe(false);
    });

    it("returns false when not allocated as evaluate defines it", async () => {
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({
          allocations: [],
        }),
      );
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const enabled = await isEntitlementEnabled({}, scope, "people.directory", FIXED_NOW);

      expect(enabled).toBe(false);
    });

    it("returns false when snapshot reading throws (unevaluable)", async () => {
      entitlements.readSnapshot.mockRejectedValueOnce(new Error("db failure"));
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const enabled = await isEntitlementEnabled({}, scope, "people.directory", FIXED_NOW);

      expect(enabled).toBe(false);
    });

    it("evaluates two communities correctly (one enabled, one not)", async () => {
      entitlements.readSnapshot.mockImplementation(
        async (_sql: unknown, query: { communityId: string }) => {
          if (query.communityId === COMMUNITY_A) {
            return createSnapshot({ communityId: COMMUNITY_A, allocations: ["people.directory"] });
          }
          return createSnapshot({ communityId: COMMUNITY_B, allocations: [] });
        },
      );

      const scopeA: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };
      const scopeB: CommunityScope = { orgId: ORG, communityId: COMMUNITY_B };

      const enabledA = await isEntitlementEnabled({}, scopeA, "people.directory", FIXED_NOW);
      const enabledB = await isEntitlementEnabled({}, scopeB, "people.directory", FIXED_NOW);

      expect(enabledA).toBe(true);
      expect(enabledB).toBe(false);
    });
  });

  describe("guardEntitlement", () => {
    it("returns null when key is enabled and checks out platform role", async () => {
      entitlements.readSnapshot.mockResolvedValueOnce(createSnapshot());
      const deps = makeDeps();
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const result = await guardEntitlement(deps, scope, "people.directory");

      expect(result).toBeNull();
      expect(checkoutRoles).toEqual(["platform"]);
    });

    it("returns 403 with empty body when key is disabled by toggle", async () => {
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({
          toggles: [{ key: "people.directory", enabled: false }],
        }),
      );
      const deps = makeDeps();
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const result = await guardEntitlement(deps, scope, "people.directory");

      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
      expect(await result?.text()).toBe("");
      expect(result?.headers.get("x-entitlement-key")).toBeNull();
    });

    it("returns 403 with empty body when key is absent", async () => {
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({
          planEntitlements: [],
          allocations: [],
        }),
      );
      const deps = makeDeps();
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const result = await guardEntitlement(deps, scope, "people.directory");

      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
      expect(await result?.text()).toBe("");
    });

    it("returns 403 with empty body when unevaluable or error thrown", async () => {
      entitlements.readSnapshot.mockRejectedValueOnce(new Error("unevaluable"));
      const deps = makeDeps();
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const result = await guardEntitlement(deps, scope, "people.directory");

      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
      expect(await result?.text()).toBe("");
    });

    it("fails closed with 403 when checkout itself rejects (finding 4)", async () => {
      const deps = makeDeps({
        checkout: vi.fn().mockRejectedValueOnce(new Error("platform checkout failed")),
      });
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const result = await guardEntitlement(deps, scope, "people.directory");

      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
      expect(await result?.text()).toBe("");
    });

    it("logs error class only when snapshot reading fails closed (finding 6)", async () => {
      const guardLog = vi.fn();
      entitlements.readSnapshot.mockRejectedValueOnce(
        new Error("sensitive internal db password or details"),
      );
      const deps = makeDeps({ guardLog });
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const result = await guardEntitlement(deps, scope, "people.directory");

      expect(result?.status).toBe(403);
      expect(guardLog).toHaveBeenCalledWith("entitlement_guard_failed", {
        errorClass: "Error",
      });
      const loggedText = JSON.stringify(guardLog.mock.calls);
      expect(loggedText).not.toContain("sensitive");
      expect(loggedText).not.toContain("password");
    });

    it("logs error class only when checkout rejects (finding 6)", async () => {
      const guardLog = vi.fn();
      const deps = makeDeps({
        checkout: vi.fn().mockRejectedValueOnce(new TypeError("sensitive type details")),
        guardLog,
      });
      const scope: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };

      const result = await guardEntitlement(deps, scope, "people.directory");

      expect(result?.status).toBe(403);
      expect(guardLog).toHaveBeenCalledWith("entitlement_guard_failed", {
        errorClass: "TypeError",
      });
      const loggedText = JSON.stringify(guardLog.mock.calls);
      expect(loggedText).not.toContain("sensitive");
      expect(loggedText).not.toContain("type details");
    });

    it("guards two communities independently (one enabled, one not)", async () => {
      entitlements.readSnapshot.mockImplementation(
        async (_sql: unknown, query: { communityId: string }) => {
          if (query.communityId === COMMUNITY_A) {
            return createSnapshot({ communityId: COMMUNITY_A, allocations: ["people.directory"] });
          }
          return createSnapshot({ communityId: COMMUNITY_B, allocations: [] });
        },
      );
      const deps = makeDeps();
      const scopeA: CommunityScope = { orgId: ORG, communityId: COMMUNITY_A };
      const scopeB: CommunityScope = { orgId: ORG, communityId: COMMUNITY_B };

      const resA = await guardEntitlement(deps, scopeA, "people.directory");
      const resB = await guardEntitlement(deps, scopeB, "people.directory");

      expect(resA).toBeNull();
      expect(resB).not.toBeNull();
      expect(resB?.status).toBe(403);
      expect(await resB?.text()).toBe("");
    });
  });
});
