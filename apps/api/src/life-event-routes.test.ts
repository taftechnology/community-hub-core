import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRequest } from "@community-hub/kernel";
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
  isCommunityAdmin: vi.fn(),
}));

const billing = vi.hoisted(() => ({
  assertWritable: vi.fn(),
}));

const people = vi.hoisted(() => ({
  listLifeEvents: vi.fn(),
  createLifeEvent: vi.fn(),
  updateLifeEvent: vi.fn(),
  personIsMinor: vi.fn(),
  lifeEventPersonIsMinor: vi.fn(),
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
    isCommunityAdmin: access.isCommunityAdmin,
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
    listLifeEvents: people.listLifeEvents,
    createLifeEvent: people.createLifeEvent,
    updateLifeEvent: people.updateLifeEvent,
    personIsMinor: people.personIsMinor,
    lifeEventPersonIsMinor: people.lifeEventPersonIsMinor,
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

import { lifeEventRoutes, type LifeEventDeps } from "./life-event-routes.js";
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
const PERSON_ID = "00000000-0000-4000-8000-000000000005";
const EVENT_ID = "00000000-0000-4000-8000-000000000099";

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

describe("life event routes unit tests", () => {
  const logCalls: { message: string; fields?: Record<string, unknown> }[] = [];

  function makeDeps(overrides: Partial<LifeEventDeps> = {}): LifeEventDeps {
    return {
      checkout: (_role, run) => run({} as never),
      kms: {} as LifeEventDeps["kms"],
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

  function route(pathName: string, bound: LifeEventDeps = makeDeps()) {
    const found = lifeEventRoutes(bound).find((item) => item.pattern === pathName);
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
    bound: LifeEventDeps = makeDeps(),
  ): Promise<Response> {
    const targetRoute = route(pathName, bound);
    const context: RouteContext = {
      pattern: targetRoute.pattern,
      billing: targetRoute.billing,
    };
    const authHeader = authorization === undefined ? `Bearer ${TOKEN}` : authorization;
    return withRequest({ requestId: REQUEST_ID }, async () =>
      targetRoute.handle(request(pathName, hostname, body, authHeader), context),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    logCalls.length = 0;

    identity.readSession.mockResolvedValue({ userId: USER });
    tenancy.findCommunityBySlug.mockResolvedValue({
      id: COMMUNITY,
      organisationId: ORG,
    });
    entitlements.readSnapshot.mockResolvedValue(createSnapshot());
    access.holdsAnyGrant.mockResolvedValue(true);
    access.holdsPermission.mockResolvedValue(true);
    // Not a Community Admin, and the person is an adult, unless a test says otherwise.
    access.isCommunityAdmin.mockResolvedValue(false);
    people.personIsMinor.mockResolvedValue(false);
    people.lifeEventPersonIsMinor.mockResolvedValue(false);
    billing.assertWritable.mockResolvedValue(undefined);
    db.withAppTransaction.mockImplementation(async (_sql, _scope, run) => run({} as never));
  });

  describe("guards and validation", () => {
    it("returns 404 with empty body when hostname does not match apiHostname", async () => {
      const res = await call(
        "/v1/people/life-events/list",
        { communitySlug: SLUG, personId: PERSON_ID },
        undefined,
        "foreign.example.test",
      );
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });

    it("returns 401 with empty body when authorization is missing or invalid", async () => {
      const missing = await call(
        "/v1/people/life-events/list",
        { communitySlug: SLUG, personId: PERSON_ID },
        "",
      );
      expect(missing.status).toBe(401);
      expect(await missing.text()).toBe("");

      identity.readSession.mockResolvedValueOnce(null);
      const invalid = await call(
        "/v1/people/life-events/list",
        { communitySlug: SLUG, personId: PERSON_ID },
        "Bearer bad-token",
      );
      expect(invalid.status).toBe(401);
      expect(await invalid.text()).toBe("");
    });

    it("returns 403 with empty body when community slug is unknown", async () => {
      tenancy.findCommunityBySlug.mockResolvedValueOnce(null);
      const res = await call("/v1/people/life-events/list", {
        communitySlug: "unknown-parish",
        personId: PERSON_ID,
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    });

    it("Pin 8: returns 403 with empty body when community lacks people.households entitlement", async () => {
      entitlements.readSnapshot.mockResolvedValueOnce(
        createSnapshot({
          planEntitlements: [],
          allocations: [],
        }),
      );
      const res = await call("/v1/people/life-events/list", {
        communitySlug: SLUG,
        personId: PERSON_ID,
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    });

    it("Pin 15: returns 400 with empty body on invalid body or extra fields", async () => {
      // List with extra field
      const listExtra = await call("/v1/people/life-events/list", {
        communitySlug: SLUG,
        personId: PERSON_ID,
        extra: "not allowed",
      });
      expect(listExtra.status).toBe(400);
      expect(await listExtra.text()).toBe("");

      // Create with future date
      const createFuture = await call("/v1/people/life-events/create", {
        communitySlug: SLUG,
        personId: PERSON_ID,
        type: "baptism",
        date: "2099-01-01",
      });
      expect(createFuture.status).toBe(400);
      expect(await createFuture.text()).toBe("");

      // Update with invalid type
      const updateInvalidType = await call("/v1/people/life-events/update", {
        communitySlug: SLUG,
        eventId: EVENT_ID,
        version: 1,
        type: "invalid_type",
        date: "2020-01-01",
      });
      expect(updateInvalidType.status).toBe(400);
      expect(await updateInvalidType.text()).toBe("");
    });
  });

  describe("permission matrix and denial audits (Pins 6, 7)", () => {
    it("Pin 6: list refuses without people.restricted.read, records denial audit, empty body", async () => {
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.view";
      });

      const res = await call("/v1/people/life-events/list", {
        communitySlug: SLUG,
        personId: PERSON_ID,
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(db.appendAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "people.permission.denied",
          purpose: "people.permission.denied",
          actorId: USER,
          targetIds: [ORG, COMMUNITY],
        }),
      );
      expect(people.listLifeEvents).not.toHaveBeenCalled();
    });

    it("Pin 7: create refuses when caller holds people.manage only, records denial audit", async () => {
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.manage";
      });

      const res = await call("/v1/people/life-events/create", {
        communitySlug: SLUG,
        personId: PERSON_ID,
        type: "baptism",
        date: "2020-01-01",
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(db.appendAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "people.permission.denied",
          purpose: "people.permission.denied",
          actorId: USER,
          targetIds: [ORG, COMMUNITY],
        }),
      );
      expect(people.createLifeEvent).not.toHaveBeenCalled();
    });

    it("Pin 7: create refuses when caller holds people.restricted.read only, records denial audit", async () => {
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.restricted.read";
      });

      const res = await call("/v1/people/life-events/create", {
        communitySlug: SLUG,
        personId: PERSON_ID,
        type: "baptism",
        date: "2020-01-01",
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(db.appendAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "people.permission.denied",
          purpose: "people.permission.denied",
          actorId: USER,
          targetIds: [ORG, COMMUNITY],
        }),
      );
      expect(people.createLifeEvent).not.toHaveBeenCalled();
    });

    it("Pin 7: update refuses when caller holds people.manage only, records denial audit", async () => {
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.manage";
      });

      const res = await call("/v1/people/life-events/update", {
        communitySlug: SLUG,
        eventId: EVENT_ID,
        version: 1,
        type: "baptism",
        date: "2020-01-01",
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(db.appendAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "people.permission.denied",
          purpose: "people.permission.denied",
        }),
      );
      expect(people.updateLifeEvent).not.toHaveBeenCalled();
    });

    it("Pin 7: update refuses when caller holds people.restricted.read only, records denial audit", async () => {
      access.holdsPermission.mockImplementation(async (_tx, _userId, perm) => {
        return perm === "people.restricted.read";
      });

      const res = await call("/v1/people/life-events/update", {
        communitySlug: SLUG,
        eventId: EVENT_ID,
        version: 1,
        type: "baptism",
        date: "2020-01-01",
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(db.appendAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "people.permission.denied",
          purpose: "people.permission.denied",
        }),
      );
      expect(people.updateLifeEvent).not.toHaveBeenCalled();
    });
  });

  describe("writes about a child (pin 78)", () => {
    const writes = [
      {
        path: "/v1/people/life-events/create",
        body: { communitySlug: SLUG, personId: PERSON_ID, type: "baptism", date: "2020-01-01" },
        lookup: () => people.personIsMinor,
        write: () => people.createLifeEvent,
        id: PERSON_ID,
        status: 201,
        answer: { eventId: EVENT_ID, version: 1 },
      },
      {
        path: "/v1/people/life-events/update",
        body: {
          communitySlug: SLUG,
          eventId: EVENT_ID,
          version: 1,
          type: "baptism",
          date: "2020-01-01",
        },
        lookup: () => people.lifeEventPersonIsMinor,
        write: () => people.updateLifeEvent,
        id: EVENT_ID,
        status: 200,
        answer: { version: 2 },
      },
    ];

    it.each(writes)(
      "$path: a non-admin gets the 404 of a missing record and nothing is written",
      async ({ path, body, lookup, write, id }) => {
        // holdsPermission answers true for every permission.
        lookup().mockResolvedValue(true);
        const child = await call(path, body);
        expect(child.status).toBe(404);
        expect(await child.text()).toBe("");
        expect(lookup()).toHaveBeenLastCalledWith(expect.anything(), id);
        expect(write()).not.toHaveBeenCalled();
        expect(db.appendAuditEvent).not.toHaveBeenCalled();

        lookup().mockResolvedValue(null);
        write().mockRejectedValueOnce(new PeopleError("life_event_not_found"));
        const missing = await call(path, body);
        expect(missing.status).toBe(404);
        expect(await missing.text()).toBe("");
        expect([...missing.headers.entries()]).toEqual([...child.headers.entries()]);

        // A caller without the permissions gets today's refusal, child or not.
        lookup().mockResolvedValue(true);
        access.holdsPermission.mockResolvedValue(false);
        write().mockClear();
        expect((await call(path, body)).status).toBe(403);
        expect(write()).not.toHaveBeenCalled();
      },
    );

    it.each(writes)(
      "$path: a Community Admin writes a child's record on the role alone, an adult's on the permissions",
      async ({ path, body, lookup, write, status, answer }) => {
        access.isCommunityAdmin.mockResolvedValue(true);
        access.holdsPermission.mockResolvedValue(false);
        lookup().mockResolvedValue(true);
        write().mockResolvedValueOnce(answer);
        const child = await call(path, body);
        expect(child.status).toBe(status);
        expect(await child.json()).toEqual(answer);

        // The role adds nothing to an adult's record.
        lookup().mockResolvedValue(false);
        write().mockClear();
        expect((await call(path, body)).status).toBe(403);
        expect(write()).not.toHaveBeenCalled();
      },
    );
  });

  describe("happy path execution", () => {
    it("list returns 200 with items for authorized caller", async () => {
      const mockResult = {
        items: [
          {
            eventId: EVENT_ID,
            version: 1,
            type: "baptism",
            date: "2020-01-01",
            place: "Church",
            notes: null,
          },
        ],
      };
      people.listLifeEvents.mockResolvedValueOnce(mockResult);

      const res = await call("/v1/people/life-events/list", {
        communitySlug: SLUG,
        personId: PERSON_ID,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockResult);
      expect(people.listLifeEvents).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        KEY_ARN,
        {
          personId: PERSON_ID,
          actorUserId: USER,
          childView: "presence",
        },
      );
    });

    it("list of a child's events: a Community Admin gets the ids and the call carries childView admin", async () => {
      access.isCommunityAdmin.mockResolvedValue(true);
      people.personIsMinor.mockResolvedValue(true);
      const mockResult = { items: [{ eventId: EVENT_ID }] };
      people.listLifeEvents.mockResolvedValueOnce(mockResult);

      const res = await call("/v1/people/life-events/list", {
        communitySlug: SLUG,
        personId: PERSON_ID,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockResult);
      expect(people.listLifeEvents).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        KEY_ARN,
        { personId: PERSON_ID, actorUserId: USER, childView: "admin" },
      );
    });

    it("list of a child's events: anyone else gets the 404 of a missing person and nothing is read", async () => {
      // holdsPermission answers true for every permission, people.restricted.read included.
      access.isCommunityAdmin.mockResolvedValue(false);
      people.personIsMinor.mockResolvedValue(true);

      const res = await call("/v1/people/life-events/list", {
        communitySlug: SLUG,
        personId: PERSON_ID,
      });

      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
      expect(people.listLifeEvents).not.toHaveBeenCalled();
      expect(db.appendAuditEvent).not.toHaveBeenCalled();

      // The answer for a person that does not exist is the same.
      people.personIsMinor.mockResolvedValue(null);
      people.listLifeEvents.mockRejectedValueOnce(new PeopleError("life_event_not_found"));
      const missing = await call("/v1/people/life-events/list", {
        communitySlug: SLUG,
        personId: PERSON_ID,
      });
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("");
      expect([...missing.headers.entries()]).toEqual([...res.headers.entries()]);
    });

    it("list of a child's events: a caller without people.restricted.read gets 403 before the person is looked up", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm !== "people.restricted.read",
      );
      people.personIsMinor.mockResolvedValue(true);

      const res = await call("/v1/people/life-events/list", {
        communitySlug: SLUG,
        personId: PERSON_ID,
      });

      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(people.personIsMinor).not.toHaveBeenCalled();
      expect(people.listLifeEvents).not.toHaveBeenCalled();
    });

    it("create returns 201 with eventId and version for caller with manage and restricted.read", async () => {
      people.createLifeEvent.mockResolvedValueOnce({
        eventId: EVENT_ID,
        version: 1,
      });

      const res = await call("/v1/people/life-events/create", {
        communitySlug: SLUG,
        personId: PERSON_ID,
        type: "marriage",
        date: "2024-05-15",
        place: "St Mary's",
        notes: "Joyful celebration",
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ eventId: EVENT_ID, version: 1 });
      expect(people.createLifeEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        KEY_ARN,
        expect.objectContaining({
          personId: PERSON_ID,
          type: "marriage",
          date: "2024-05-15",
          place: "St Mary's",
          notes: "Joyful celebration",
          actorUserId: USER,
          now: FIXED_NOW,
        }),
      );
    });

    it("update returns 200 with new version for caller with manage and restricted.read", async () => {
      people.updateLifeEvent.mockResolvedValueOnce({
        version: 2,
      });

      const res = await call("/v1/people/life-events/update", {
        communitySlug: SLUG,
        eventId: EVENT_ID,
        version: 1,
        type: "marriage",
        date: "2024-05-15",
        place: "St Mary's Chapel",
        notes: null,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ version: 2 });
      expect(people.updateLifeEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        KEY_ARN,
        expect.objectContaining({
          eventId: EVENT_ID,
          version: 1,
          type: "marriage",
          date: "2024-05-15",
          place: "St Mary's Chapel",
          notes: null,
          actorUserId: USER,
          now: FIXED_NOW,
        }),
      );
    });
  });

  describe("statusForPeople domain error mapping (Pin 14)", () => {
    it("Pin 14: maps life_event_not_found to 404 with empty body", async () => {
      people.listLifeEvents.mockRejectedValueOnce(new PeopleError("life_event_not_found"));
      const res = await call("/v1/people/life-events/list", {
        communitySlug: SLUG,
        personId: PERSON_ID,
      });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });

    it("Pin 14: maps invalid_life_event to 400 with empty body", async () => {
      people.createLifeEvent.mockRejectedValueOnce(new PeopleError("invalid_life_event"));
      const res = await call("/v1/people/life-events/create", {
        communitySlug: SLUG,
        personId: PERSON_ID,
        type: "baptism",
        date: "2020-01-01",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    });

    it("Pin 14: maps too_many to 409 with empty body", async () => {
      people.listLifeEvents.mockRejectedValueOnce(new PeopleError("too_many"));
      const res = await call("/v1/people/life-events/list", {
        communitySlug: SLUG,
        personId: PERSON_ID,
      });
      expect(res.status).toBe(409);
      expect(await res.text()).toBe("");
    });

    it("Pin 14: maps conflict (stale version) to 409 with empty body", async () => {
      people.updateLifeEvent.mockRejectedValueOnce(new PeopleError("conflict"));
      const res = await call("/v1/people/life-events/update", {
        communitySlug: SLUG,
        eventId: EVENT_ID,
        version: 1,
        type: "baptism",
        date: "2020-01-01",
      });
      expect(res.status).toBe(409);
      expect(await res.text()).toBe("");
    });

    it("Pin 14: non-PeopleError returns 500 with empty body and does not leak message into logCalls", async () => {
      const fixturePlace = "St Jude Cathedral of Error";
      people.listLifeEvents.mockRejectedValueOnce(new Error(`database failed at ${fixturePlace}`));
      const res = await call("/v1/people/life-events/list", {
        communitySlug: SLUG,
        personId: PERSON_ID,
      });
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");
      expect(JSON.stringify(logCalls)).not.toContain(fixturePlace);
    });

    it("Pin 14: create route non-PeopleError returns 500 with empty body and does not leak message into logCalls", async () => {
      const fixturePlace = "St Jude Cathedral of Create Error";
      people.createLifeEvent.mockRejectedValueOnce(new Error(`database failed at ${fixturePlace}`));
      const res = await call("/v1/people/life-events/create", {
        communitySlug: SLUG,
        personId: PERSON_ID,
        type: "baptism",
        date: "2020-01-01",
      });
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");
      expect(JSON.stringify(logCalls)).not.toContain(fixturePlace);
    });

    it("Pin 14: update route non-PeopleError returns 500 with empty body and does not leak message into logCalls", async () => {
      const fixturePlace = "St Jude Cathedral of Update Error";
      people.updateLifeEvent.mockRejectedValueOnce(new Error(`database failed at ${fixturePlace}`));
      const res = await call("/v1/people/life-events/update", {
        communitySlug: SLUG,
        eventId: EVENT_ID,
        version: 1,
        type: "baptism",
        date: "2020-01-01",
      });
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");
      expect(JSON.stringify(logCalls)).not.toContain(fixturePlace);
    });

    it("Pin 14: happy-path create with fixture place and notes does not leak fields into logCalls", async () => {
      const fixturePlace = "St Mary's Secret Basilica";
      const fixtureNotes = "Confidential baptismal annotations";
      people.createLifeEvent.mockResolvedValueOnce({ eventId: EVENT_ID, version: 1 });
      const res = await call("/v1/people/life-events/create", {
        communitySlug: SLUG,
        personId: PERSON_ID,
        type: "baptism",
        date: "2020-01-01",
        place: fixturePlace,
        notes: fixtureNotes,
      });
      expect(res.status).toBe(201);
      expect(JSON.stringify(logCalls)).not.toContain(fixturePlace);
      expect(JSON.stringify(logCalls)).not.toContain(fixtureNotes);
    });
  });
});
