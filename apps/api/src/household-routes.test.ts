import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRequest } from "@community-hub/kernel";
import { BillingReadOnly } from "@community-hub/billing";
import { PeopleError } from "@community-hub/people";
import type { EntitlementSnapshot } from "@community-hub/entitlements-eval";

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

const people = vi.hoisted(() => ({
  listHouseholds: vi.fn(),
  readHouseholdDetail: vi.fn(),
}));

const entitlements = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
}));

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

vi.mock("@community-hub/access", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/access")>("@community-hub/access");
  return {
    ...actual,
    holdsPermission: access.holdsPermission,
    holdsAnyGrant: access.holdsAnyGrant,
  };
});

vi.mock("@community-hub/billing", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/billing")>("@community-hub/billing");
  return {
    ...actual,
    assertWritable: billing.assertWritable,
  };
});

vi.mock("@community-hub/people", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/people")>("@community-hub/people");
  return {
    ...actual,
    listHouseholds: people.listHouseholds,
    readHouseholdDetail: people.readHouseholdDetail,
  };
});

vi.mock("@community-hub/entitlements", () => ({
  readSnapshot: entitlements.readSnapshot,
}));

vi.mock("@community-hub/db", async () => {
  const actual = await vi.importActual<typeof import("@community-hub/db")>("@community-hub/db");
  return {
    ...actual,
    withAppTransaction: db.withAppTransaction,
    appendAuditEvent: db.appendAuditEvent,
  };
});

import { householdRoutes, type HouseholdDeps } from "./household-routes.js";
import type { RouteContext } from "./gate.js";

const API_HOSTNAME = "au.api.example.test";
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const USER = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-000000000010";
const COMMUNITY = "00000000-0000-4000-8000-000000000020";
const SLUG = "parish-of-st-mary";
const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");
const FIXED_NOW = new Date("2026-11-01T12:00:00Z");
const TOKEN = "valid-token-example";
const HOUSEHOLD_ID = "00000000-0000-4000-8000-000000000099";

function createSnapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    organisationId: ORG,
    communityId: COMMUNITY,
    region: "au",
    planKey: "standard",
    loadedAt: FIXED_NOW,
    planEntitlements: [{ key: "people.households", limit: null }],
    addOnEntitlements: [],
    allocations: ["people.households"],
    toggles: [],
    overrides: [],
    flags: [],
    ...overrides,
  };
}

describe("household read routes (Task 9: list and read)", () => {
  const logCalls: { message: string; fields?: Record<string, unknown> }[] = [];

  function makeDeps(overrides: Partial<HouseholdDeps> = {}): HouseholdDeps {
    return {
      checkout: (_role, run) => run({} as never),
      kms: {} as HouseholdDeps["kms"],
      keyArn: KEY_ARN,
      now: () => FIXED_NOW,
      apiHostname: API_HOSTNAME,
      log: (message, fields) => {
        logCalls.push(fields !== undefined ? { message, fields } : { message });
      },
      guardLog: () => undefined,
      ...overrides,
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

  function route(pathName: string, bound: HouseholdDeps = makeDeps()) {
    const found = householdRoutes(bound).find((item) => item.pattern === pathName);
    if (found === undefined) {
      throw new Error(`Route not found: ${pathName}`);
    }
    return found;
  }

  async function call(
    pathName: string,
    body: unknown,
    authorization?: string,
    hostname = API_HOSTNAME,
    bound: HouseholdDeps = makeDeps(),
  ): Promise<Response> {
    const targetRoute = route(pathName, bound);
    const context: RouteContext = {
      pattern: targetRoute.pattern,
      billing: targetRoute.billing,
    };
    const authHeader = authorization === undefined ? `Bearer ${TOKEN}` : authorization;
    return withRequest({ requestId: REQUEST_ID }, async () =>
      targetRoute.handle(
        request(pathName, hostname, body, authHeader === "" ? undefined : authHeader),
        context,
      ),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    logCalls.length = 0;

    identity.readSession.mockResolvedValue({
      userId: USER,
      createdAt: FIXED_NOW,
      expiresAt: new Date(FIXED_NOW.getTime() + 3600_000),
    });

    tenancy.findCommunityBySlug.mockResolvedValue({
      id: COMMUNITY,
      organisationId: ORG,
      slug: SLUG,
    });

    access.holdsPermission.mockResolvedValue(true);
    access.holdsAnyGrant.mockResolvedValue(true);
    billing.assertWritable.mockResolvedValue("ok");
    entitlements.readSnapshot.mockResolvedValue(createSnapshot());

    db.withAppTransaction.mockImplementation((_sql, _scope, callback) => callback({} as never));

    people.listHouseholds.mockResolvedValue({
      items: [
        {
          householdId: HOUSEHOLD_ID,
          version: 1,
          label: "Smith Family",
          adultCount: 2,
        },
      ],
      nextCursor: null,
    });

    people.readHouseholdDetail.mockResolvedValue({
      householdId: HOUSEHOLD_ID,
      version: 1,
      label: "Smith Family",
      adults: [
        {
          personId: USER,
          givenName: "John",
          familyName: "Smith",
          version: 1,
        },
      ],
      guardians: [],
    });
  });

  describe("Route registration and properties", () => {
    it("registers list and read routes as tenant surface with billing: 'read'", () => {
      const routes = householdRoutes(makeDeps());
      const listRoute = routes.find((r) => r.pattern === "/v1/households/list");
      const readRoute = routes.find((r) => r.pattern === "/v1/households/read");

      expect(listRoute).toBeDefined();
      expect(listRoute?.method).toBe("POST");
      expect(listRoute?.surface).toBe("tenant");
      expect(listRoute?.billing).toBe("read");

      expect(readRoute).toBeDefined();
      expect(readRoute?.method).toBe("POST");
      expect(readRoute?.surface).toBe("tenant");
      expect(readRoute?.billing).toBe("read");
    });
  });

  describe("Validation & Strict bodies (Pin 10)", () => {
    it("rejects bodies with extra keys on households/list (400)", async () => {
      const res = await call("/v1/households/list", {
        communitySlug: SLUG,
        includeRestricted: true,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    });

    it("rejects bodies with isMinor, orgId, or communityId on households/read (400)", async () => {
      for (const extraKey of ["includeRestricted", "isMinor", "orgId", "communityId"]) {
        const res = await call("/v1/households/read", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          [extraKey]: "forbidden",
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toBe("");
      }
    });

    it("rejects limit > 25 on households/list (400)", async () => {
      const res = await call("/v1/households/list", {
        communitySlug: SLUG,
        limit: 26,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    });

    it("rejects malformed json (400)", async () => {
      const targetRoute = route("/v1/households/list");
      const context: RouteContext = {
        pattern: targetRoute.pattern,
        billing: targetRoute.billing,
      };
      const badReq = new Request("http://127.0.0.1/v1/households/list", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-community-hub-hostname": API_HOSTNAME,
          authorization: `Bearer ${TOKEN}`,
        },
        body: "{ bad json",
      });
      const res = await withRequest({ requestId: REQUEST_ID }, async () =>
        targetRoute.handle(badReq, context),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    });
  });

  describe("Authentication & Hostname", () => {
    it("rejects requests missing bearer token (401)", async () => {
      const res = await call("/v1/households/list", { communitySlug: SLUG }, "");
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });

    it("rejects invalid / expired session (401)", async () => {
      identity.readSession.mockResolvedValueOnce(null);
      const res = await call("/v1/households/list", { communitySlug: SLUG });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });

    it("rejects foreign hostname header (404)", async () => {
      const res = await call(
        "/v1/households/list",
        { communitySlug: SLUG },
        `Bearer ${TOKEN}`,
        "wrong-host.test",
      );
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });
  });

  describe("Slug & Stranger Isolation (Pin 19)", () => {
    it("returns empty 403 when community slug is not found", async () => {
      tenancy.findCommunityBySlug.mockResolvedValueOnce(null);
      const res = await call("/v1/households/list", { communitySlug: "non-existent" });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    });
  });

  describe("Entitlement check (Pin 13)", () => {
    it("refuses with 403 when people.households is disabled", async () => {
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({
          planEntitlements: [],
          allocations: [],
        }),
      );
      const res = await call("/v1/households/list", { communitySlug: SLUG });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    });

    it("allows with 200 when people.directory is disabled and people.households is enabled", async () => {
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({
          planEntitlements: [{ key: "people.households", limit: null }],
          allocations: ["people.households"],
        }),
      );
      const res = await call("/v1/households/list", { communitySlug: SLUG });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { items: unknown[] };
      expect(data.items).toHaveLength(1);
    });
  });

  describe("Billing guard: read routes are allowed during read_only (Pin 14)", () => {
    it("allows list and read even when organisation is in read-only billing state", async () => {
      billing.assertWritable.mockRejectedValue(new BillingReadOnly("read_only"));

      const listRes = await call("/v1/households/list", { communitySlug: SLUG });
      expect(listRes.status).toBe(200);

      const readRes = await call("/v1/households/read", {
        communitySlug: SLUG,
        householdId: HOUSEHOLD_ID,
      });
      expect(readRes.status).toBe(200);
    });
  });

  describe("Permission Matrix (Pin 11)", () => {
    it("households/list: requires people.view; refuses people.manage only or people.restricted.read only with 403", async () => {
      // Caller with people.manage only
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.manage";
      });

      const resManage = await call("/v1/households/list", { communitySlug: SLUG });
      expect(resManage.status).toBe(403);
      expect(await resManage.text()).toBe("");
      expect(db.appendAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorKind: "user",
          actorId: USER,
          action: "people.permission.denied",
          purpose: "people.view",
          targetIds: [ORG, COMMUNITY],
        }),
      );

      // Caller with people.restricted.read only
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.restricted.read";
      });

      const resRestricted = await call("/v1/households/list", { communitySlug: SLUG });
      expect(resRestricted.status).toBe(403);
      expect(await resRestricted.text()).toBe("");

      // Caller with people.view
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.view";
      });

      const resView = await call("/v1/households/list", { communitySlug: SLUG });
      expect(resView.status).toBe(200);
    });

    it("households/read: requires people.view OR people.restricted.read; refuses people.manage only with 403", async () => {
      // Caller with people.manage only
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.manage";
      });

      const resManage = await call("/v1/households/read", {
        communitySlug: SLUG,
        householdId: HOUSEHOLD_ID,
      });
      expect(resManage.status).toBe(403);
      expect(await resManage.text()).toBe("");
      expect(db.appendAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorKind: "user",
          actorId: USER,
          action: "people.permission.denied",
          purpose: "people.view",
          targetIds: [ORG, COMMUNITY],
        }),
      );

      // Caller with people.view only
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.view";
      });

      const resView = await call("/v1/households/read", {
        communitySlug: SLUG,
        householdId: HOUSEHOLD_ID,
      });
      expect(resView.status).toBe(200);

      // Caller with people.restricted.read only (safeguarding officer)
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.restricted.read";
      });

      const resRestricted = await call("/v1/households/read", {
        communitySlug: SLUG,
        householdId: HOUSEHOLD_ID,
      });
      expect(resRestricted.status).toBe(200);
    });
  });

  describe("Restricted derivation & Field redaction (Pins 9 & 10)", () => {
    it("passes includeRestricted: false when caller lacks people.restricted.read on list and read", async () => {
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.view";
      });

      await call("/v1/households/list", { communitySlug: SLUG });
      expect(people.listHouseholds).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        KEY_ARN,
        expect.objectContaining({
          includeRestricted: false,
          actorUserId: USER,
        }),
      );

      await call("/v1/households/read", {
        communitySlug: SLUG,
        householdId: HOUSEHOLD_ID,
      });
      expect(people.readHouseholdDetail).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        KEY_ARN,
        expect.objectContaining({
          includeRestricted: false,
          householdId: HOUSEHOLD_ID,
          actorUserId: USER,
        }),
      );
    });

    it("passes includeRestricted: true when caller holds people.restricted.read", async () => {
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.view" || perm === "people.restricted.read";
      });

      await call("/v1/households/list", { communitySlug: SLUG });
      expect(people.listHouseholds).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        KEY_ARN,
        expect.objectContaining({
          includeRestricted: true,
          actorUserId: USER,
        }),
      );

      await call("/v1/households/read", {
        communitySlug: SLUG,
        householdId: HOUSEHOLD_ID,
      });
      expect(people.readHouseholdDetail).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        KEY_ARN,
        expect.objectContaining({
          includeRestricted: true,
          householdId: HOUSEHOLD_ID,
          actorUserId: USER,
        }),
      );
    });
  });

  describe("Tenant scope and Not Found (Pins 12 & 15)", () => {
    it("returns empty 404 when readHouseholdDetail returns null (absent, cross-community or cross-org)", async () => {
      people.readHouseholdDetail.mockResolvedValueOnce(null);

      const res = await call("/v1/households/read", {
        communitySlug: SLUG,
        householdId: HOUSEHOLD_ID,
      });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });

    it("returns empty 404 when readHouseholdDetail throws not_found PeopleError", async () => {
      people.readHouseholdDetail.mockRejectedValueOnce(new PeopleError("not_found"));

      const res = await call("/v1/households/read", {
        communitySlug: SLUG,
        householdId: HOUSEHOLD_ID,
      });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });
  });

  describe("Log & Audit Hygiene (Pin 16)", () => {
    it("logs only route path, status, and requestId with no personal data or names", async () => {
      await call("/v1/households/list", { communitySlug: SLUG });

      expect(logCalls).toContainEqual({
        message: "request",
        fields: {
          path: "/v1/households/list",
          status: 200,
          requestId: REQUEST_ID,
        },
      });

      // Assert no personal name in logged fields
      for (const call of logCalls) {
        const str = JSON.stringify(call);
        expect(str).not.toContain("Smith");
        expect(str).not.toContain("John");
      }
    });
  });
});
