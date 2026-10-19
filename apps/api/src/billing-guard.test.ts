import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingReadOnly } from "@community-hub/billing";

const access = vi.hoisted(() => ({
  holdsAnyGrant: vi.fn(),
}));

const billing = vi.hoisted(() => ({
  assertWritable: vi.fn(),
}));

const db = vi.hoisted(() => ({
  withAppTransaction: vi.fn(),
}));

vi.mock("@community-hub/access", () => ({
  holdsAnyGrant: access.holdsAnyGrant,
}));

vi.mock("@community-hub/billing", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/billing")>("@community-hub/billing");
  return {
    ...actual,
    assertWritable: billing.assertWritable,
  };
});

vi.mock("@community-hub/db", async () => {
  const actual = await vi.importActual<typeof import("@community-hub/db")>("@community-hub/db");
  return {
    ...actual,
    withAppTransaction: db.withAppTransaction,
  };
});

import { guardWrite, type BillingGuardDeps } from "./billing-guard.js";
import type { Role } from "./checkout.js";

const ORG = "00000000-0000-4000-8000-000000000010";
const COMMUNITY = "00000000-0000-4000-8000-000000000011";
const USER = "00000000-0000-4000-8000-000000000002";
const FIXED_NOW = new Date("2026-10-19T00:00:00.000Z");

describe("billing-guard", () => {
  const checkoutRoles: Role[] = [];
  const logCalls: { message: string; fields: Record<string, unknown> }[] = [];

  function makeDeps(overrides: Partial<BillingGuardDeps> = {}): BillingGuardDeps {
    return {
      checkout: async (role, run) => {
        checkoutRoles.push(role);
        return run({} as never);
      },
      now: () => FIXED_NOW,
      guardLog: (message, fields) => {
        logCalls.push({ message, fields: fields as Record<string, unknown> });
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    checkoutRoles.length = 0;
    logCalls.length = 0;
    access.holdsAnyGrant.mockReset();
    billing.assertWritable.mockReset();
    db.withAppTransaction.mockReset();

    db.withAppTransaction.mockImplementation(
      async (_sql: unknown, _scope: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    );
    access.holdsAnyGrant.mockResolvedValue(true);
    billing.assertWritable.mockResolvedValue("ok");
  });

  it("returns null with no checkout calls on read or exempt marking", async () => {
    const deps = makeDeps();
    const readRes = await guardWrite(deps, { orgId: ORG, communityId: COMMUNITY }, USER, {
      billing: "read",
      pattern: "/v1/access/grants/list",
    });
    expect(readRes).toBeNull();
    expect(checkoutRoles).toEqual([]);

    const exemptRes = await guardWrite(deps, { orgId: ORG, communityId: COMMUNITY }, USER, {
      billing: "exempt",
      pattern: "/v1/billing/status",
    });
    expect(exemptRes).toBeNull();
    expect(checkoutRoles).toEqual([]);
  });

  it("returns null and never checks out the platform role when caller holds no grant (pin 10)", async () => {
    access.holdsAnyGrant.mockResolvedValueOnce(false);
    const deps = makeDeps();

    const res = await guardWrite(deps, { orgId: ORG, communityId: COMMUNITY }, USER, {
      billing: "write",
      pattern: "/v1/access/grants",
    });

    expect(res).toBeNull();
    expect(checkoutRoles).toEqual(["app"]);
    expect(billing.assertWritable).not.toHaveBeenCalled();
    expect(access.holdsAnyGrant).toHaveBeenCalledWith(expect.anything(), USER);
  });

  describe("grant plus each state (pin 11)", () => {
    it.each([
      ["none", 402],
      ["read_only", 402],
    ] as const)(
      "returns %s with empty body for blocking state %s",
      async (state, expectedStatus) => {
        billing.assertWritable.mockRejectedValueOnce(new BillingReadOnly(state));
        const deps = makeDeps();

        const res = await guardWrite(deps, { orgId: ORG, communityId: COMMUNITY }, USER, {
          billing: "write",
          pattern: "/v1/access/grants",
        });

        expect(res).not.toBeNull();
        expect(res?.status).toBe(expectedStatus);
        expect(await res?.text()).toBe("");
        expect(checkoutRoles).toEqual(["app", "platform"]);
        expect(db.withAppTransaction).toHaveBeenCalledWith(
          expect.anything(),
          { orgId: ORG, communityId: COMMUNITY },
          expect.any(Function),
        );
        expect(access.holdsAnyGrant).toHaveBeenCalledWith(expect.anything(), USER);
        expect(billing.assertWritable).toHaveBeenCalledWith(expect.anything(), ORG, FIXED_NOW);
      },
    );

    it.each(["invoiced", "ok", "retrying", "grace"] as const)(
      "returns null for writable state %s",
      async (state) => {
        billing.assertWritable.mockResolvedValueOnce(state);
        const deps = makeDeps();

        const res = await guardWrite(deps, { orgId: ORG, communityId: COMMUNITY }, USER, {
          billing: "write",
          pattern: "/v1/access/grants",
        });

        expect(res).toBeNull();
        expect(checkoutRoles).toEqual(["app", "platform"]);
        expect(db.withAppTransaction).toHaveBeenCalledWith(
          expect.anything(),
          { orgId: ORG, communityId: COMMUNITY },
          expect.any(Function),
        );
        expect(access.holdsAnyGrant).toHaveBeenCalledWith(expect.anything(), USER);
        expect(billing.assertWritable).toHaveBeenCalledWith(expect.anything(), ORG, FIXED_NOW);
      },
    );
  });

  describe("failure cases (pin 12)", () => {
    it("returns 503 with empty body when holdsAnyGrant throws", async () => {
      access.holdsAnyGrant.mockRejectedValueOnce(new Error("app db failure"));
      const deps = makeDeps();

      const res = await guardWrite(deps, { orgId: ORG, communityId: COMMUNITY }, USER, {
        billing: "write",
        pattern: "/v1/access/grants",
      });

      expect(res).not.toBeNull();
      expect(res?.status).toBe(503);
      expect(await res?.text()).toBe("");
      expect(billing.assertWritable).not.toHaveBeenCalled();
    });

    it("returns 503 with empty body when assertWritable throws an unexpected error", async () => {
      billing.assertWritable.mockRejectedValueOnce(new Error("platform db outage"));
      const deps = makeDeps();

      const res = await guardWrite(deps, { orgId: ORG, communityId: COMMUNITY }, USER, {
        billing: "write",
        pattern: "/v1/access/grants",
      });

      expect(res).not.toBeNull();
      expect(res?.status).toBe(503);
      expect(await res?.text()).toBe("");
    });
  });

  it("logs billing_write_blocked with exactly path and organisationId on 402, and body is empty (pins 11, 13)", async () => {
    billing.assertWritable.mockRejectedValueOnce(new BillingReadOnly("read_only"));
    const deps = makeDeps();

    const res = await guardWrite(deps, { orgId: ORG, communityId: COMMUNITY }, USER, {
      billing: "write",
      pattern: "/v1/access/grants",
    });

    expect(res).not.toBeNull();
    expect(res?.status).toBe(402);
    expect(await res?.text()).toBe("");

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]?.message).toBe("billing_write_blocked");
    expect(logCalls[0]?.fields).toEqual({
      path: "/v1/access/grants",
      organisationId: ORG,
    });
    expect(Object.keys(logCalls[0]?.fields ?? {})).toEqual(["path", "organisationId"]);
    expect(billing.assertWritable).toHaveBeenCalledWith(expect.anything(), ORG, FIXED_NOW);
  });
});
