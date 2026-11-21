import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRequest } from "@community-hub/kernel";
import { BillingReadOnly } from "@community-hub/billing";
import { AccessError } from "@community-hub/access";
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
  readPersonForActor: vi.fn(),
}));

const billing = vi.hoisted(() => ({
  assertWritable: vi.fn(),
}));

const people = vi.hoisted(() => ({
  listPersons: vi.fn(),
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  setPersonStatus: vi.fn(),
  summarisePersons: vi.fn(),
}));

const groups = vi.hoisted(() => ({
  activeGroupsForPersons: vi.fn(),
  personIdsInGroup: vi.fn(),
  listGroups: vi.fn(),
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
    readPersonForActor: access.readPersonForActor,
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
    listPersons: people.listPersons,
    createPerson: people.createPerson,
    updatePerson: people.updatePerson,
    setPersonStatus: people.setPersonStatus,
    summarisePersons: people.summarisePersons,
  };
});

vi.mock("@community-hub/groups", () => ({
  activeGroupsForPersons: groups.activeGroupsForPersons,
  personIdsInGroup: groups.personIdsInGroup,
  listGroups: groups.listGroups,
}));

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

import { peopleRoutes, type PeopleDeps } from "./people-routes.js";
import { createGate, type RouteContext } from "./gate.js";

const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const USER = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-000000000010";
const COMMUNITY = "00000000-0000-4000-8000-000000000011";
const TOKEN = "session-token-abc";
const PERSON_ID = "00000000-0000-4000-8000-000000000099";
const FIXED_NOW = new Date("2026-10-31T12:00:00.000Z");
const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  "key/mrk-test",
].join(":");

function createSnapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    organisationId: ORG,
    communityId: COMMUNITY,
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

function createSnapshotWithGroups(): EntitlementSnapshot {
  return createSnapshot({
    planEntitlements: [
      { key: "people.directory", limit: null },
      { key: "groups.basic", limit: null },
    ],
    allocations: ["people.directory", "groups.basic"],
  });
}

describe("people routes (list and read)", () => {
  const logCalls: { message: string; fields?: Record<string, unknown> }[] = [];

  function makeDeps(overrides: Partial<PeopleDeps> = {}): PeopleDeps {
    return {
      checkout: (_role, run) => run({} as never),
      kms: {} as PeopleDeps["kms"],
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

  function route(pathName: string, bound: PeopleDeps = makeDeps()) {
    const found = peopleRoutes(bound).find((item) => item.pattern === pathName);
    if (found === undefined) {
      throw new Error(`Route not found: ${pathName}`);
    }
    return found;
  }

  async function call(
    pathName: string,
    body: unknown,
    authorization = `Bearer ${TOKEN}`,
    hostname = API_HOSTNAME,
    bound: PeopleDeps = makeDeps(),
  ): Promise<Response> {
    const r = route(pathName, bound);
    const req = request(pathName, hostname, body, authorization);
    const context: RouteContext = { billing: r.billing, pattern: r.pattern };
    return withRequest({ requestId: REQUEST_ID }, async () => r.handle(req, context));
  }

  beforeEach(() => {
    logCalls.length = 0;
    identity.readSession.mockReset();
    tenancy.findCommunityBySlug.mockReset();
    access.holdsPermission.mockReset();
    access.holdsAnyGrant.mockReset();
    access.readPersonForActor.mockReset();
    billing.assertWritable.mockReset();
    people.listPersons.mockReset();
    people.createPerson.mockReset();
    people.updatePerson.mockReset();
    people.setPersonStatus.mockReset();
    people.summarisePersons.mockReset();
    groups.activeGroupsForPersons.mockReset();
    groups.personIdsInGroup.mockReset();
    groups.listGroups.mockReset();
    entitlements.readSnapshot.mockReset();
    db.withAppTransaction.mockReset();
    db.appendAuditEvent.mockReset();

    identity.readSession.mockResolvedValue({ userId: USER });
    tenancy.findCommunityBySlug.mockResolvedValue({
      id: COMMUNITY,
      organisationId: ORG,
      slug: "parish",
      region: "au",
    });
    entitlements.readSnapshot.mockResolvedValue(createSnapshot());
    groups.activeGroupsForPersons.mockResolvedValue(new Map());
    groups.personIdsInGroup.mockResolvedValue([]);
    groups.listGroups.mockResolvedValue([]);
    db.withAppTransaction.mockImplementation(
      async (_sql: unknown, _scope: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    );
    access.holdsPermission.mockResolvedValue(true);
    access.holdsAnyGrant.mockResolvedValue(true);
    billing.assertWritable.mockResolvedValue("ok");
  });

  describe("common route gate checks", () => {
    it("returns 404 when request is on foreign hostname", async () => {
      const res = await call(
        "/v1/people/list",
        { communitySlug: "parish" },
        `Bearer ${TOKEN}`,
        AUTH_HOSTNAME,
      );
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });

    it("returns 401 when authorization header is missing or session invalid", async () => {
      const noAuth = await call("/v1/people/list", { communitySlug: "parish" }, "");
      expect(noAuth.status).toBe(401);

      identity.readSession.mockResolvedValueOnce(null);
      const invalidAuth = await call("/v1/people/list", { communitySlug: "parish" });
      expect(invalidAuth.status).toBe(401);
    });

    it("returns 400 when request body contains extra forbidden fields (pin 2)", async () => {
      const resList = await call("/v1/people/list", {
        communitySlug: "parish",
        includeRestricted: true,
      });
      expect(resList.status).toBe(400);

      const resRead = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
        isMinor: false,
      });
      expect(resRead.status).toBe(400);

      const resCreate = await call("/v1/people/create", {
        communitySlug: "parish",
        givenName: "Jane",
        familyName: "Doe",
        isMinor: false,
      });
      expect(resCreate.status).toBe(400);

      const resUpdate = await call("/v1/people/update", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        includeRestricted: true,
      });
      expect(resUpdate.status).toBe(400);
    });

    it("answers unknown communities like unauthorised ones with 403 (finding 1, Deviation 12)", async () => {
      tenancy.findCommunityBySlug.mockResolvedValueOnce(null);
      const resListUnknown = await call("/v1/people/list", { communitySlug: "nonexistent" });
      expect(resListUnknown.status).toBe(403);
      expect(await resListUnknown.text()).toBe("");

      tenancy.findCommunityBySlug.mockResolvedValueOnce(null);
      const resReadUnknown = await call("/v1/people/read", {
        communitySlug: "nonexistent",
        personId: PERSON_ID,
      });
      expect(resReadUnknown.status).toBe(403);
      expect(await resReadUnknown.text()).toBe("");

      tenancy.findCommunityBySlug.mockResolvedValueOnce(null);
      const resCreateUnknown = await call("/v1/people/create", {
        communitySlug: "nonexistent",
        givenName: "Jane",
        familyName: "Doe",
      });
      expect(resCreateUnknown.status).toBe(403);
      expect(await resCreateUnknown.text()).toBe("");

      tenancy.findCommunityBySlug.mockResolvedValueOnce(null);
      const resUpdateUnknown = await call("/v1/people/update", {
        communitySlug: "nonexistent",
        personId: PERSON_ID,
        version: 1,
        givenName: "Jane",
      });
      expect(resUpdateUnknown.status).toBe(403);
      expect(await resUpdateUnknown.text()).toBe("");

      access.holdsPermission.mockResolvedValue(false);
      const resListStranger = await call("/v1/people/list", { communitySlug: "parish" });
      expect(resListStranger.status).toBe(403);
      expect(await resListStranger.text()).toBe("");

      const resReadStranger = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
      });
      expect(resReadStranger.status).toBe(403);
      expect(await resReadStranger.text()).toBe("");

      const resCreateStranger = await call("/v1/people/create", {
        communitySlug: "parish",
        givenName: "Jane",
        familyName: "Doe",
      });
      expect(resCreateStranger.status).toBe(403);
      expect(await resCreateStranger.text()).toBe("");

      const resUpdateStranger = await call("/v1/people/update", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        givenName: "Jane",
      });
      expect(resUpdateStranger.status).toBe(403);
      expect(await resUpdateStranger.text()).toBe("");
    });

    it("refuses 403 when entitlement people.directory is disabled across all 4 routes (pin 12)", async () => {
      // 1. List
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({ toggles: [{ key: "people.directory", enabled: false }] }),
      );
      const resList = await call("/v1/people/list", { communitySlug: "parish" });
      expect(resList.status).toBe(403);
      expect(await resList.text()).toBe("");
      expect(people.listPersons).not.toHaveBeenCalled();
      expect(db.appendAuditEvent).not.toHaveBeenCalled();

      // 2. Read
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({ toggles: [{ key: "people.directory", enabled: false }] }),
      );
      const resRead = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
      });
      expect(resRead.status).toBe(403);
      expect(await resRead.text()).toBe("");
      expect(access.readPersonForActor).not.toHaveBeenCalled();

      // 3. Create
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({ toggles: [{ key: "people.directory", enabled: false }] }),
      );
      const resCreate = await call("/v1/people/create", {
        communitySlug: "parish",
        givenName: "Jane",
        familyName: "Doe",
      });
      expect(resCreate.status).toBe(403);
      expect(await resCreate.text()).toBe("");
      expect(people.createPerson).not.toHaveBeenCalled();

      // 4. Update
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({ toggles: [{ key: "people.directory", enabled: false }] }),
      );
      const resUpdate = await call("/v1/people/update", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        givenName: "Janet",
      });
      expect(resUpdate.status).toBe(403);
      expect(await resUpdate.text()).toBe("");
      expect(people.updatePerson).not.toHaveBeenCalled();
    });

    it("logs error class only through guardLog when entitlement guard fails closed with an error (finding 6)", async () => {
      const guardLog = vi.fn();
      entitlements.readSnapshot.mockRejectedValueOnce(
        new Error("sensitive database error message"),
      );
      const depsInstance = makeDeps({ guardLog });

      const res = await call(
        "/v1/people/list",
        { communitySlug: "parish" },
        `Bearer ${TOKEN}`,
        API_HOSTNAME,
        depsInstance,
      );

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(guardLog).toHaveBeenCalledWith("entitlement_guard_failed", {
        errorClass: "Error",
      });
      const logged = JSON.stringify(guardLog.mock.calls);
      expect(logged).not.toContain("sensitive");
      expect(logged).not.toContain("database error message");
    });

    it("allows list and read (billing: read) but gives 402 on create and update (billing: write) for read-only org (pin 11)", async () => {
      billing.assertWritable.mockRejectedValue(new BillingReadOnly("read_only"));
      people.listPersons.mockResolvedValueOnce({ items: [], nextCursor: null });
      access.readPersonForActor.mockResolvedValueOnce({
        personId: PERSON_ID,
        givenName: "Alice",
        familyName: "Smith",
        version: 1,
      });

      const resList = await call("/v1/people/list", { communitySlug: "parish" });
      expect(resList.status).toBe(200);

      const resRead = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
      });
      expect(resRead.status).toBe(200);

      const resCreate = await call("/v1/people/create", {
        communitySlug: "parish",
        givenName: "Jane",
        familyName: "Doe",
      });
      expect(resCreate.status).toBe(402);
      expect(await resCreate.text()).toBe("");
      expect(people.createPerson).not.toHaveBeenCalled();

      const resUpdate = await call("/v1/people/update", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        givenName: "Janet",
      });
      expect(resUpdate.status).toBe(402);
      expect(await resUpdate.text()).toBe("");
      expect(people.updatePerson).not.toHaveBeenCalled();
    });

    it("enforces tenant boundary by scoping transaction to slug-resolved organisation and community", async () => {
      const OTHER_ORG = "00000000-0000-4000-8000-000000000020";
      const OTHER_COMMUNITY = "00000000-0000-4000-8000-000000000021";
      tenancy.findCommunityBySlug.mockResolvedValueOnce({
        id: OTHER_COMMUNITY,
        organisationId: OTHER_ORG,
        slug: "other-parish",
        region: "au",
      });
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({ organisationId: OTHER_ORG, communityId: OTHER_COMMUNITY }),
      );
      people.listPersons.mockResolvedValueOnce({ items: [], nextCursor: null });

      await call("/v1/people/list", { communitySlug: "other-parish" });
      expect(db.withAppTransaction).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: OTHER_ORG, communityId: OTHER_COMMUNITY },
        expect.any(Function),
      );
    });
  });

  describe("POST /v1/people/list", () => {
    it("lists adults when kind is adults and actor holds people.view", async () => {
      const mockResult = {
        items: [
          {
            id: PERSON_ID,
            personId: PERSON_ID,
            isMinor: false,
            givenName: "Jane",
            familyName: "Doe",
            version: 1,
          },
        ],
        nextCursor: null,
      };
      people.listPersons.mockResolvedValueOnce(mockResult);

      const res = await call("/v1/people/list", {
        communitySlug: "parish",
        kind: "adults",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockResult);
      expect(access.holdsPermission).toHaveBeenCalledWith(expect.anything(), USER, "people.view");
      expect(people.listPersons).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        {
          kind: "adults",
          search: null,
          cursor: null,
          includeRestricted: false,
          actorUserId: USER,
          now: FIXED_NOW,
        },
      );
    });

    it("defaults to adults mode when kind is omitted", async () => {
      people.listPersons.mockResolvedValueOnce({ items: [], nextCursor: null });

      const res = await call("/v1/people/list", {
        communitySlug: "parish",
      });

      expect(res.status).toBe(200);
      expect(access.holdsPermission).toHaveBeenCalledWith(expect.anything(), USER, "people.view");
    });

    it("refuses adult list with 403 and people.permission.denied audit when actor lacks people.view (pin 5)", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm !== "people.view",
      );

      const res = await call("/v1/people/list", {
        communitySlug: "parish",
        kind: "adults",
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(people.listPersons).not.toHaveBeenCalled();
      expect(db.appendAuditEvent).toHaveBeenCalledWith(expect.anything(), {
        actorKind: "user",
        actorId: USER,
        action: "people.permission.denied",
        purpose: "people.person.view",
        targetIds: [ORG, COMMUNITY],
      });
    });

    it("lists minors with includeRestricted=true when kind is minors and actor holds people.restricted.read (pin 3)", async () => {
      const mockMinorsResult = {
        items: [
          {
            id: PERSON_ID,
            personId: PERSON_ID,
            isMinor: true,
            givenName: "Tommy",
            familyName: "Smith",
            version: 1,
          },
        ],
        nextCursor: null,
      };
      people.listPersons.mockResolvedValueOnce(mockMinorsResult);

      const res = await call("/v1/people/list", {
        communitySlug: "parish",
        kind: "minors",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockMinorsResult);
      expect(access.holdsPermission).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        "people.restricted.read",
      );
      expect(people.listPersons).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        {
          kind: "minors",
          cursor: null,
          includeRestricted: true,
          actorUserId: USER,
        },
      );
    });

    it("refuses minors mode with 403 and people.permission.denied audit when actor lacks people.restricted.read (pins 3, 4)", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm === "people.view",
      );

      const res = await call("/v1/people/list", {
        communitySlug: "parish",
        kind: "minors",
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(people.listPersons).not.toHaveBeenCalled();
      expect(db.appendAuditEvent).toHaveBeenCalledWith(expect.anything(), {
        actorKind: "user",
        actorId: USER,
        action: "people.permission.denied",
        purpose: "people.restricted.read",
        targetIds: [ORG, COMMUNITY],
      });
    });

    it("returns 400 with empty body when listPersons throws PeopleError invalid_input (finding 2)", async () => {
      people.listPersons.mockRejectedValueOnce(new PeopleError("invalid_input"));

      const resAdult = await call("/v1/people/list", {
        communitySlug: "parish",
        cursor: "malformed-cursor",
      });

      expect(resAdult.status).toBe(400);
      expect(await resAdult.text()).toBe("");

      people.listPersons.mockRejectedValueOnce(new PeopleError("invalid_input"));

      const resMinor = await call("/v1/people/list", {
        communitySlug: "parish",
        kind: "minors",
        cursor: "malformed-cursor",
      });

      expect(resMinor.status).toBe(400);
      expect(await resMinor.text()).toBe("");
    });

    it("forwards search, cursor and limit to listPersons in adults mode (finding 4)", async () => {
      people.listPersons.mockResolvedValueOnce({ items: [], nextCursor: null });

      const res = await call("/v1/people/list", {
        communitySlug: "parish",
        kind: "adults",
        search: "Zelda",
        cursor: "cursor-adults-token",
        limit: 25,
      });

      expect(res.status).toBe(200);
      expect(people.listPersons).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        {
          kind: "adults",
          search: "Zelda",
          cursor: "cursor-adults-token",
          limit: 25,
          includeRestricted: false,
          actorUserId: USER,
          now: FIXED_NOW,
        },
      );
    });

    it("forwards cursor and limit to listPersons in minors mode (finding 4)", async () => {
      people.listPersons.mockResolvedValueOnce({ items: [], nextCursor: null });

      const res = await call("/v1/people/list", {
        communitySlug: "parish",
        kind: "minors",
        cursor: "cursor-minors-token",
        limit: 15,
      });

      expect(res.status).toBe(200);
      expect(people.listPersons).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        {
          kind: "minors",
          cursor: "cursor-minors-token",
          limit: 15,
          includeRestricted: true,
          actorUserId: USER,
        },
      );
    });

    it("never logs search terms, names, or emails in logger output or audit rows (pins 7, 13)", async () => {
      const SECRET_TERM = "SensitiveQueryTerm987";
      people.listPersons.mockResolvedValueOnce({ items: [], nextCursor: null });

      const depsInstance = makeDeps();
      const res = await call(
        "/v1/people/list",
        {
          communitySlug: "parish",
          search: SECRET_TERM,
        },
        `Bearer ${TOKEN}`,
        API_HOSTNAME,
        depsInstance,
      );

      expect(res.status).toBe(200);

      // Verify logger calls never contain search term
      for (const callItem of logCalls) {
        const text = JSON.stringify(callItem);
        expect(text).not.toContain(SECRET_TERM);
      }

      // Verify audit calls never contain search term
      for (const auditCall of db.appendAuditEvent.mock.calls) {
        const text = JSON.stringify(auditCall);
        expect(text).not.toContain(SECRET_TERM);
      }
    });
  });

  describe("POST /v1/people/read", () => {
    it("reads a person when actor holds people.view and returns person with version", async () => {
      const mockPerson = {
        personId: PERSON_ID,
        householdId: null,
        isMinor: false,
        ageBasis: "declared_adult",
        birthdayMd: 505,
        givenName: "Arthur",
        familyName: "Pendelton",
        email: "arthur@example.com",
        phone: "+61400000000",
        dateOfBirth: "1985-05-05",
        version: 2,
      };
      access.readPersonForActor.mockResolvedValueOnce(mockPerson);

      const res = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockPerson);
      expect(access.readPersonForActor).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        {
          personId: PERSON_ID,
          actorUserId: USER,
        },
      );
    });

    it("refuses read with 403 when actor holds neither people.view nor people.restricted.read (pin 5)", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm === "people.manage",
      );

      const res = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(access.readPersonForActor).not.toHaveBeenCalled();
      expect(db.appendAuditEvent).toHaveBeenCalledWith(expect.anything(), {
        actorKind: "user",
        actorId: USER,
        action: "people.permission.denied",
        purpose: "people.person.view",
        targetIds: [ORG, COMMUNITY],
      });
    });

    it("allows caller with only people.view to read an adult (finding 4)", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm === "people.view",
      );
      access.readPersonForActor.mockResolvedValueOnce({
        personId: PERSON_ID,
        version: 1,
      });

      const res = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
      });

      expect(res.status).toBe(200);
      expect(access.readPersonForActor).toHaveBeenCalled();
    });

    it("allows caller with only people.restricted.read to read an adult (finding 4)", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm === "people.restricted.read",
      );
      access.readPersonForActor.mockResolvedValueOnce({
        personId: PERSON_ID,
        version: 1,
      });

      const res = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
      });

      expect(res.status).toBe(200);
      expect(access.readPersonForActor).toHaveBeenCalled();
    });

    it("returns byte-identical 404 for absent id, cross-community id, and unreadable minor (pin 6)", async () => {
      access.holdsPermission.mockResolvedValue(true);

      // 1. Absent id throws AccessError("forbidden")
      access.readPersonForActor.mockRejectedValueOnce(new AccessError("forbidden"));
      const absentRes = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
      });

      // 2. Cross-community id throws AccessError("forbidden")
      access.readPersonForActor.mockRejectedValueOnce(new AccessError("forbidden"));
      const crossRes = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
      });

      // 3. Unreadable minor throws AccessError("forbidden")
      access.readPersonForActor.mockRejectedValueOnce(new AccessError("forbidden"));
      const minorRes = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
      });

      expect(absentRes.status).toBe(404);
      expect(crossRes.status).toBe(404);
      expect(minorRes.status).toBe(404);

      const absentBody = await absentRes.text();
      const crossBody = await crossRes.text();
      const minorBody = await minorRes.text();

      expect(absentBody).toBe("");
      expect(crossBody).toBe(absentBody);
      expect(minorBody).toBe(absentBody);
    });
  });

  describe("POST /v1/people/create", () => {
    it("creates an adult and returns 201 with personId, passing declaredAdult=true (pin 5)", async () => {
      const NEW_PERSON_ID = "00000000-0000-4000-8000-000000000055";
      people.createPerson.mockResolvedValueOnce({
        personId: NEW_PERSON_ID,
        isMinor: false,
      });

      const res = await call("/v1/people/create", {
        communitySlug: "parish",
        givenName: "Arthur",
        familyName: "Dent",
        email: "arthur@example.com",
        phone: "+61400000000",
        dateOfBirth: "1980-01-01",
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ personId: NEW_PERSON_ID });
      expect(access.holdsPermission).toHaveBeenCalledWith(expect.anything(), USER, "people.manage");
      expect(people.createPerson).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        {
          now: FIXED_NOW,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: "1980-01-01",
          givenName: "Arthur",
          familyName: "Dent",
          email: "arthur@example.com",
          phone: "+61400000000",
          actorUserId: USER,
        },
      );
    });

    it("refuses create with 403 and people.permission.denied audit when actor lacks people.manage (pin 5)", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm !== "people.manage",
      );

      const res = await call("/v1/people/create", {
        communitySlug: "parish",
        givenName: "Arthur",
        familyName: "Dent",
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(people.createPerson).not.toHaveBeenCalled();
      expect(db.appendAuditEvent).toHaveBeenCalledWith(expect.anything(), {
        actorKind: "user",
        actorId: USER,
        action: "people.permission.denied",
        purpose: "people.permission.denied",
        targetIds: [ORG, COMMUNITY],
      });
    });

    it("returns 409 with empty body on duplicate email or phone (no hint which)", async () => {
      people.createPerson.mockRejectedValueOnce(new PeopleError("duplicate_email"));
      const resEmail = await call("/v1/people/create", {
        communitySlug: "parish",
        givenName: "Arthur",
        familyName: "Dent",
        email: "arthur@example.com",
      });
      expect(resEmail.status).toBe(409);
      expect(await resEmail.text()).toBe("");

      people.createPerson.mockRejectedValueOnce(new PeopleError("duplicate_phone"));
      const resPhone = await call("/v1/people/create", {
        communitySlug: "parish",
        givenName: "Arthur",
        familyName: "Dent",
        phone: "+61400000000",
      });
      expect(resPhone.status).toBe(409);
      expect(await resPhone.text()).toBe("");
    });

    it("returns 400 with empty body on domain validation error", async () => {
      people.createPerson.mockRejectedValueOnce(new PeopleError("invalid_declaration"));
      const res = await call("/v1/people/create", {
        communitySlug: "parish",
        givenName: "Arthur",
        familyName: "Dent",
        dateOfBirth: "2015-01-01",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    });

    it("never logs personal data (names, emails, phones) in logger output or error text (pins 7, 13)", async () => {
      const SECRET_NAME = "SecretArthurPersonName";
      const SECRET_EMAIL = "secret-arthur-email@example.com";
      people.createPerson.mockResolvedValueOnce({
        personId: PERSON_ID,
        isMinor: false,
      });

      const res = await call("/v1/people/create", {
        communitySlug: "parish",
        givenName: SECRET_NAME,
        familyName: "Dent",
        email: SECRET_EMAIL,
      });

      expect(res.status).toBe(201);
      for (const callItem of logCalls) {
        const text = JSON.stringify(callItem);
        expect(text).not.toContain(SECRET_NAME);
        expect(text).not.toContain(SECRET_EMAIL);
      }
    });
  });

  describe("POST /v1/people/update", () => {
    it("updates an adult and returns 200 with new version (pin 5)", async () => {
      people.updatePerson.mockResolvedValueOnce({ version: 3 });

      const res = await call("/v1/people/update", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 2,
        givenName: "Arthur",
        familyName: "Dent",
        email: "arthur@example.com",
        phone: "+61400000000",
        dateOfBirth: "1980-01-01",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ version: 3 });
      expect(access.holdsPermission).toHaveBeenCalledWith(expect.anything(), USER, "people.manage");
      expect(people.updatePerson).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        {
          personId: PERSON_ID,
          version: 2,
          changes: {
            givenName: "Arthur",
            familyName: "Dent",
            email: "arthur@example.com",
            phone: "+61400000000",
            dateOfBirth: "1980-01-01",
          },
          actorUserId: USER,
          now: FIXED_NOW,
        },
      );
    });

    it("refuses update with 403 and people.permission.denied audit when actor lacks people.manage (pin 5)", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm !== "people.manage",
      );

      const res = await call("/v1/people/update", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        givenName: "Arthur",
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(people.updatePerson).not.toHaveBeenCalled();
      expect(db.appendAuditEvent).toHaveBeenCalledWith(expect.anything(), {
        actorKind: "user",
        actorId: USER,
        action: "people.permission.denied",
        purpose: "people.permission.denied",
        targetIds: [ORG, COMMUNITY],
      });
    });

    it("returns 409 with empty body on stale version or duplicate email/phone (pin 9)", async () => {
      people.updatePerson.mockRejectedValueOnce(new PeopleError("conflict"));
      const res = await call("/v1/people/update", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        givenName: "Arthur",
      });
      expect(res.status).toBe(409);
      expect(await res.text()).toBe("");
    });

    it("returns 404 with empty body when person is a minor or not found", async () => {
      people.updatePerson.mockRejectedValueOnce(new PeopleError("not_found"));
      const res = await call("/v1/people/update", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        givenName: "Arthur",
      });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });

    it("returns 400 with empty body on invalid input", async () => {
      people.updatePerson.mockRejectedValueOnce(new PeopleError("invalid_input"));
      const res = await call("/v1/people/update", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        givenName: "Arthur",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    });

    it("never logs personal data (names, emails, phones) in logger output or error text (pins 7, 13)", async () => {
      const SECRET_NAME = "SecretUpdatedPersonName";
      const SECRET_EMAIL = "secret-updated-email@example.com";
      people.updatePerson.mockResolvedValueOnce({ version: 2 });

      const res = await call("/v1/people/update", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        givenName: SECRET_NAME,
        email: SECRET_EMAIL,
      });

      expect(res.status).toBe(200);
      for (const callItem of logCalls) {
        const text = JSON.stringify(callItem);
        expect(text).not.toContain(SECRET_NAME);
        expect(text).not.toContain(SECRET_EMAIL);
      }
    });
  });

  describe("retired /v1/people/access route (Task 8, pin 20)", () => {
    it("retires /v1/people/access route: not in route table and requests return 404 (pin 20)", async () => {
      const routes = peopleRoutes(makeDeps());
      expect(routes.find((r) => r.pattern === "/v1/people/access")).toBeUndefined();

      const gate = createGate({
        hostnames: {
          api: API_HOSTNAME,
          auth: AUTH_HOSTNAME,
          webhooks: "webhooks.example.com",
          ops: "ops.example.com",
        },
        routes,
        info: () => undefined,
      });

      const req = request(
        "/v1/people/access",
        API_HOSTNAME,
        { communitySlug: "parish" },
        `Bearer ${TOKEN}`,
      );
      const res = await gate({ request: req, remoteAddress: "127.0.0.1" });
      expect(res.status).toBe(404);
    });
  });

  describe("status, summary, list filters, groups, and source (Task 7)", () => {
    it("POST /v1/people/status: a caller with only people.view gets 403 and no update", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx, _userId, perm) => perm === "people.view",
      );

      const res = await call("/v1/people/status", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        status: "inactive",
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(people.setPersonStatus).not.toHaveBeenCalled();
    });

    it("POST /v1/people/summary: a caller without people.view gets 403", async () => {
      access.holdsPermission.mockResolvedValue(false);

      const res = await call("/v1/people/summary", {
        communitySlug: "parish",
        addedSince: "2026-10-01T00:00:00+10:00",
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(people.summarisePersons).not.toHaveBeenCalled();
    });

    it("POST /v1/people/list: groupId without groups.basic gets 403", async () => {
      // default snapshot has people.directory but not groups.basic
      const res = await call("/v1/people/list", {
        communitySlug: "parish",
        groupId: "00000000-0000-4000-8000-000000000099",
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(people.listPersons).not.toHaveBeenCalled();
    });

    it("POST /v1/people/list and summary: no groups key without groups.basic", async () => {
      // default snapshot has people.directory but not groups.basic
      people.listPersons.mockResolvedValueOnce({
        items: [
          {
            id: PERSON_ID,
            personId: PERSON_ID,
            isMinor: false,
            givenName: "Arthur",
            familyName: "Dent",
            version: 1,
            email: null,
            phone: null,
            age: 42,
            createdAt: "2026-10-01T00:00:00.000Z",
            status: "active",
            source: "manual",
          },
        ],
        nextCursor: null,
      });
      people.summarisePersons.mockResolvedValueOnce({
        total: 1,
        active: 1,
        inactive: 0,
        addedSince: 1,
      });

      const resList = await call("/v1/people/list", { communitySlug: "parish" });
      expect(resList.status).toBe(200);
      const listData = (await resList.json()) as { items: Array<Record<string, unknown>> };
      expect(listData.items[0]).toBeDefined();
      expect("groups" in listData.items[0]!).toBe(false);

      const resSummary = await call("/v1/people/summary", {
        communitySlug: "parish",
        addedSince: "2026-10-01T00:00:00+10:00",
      });
      expect(resSummary.status).toBe(200);
      const summaryData = (await resSummary.json()) as Record<string, unknown>;
      expect("groups" in summaryData).toBe(false);
    });

    it("POST /v1/people/list, read and summary send cache-control no-store", async () => {
      people.listPersons.mockResolvedValueOnce({ items: [], nextCursor: null });
      access.readPersonForActor.mockResolvedValueOnce({
        id: PERSON_ID,
        personId: PERSON_ID,
        isMinor: false,
        givenName: "Arthur",
        familyName: "Dent",
        version: 1,
        status: "active",
        source: "manual",
      });
      people.summarisePersons.mockResolvedValueOnce({
        total: 0,
        active: 0,
        inactive: 0,
        addedSince: 0,
      });

      const resList = await call("/v1/people/list", { communitySlug: "parish" });
      expect(resList.headers.get("cache-control")).toBe("no-store");

      const resRead = await call("/v1/people/read", {
        communitySlug: "parish",
        personId: PERSON_ID,
      });
      expect(resRead.headers.get("cache-control")).toBe("no-store");

      const resSummary = await call("/v1/people/summary", {
        communitySlug: "parish",
        addedSince: "2026-10-01T00:00:00+10:00",
      });
      expect(resSummary.headers.get("cache-control")).toBe("no-store");
    });

    it("POST /v1/people/status and summary without people.directory get 403", async () => {
      entitlements.readSnapshot.mockResolvedValue(
        createSnapshot({ planEntitlements: [], allocations: [] }),
      );

      const resStatus = await call("/v1/people/status", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        status: "inactive",
      });
      expect(resStatus.status).toBe(403);
      expect(await resStatus.text()).toBe("");
      expect(people.setPersonStatus).not.toHaveBeenCalled();

      const resSummary = await call("/v1/people/summary", {
        communitySlug: "parish",
        addedSince: "2026-10-01T00:00:00+10:00",
      });
      expect(resSummary.status).toBe(403);
      expect(await resSummary.text()).toBe("");
      expect(people.summarisePersons).not.toHaveBeenCalled();
    });

    it("POST /v1/people/status: returns 200 with new version and status on change", async () => {
      people.setPersonStatus.mockResolvedValueOnce({ version: 2, status: "inactive" });

      const res = await call("/v1/people/status", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        status: "inactive",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ version: 2, status: "inactive" });
      expect(people.setPersonStatus).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          personId: PERSON_ID,
          version: 1,
          status: "inactive",
          actorUserId: USER,
          now: FIXED_NOW,
        }),
      );
    });

    it("POST /v1/people/status: returns 200 with unchanged version and status on no-op", async () => {
      people.setPersonStatus.mockResolvedValueOnce({ version: 1, status: "active" });

      const res = await call("/v1/people/status", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        status: "active",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ version: 1, status: "active" });
    });

    it("POST /v1/people/status: returns 400 with empty body on invalid input", async () => {
      people.setPersonStatus.mockRejectedValueOnce(new PeopleError("invalid_input"));

      const res = await call("/v1/people/status", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        status: "inactive",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    });

    it("POST /v1/people/status: returns 400 with empty body on schema parse error", async () => {
      const res = await call("/v1/people/status", {
        communitySlug: "parish",
        personId: "not-a-uuid",
        version: 1,
        status: "inactive",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    });

    it("POST /v1/people/status: returns 401 with empty body when unauthenticated", async () => {
      const res = await call(
        "/v1/people/status",
        {
          communitySlug: "parish",
          personId: PERSON_ID,
          version: 1,
          status: "inactive",
        },
        "",
      );
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });

    it("POST /v1/people/status: returns 403 with empty body when community slug unknown", async () => {
      tenancy.findCommunityBySlug.mockResolvedValueOnce(null);

      const res = await call("/v1/people/status", {
        communitySlug: "unknown-parish",
        personId: PERSON_ID,
        version: 1,
        status: "inactive",
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    });

    it("POST /v1/people/status: returns 404 with empty body when person not found", async () => {
      people.setPersonStatus.mockRejectedValueOnce(new PeopleError("not_found"));

      const res = await call("/v1/people/status", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        status: "inactive",
      });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });

    it("POST /v1/people/status: returns 409 with empty body on version conflict", async () => {
      people.setPersonStatus.mockRejectedValueOnce(new PeopleError("conflict"));

      const res = await call("/v1/people/status", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        status: "inactive",
      });
      expect(res.status).toBe(409);
      expect(await res.text()).toBe("");
    });

    it("POST /v1/people/summary: returns 200 with counts and groups when groups.basic is enabled", async () => {
      entitlements.readSnapshot.mockResolvedValue(createSnapshotWithGroups());
      people.summarisePersons.mockResolvedValueOnce({
        total: 10,
        active: 8,
        inactive: 2,
        addedSince: 3,
      });
      groups.listGroups.mockResolvedValueOnce([
        { id: "00000000-0000-4000-8000-000000000001", name: "Choir" },
      ]);

      const res = await call("/v1/people/summary", {
        communitySlug: "parish",
        addedSince: "2026-10-01T00:00:00+10:00",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        total: 10,
        active: 8,
        inactive: 2,
        addedSince: 3,
        groups: [{ id: "00000000-0000-4000-8000-000000000001", name: "Choir" }],
      });
      expect(people.summarisePersons).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          addedSince: new Date("2026-10-01T00:00:00+10:00"),
        }),
      );
    });

    it("POST /v1/people/summary: returns 400 with empty body on invalid addedSince date", async () => {
      const res = await call("/v1/people/summary", {
        communitySlug: "parish",
        addedSince: "not-a-date",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    });

    it("POST /v1/people/summary: returns 401 with empty body when unauthenticated", async () => {
      const res = await call(
        "/v1/people/summary",
        {
          communitySlug: "parish",
          addedSince: "2026-10-01T00:00:00+10:00",
        },
        "",
      );
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    });

    it("POST /v1/people/summary: returns 403 with empty body when community slug unknown", async () => {
      tenancy.findCommunityBySlug.mockResolvedValueOnce(null);

      const res = await call("/v1/people/summary", {
        communitySlug: "unknown-parish",
        addedSince: "2026-10-01T00:00:00+10:00",
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    });

    it("POST /v1/people/list: passes status, source, groupId and now to listPersons", async () => {
      entitlements.readSnapshot.mockResolvedValue(createSnapshotWithGroups());
      groups.personIdsInGroup.mockResolvedValueOnce(["00000000-0000-4000-8000-000000000002"]);
      people.listPersons.mockResolvedValueOnce({ items: [], nextCursor: null });

      const res = await call("/v1/people/list", {
        communitySlug: "parish",
        status: "active",
        source: "family_records",
        groupId: "00000000-0000-4000-8000-000000000099",
      });
      expect(res.status).toBe(200);
      expect(groups.personIdsInGroup).toHaveBeenCalledWith(
        expect.anything(),
        "00000000-0000-4000-8000-000000000099",
      );
      expect(people.listPersons).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        KEY_ARN,
        expect.objectContaining({
          status: "active",
          source: "family_records",
          personIds: ["00000000-0000-4000-8000-000000000002"],
          now: FIXED_NOW,
        }),
      );
    });

    it("POST /v1/people/list: attaches groups to adult items when groups.basic is enabled", async () => {
      entitlements.readSnapshot.mockResolvedValue(createSnapshotWithGroups());
      people.listPersons.mockResolvedValueOnce({
        items: [
          {
            id: PERSON_ID,
            personId: PERSON_ID,
            isMinor: false,
            givenName: "Arthur",
            familyName: "Dent",
            version: 1,
            email: null,
            phone: null,
            age: 42,
            createdAt: "2026-10-01T00:00:00.000Z",
            status: "active",
            source: "manual",
          },
        ],
        nextCursor: null,
      });
      groups.activeGroupsForPersons.mockResolvedValueOnce(
        new Map([[PERSON_ID, [{ id: "00000000-0000-4000-8000-000000000001", name: "Choir" }]]]),
      );

      const res = await call("/v1/people/list", { communitySlug: "parish" });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        items: Array<{ groups?: Array<{ id: string; name: string }> }>;
      };
      expect(data.items[0]?.groups).toEqual([
        { id: "00000000-0000-4000-8000-000000000001", name: "Choir" },
      ]);
    });

    it("POST /v1/people/create: passes source when provided", async () => {
      people.createPerson.mockResolvedValueOnce({ personId: PERSON_ID });

      const res = await call("/v1/people/create", {
        communitySlug: "parish",
        givenName: "Arthur",
        familyName: "Dent",
        source: "family_records",
      });
      expect(res.status).toBe(201);
      expect(people.createPerson).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        KEY_ARN,
        expect.objectContaining({
          source: "family_records",
        }),
      );
    });

    it("POST /v1/people/update: passes source in changes when provided", async () => {
      people.updatePerson.mockResolvedValueOnce({ version: 2 });

      const res = await call("/v1/people/update", {
        communitySlug: "parish",
        personId: PERSON_ID,
        version: 1,
        source: "family_records",
      });
      expect(res.status).toBe(200);
      expect(people.updatePerson).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        KEY_ARN,
        expect.objectContaining({
          changes: expect.objectContaining({
            source: "family_records",
          }),
        }),
      );
    });
  });
});
