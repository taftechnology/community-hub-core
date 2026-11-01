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
  createHousehold: vi.fn(),
  renameHousehold: vi.fn(),
  moveAdult: vi.fn(),
  addMinor: vi.fn(),
  linkGuardian: vi.fn(),
  unlinkGuardian: vi.fn(),
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
    createHousehold: people.createHousehold,
    renameHousehold: people.renameHousehold,
    moveAdult: people.moveAdult,
    addMinor: people.addMinor,
    linkGuardian: people.linkGuardian,
    unlinkGuardian: people.unlinkGuardian,
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
const PERSON_ID = "00000000-0000-4000-8000-000000000005";
const GUARDIAN_ID = "00000000-0000-4000-8000-000000000006";
const LINK_ID = "00000000-0000-4000-8000-000000000007";

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

    people.createHousehold.mockResolvedValue({
      householdId: HOUSEHOLD_ID,
      version: 1,
    });
    people.renameHousehold.mockResolvedValue({ version: 2 });
    people.moveAdult.mockResolvedValue({ version: 2 });
    people.addMinor.mockResolvedValue({ personId: PERSON_ID, linkId: LINK_ID });
    people.linkGuardian.mockResolvedValue({ linkId: LINK_ID });
    people.unlinkGuardian.mockResolvedValue(undefined);
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

  describe("Household Write Routes (Task 10)", () => {
    describe("Route registration and properties", () => {
      it("registers all six write routes as tenant surface with billing: 'write'", () => {
        const routes = householdRoutes(makeDeps());
        const patterns = [
          "/v1/households/create",
          "/v1/households/rename",
          "/v1/households/members/move-adult",
          "/v1/households/members/add-minor",
          "/v1/households/guardians/link",
          "/v1/households/guardians/unlink",
        ];

        for (const pattern of patterns) {
          const r = routes.find((item) => item.pattern === pattern);
          expect(r).toBeDefined();
          expect(r?.method).toBe("POST");
          expect(r?.surface).toBe("tenant");
          expect(r?.billing).toBe("write");
        }
      });
    });

    describe("Strict bodies and Validation (Pin 10)", () => {
      it("rejects extra keys on all write routes with 400", async () => {
        const resCreate = await call("/v1/households/create", {
          communitySlug: SLUG,
          includeRestricted: true,
        });
        expect(resCreate.status).toBe(400);

        const resRename = await call("/v1/households/rename", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          version: 1,
          label: "New Name",
          isMinor: false,
        });
        expect(resRename.status).toBe(400);

        const resMove = await call("/v1/households/members/move-adult", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          personId: PERSON_ID,
          version: 1,
          communityId: COMMUNITY,
        });
        expect(resMove.status).toBe(400);

        const resAdd = await call("/v1/households/members/add-minor", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          givenName: "Tommy",
          familyName: "Smith",
          dateOfBirth: "2015-05-10",
          guardianId: GUARDIAN_ID,
          orgId: ORG,
        });
        expect(resAdd.status).toBe(400);

        const resLink = await call("/v1/households/guardians/link", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          guardianId: GUARDIAN_ID,
          childId: PERSON_ID,
          includeRestricted: false,
        });
        expect(resLink.status).toBe(400);

        const resUnlink = await call("/v1/households/guardians/unlink", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          linkId: LINK_ID,
          orgId: ORG,
        });
        expect(resUnlink.status).toBe(400);
      });
    });

    describe("Billing Guard: write routes return 402 on read_only (Pin 14)", () => {
      it("blocks all six write routes with empty 402 when organisation is read-only", async () => {
        billing.assertWritable.mockRejectedValue(new BillingReadOnly("read_only"));

        const calls = [
          call("/v1/households/create", { communitySlug: SLUG }),
          call("/v1/households/rename", {
            communitySlug: SLUG,
            householdId: HOUSEHOLD_ID,
            version: 1,
            label: "New Name",
          }),
          call("/v1/households/members/move-adult", {
            communitySlug: SLUG,
            householdId: HOUSEHOLD_ID,
            personId: PERSON_ID,
            version: 1,
          }),
          call("/v1/households/members/add-minor", {
            communitySlug: SLUG,
            householdId: HOUSEHOLD_ID,
            givenName: "Tommy",
            familyName: "Smith",
            dateOfBirth: "2015-05-10",
            guardianId: GUARDIAN_ID,
          }),
          call("/v1/households/guardians/link", {
            communitySlug: SLUG,
            householdId: HOUSEHOLD_ID,
            guardianId: GUARDIAN_ID,
            childId: PERSON_ID,
          }),
          call("/v1/households/guardians/unlink", {
            communitySlug: SLUG,
            householdId: HOUSEHOLD_ID,
            linkId: LINK_ID,
          }),
        ];

        for (const p of calls) {
          const res = await p;
          expect(res.status).toBe(402);
          expect(await res.text()).toBe("");
        }
      });
    });

    describe("Entitlement check on write routes (Pin 13)", () => {
      it("refuses write routes with 403 when people.households is disabled", async () => {
        entitlements.readSnapshot.mockResolvedValue(
          createSnapshot({
            planEntitlements: [],
            allocations: [],
          }),
        );

        const res = await call("/v1/households/create", { communitySlug: SLUG });
        expect(res.status).toBe(403);
        expect(await res.text()).toBe("");
      });

      it("allows write routes when people.directory is disabled and people.households is enabled", async () => {
        entitlements.readSnapshot.mockResolvedValue(
          createSnapshot({
            planEntitlements: [{ key: "people.households", limit: null }],
            allocations: ["people.households"],
          }),
        );

        const res = await call("/v1/households/create", { communitySlug: SLUG });
        expect(res.status).toBe(201);
      });
    });

    describe("Permission Matrix on write routes (Pin 11)", () => {
      it("households/create: requires people.manage; refuses view or restricted.read only with 403", async () => {
        // Caller with view only
        access.holdsPermission.mockImplementation(async (_tx, _u, perm) => perm === "people.view");
        db.appendAuditEvent.mockClear();
        const resView = await call("/v1/households/create", { communitySlug: SLUG });
        expect(resView.status).toBe(403);
        expect(await resView.text()).toBe("");
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.manage",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Caller with restricted.read only
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.restricted.read",
        );
        db.appendAuditEvent.mockClear();
        const resRestricted = await call("/v1/households/create", { communitySlug: SLUG });
        expect(resRestricted.status).toBe(403);
        expect(await resRestricted.text()).toBe("");
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.manage",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Caller with manage
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.manage",
        );
        db.appendAuditEvent.mockClear();
        const resManage = await call("/v1/households/create", { communitySlug: SLUG });
        expect(resManage.status).toBe(201);
        expect(db.appendAuditEvent).not.toHaveBeenCalled();
      });

      it("households/rename: requires people.manage; refuses view or restricted.read only with 403", async () => {
        // Caller with view only
        access.holdsPermission.mockImplementation(async (_tx, _u, perm) => perm === "people.view");
        db.appendAuditEvent.mockClear();
        const resView = await call("/v1/households/rename", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          version: 1,
          label: "New",
        });
        expect(resView.status).toBe(403);
        expect(await resView.text()).toBe("");
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.manage",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Caller with restricted only
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.restricted.read",
        );
        db.appendAuditEvent.mockClear();
        const resRestricted = await call("/v1/households/rename", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          version: 1,
          label: "New",
        });
        expect(resRestricted.status).toBe(403);
        expect(await resRestricted.text()).toBe("");
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.manage",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Caller with manage
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.manage",
        );
        db.appendAuditEvent.mockClear();
        const resManage = await call("/v1/households/rename", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          version: 1,
          label: "New",
        });
        expect(resManage.status).toBe(200);
        expect(db.appendAuditEvent).not.toHaveBeenCalled();
      });

      it("move-adult: requires BOTH people.manage AND people.restricted.read (Pin 11)", async () => {
        // Caller with manage only -> 403
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.manage",
        );
        db.appendAuditEvent.mockClear();
        const resManageOnly = await call("/v1/households/members/move-adult", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          personId: PERSON_ID,
          version: 1,
        });
        expect(resManageOnly.status).toBe(403);
        expect(await resManageOnly.text()).toBe("");
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.restricted.read",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Caller with restricted.read only -> 403
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.restricted.read",
        );
        db.appendAuditEvent.mockClear();
        const resRestrictedOnly = await call("/v1/households/members/move-adult", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          personId: PERSON_ID,
          version: 1,
        });
        expect(resRestrictedOnly.status).toBe(403);
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.manage",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Caller with BOTH -> 200
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.manage" || perm === "people.restricted.read",
        );
        db.appendAuditEvent.mockClear();
        const resBoth = await call("/v1/households/members/move-adult", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          personId: PERSON_ID,
          version: 1,
        });
        expect(resBoth.status).toBe(200);
        expect(db.appendAuditEvent).not.toHaveBeenCalled();
      });

      it("add-minor: requires BOTH people.manage AND people.restricted.read (Pin 11)", async () => {
        // Manage only -> 403
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.manage",
        );
        db.appendAuditEvent.mockClear();
        const resManageOnly = await call("/v1/households/members/add-minor", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          givenName: "Tommy",
          familyName: "Smith",
          dateOfBirth: "2015-05-10",
          guardianId: GUARDIAN_ID,
        });
        expect(resManageOnly.status).toBe(403);
        expect(await resManageOnly.text()).toBe("");
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.restricted.read",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Restricted.read only -> 403
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.restricted.read",
        );
        db.appendAuditEvent.mockClear();
        const resRestrictedOnly = await call("/v1/households/members/add-minor", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          givenName: "Tommy",
          familyName: "Smith",
          dateOfBirth: "2015-05-10",
          guardianId: GUARDIAN_ID,
        });
        expect(resRestrictedOnly.status).toBe(403);
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.manage",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Both -> 201
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.manage" || perm === "people.restricted.read",
        );
        db.appendAuditEvent.mockClear();
        const resBoth = await call("/v1/households/members/add-minor", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          givenName: "Tommy",
          familyName: "Smith",
          dateOfBirth: "2015-05-10",
          guardianId: GUARDIAN_ID,
        });
        expect(resBoth.status).toBe(201);
        expect(db.appendAuditEvent).not.toHaveBeenCalled();
      });

      it("guardians/link: requires BOTH people.manage AND people.restricted.read (Pin 11)", async () => {
        // Link with manage only -> 403
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.manage",
        );
        people.linkGuardian.mockClear();
        db.appendAuditEvent.mockClear();
        const resManageOnly = await call("/v1/households/guardians/link", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          guardianId: GUARDIAN_ID,
          childId: PERSON_ID,
        });
        expect(resManageOnly.status).toBe(403);
        expect(await resManageOnly.text()).toBe("");
        expect(people.linkGuardian).not.toHaveBeenCalled();
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.restricted.read",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Link with restricted only -> 403
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.restricted.read",
        );
        people.linkGuardian.mockClear();
        db.appendAuditEvent.mockClear();
        const resRestrictedOnly = await call("/v1/households/guardians/link", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          guardianId: GUARDIAN_ID,
          childId: PERSON_ID,
        });
        expect(resRestrictedOnly.status).toBe(403);
        expect(await resRestrictedOnly.text()).toBe("");
        expect(people.linkGuardian).not.toHaveBeenCalled();
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.manage",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Link with view only -> 403
        access.holdsPermission.mockImplementation(async (_tx, _u, perm) => perm === "people.view");
        people.linkGuardian.mockClear();
        db.appendAuditEvent.mockClear();
        const resViewOnly = await call("/v1/households/guardians/link", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          guardianId: GUARDIAN_ID,
          childId: PERSON_ID,
        });
        expect(resViewOnly.status).toBe(403);
        expect(await resViewOnly.text()).toBe("");
        expect(people.linkGuardian).not.toHaveBeenCalled();

        // Both -> 201
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.manage" || perm === "people.restricted.read",
        );
        people.linkGuardian.mockClear();
        db.appendAuditEvent.mockClear();
        const resBoth = await call("/v1/households/guardians/link", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          guardianId: GUARDIAN_ID,
          childId: PERSON_ID,
        });
        expect(resBoth.status).toBe(201);
        expect(people.linkGuardian).toHaveBeenCalled();
        expect(db.appendAuditEvent).not.toHaveBeenCalled();
      });

      it("guardians/unlink: requires BOTH people.manage AND people.restricted.read (Pin 11)", async () => {
        // Unlink with manage only -> 403
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.manage",
        );
        people.unlinkGuardian.mockClear();
        db.appendAuditEvent.mockClear();
        const resManageOnly = await call("/v1/households/guardians/unlink", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          linkId: LINK_ID,
        });
        expect(resManageOnly.status).toBe(403);
        expect(await resManageOnly.text()).toBe("");
        expect(people.unlinkGuardian).not.toHaveBeenCalled();
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.restricted.read",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Unlink with restricted only -> 403
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.restricted.read",
        );
        people.unlinkGuardian.mockClear();
        db.appendAuditEvent.mockClear();
        const resRestrictedOnly = await call("/v1/households/guardians/unlink", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          linkId: LINK_ID,
        });
        expect(resRestrictedOnly.status).toBe(403);
        expect(await resRestrictedOnly.text()).toBe("");
        expect(people.unlinkGuardian).not.toHaveBeenCalled();
        expect(db.appendAuditEvent).toHaveBeenCalledTimes(1);
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "people.permission.denied",
            purpose: "people.manage",
            targetIds: [ORG, COMMUNITY],
          }),
        );

        // Unlink with view only -> 403
        access.holdsPermission.mockImplementation(async (_tx, _u, perm) => perm === "people.view");
        people.unlinkGuardian.mockClear();
        db.appendAuditEvent.mockClear();
        const resViewOnly = await call("/v1/households/guardians/unlink", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          linkId: LINK_ID,
        });
        expect(resViewOnly.status).toBe(403);
        expect(await resViewOnly.text()).toBe("");
        expect(people.unlinkGuardian).not.toHaveBeenCalled();

        // Both -> 200
        access.holdsPermission.mockImplementation(
          async (_tx, _u, perm) => perm === "people.manage" || perm === "people.restricted.read",
        );
        people.unlinkGuardian.mockClear();
        db.appendAuditEvent.mockClear();
        const resBoth = await call("/v1/households/guardians/unlink", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          linkId: LINK_ID,
        });
        expect(resBoth.status).toBe(200);
        expect(people.unlinkGuardian).toHaveBeenCalled();
        expect(db.appendAuditEvent).not.toHaveBeenCalled();
      });
    });

    describe("Argument forwarding and response integrity for household routes (finding 3)", () => {
      it("forwards token to readSession", async () => {
        identity.readSession.mockClear();
        await call(
          "/v1/households/list",
          { communitySlug: SLUG },
          "Bearer custom-bearer-token-123",
        );
        expect(identity.readSession).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          KEY_ARN,
          expect.objectContaining({
            accessToken: "custom-bearer-token-123",
            now: FIXED_NOW,
          }),
        );
      });

      it("forwards cursor and limit to listHouseholds and passes includeRestricted", async () => {
        access.holdsPermission.mockImplementation(async (_tx, _u, perm) => perm === "people.view");
        people.listHouseholds.mockClear();
        await call("/v1/households/list", {
          communitySlug: SLUG,
          cursor: "token-abc-999",
          limit: 17,
        });
        expect(people.listHouseholds).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          KEY_ARN,
          expect.objectContaining({
            cursor: "token-abc-999",
            limit: 17,
            includeRestricted: false,
            actorUserId: USER,
          }),
        );

        // When cursor and limit omitted
        people.listHouseholds.mockClear();
        await call("/v1/households/list", { communitySlug: SLUG });
        const lastCallArgs = people.listHouseholds.mock.calls[0]?.[3] as Record<string, unknown>;
        expect(lastCallArgs.cursor).toBeNull();
        expect(lastCallArgs.limit).toBeUndefined();
      });

      it("forwards arguments to readHouseholdDetail and returns the detail result in the response body", async () => {
        const mockDetail = {
          householdId: HOUSEHOLD_ID,
          version: 3,
          label: "Unique Detail Label",
          adults: [],
          guardians: [],
        };
        people.readHouseholdDetail.mockResolvedValueOnce(mockDetail);
        access.holdsPermission.mockResolvedValue(true);

        const res = await call("/v1/households/read", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(mockDetail);
        expect(people.readHouseholdDetail).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          KEY_ARN,
          expect.objectContaining({
            householdId: HOUSEHOLD_ID,
            includeRestricted: true,
            actorUserId: USER,
          }),
        );
      });

      it("forwards arguments to createHousehold including label", async () => {
        people.createHousehold.mockClear();
        const res = await call("/v1/households/create", {
          communitySlug: SLUG,
          label: "The Great Family",
        });
        expect(res.status).toBe(201);
        expect(people.createHousehold).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          KEY_ARN,
          expect.objectContaining({
            now: FIXED_NOW,
            label: "The Great Family",
            actorUserId: USER,
          }),
        );

        // Without label
        people.createHousehold.mockClear();
        const resNoLabel = await call("/v1/households/create", { communitySlug: SLUG });
        expect(resNoLabel.status).toBe(201);
        expect(people.createHousehold).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          KEY_ARN,
          expect.objectContaining({
            now: FIXED_NOW,
            label: null,
            actorUserId: USER,
          }),
        );
      });

      it("forwards arguments to renameHousehold including householdId, version, and label", async () => {
        people.renameHousehold.mockClear();
        const res = await call("/v1/households/rename", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          version: 9,
          label: "Renamed Title",
        });
        expect(res.status).toBe(200);
        expect(people.renameHousehold).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          KEY_ARN,
          expect.objectContaining({
            householdId: HOUSEHOLD_ID,
            label: "Renamed Title",
            version: 9,
            actorUserId: USER,
          }),
        );
      });

      it("forwards arguments to moveAdult including personId, householdId, and version", async () => {
        people.moveAdult.mockClear();
        const res = await call("/v1/households/members/move-adult", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          personId: PERSON_ID,
          version: 4,
        });
        expect(res.status).toBe(200);
        expect(people.moveAdult).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            personId: PERSON_ID,
            householdId: HOUSEHOLD_ID,
            version: 4,
            actorUserId: USER,
          }),
        );
      });

      it("forwards arguments to addMinor with partial rights and without rights", async () => {
        // With explicit partial rights
        people.addMinor.mockClear();
        const resWithRights = await call("/v1/households/members/add-minor", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          givenName: "Tommy",
          familyName: "Smith",
          dateOfBirth: "2015-05-10",
          guardianId: GUARDIAN_ID,
          rights: { pickup: true, manage: true },
        });
        expect(resWithRights.status).toBe(201);
        expect(people.addMinor).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          KEY_ARN,
          expect.objectContaining({
            now: FIXED_NOW,
            householdId: HOUSEHOLD_ID,
            givenName: "Tommy",
            familyName: "Smith",
            dateOfBirth: "2015-05-10",
            guardianId: GUARDIAN_ID,
            rights: { pickup: true, manage: true },
            actorUserId: USER,
          }),
        );

        // Without rights
        people.addMinor.mockClear();
        const resNoRights = await call("/v1/households/members/add-minor", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          givenName: "Alice",
          familyName: "Brown",
          dateOfBirth: "2016-07-20",
          guardianId: GUARDIAN_ID,
        });
        expect(resNoRights.status).toBe(201);
        const noRightsCall = people.addMinor.mock.calls[0]?.[3] as Record<string, unknown>;
        expect(noRightsCall.rights).toBeUndefined();
        expect(noRightsCall.givenName).toBe("Alice");
        expect(noRightsCall.familyName).toBe("Brown");
        expect(noRightsCall.dateOfBirth).toBe("2016-07-20");
        expect(noRightsCall.householdId).toBe(HOUSEHOLD_ID);
        expect(noRightsCall.guardianId).toBe(GUARDIAN_ID);
        expect(noRightsCall.actorUserId).toBe(USER);
      });

      it("forwards arguments to linkGuardian with default rights when omitted", async () => {
        people.linkGuardian.mockClear();
        const res = await call("/v1/households/guardians/link", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          guardianId: GUARDIAN_ID,
          childId: PERSON_ID,
        });
        expect(res.status).toBe(201);
        expect(people.linkGuardian).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            now: FIXED_NOW,
            householdId: HOUSEHOLD_ID,
            guardianPersonId: GUARDIAN_ID,
            childPersonId: PERSON_ID,
            consent: true,
            pickup: false,
            view: true,
            manage: false,
            actorUserId: USER,
          }),
        );
      });

      it("forwards arguments to linkGuardian with custom rights and defaults unspecified to false", async () => {
        people.linkGuardian.mockClear();
        const res = await call("/v1/households/guardians/link", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          guardianId: GUARDIAN_ID,
          childId: PERSON_ID,
          rights: { view: true },
        });
        expect(res.status).toBe(201);
        expect(people.linkGuardian).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            now: FIXED_NOW,
            householdId: HOUSEHOLD_ID,
            guardianPersonId: GUARDIAN_ID,
            childPersonId: PERSON_ID,
            consent: false,
            pickup: false,
            view: true,
            manage: false,
            actorUserId: USER,
          }),
        );
      });

      it("forwards arguments to unlinkGuardian including householdId, linkId, and actorUserId", async () => {
        people.unlinkGuardian.mockClear();
        const res = await call("/v1/households/guardians/unlink", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          linkId: LINK_ID,
        });
        expect(res.status).toBe(200);
        expect(people.unlinkGuardian).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            now: FIXED_NOW,
            householdId: HOUSEHOLD_ID,
            linkId: LINK_ID,
            actorUserId: USER,
          }),
        );
      });
    });

    describe("Status mapping for write routes (Pin 15)", () => {
      it("maps rename stale version to 409 and not found to 404", async () => {
        people.renameHousehold.mockRejectedValueOnce(new PeopleError("conflict"));
        const resConflict = await call("/v1/households/rename", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          version: 1,
          label: "New",
        });
        expect(resConflict.status).toBe(409);
        expect(await resConflict.text()).toBe("");

        people.renameHousehold.mockRejectedValueOnce(new PeopleError("not_found"));
        const resNotFound = await call("/v1/households/rename", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          version: 1,
          label: "New",
        });
        expect(resNotFound.status).toBe(404);
        expect(await resNotFound.text()).toBe("");
      });

      it("maps move-adult guardian links to 409 and minor to 400", async () => {
        people.moveAdult.mockRejectedValueOnce(new PeopleError("adult_cannot_move_with_links"));
        const resLinks = await call("/v1/households/members/move-adult", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          personId: PERSON_ID,
          version: 1,
        });
        expect(resLinks.status).toBe(409);
        expect(await resLinks.text()).toBe("");

        people.moveAdult.mockRejectedValueOnce(new PeopleError("minor_not_movable"));
        const resMinor = await call("/v1/households/members/move-adult", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          personId: PERSON_ID,
          version: 1,
        });
        expect(resMinor.status).toBe(400);
        expect(await resMinor.text()).toBe("");
      });

      it("maps add-minor adult dob to 400 and invalid guardian to 400", async () => {
        people.addMinor.mockRejectedValueOnce(new PeopleError("invalid_date"));
        const resDob = await call("/v1/households/members/add-minor", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          givenName: "Tommy",
          familyName: "Smith",
          dateOfBirth: "1990-01-01",
          guardianId: GUARDIAN_ID,
        });
        expect(resDob.status).toBe(400);
        expect(await resDob.text()).toBe("");

        people.addMinor.mockRejectedValueOnce(new PeopleError("invalid_guardian"));
        const resGuardian = await call("/v1/households/members/add-minor", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          givenName: "Tommy",
          familyName: "Smith",
          dateOfBirth: "2015-05-10",
          guardianId: GUARDIAN_ID,
        });
        expect(resGuardian.status).toBe(400);
        expect(await resGuardian.text()).toBe("");
      });

      it("maps link duplicate to 409 and invalid guardian to 400", async () => {
        people.linkGuardian.mockRejectedValueOnce(new PeopleError("duplicate_guardian_link"));
        const resDup = await call("/v1/households/guardians/link", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          guardianId: GUARDIAN_ID,
          childId: PERSON_ID,
        });
        expect(resDup.status).toBe(409);
        expect(await resDup.text()).toBe("");

        people.linkGuardian.mockRejectedValueOnce(new PeopleError("invalid_guardian"));
        const resGuardian = await call("/v1/households/guardians/link", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          guardianId: GUARDIAN_ID,
          childId: PERSON_ID,
        });
        expect(resGuardian.status).toBe(400);
        expect(await resGuardian.text()).toBe("");
      });

      it("maps unlink last guardian to 409 and not found to 404", async () => {
        people.unlinkGuardian.mockRejectedValueOnce(new PeopleError("last_guardian"));
        const resLast = await call("/v1/households/guardians/unlink", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          linkId: LINK_ID,
        });
        expect(resLast.status).toBe(409);
        expect(await resLast.text()).toBe("");

        people.unlinkGuardian.mockRejectedValueOnce(new PeopleError("not_found"));
        const resNotFound = await call("/v1/households/guardians/unlink", {
          communitySlug: SLUG,
          householdId: HOUSEHOLD_ID,
          linkId: LINK_ID,
        });
        expect(resNotFound.status).toBe(404);
        expect(await resNotFound.text()).toBe("");
      });
    });
  });
});
