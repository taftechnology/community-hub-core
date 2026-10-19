import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRequest } from "@community-hub/kernel";
import { BillingReadOnly } from "@community-hub/billing";

const identity = vi.hoisted(() => ({
  readSession: vi.fn(),
}));

const tenancy = vi.hoisted(() => ({
  findCommunityBySlug: vi.fn(),
}));

const access = vi.hoisted(() => ({
  holdsPermission: vi.fn(),
  holdsAnyGrant: vi.fn(),
}));

const billing = vi.hoisted(() => ({
  assertWritable: vi.fn(),
}));

const entitlements = vi.hoisted(() => {
  class EntitlementError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "EntitlementError";
      this.code = code;
    }
  }
  return {
    EntitlementError,
    readSnapshot: vi.fn(),
    setToggle: vi.fn(),
  };
});

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

vi.mock("@community-hub/entitlements", () => ({
  EntitlementError: entitlements.EntitlementError,
  readSnapshot: entitlements.readSnapshot,
  setToggle: entitlements.setToggle,
}));

vi.mock("@community-hub/db", async () => {
  const actual = await vi.importActual<typeof import("@community-hub/db")>("@community-hub/db");
  return {
    ...actual,
    withAppTransaction: db.withAppTransaction,
    appendAuditEvent: db.appendAuditEvent,
  };
});

import { entitlementRoutes, type EntitlementDeps } from "./entitlement-routes.js";

const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const USER = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-000000000010";
const COMMUNITY = "00000000-0000-4000-8000-000000000011";

function deps(): EntitlementDeps {
  return {
    checkout: (_role, run) => run({} as never),
    kms: {} as EntitlementDeps["kms"],
    keyArn: "arn:aws:kms:ap-southeast-2:123456789012:key/mrk-test",
    now: () => new Date("2026-10-12T00:00:00.000Z"),
    apiHostname: API_HOSTNAME,
    log: () => undefined,
    guardLog: () => undefined,
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

function route(pathName: string, bound: EntitlementDeps = deps()) {
  const found = entitlementRoutes(bound).find((item) => item.pattern === pathName);
  if (found === undefined) {
    throw new Error(pathName);
  }
  return found;
}

describe("entitlement routes", () => {
  beforeEach(() => {
    identity.readSession.mockReset();
    tenancy.findCommunityBySlug.mockReset();
    access.holdsPermission.mockReset();
    entitlements.readSnapshot.mockReset();
    entitlements.setToggle.mockReset();
    db.withAppTransaction.mockReset();
    db.appendAuditEvent.mockReset();
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
    access.holdsPermission.mockResolvedValue(true);
    access.holdsAnyGrant.mockReset();
    access.holdsAnyGrant.mockResolvedValue(true);
    billing.assertWritable.mockReset();
    billing.assertWritable.mockResolvedValue("ok");
  });

  it("serves list and toggle on the tenant surface", () => {
    expect(
      entitlementRoutes(deps()).map((item) => ({
        method: item.method,
        pattern: item.pattern,
        surface: item.surface,
      })),
    ).toEqual([
      { method: "POST", pattern: "/v1/entitlements/list", surface: "tenant" },
      { method: "POST", pattern: "/v1/entitlements/toggle", surface: "tenant" },
    ]);
  });

  it("answers the auth hostname with 404 and a missing bearer with 401", async () => {
    const listed = route("/v1/entitlements/list");
    const hidden = await withRequest({ requestId: REQUEST_ID }, async () =>
      listed.handle(
        request(
          "/v1/entitlements/list",
          AUTH_HOSTNAME,
          { communitySlug: "parish" },
          "Bearer token",
        ),
        { billing: listed.billing, pattern: listed.pattern },
      ),
    );
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe("");

    const open = await withRequest({ requestId: REQUEST_ID }, async () =>
      listed.handle(request("/v1/entitlements/list", API_HOSTNAME, { communitySlug: "parish" }), {
        billing: listed.billing,
        pattern: listed.pattern,
      }),
    );
    expect(open.status).toBe(401);
    expect(await open.text()).toBe("");
  });

  it("answers not_found from setToggle with 404 and no audit", async () => {
    entitlements.setToggle.mockRejectedValue(new entitlements.EntitlementError("not_found"));
    const toggled = route("/v1/entitlements/toggle");
    const response = await withRequest({ requestId: REQUEST_ID }, async () =>
      toggled.handle(
        request(
          "/v1/entitlements/toggle",
          API_HOSTNAME,
          { communitySlug: "parish", key: "people.directory", enabled: false },
          "Bearer token",
        ),
        { billing: toggled.billing, pattern: toggled.pattern },
      ),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(db.appendAuditEvent).not.toHaveBeenCalled();
  });

  it("a member without entitlements.manage gets 402 on toggle in read_only, and 403 plus one audit row in ok (pin 11)", async () => {
    access.holdsPermission.mockImplementation(
      async (_tx: unknown, _userId: string, permission: string) => {
        return permission === "entitlements.view";
      },
    );
    billing.assertWritable.mockRejectedValue(new BillingReadOnly("read_only"));

    const toggled = route("/v1/entitlements/toggle");
    const blockedRes = await withRequest({ requestId: REQUEST_ID }, async () =>
      toggled.handle(
        request(
          "/v1/entitlements/toggle",
          API_HOSTNAME,
          { communitySlug: "parish", key: "people.directory", enabled: false },
          "Bearer token",
        ),
        { billing: toggled.billing, pattern: toggled.pattern },
      ),
    );
    expect(blockedRes.status).toBe(402);
    expect(await blockedRes.text()).toBe("");
    expect(db.appendAuditEvent).not.toHaveBeenCalled();

    billing.assertWritable.mockResolvedValue("ok");
    const okRes = await withRequest({ requestId: REQUEST_ID }, async () =>
      toggled.handle(
        request(
          "/v1/entitlements/toggle",
          API_HOSTNAME,
          { communitySlug: "parish", key: "people.directory", enabled: false },
          "Bearer token",
        ),
        { billing: toggled.billing, pattern: toggled.pattern },
      ),
    );
    expect(okRes.status).toBe(403);
    expect(await okRes.text()).toBe("");
    expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
    expect(db.appendAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorKind: "user",
        actorId: USER,
        action: "entitlements.permission.denied",
        purpose: "entitlements.toggles.manage",
        targetIds: [ORG, COMMUNITY],
      }),
    );
  });

  it("serves list normally in read_only and assertWritable is never called", async () => {
    billing.assertWritable.mockRejectedValue(new BillingReadOnly("read_only"));
    entitlements.readSnapshot.mockResolvedValue({
      planEntitlements: [],
      addOnEntitlements: [],
      allocations: [],
      overrides: [],
      flags: [],
      toggles: [],
    });
    const listed = route("/v1/entitlements/list");
    const res = await withRequest({ requestId: REQUEST_ID }, async () =>
      listed.handle(
        request("/v1/entitlements/list", API_HOSTNAME, { communitySlug: "parish" }, "Bearer token"),
        { billing: listed.billing, pattern: listed.pattern },
      ),
    );
    expect(res.status).toBe(200);
    expect(billing.assertWritable).not.toHaveBeenCalled();
  });
});
