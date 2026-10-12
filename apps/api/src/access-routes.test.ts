import { beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
  readSession: vi.fn(),
}));

const tenancy = vi.hoisted(() => ({
  findCommunityBySlug: vi.fn(),
}));

const access = vi.hoisted(() => ({
  grantRole: vi.fn(),
  revokeRole: vi.fn(),
  createCustomRole: vi.fn(),
  deleteCustomRole: vi.fn(),
  linkUser: vi.fn(),
  unlinkUser: vi.fn(),
}));

const db = vi.hoisted(() => ({
  withAppTransaction: vi.fn(),
}));

vi.mock("@community-hub/identity", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/identity")>("@community-hub/identity");
  return { ...actual, readSession: identity.readSession };
});

vi.mock("@community-hub/tenancy", () => tenancy);

vi.mock("@community-hub/access", () => {
  class AccessError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "AccessError";
      this.code = code;
    }
  }
  return { AccessError, ...access };
});

vi.mock("@community-hub/db", async () => {
  const actual = await vi.importActual<typeof import("@community-hub/db")>("@community-hub/db");
  return { ...actual, withAppTransaction: db.withAppTransaction };
});

import { accessRoutes, type AccessDeps } from "./access-routes.js";

const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const TOKEN = "secret-access-token";
const USER = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-000000000010";
const COMMUNITY = "00000000-0000-4000-8000-000000000011";
const ORG_GRANT = "00000000-0000-4000-8000-000000000020";
const COMMUNITY_GRANT = "00000000-0000-4000-8000-000000000021";

function fakeTx(strings: TemplateStringsArray): unknown[] {
  const text = strings.join(" ");
  if (text.includes("app.organisation_role_grants")) {
    return [{ grant_id: ORG_GRANT, user_id: USER, role_key: "org_owner" }];
  }
  if (text.includes("app.community_role_grants")) {
    return [
      {
        grant_id: COMMUNITY_GRANT,
        user_id: USER,
        role_key: "community_admin",
        custom_role_id: null,
        custom_role_key: null,
      },
    ];
  }
  return [];
}

function deps(log: AccessDeps["log"] = () => undefined): AccessDeps {
  return {
    checkout: (_role, run) => run({} as never),
    kms: {} as AccessDeps["kms"],
    keyArn: "arn:aws:kms:ap-southeast-2:123456789012:key/mrk-example",
    now: () => new Date("2026-10-11T00:00:00.000Z"),
    apiHostname: API_HOSTNAME,
    log,
  };
}

function request(path: string, hostname: string, body: unknown, authorization?: string): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "x-community-hub-hostname": hostname,
  });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function route(path: string, bound: AccessDeps = deps()) {
  const found = accessRoutes(bound).find((item) => item.pattern === path);
  if (found === undefined) {
    throw new Error(`missing ${path}`);
  }
  return found;
}

describe("access routes", () => {
  beforeEach(() => {
    identity.readSession.mockReset();
    tenancy.findCommunityBySlug.mockReset();
    access.grantRole.mockReset();
    db.withAppTransaction.mockReset();
    db.withAppTransaction.mockImplementation(
      async (_sql: unknown, _scope: unknown, fn: (tx: typeof fakeTx) => Promise<unknown>) =>
        fn(fakeTx),
    );
    identity.readSession.mockResolvedValue({ userId: USER });
    tenancy.findCommunityBySlug.mockResolvedValue({
      id: COMMUNITY,
      organisationId: ORG,
      slug: "parish",
      region: "au",
    });
  });

  it("registers seven tenant posts", () => {
    const routes = accessRoutes(deps());
    expect(routes.map((item) => `${item.method} ${item.pattern}`)).toEqual([
      "POST /v1/access/grants/list",
      "POST /v1/access/grants",
      "POST /v1/access/grants/revoke",
      "POST /v1/access/custom-roles",
      "POST /v1/access/custom-roles/delete",
      "POST /v1/access/user-links",
      "POST /v1/access/user-links/delete",
    ]);
    expect(routes.every((item) => item.surface === "tenant")).toBe(true);
  });

  it("returns 401 when the token is missing or unknown", async () => {
    identity.readSession.mockClear();
    const missing = await route("/v1/access/grants/list").handle(
      request("/v1/access/grants/list", API_HOSTNAME, { communitySlug: "parish" }),
    );
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe("");
    expect(identity.readSession).not.toHaveBeenCalled();

    identity.readSession.mockResolvedValue(null);
    const unknown = await route("/v1/access/grants/list").handle(
      request(
        "/v1/access/grants/list",
        API_HOSTNAME,
        { communitySlug: "parish" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.text()).toBe("");
  });

  it("returns 400 for an extra key and does not grant an organisation id", async () => {
    const extra = await route("/v1/access/grants/list").handle(
      request(
        "/v1/access/grants/list",
        API_HOSTNAME,
        { communitySlug: "parish", extra: true },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(extra.status).toBe(400);
    expect(await extra.text()).toBe("");

    access.grantRole.mockClear();
    db.withAppTransaction.mockClear();
    const planted = await route("/v1/access/grants").handle(
      request(
        "/v1/access/grants",
        API_HOSTNAME,
        {
          communitySlug: "parish",
          userId: USER,
          roleKey: "staff",
          organisationId: "00000000-0000-4000-8000-000000000001",
        },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(planted.status).toBe(400);
    expect(await planted.text()).toBe("");
    expect(access.grantRole).not.toHaveBeenCalled();
    expect(db.withAppTransaction).not.toHaveBeenCalled();
  });

  it("lists the owner grant on the api hostname and hides it on the auth hostname", async () => {
    const entries: unknown[] = [];
    const bound = deps((message, fields) => {
      entries.push({ message, fields });
    });
    const listed = await route("/v1/access/grants/list", bound).handle(
      request(
        "/v1/access/grants/list",
        API_HOSTNAME,
        { communitySlug: "parish" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      grants: { grantId: string; roleKey: string | null }[];
      permissions: string[];
    };
    expect(body.permissions).toEqual([
      "access.users.view",
      "access.users.manage",
      "access.roles.view",
      "access.roles.manage",
      "people.restricted.read",
    ]);
    expect(body.grants).toEqual([
      {
        grantId: ORG_GRANT,
        scope: "organisation",
        userId: USER,
        roleKey: "org_owner",
        customRoleId: null,
        customRoleKey: null,
      },
      {
        grantId: COMMUNITY_GRANT,
        scope: "community",
        userId: USER,
        roleKey: "community_admin",
        customRoleId: null,
        customRoleKey: null,
      },
    ]);

    identity.readSession.mockClear();
    const hidden = await route("/v1/access/grants/list", bound).handle(
      request(
        "/v1/access/grants/list",
        AUTH_HOSTNAME,
        { communitySlug: "parish" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe("");
    expect(identity.readSession).not.toHaveBeenCalled();
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain("@");
    expect(logged).not.toContain(TOKEN);
  });

  it("rejects an unknown slug", async () => {
    tenancy.findCommunityBySlug.mockResolvedValue(null);
    const listed = await route("/v1/access/grants/list").handle(
      request(
        "/v1/access/grants/list",
        API_HOSTNAME,
        { communitySlug: "missing" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(listed.status).toBe(403);
    expect(await listed.text()).toBe("");
  });
});
