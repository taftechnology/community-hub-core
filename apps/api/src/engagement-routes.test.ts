import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRequest } from "@community-hub/kernel";
import { ServiceTimesError } from "@community-hub/engagement";
import type { EntitlementSnapshot } from "@community-hub/entitlements-eval";
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

const engagement = vi.hoisted(() => ({
  getServiceTimes: vi.fn(),
  saveServiceTimes: vi.fn(),
}));

const entitlements = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
}));

const db = vi.hoisted(() => ({
  withAppTransaction: vi.fn(),
  appendAuditEvent: vi.fn(async () => ({ id: "audit-1", seq: "1" })),
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

vi.mock("@community-hub/engagement", async () => {
  const actual = await vi.importActual<typeof import("@community-hub/engagement")>(
    "@community-hub/engagement",
  );
  return {
    ...actual,
    getServiceTimes: engagement.getServiceTimes,
    saveServiceTimes: engagement.saveServiceTimes,
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

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { startServer } from "./server.js";
import { engagementRoutes, type EngagementDeps } from "./engagement-routes.js";
import type { RouteContext } from "./gate.js";

const API_HOSTNAME = "au.api.example.test";
const WEBHOOKS_HOSTNAME = "webhooks.au.example.test";
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

const pem = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../certs/rds-ap-southeast-2-bundle.pem"),
  "utf8",
);

function envFor(port: number): ServiceEnv {
  const read = readServiceEnv(
    {
      PORT: String(port),
      PGPORT: "5432",
      AWS_REGION: "ap-southeast-2",
      NODE_ENV: "test",
      COMMUNITY_HUB_ENVIRONMENT: "staging",
      API_HOSTNAME,
      AUTH_HOSTNAME: "auth.au.example.test",
      WEBHOOKS_HOSTNAME,
      OPS_HOSTNAME: "ops.au.example.test",
      PGHOST: "db.internal",
      PGDATABASE: "communityhub",
      PGUSER_APP: "app",
      PGUSER_IDENTITY: "identity",
      PGUSER_PLATFORM: "platform",
      PGPASSWORD_APP: "pw-app",
      PGPASSWORD_IDENTITY: "pw-identity",
      PGPASSWORD_PLATFORM: "pw-platform",
      ENVELOPE_KEY_ARN: KEY_ARN,
      APP_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app",
      IDENTITY_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity",
      PLATFORM_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform",
    },
    pem,
  );
  if (!read.ok) {
    throw new Error("synthetic env failed");
  }
  return read.env;
}

function createSnapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    organisationId: ORG,
    communityId: COMMUNITY,
    region: "au",
    planKey: "standard",
    loadedAt: FIXED_NOW,
    planEntitlements: [{ key: "module.engagement", limit: null }],
    addOnEntitlements: [],
    allocations: ["module.engagement"],
    toggles: [],
    overrides: [],
    flags: [],
    ...overrides,
  };
}

describe("engagement routes unit tests", () => {
  const logCalls: { message: string; fields?: Record<string, unknown> }[] = [];

  function makeDeps(overrides: Partial<EngagementDeps> = {}): EngagementDeps {
    return {
      checkout: (_role, run) => run({} as never),
      kms: {} as EngagementDeps["kms"],
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
    contentType = "application/json",
  ): Request {
    const headers = new Headers({
      "x-community-hub-hostname": hostname,
    });
    if (contentType !== "") {
      headers.set("content-type", contentType);
    }
    if (authorization !== undefined) {
      headers.set("authorization", authorization);
    }
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    return new Request(`http://127.0.0.1${pathName}`, {
      method: "POST",
      headers,
      body: bodyStr,
    });
  }

  function route(pathName: string, bound: EngagementDeps = makeDeps()) {
    const found = engagementRoutes(bound).find((item) => item.pattern === pathName);
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
    bound: EngagementDeps = makeDeps(),
    contentType = "application/json",
  ): Promise<Response> {
    const targetRoute = route(pathName, bound);
    const context: RouteContext = {
      pattern: targetRoute.pattern,
      billing: targetRoute.billing,
    };
    const authHeader = authorization === undefined ? `Bearer ${TOKEN}` : authorization;
    return withRequest({ requestId: REQUEST_ID }, async () =>
      targetRoute.handle(request(pathName, hostname, body, authHeader, contentType), context),
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
    access.holdsPermission.mockResolvedValue(true);
    access.holdsAnyGrant.mockResolvedValue(true);
    billing.assertWritable.mockResolvedValue(undefined);
    db.withAppTransaction.mockImplementation((_sql, _scope, callback) => callback({} as never));
    engagement.getServiceTimes.mockResolvedValue({
      html: "<p>Sunday 10am</p>",
      version: 1,
    });
    engagement.saveServiceTimes.mockResolvedValue({
      html: "<p>Sunday 10am</p>",
      version: 2,
    });
  });

  describe("common route guards (404, 401, 403)", () => {
    const routes = [
      { path: "/v1/engagement/service-times/get", body: { communitySlug: SLUG } },
      {
        path: "/v1/engagement/service-times/save",
        body: { communitySlug: SLUG, html: "<p>Sunday 10am</p>", version: 1 },
      },
    ];

    it.each(routes)(
      "$path returns 404 for foreign presented hostname",
      async ({ path: p, body }) => {
        const response = await call(p, body, undefined, "foreign.example.test");
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("");
        expect(identity.readSession).not.toHaveBeenCalled();
      },
    );

    it.each(routes)("$path returns 401 when bearer token is missing", async ({ path: p, body }) => {
      const response = await call(p, body, "");
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
    });

    it.each(routes)(
      "$path returns 401 when bearer token is garbled or session not found",
      async ({ path: p, body }) => {
        identity.readSession.mockResolvedValue(null);
        const response = await call(p, body, "Bearer invalid-or-expired");
        expect(response.status).toBe(401);
        expect(await response.text()).toBe("");
      },
    );

    it.each(routes)("$path returns 403 when community is not found", async ({ path: p, body }) => {
      tenancy.findCommunityBySlug.mockResolvedValue(null);
      const response = await call(p, body);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("");
    });

    it.each(routes)(
      "$path returns 403 when module.engagement is off (Pin 19)",
      async ({ path: p, body }) => {
        entitlements.readSnapshot.mockResolvedValue(
          createSnapshot({ planEntitlements: [], allocations: [] }),
        );
        const response = await call(p, body);
        expect(response.status).toBe(403);
        expect(await response.text()).toBe("");
        expect(db.withAppTransaction).not.toHaveBeenCalled();
      },
    );

    it.each(routes)(
      "$path returns 403 and appends denial audit when service_times.manage is missing (Pin 18)",
      async ({ path: p, body }) => {
        access.holdsPermission.mockImplementation((_tx, _userId, perm) =>
          Promise.resolve(perm !== "service_times.manage"),
        );

        const response = await call(p, body);
        expect(response.status).toBe(403);
        expect(await response.text()).toBe("");

        // Exactly service_times.manage was checked
        expect(access.holdsPermission).toHaveBeenCalledWith(
          expect.anything(),
          USER,
          "service_times.manage",
        );
        // Denial audit appended
        expect(db.appendAuditEvent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            actorKind: "user",
            actorId: USER,
            action: "engagement.permission.denied",
            purpose: "engagement.permission.denied",
            targetIds: [ORG, COMMUNITY],
          }),
        );
      },
    );
  });

  describe("billing guards", () => {
    it("save returns 402 when billing is read-only", async () => {
      billing.assertWritable.mockRejectedValue(new BillingReadOnly("read_only"));
      const response = await call("/v1/engagement/service-times/save", {
        communitySlug: SLUG,
        html: "<p>Text</p>",
        version: 1,
      });
      expect(response.status).toBe(402);
      expect(await response.text()).toBe("");
      expect(engagement.saveServiceTimes).not.toHaveBeenCalled();
    });

    it("get is unaffected by read-only billing", async () => {
      billing.assertWritable.mockRejectedValue(new BillingReadOnly("read_only"));
      const response = await call("/v1/engagement/service-times/get", {
        communitySlug: SLUG,
      });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({
        html: "<p>Sunday 10am</p>",
        version: 1,
      });
    });
  });

  describe("request validation", () => {
    it("returns 400 when content-type is not application/json", async () => {
      const response = await call(
        "/v1/engagement/service-times/save",
        JSON.stringify({ communitySlug: SLUG, html: "<p>Text</p>", version: 1 }),
        undefined,
        API_HOSTNAME,
        makeDeps(),
        "text/plain",
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("");
    });

    it("returns 400 when body has extra keys (strict schema)", async () => {
      const response = await call("/v1/engagement/service-times/get", {
        communitySlug: SLUG,
        extraProp: "not-allowed",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("");
    });

    it.each([{ version: -1 }, { version: 1.5 }, { version: "1" }])(
      "save returns 400 when version is invalid ($version)",
      async ({ version }) => {
        const response = await call("/v1/engagement/service-times/save", {
          communitySlug: SLUG,
          html: "<p>Text</p>",
          version,
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toBe("");
      },
    );

    it("save returns 400 when raw html exceeds 120,000 units", async () => {
      const response = await call("/v1/engagement/service-times/save", {
        communitySlug: SLUG,
        html: "a".repeat(120_001),
        version: 1,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("");
    });
  });

  describe("handler outcomes", () => {
    it("get success returns service times response", async () => {
      const response = await call("/v1/engagement/service-times/get", {
        communitySlug: SLUG,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        html: "<p>Sunday 10am</p>",
        version: 1,
      });
    });

    it("save success returns cleaned html and new version", async () => {
      engagement.saveServiceTimes.mockResolvedValue({
        html: "<p>Cleaned text</p>",
        version: 2,
      });
      const response = await call("/v1/engagement/service-times/save", {
        communitySlug: SLUG,
        html: "<p>Uncleaned<script>alert(1)</script></p>",
        version: 1,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        html: "<p>Cleaned text</p>",
        version: 2,
      });
      expect(engagement.saveServiceTimes).toHaveBeenCalledWith(expect.anything(), {
        html: "<p>Uncleaned<script>alert(1)</script></p>",
        expectedVersion: 1,
        now: FIXED_NOW,
        actorUserId: USER,
      });
    });

    it("save returns empty 409 on version_conflict", async () => {
      engagement.saveServiceTimes.mockRejectedValue(new ServiceTimesError("version_conflict"));
      const response = await call("/v1/engagement/service-times/save", {
        communitySlug: SLUG,
        html: "<p>Text</p>",
        version: 0,
      });
      expect(response.status).toBe(409);
      expect(await response.text()).toBe("");
    });

    it("save returns empty 400 when cleaned output exceeds 20,000 (invalid_input)", async () => {
      engagement.saveServiceTimes.mockRejectedValue(new ServiceTimesError("invalid_input"));
      const response = await call("/v1/engagement/service-times/save", {
        communitySlug: SLUG,
        html: "<p>Large text</p>",
        version: 1,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("");
    });

    it("save returns empty 500 on unexpected error (no SQL or stack)", async () => {
      engagement.saveServiceTimes.mockRejectedValue(new Error("FATAL: connection terminated"));
      const response = await call("/v1/engagement/service-times/save", {
        communitySlug: SLUG,
        html: "<p>Text</p>",
        version: 1,
      });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("");
    });
  });

  describe("privacy & logging", () => {
    it("never logs content, content length, or slug", async () => {
      const secretHtml = "<h1>Confidential Mass Schedule</h1>";
      await call("/v1/engagement/service-times/save", {
        communitySlug: SLUG,
        html: secretHtml,
        version: 1,
      });

      expect(logCalls.length).toBeGreaterThan(0);
      const logString = JSON.stringify(logCalls);
      expect(logString).not.toContain("Confidential");
      expect(logString).not.toContain(secretHtml);
      expect(logString).not.toContain(SLUG);
      expect(logCalls[0]?.fields).toEqual({
        path: "/v1/engagement/service-times/save",
        status: 200,
        requestId: REQUEST_ID,
      });
    });
  });
});

describe("server-level body-limit tests through real startServer with engagement routes", () => {
  let server: ReturnType<typeof startServer>;
  const PORT = 18485;

  async function listening(s: ReturnType<typeof startServer>): Promise<void> {
    if (s.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      s.once("listening", () => resolve());
      s.once("error", reject);
    });
  }

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("a 20,000-character html body is accepted on save on the API hostname", async () => {
    const env = envFor(PORT);
    const routes = engagementRoutes({
      checkout: (_role, run) => run({} as never),
      kms: {} as never,
      keyArn: KEY_ARN,
      now: () => FIXED_NOW,
      apiHostname: API_HOSTNAME,
      log: () => undefined,
      guardLog: () => undefined,
    });

    server = startServer({
      env,
      routes,
    });
    await listening(server);

    const payload = JSON.stringify({
      communitySlug: SLUG,
      html: "<p>" + "a".repeat(19990) + "</p>",
      version: 1,
    });

    const response = await fetch(`http://127.0.0.1:${PORT}/v1/engagement/service-times/save`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-community-hub-hostname": API_HOSTNAME,
        authorization: `Bearer ${TOKEN}`,
      },
      body: payload,
    });

    // 20,000 chars body is parsed and accepted by server body limit (handler returns 200)
    expect(response.status).toBe(200);
  });

  it("a body of 131,073 bytes on save answers 413 with empty body", async () => {
    const env = envFor(PORT);
    const routes = engagementRoutes({
      checkout: (_role, run) => run({} as never),
      kms: {} as never,
      keyArn: KEY_ARN,
      now: () => FIXED_NOW,
      apiHostname: API_HOSTNAME,
      log: () => undefined,
      guardLog: () => undefined,
    });

    server = startServer({
      env,
      routes,
    });
    await listening(server);

    const response = await fetch(`http://127.0.0.1:${PORT}/v1/engagement/service-times/save`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-community-hub-hostname": API_HOSTNAME,
      },
      body: "a".repeat(131073),
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("content-length")).toBe("0");
    expect(await response.text()).toBe("");
  });

  it("a 4,097-byte body to get answers 400", async () => {
    const env = envFor(PORT);
    const routes = engagementRoutes({
      checkout: (_role, run) => run({} as never),
      kms: {} as never,
      keyArn: KEY_ARN,
      now: () => FIXED_NOW,
      apiHostname: API_HOSTNAME,
      log: () => undefined,
      guardLog: () => undefined,
    });

    server = startServer({
      env,
      routes,
    });
    await listening(server);

    const response = await fetch(`http://127.0.0.1:${PORT}/v1/engagement/service-times/get`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-community-hub-hostname": API_HOSTNAME,
      },
      body: "a".repeat(4097),
    });

    expect(response.status).toBe(400);
  });

  it("the same 5,000-byte body to save on the WEBHOOKS hostname answers 400", async () => {
    const env = envFor(PORT);
    const routes = engagementRoutes({
      checkout: (_role, run) => run({} as never),
      kms: {} as never,
      keyArn: KEY_ARN,
      now: () => FIXED_NOW,
      apiHostname: API_HOSTNAME,
      log: () => undefined,
      guardLog: () => undefined,
    });

    server = startServer({
      env,
      routes,
    });
    await listening(server);

    const response = await fetch(`http://127.0.0.1:${PORT}/v1/engagement/service-times/save`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-community-hub-hostname": WEBHOOKS_HOSTNAME,
      },
      body: "a".repeat(5000),
    });

    expect(response.status).toBe(400);
  });
});
