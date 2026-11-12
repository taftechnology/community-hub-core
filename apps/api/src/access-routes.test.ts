import util from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingReadOnly } from "@community-hub/billing";
import {
  CAPABILITIES_ALLOW_LIST,
  listUsersResponse,
  type CapabilitiesResponse,
} from "@community-hub/contracts/access";
import { withRequest } from "@community-hub/kernel";

const identity = vi.hoisted(() => ({
  readSession: vi.fn(),
  readUserEmails: vi.fn(),
}));

const people = vi.hoisted(() => ({
  readLinkedContacts: vi.fn(),
}));

const tenancy = vi.hoisted(() => ({
  findCommunityBySlug: vi.fn(),
}));

const access = vi.hoisted(() => {
  class AccessError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "AccessError";
      this.code = code;
    }
  }
  return {
    AccessError,
    grantRole: vi.fn(),
    revokeRole: vi.fn(),
    createCustomRole: vi.fn(),
    deleteCustomRole: vi.fn(),
    linkUser: vi.fn(),
    unlinkUser: vi.fn(),
    holdsAnyGrant: vi.fn(),
    holdsPermission: vi.fn(),
  };
});

const entitlementGuard = vi.hoisted(() => ({
  checkEntitlement: vi.fn(),
}));

const billing = vi.hoisted(() => ({
  assertWritable: vi.fn(),
}));

const db = vi.hoisted(() => ({
  withAppTransaction: vi.fn(),
  appendAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("@community-hub/identity", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/identity")>("@community-hub/identity");
  return {
    ...actual,
    readSession: identity.readSession,
    readUserEmails: identity.readUserEmails,
  };
});

vi.mock("@community-hub/people", () => ({
  readLinkedContacts: people.readLinkedContacts,
}));

vi.mock("@community-hub/tenancy", () => tenancy);

vi.mock("@community-hub/access", () => ({
  AccessError: access.AccessError,
  grantRole: access.grantRole,
  revokeRole: access.revokeRole,
  createCustomRole: access.createCustomRole,
  deleteCustomRole: access.deleteCustomRole,
  linkUser: access.linkUser,
  unlinkUser: access.unlinkUser,
  holdsAnyGrant: access.holdsAnyGrant,
  holdsPermission: access.holdsPermission,
}));

vi.mock("./entitlement-guard.js", async () => {
  const actual =
    await vi.importActual<typeof import("./entitlement-guard.js")>("./entitlement-guard.js");
  return {
    ...actual,
    checkEntitlement: entitlementGuard.checkEntitlement,
  };
});

vi.mock("@community-hub/billing", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/billing")>("@community-hub/billing");
  return { ...actual, assertWritable: billing.assertWritable };
});

vi.mock("@community-hub/db", async () => {
  const actual = await vi.importActual<typeof import("@community-hub/db")>("@community-hub/db");
  return {
    ...actual,
    withAppTransaction: db.withAppTransaction,
    appendAuditEvent: db.appendAuditEvent,
  };
});

import { accessRoutes, sortUsers, type AccessDeps } from "./access-routes.js";

const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const TOKEN = "secret-access-token";
const USER = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-000000000010";
const COMMUNITY = "00000000-0000-4000-8000-000000000011";
const ORG_GRANT = "00000000-0000-4000-8000-000000000020";
const COMMUNITY_GRANT = "00000000-0000-4000-8000-000000000021";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";

let grantsVisible = true;
let directoryMode: "owner" | "billing" = "owner";
let customRoles: { custom_role_id: string; key: string }[] = [];
let customRolePermissions: { custom_role_id: string; permission: string }[] = [];
let userLinks: { user_id: string; person_id: string }[] = [];
let customOrgGrants: { grant_id: string; user_id: string; role_key: string }[] | undefined;
let customCommunityGrants:
  | {
      grant_id: string;
      user_id: string;
      role_key: string | null;
      custom_role_id: string | null;
      custom_role_key: string | null;
    }[]
  | undefined;

function fakeTx(strings: TemplateStringsArray): unknown[] {
  const text = strings.join(" ");
  if (text.includes("from app.custom_roles")) {
    return customRoles;
  }
  if (text.includes("from app.custom_role_permissions")) {
    return customRolePermissions;
  }
  if (text.includes("from app.user_links")) {
    return userLinks;
  }
  if (customOrgGrants !== undefined && text.includes("app.organisation_role_grants")) {
    return customOrgGrants;
  }
  if (customCommunityGrants !== undefined && text.includes("app.community_role_grants")) {
    return customCommunityGrants;
  }
  if (!grantsVisible || directoryMode === "billing") {
    if (directoryMode === "billing" && text.includes("app.organisation_role_grants")) {
      return [{ grant_id: ORG_GRANT, user_id: USER, role_key: "org_billing" }];
    }
    return [];
  }
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
    guardLog: () => undefined,
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
  return {
    ...found,
    handle: (request: Request, context = { billing: found.billing, pattern: found.pattern }) =>
      found.handle(request, context),
  };
}

describe("access routes", () => {
  beforeEach(() => {
    grantsVisible = true;
    directoryMode = "owner";
    identity.readSession.mockReset();
    tenancy.findCommunityBySlug.mockReset();
    access.grantRole.mockReset();
    access.linkUser.mockReset();
    access.unlinkUser.mockReset();
    access.holdsAnyGrant.mockReset();
    access.holdsAnyGrant.mockResolvedValue(true);
    access.holdsPermission.mockReset();
    access.holdsPermission.mockResolvedValue(true);
    entitlementGuard.checkEntitlement.mockReset();
    entitlementGuard.checkEntitlement.mockResolvedValue(true);
    billing.assertWritable.mockReset();
    billing.assertWritable.mockResolvedValue("ok");
    db.withAppTransaction.mockReset();
    db.appendAuditEvent.mockReset();
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
    customRoles = [];
    customRolePermissions = [];
    userLinks = [];
    customOrgGrants = undefined;
    customCommunityGrants = undefined;
    people.readLinkedContacts.mockReset();
    identity.readUserEmails.mockReset();
    people.readLinkedContacts.mockResolvedValue(new Map());
    identity.readUserEmails.mockResolvedValue(new Map());
  });

  it("registers nine tenant posts", () => {
    const routes = accessRoutes(deps());
    expect(routes.map((item) => `${item.method} ${item.pattern}`)).toEqual([
      "POST /v1/access/grants/list",
      "POST /v1/access/users/list",
      "POST /v1/access/capabilities",
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
      "people.view",
      "people.manage",
      "people.restricted.read",
      "entitlements.view",
      "entitlements.manage",
      "service_times.manage",
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

  it("answers an unknown slug and a community with no role the same way", async () => {
    tenancy.findCommunityBySlug.mockResolvedValue(null);
    const missing = await route("/v1/access/grants/list").handle(
      request(
        "/v1/access/grants/list",
        API_HOSTNAME,
        { communitySlug: "missing" },
        `Bearer ${TOKEN}`,
      ),
    );
    tenancy.findCommunityBySlug.mockResolvedValue({
      id: COMMUNITY,
      organisationId: ORG,
      slug: "other",
      region: "au",
    });
    grantsVisible = false;
    const absent = await route("/v1/access/grants/list").handle(
      request(
        "/v1/access/grants/list",
        API_HOSTNAME,
        { communitySlug: "other" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(absent.status).toBe(missing.status);
    expect(missing.status).toBe(403);
    expect(await absent.text()).toBe(await missing.text());
    expect(await missing.text()).toBe("");
  });

  it("refuses a link and an unlink when the caller cannot manage users", async () => {
    directoryMode = "billing";
    const linked = await route("/v1/access/user-links").handle(
      request(
        "/v1/access/user-links",
        API_HOSTNAME,
        {
          communitySlug: "parish",
          userId: "00000000-0000-4000-8000-000000000030",
          personId: "00000000-0000-4000-8000-000000000031",
        },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(linked.status).toBe(403);
    expect(await linked.text()).toBe("");
    expect(access.linkUser).not.toHaveBeenCalled();
    const unlinked = await route("/v1/access/user-links/delete").handle(
      request(
        "/v1/access/user-links/delete",
        API_HOSTNAME,
        { communitySlug: "parish", userId: "00000000-0000-4000-8000-000000000030" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(unlinked.status).toBe(403);
    expect(await unlinked.text()).toBe("");
    expect(access.unlinkUser).not.toHaveBeenCalled();
  });

  it("maps a forbidden grant to an empty 403 and takes the actor from the session", async () => {
    const subject = "00000000-0000-4000-8000-000000000030";
    access.grantRole.mockResolvedValue({ grantId: ORG_GRANT, scope: "community" });
    const granted = await route("/v1/access/grants").handle(
      request(
        "/v1/access/grants",
        API_HOSTNAME,
        { communitySlug: "parish", userId: subject, roleKey: "member" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(granted.status).toBe(200);
    expect(access.grantRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorUserId: USER, userId: subject }),
    );
    access.grantRole.mockReset();
    access.grantRole.mockRejectedValue(new access.AccessError("forbidden"));
    const refused = await route("/v1/access/grants").handle(
      request(
        "/v1/access/grants",
        API_HOSTNAME,
        { communitySlug: "parish", userId: subject, roleKey: "member" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe("");
    access.grantRole.mockReset();
    const planted = await route("/v1/access/grants").handle(
      request(
        "/v1/access/grants",
        API_HOSTNAME,
        { communitySlug: "parish", userId: subject, roleKey: "member", actorUserId: subject },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(planted.status).toBe(400);
    expect(access.grantRole).not.toHaveBeenCalled();
  });

  it("a member without access.roles.manage gets 402 on POST /v1/access/grants in read_only and 403 in ok", async () => {
    access.grantRole.mockRejectedValue(new access.AccessError("forbidden"));
    billing.assertWritable.mockRejectedValue(new BillingReadOnly("read_only"));

    const blocked = await route("/v1/access/grants").handle(
      request(
        "/v1/access/grants",
        API_HOSTNAME,
        { communitySlug: "parish", userId: USER, roleKey: "member" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(blocked.status).toBe(402);
    expect(await blocked.text()).toBe("");
    expect(access.grantRole).not.toHaveBeenCalled();

    billing.assertWritable.mockResolvedValue("ok");
    const allowed = await route("/v1/access/grants").handle(
      request(
        "/v1/access/grants",
        API_HOSTNAME,
        { communitySlug: "parish", userId: USER, roleKey: "member" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(allowed.status).toBe(403);
    expect(await allowed.text()).toBe("");
    expect(access.grantRole).toHaveBeenCalled();
  });

  it("grants/list answers 200 in read_only and when assertWritable rejects", async () => {
    billing.assertWritable.mockRejectedValue(new BillingReadOnly("read_only"));
    const listedReadOnly = await route("/v1/access/grants/list").handle(
      request(
        "/v1/access/grants/list",
        API_HOSTNAME,
        { communitySlug: "parish" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(listedReadOnly.status).toBe(200);

    billing.assertWritable.mockRejectedValue(new Error("platform db outage"));
    const listedOutage = await route("/v1/access/grants/list").handle(
      request(
        "/v1/access/grants/list",
        API_HOSTNAME,
        { communitySlug: "parish" },
        `Bearer ${TOKEN}`,
      ),
    );
    expect(listedOutage.status).toBe(200);
    expect(billing.assertWritable).not.toHaveBeenCalled();
  });

  describe("POST /v1/access/capabilities (pins 17-19)", () => {
    it("returns 200 with all permissions and entitlements when caller has grants", async () => {
      access.holdsAnyGrant.mockResolvedValueOnce(true);
      access.holdsPermission.mockResolvedValue(true);
      entitlementGuard.checkEntitlement.mockResolvedValue(true);

      const res = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as CapabilitiesResponse;
      expect(data).toEqual({
        permissions: {
          "people.view": true,
          "people.manage": true,
          "people.restricted.read": true,
          "service_times.manage": true,
        },
        entitlements: {
          "people.directory": true,
          "people.households": true,
          "module.engagement": true,
        },
      });

      // Pin 17: response key set equals the constant allow-list
      expect(Object.keys(data.permissions).sort()).toEqual(
        [...CAPABILITIES_ALLOW_LIST.permissions].sort(),
      );
      expect(Object.keys(data.entitlements).sort()).toEqual(
        [...CAPABILITIES_ALLOW_LIST.entitlements].sort(),
      );

      // Finding 1: verify checkEntitlement receives the exact scope
      expect(entitlementGuard.checkEntitlement).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        "people.directory",
      );
      expect(entitlementGuard.checkEntitlement).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        "people.households",
      );
      expect(entitlementGuard.checkEntitlement).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        "module.engagement",
      );
    });

    it("returns 200 with all permissions false when caller has role grant with no people permissions (finding 2)", async () => {
      access.holdsAnyGrant.mockResolvedValueOnce(true);
      access.holdsPermission.mockResolvedValue(false);
      entitlementGuard.checkEntitlement.mockResolvedValue(true);

      const res = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as CapabilitiesResponse;
      expect(data.permissions).toEqual({
        "people.view": false,
        "people.manage": false,
        "people.restricted.read": false,
        "service_times.manage": false,
      });
      expect(data.entitlements).toEqual({
        "people.directory": true,
        "people.households": true,
        "module.engagement": true,
      });
      expect(entitlementGuard.checkEntitlement).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        "people.directory",
      );
      expect(entitlementGuard.checkEntitlement).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        "people.households",
      );
      expect(entitlementGuard.checkEntitlement).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: ORG, communityId: COMMUNITY },
        "module.engagement",
      );
    });

    it("hides the capabilities route on a foreign hostname before any lookup (finding H5a)", async () => {
      for (const hostname of [AUTH_HOSTNAME, "other.example.test"]) {
        const res = await route("/v1/access/capabilities").handle(
          request(
            "/v1/access/capabilities",
            hostname,
            { communitySlug: "parish" },
            `Bearer ${TOKEN}`,
          ),
        );
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("");
      }
      expect(identity.readSession).not.toHaveBeenCalled();
      expect(tenancy.findCommunityBySlug).not.toHaveBeenCalled();
      expect(access.holdsAnyGrant).not.toHaveBeenCalled();
      expect(access.holdsPermission).not.toHaveBeenCalled();
      expect(db.withAppTransaction).not.toHaveBeenCalled();
    });

    it("returns 400 when body carries extra keys or non-slug fields (pin 17)", async () => {
      const extra = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish", extra: true },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(extra.status).toBe(400);

      const extraPerm = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish", permissions: ["people.view"] },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(extraPerm.status).toBe(400);
    });

    it("evaluates each boolean independently based on its own permission or entitlement (pin 18)", async () => {
      // only people.view
      access.holdsAnyGrant.mockResolvedValue(true);
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm === "people.view",
      );
      entitlementGuard.checkEntitlement.mockResolvedValue(true);

      const resView = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(resView.status).toBe(200);
      const dataView = (await resView.json()) as CapabilitiesResponse;
      expect(dataView.permissions).toEqual({
        "people.view": true,
        "people.manage": false,
        "people.restricted.read": false,
        "service_times.manage": false,
      });

      // only people.manage
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm === "people.manage",
      );
      const resManage = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(resManage.status).toBe(200);
      const dataManage = (await resManage.json()) as CapabilitiesResponse;
      expect(dataManage.permissions).toEqual({
        "people.view": false,
        "people.manage": true,
        "people.restricted.read": false,
        "service_times.manage": false,
      });

      // only people.restricted.read
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm === "people.restricted.read",
      );
      const resRestricted = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(resRestricted.status).toBe(200);
      const dataRestricted = (await resRestricted.json()) as CapabilitiesResponse;
      expect(dataRestricted.permissions).toEqual({
        "people.view": false,
        "people.manage": false,
        "people.restricted.read": true,
        "service_times.manage": false,
      });

      // only service_times.manage
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm === "service_times.manage",
      );
      const resServiceTimes = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(resServiceTimes.status).toBe(200);
      const dataServiceTimes = (await resServiceTimes.json()) as CapabilitiesResponse;
      expect(dataServiceTimes.permissions).toEqual({
        "people.view": false,
        "people.manage": false,
        "people.restricted.read": false,
        "service_times.manage": true,
      });

      // Entitlements toggles
      access.holdsPermission.mockResolvedValue(true);
      entitlementGuard.checkEntitlement.mockImplementation(
        async (_deps: unknown, _scope: unknown, key: string) => key === "people.directory",
      );
      const resEnt1 = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(resEnt1.status).toBe(200);
      const dataEnt1 = (await resEnt1.json()) as CapabilitiesResponse;
      expect(dataEnt1.entitlements).toEqual({
        "people.directory": true,
        "people.households": false,
        "module.engagement": false,
      });

      entitlementGuard.checkEntitlement.mockImplementation(
        async (_deps: unknown, _scope: unknown, key: string) => key === "people.households",
      );
      const resEnt2 = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(resEnt2.status).toBe(200);
      const dataEnt2 = (await resEnt2.json()) as CapabilitiesResponse;
      expect(dataEnt2.entitlements).toEqual({
        "people.directory": false,
        "people.households": true,
        "module.engagement": false,
      });

      entitlementGuard.checkEntitlement.mockImplementation(
        async (_deps: unknown, _scope: unknown, key: string) => key === "module.engagement",
      );
      const resEnt3 = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(resEnt3.status).toBe(200);
      const dataEnt3 = (await resEnt3.json()) as CapabilitiesResponse;
      expect(dataEnt3.entitlements).toEqual({
        "people.directory": false,
        "people.households": false,
        "module.engagement": true,
      });
    });

    it("answers stranger and unknown slug with identical empty 403 (pin 19)", async () => {
      // Unknown slug
      tenancy.findCommunityBySlug.mockResolvedValueOnce(null);
      const resUnknown = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "unknown-slug" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(resUnknown.status).toBe(403);
      const bodyUnknown = await resUnknown.text();
      expect(bodyUnknown).toBe("");

      // Stranger (holdsAnyGrant returns false)
      access.holdsAnyGrant.mockResolvedValueOnce(false);
      const resStranger = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(resStranger.status).toBe(403);
      const bodyStranger = await resStranger.text();
      expect(bodyStranger).toBe("");

      expect(bodyUnknown).toBe(bodyStranger);
    });

    it("works for a read-only organisation (billing: read)", async () => {
      billing.assertWritable.mockRejectedValue(new BillingReadOnly("read_only"));
      access.holdsAnyGrant.mockResolvedValueOnce(true);
      access.holdsPermission.mockResolvedValue(true);
      entitlementGuard.checkEntitlement.mockResolvedValue(true);

      const res = await route("/v1/access/capabilities").handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(res.status).toBe(200);
    });

    it("never logs caller permissions, user id or community internal ids", async () => {
      const logCalls: unknown[] = [];
      const bound = deps((message, fields) => {
        logCalls.push({ message, fields });
      });
      access.holdsAnyGrant.mockResolvedValueOnce(true);
      access.holdsPermission.mockResolvedValue(true);
      entitlementGuard.checkEntitlement.mockResolvedValue(true);

      const res = await route("/v1/access/capabilities", bound).handle(
        request(
          "/v1/access/capabilities",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(res.status).toBe(200);

      const logged = JSON.stringify(logCalls);
      expect(logged).not.toContain(USER);
      expect(logged).not.toContain(ORG);
      expect(logged).not.toContain(COMMUNITY);
      expect(logged).not.toContain("canReadMinors");
      expect(logged).not.toContain("people.view");
    });
  });

  describe("POST /v1/access/users/list", () => {
    async function callUsersList(
      body: unknown,
      token = TOKEN,
      hostname = API_HOSTNAME,
      bound = deps(),
    ): Promise<Response> {
      return await withRequest(
        { requestId: REQUEST_ID },
        async () =>
          await route("/v1/access/users/list", bound).handle(
            request(
              "/v1/access/users/list",
              hostname,
              body,
              token === "" ? undefined : `Bearer ${token}`,
            ),
          ),
      );
    }

    it("Pin 12: returns 404 with no-store and empty body on foreign host", async () => {
      const res = await callUsersList({ communitySlug: "parish" }, TOKEN, "foreign.example.test");
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("");
    });

    it("Pin 12: returns 401 with no-store and empty body when unauthenticated or session invalid", async () => {
      const missing = await callUsersList({ communitySlug: "parish" }, "");
      expect(missing.status).toBe(401);
      expect(missing.headers.get("cache-control")).toBe("no-store");
      expect(await missing.text()).toBe("");

      identity.readSession.mockResolvedValueOnce(null);
      const invalid = await callUsersList({ communitySlug: "parish" });
      expect(invalid.status).toBe(401);
      expect(invalid.headers.get("cache-control")).toBe("no-store");
      expect(await invalid.text()).toBe("");
    });

    it("Pin 4: returns 400 with no-store and empty body on body with extra userIds, calling neither export", async () => {
      const res = await callUsersList({
        communitySlug: "parish",
        userIds: [USER],
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("");
      expect(people.readLinkedContacts).not.toHaveBeenCalled();
      expect(identity.readUserEmails).not.toHaveBeenCalled();
    });

    it("Pin 12: returns 403 with no-store and empty body when community slug is unknown", async () => {
      tenancy.findCommunityBySlug.mockResolvedValueOnce(null);
      const res = await callUsersList({ communitySlug: "unknown-parish" });
      expect(res.status).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("");
    });

    it("Pin 1: checks permissions (roles.view only -> 403, users.view only -> 403, both -> 200)", async () => {
      const customRoleId = "00000000-0000-4000-8000-000000000077";
      const linkedPersonId = "00000000-0000-4000-8000-000000000055";
      userLinks = [{ user_id: USER, person_id: linkedPersonId }];
      people.readLinkedContacts.mockResolvedValue(
        new Map([
          [linkedPersonId, { minor: false, given: "Ada", family: "Lovelace", phone: null }],
        ]),
      );
      customOrgGrants = [];

      // Case 1: Caller with access.roles.view only
      customRoles = [{ custom_role_id: customRoleId, key: "role_viewer" }];
      customRolePermissions = [{ custom_role_id: customRoleId, permission: "access.roles.view" }];
      customCommunityGrants = [
        {
          grant_id: COMMUNITY_GRANT,
          user_id: USER,
          role_key: null,
          custom_role_id: customRoleId,
          custom_role_key: "role_viewer",
        },
      ];
      people.readLinkedContacts.mockClear();
      identity.readUserEmails.mockClear();
      db.appendAuditEvent.mockClear();
      const rolesOnly = await callUsersList({ communitySlug: "parish" });
      expect(rolesOnly.status).toBe(403);
      expect(rolesOnly.headers.get("cache-control")).toBe("no-store");
      expect(await rolesOnly.text()).toBe("");
      expect(people.readLinkedContacts).not.toHaveBeenCalled();
      expect(identity.readUserEmails).not.toHaveBeenCalled();
      expect(db.appendAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "access.permission.denied",
          purpose: "access.users.view",
          targetIds: [USER],
        }),
      );

      // Case 2: Caller with access.users.view only
      customRoles = [{ custom_role_id: customRoleId, key: "user_viewer" }];
      customRolePermissions = [{ custom_role_id: customRoleId, permission: "access.users.view" }];
      customCommunityGrants = [
        {
          grant_id: COMMUNITY_GRANT,
          user_id: USER,
          role_key: null,
          custom_role_id: customRoleId,
          custom_role_key: "user_viewer",
        },
      ];
      people.readLinkedContacts.mockClear();
      identity.readUserEmails.mockClear();
      db.appendAuditEvent.mockClear();
      const usersOnly = await callUsersList({ communitySlug: "parish" });
      expect(usersOnly.status).toBe(403);
      expect(usersOnly.headers.get("cache-control")).toBe("no-store");
      expect(await usersOnly.text()).toBe("");
      expect(people.readLinkedContacts).not.toHaveBeenCalled();
      expect(identity.readUserEmails).not.toHaveBeenCalled();

      // Case 3: Caller who lacks both
      customCommunityGrants = [];
      people.readLinkedContacts.mockClear();
      identity.readUserEmails.mockClear();
      db.appendAuditEvent.mockClear();
      const neither = await callUsersList({ communitySlug: "parish" });
      expect(neither.status).toBe(403);
      expect(neither.headers.get("cache-control")).toBe("no-store");
      expect(await neither.text()).toBe("");
      expect(people.readLinkedContacts).not.toHaveBeenCalled();
      expect(identity.readUserEmails).not.toHaveBeenCalled();
      expect(db.appendAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "access.permission.denied",
          purpose: "access.roles.view",
          targetIds: [USER],
        }),
      );

      // Case 4: Caller with both (e.g. org_owner from default fakeTx)
      customCommunityGrants = undefined;
      customOrgGrants = undefined;
      customRoles = [];
      customRolePermissions = [];
      identity.readUserEmails.mockResolvedValueOnce(new Map([[USER, "owner@example.com"]]));
      const ok = await callUsersList({ communitySlug: "parish" });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      const parsed = listUsersResponse.safeParse(await ok.json());
      expect(parsed.success).toBe(true);
    });

    it("Pin 2: phone needs people.view (both view permissions without people.view -> phone null, phoneVisible false)", async () => {
      customOrgGrants = [];
      customCommunityGrants = [
        {
          grant_id: COMMUNITY_GRANT,
          user_id: USER,
          role_key: "staff",
          custom_role_id: null,
          custom_role_key: null,
        },
      ];
      const personId = "00000000-0000-4000-8000-000000000033";
      userLinks = [{ user_id: USER, person_id: personId }];
      people.readLinkedContacts.mockResolvedValueOnce(
        new Map([
          [
            personId,
            {
              minor: false,
              given: "Staff",
              family: "Member",
              phone: "+61491570006",
            },
          ],
        ]),
      );
      identity.readUserEmails.mockResolvedValueOnce(new Map([[USER, "staff@example.com"]]));

      const res = await callUsersList({ communitySlug: "parish" });
      expect(res.status).toBe(200);
      expect(people.readLinkedContacts).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          includePhone: false,
          actorUserId: USER,
          personIds: [personId],
        }),
      );

      const body = listUsersResponse.parse(await res.json());
      expect(body.phoneVisible).toBe(false);
      expect(body.users).toHaveLength(1);
      expect(body.users[0]?.phone).toBeNull();
      expect(body.users[0]?.name).toEqual({ given: "Staff", family: "Member" });
      expect(body.users[0]?.email).toBe("staff@example.com");
    });

    it("Pin 3: minor-linked user id never reaches readUserEmails, row has minor: true and nulls", async () => {
      const minorPersonId = "00000000-0000-4000-8000-000000000044";
      userLinks = [{ user_id: USER, person_id: minorPersonId }];
      people.readLinkedContacts.mockResolvedValueOnce(new Map([[minorPersonId, { minor: true }]]));

      const res = await callUsersList({ communitySlug: "parish" });
      expect(res.status).toBe(200);
      expect(identity.readUserEmails).not.toHaveBeenCalled();

      const body = listUsersResponse.parse(await res.json());
      expect(body.users).toEqual([
        {
          userId: USER,
          personId: minorPersonId,
          name: null,
          email: null,
          phone: null,
          minor: true,
        },
      ]);
    });

    it("a linked user whose person is not returned is hidden and never reaches readUserEmails", async () => {
      const missingPersonId = "00000000-0000-4000-8000-000000000088";
      userLinks = [{ user_id: USER, person_id: missingPersonId }];
      people.readLinkedContacts.mockResolvedValueOnce(new Map());
      identity.readUserEmails.mockResolvedValueOnce(new Map([[USER, "hidden@example.test"]]));

      const res = await callUsersList({ communitySlug: "parish" });
      expect(res.status).toBe(200);

      const body = listUsersResponse.parse(await res.json());
      expect(body.users).toEqual([
        {
          userId: USER,
          personId: missingPersonId,
          name: null,
          email: null,
          phone: null,
          minor: true,
        },
      ]);

      expect(identity.readUserEmails).not.toHaveBeenCalled();
      for (const call of identity.readUserEmails.mock.calls) {
        expect((call[3] as string[] | undefined) ?? []).not.toContain(USER);
      }
    });

    it("mixed directory (L3): readUserEmails receives exactly the adult-linked user and unlinked user, never the minor", async () => {
      const userAdult = USER;
      const userMinor = "00000000-0000-4000-8000-0000000000a2";
      const userUnlinked = "00000000-0000-4000-8000-0000000000a3";
      const adultPersonId = "00000000-0000-4000-8000-0000000000b1";
      const minorPersonId = "00000000-0000-4000-8000-0000000000b2";

      customOrgGrants = [
        {
          grant_id: "00000000-0000-4000-8000-0000000000c1",
          user_id: userAdult,
          role_key: "org_owner",
        },
        {
          grant_id: "00000000-0000-4000-8000-0000000000c2",
          user_id: userMinor,
          role_key: "member",
        },
        {
          grant_id: "00000000-0000-4000-8000-0000000000c3",
          user_id: userUnlinked,
          role_key: "member",
        },
      ];
      userLinks = [
        { user_id: userAdult, person_id: adultPersonId },
        { user_id: userMinor, person_id: minorPersonId },
      ];
      people.readLinkedContacts.mockResolvedValueOnce(
        new Map([
          [
            adultPersonId,
            { minor: false, given: "Adult", family: "Person", phone: "+61491570111" },
          ],
          [minorPersonId, { minor: true }],
        ]),
      );
      identity.readUserEmails.mockResolvedValueOnce(
        new Map([
          [userAdult, "adult@example.com"],
          [userUnlinked, "unlinked@example.com"],
        ]),
      );

      const res = await callUsersList({ communitySlug: "parish" });
      expect(res.status).toBe(200);

      expect(identity.readUserEmails).toHaveBeenCalledTimes(1);
      const fourthArg = (identity.readUserEmails.mock.calls[0]?.[3] as string[]) ?? [];
      expect(new Set(fourthArg)).toEqual(new Set([userAdult, userUnlinked]));
      expect(fourthArg).toHaveLength(2);
      expect(fourthArg).not.toContain(userMinor);
    });

    it("Pin 9: 501 directory users -> 409 (too_many) with no export calls and no audit, 500 -> 200", async () => {
      const makeUsers = (count: number) => {
        const grants = [];
        for (let i = 0; i < count; i += 1) {
          const hex = i.toString(16).padStart(12, "0");
          grants.push({
            grant_id: `00000000-0000-4000-8000-${hex}`,
            user_id: `00000000-0000-4000-8000-${hex}`,
            role_key: i === 0 ? "org_owner" : "member",
          });
        }
        return grants;
      };

      // 501 users
      customOrgGrants = makeUsers(501);
      userLinks = [{ user_id: USER, person_id: "00000000-0000-4000-8000-000000000099" }];
      db.appendAuditEvent.mockClear();
      people.readLinkedContacts.mockClear();
      identity.readUserEmails.mockClear();

      const tooMany = await callUsersList({ communitySlug: "parish" });
      expect(tooMany.status).toBe(409);
      expect(tooMany.headers.get("cache-control")).toBe("no-store");
      expect(await tooMany.text()).toBe("");
      expect(people.readLinkedContacts).not.toHaveBeenCalled();
      expect(identity.readUserEmails).not.toHaveBeenCalled();
      expect(db.appendAuditEvent).not.toHaveBeenCalled();

      // Exactly 500 users
      customOrgGrants = makeUsers(500);
      people.readLinkedContacts.mockClear();
      identity.readUserEmails.mockClear();
      identity.readUserEmails.mockResolvedValueOnce(new Map());

      const exactly500 = await callUsersList({ communitySlug: "parish" });
      expect(exactly500.status).toBe(200);
      expect(exactly500.headers.get("cache-control")).toBe("no-store");
      const body = listUsersResponse.parse(await exactly500.json());
      expect(body.users).toHaveLength(500);
    });

    it("Pin 12: every response carries cache-control: no-store, empty bodies on non-200, grants/list 200 untouched", async () => {
      const ok = await callUsersList({ communitySlug: "parish" });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      listUsersResponse.parse(await ok.json());

      const grantsRes = await route("/v1/access/grants/list").handle(
        request(
          "/v1/access/grants/list",
          API_HOSTNAME,
          { communitySlug: "parish" },
          `Bearer ${TOKEN}`,
        ),
      );
      expect(grantsRes.status).toBe(200);
      expect(grantsRes.headers.get("cache-control")).toBeNull();

      identity.readUserEmails.mockRejectedValueOnce(new Error("kms decrypt error"));
      const decryptFail = await callUsersList({ communitySlug: "parish" });
      expect(decryptFail.status).toBe(500);
      expect(decryptFail.headers.get("cache-control")).toBe("no-store");
      expect(await decryptFail.text()).toBe("");

      tenancy.findCommunityBySlug.mockRejectedValueOnce(new Error("platform db dead"));
      const platformFail = await callUsersList({ communitySlug: "parish" });
      expect(platformFail.status).toBe(500);
      expect(platformFail.headers.get("cache-control")).toBe("no-store");
      expect(await platformFail.text()).toBe("");

      identity.readSession.mockRejectedValueOnce(new Error("identity session db dead"));
      const sessionFail = await callUsersList({ communitySlug: "parish" });
      expect(sessionFail.status).toBe(500);
      expect(sessionFail.headers.get("cache-control")).toBe("no-store");
      expect(await sessionFail.text()).toBe("");
    });

    it("Pin 15: logs on 500 record primitive fields only and leak no fixture, SQL, hostname or stack", async () => {
      const logCalls: { message: string; fields?: Record<string, unknown> }[] = [];
      const bound = deps((message, fields) => {
        logCalls.push({ message, fields });
      });

      const fixtureEmail = "morgan@example.test";
      const sensitiveMessage = `forced error with ${fixtureEmail} and select email from identity.users`;
      identity.readUserEmails.mockRejectedValueOnce(new Error(sensitiveMessage));

      const res = await callUsersList({ communitySlug: "parish" }, TOKEN, API_HOSTNAME, bound);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");
      expect(logCalls).toHaveLength(1);

      const loggedCall = logCalls[0]!;
      expect(loggedCall.fields).toBeDefined();

      for (const value of Object.values(loggedCall.fields ?? {})) {
        const isPrimitive =
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          value === null ||
          value === undefined;
        expect(isPrimitive).toBe(true);
      }

      const rendered = util.inspect(loggedCall, { depth: null });
      expect(rendered).not.toContain(fixtureEmail);
      expect(rendered).not.toContain("Morgan");
      expect(rendered).not.toContain("+61491570");
      expect(rendered).not.toContain("select");
      expect(rendered).not.toContain("identity.");
      expect(rendered).not.toContain(API_HOSTNAME);
      expect(rendered).not.toContain("at ");
    });

    it("sortUsers pure function: handles named rows, unnamed rows, null emails, accented names, and ties", () => {
      const items = [
        {
          userId: "00000000-0000-4000-8000-000000000003",
          personId: null,
          name: null,
          email: "charlie@example.com",
          phone: null,
          minor: false,
        },
        {
          userId: "00000000-0000-4000-8000-000000000001",
          personId: "00000000-0000-4000-8000-000000000010",
          name: { given: "Bob", family: "Smith" },
          email: "bob@example.com",
          phone: null,
          minor: false,
        },
        {
          userId: "00000000-0000-4000-8000-000000000002",
          personId: "00000000-0000-4000-8000-000000000011",
          name: { given: "Alice", family: "Smith" },
          email: "alice@example.com",
          phone: null,
          minor: false,
        },
        {
          userId: "00000000-0000-4000-8000-000000000004",
          personId: null,
          name: null,
          email: null,
          phone: null,
          minor: false,
        },
        {
          userId: "00000000-0000-4000-8000-000000000005",
          personId: "00000000-0000-4000-8000-000000000012",
          name: { given: "Chloë", family: "Brown" },
          email: "chloe2@example.com",
          phone: null,
          minor: false,
        },
        {
          userId: "00000000-0000-4000-8000-000000000006",
          personId: "00000000-0000-4000-8000-000000000013",
          name: { given: "Chloe", family: "Brown" },
          email: "chloe1@example.com",
          phone: null,
          minor: false,
        },
      ];

      const sorted = sortUsers(items);
      expect(sorted.map((u) => u.userId)).toEqual([
        "00000000-0000-4000-8000-000000000006",
        "00000000-0000-4000-8000-000000000005",
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004",
      ]);
    });
  });
});
