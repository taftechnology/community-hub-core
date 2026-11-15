import util from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingReadOnly } from "@community-hub/billing";
import {
  acceptInvitationResponse,
  accessErrorBody,
  createInvitationResponse,
  listInvitationsResponse,
} from "@community-hub/contracts/access";
import { withRequest } from "@community-hub/kernel";

const identity = vi.hoisted(() => ({
  readSession: vi.fn(),
  readUserEmails: vi.fn(),
  findUserByEmail: vi.fn(),
  findOrCreateUserByEmail: vi.fn(),
  createInvitationEmail: vi.fn(),
  refreshInvitationEmail: vi.fn(),
  closeInvitationEmail: vi.fn(),
  openInvitationEmails: vi.fn(),
  invitationAddressMatches: vi.fn(),
  sweepInvitationEmails: vi.fn(),
}));

const tenancy = vi.hoisted(() => ({
  findCommunityBySlug: vi.fn(),
  findCommunityById: vi.fn(),
}));

const billing = vi.hoisted(() => ({
  assertWritable: vi.fn(),
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
    createInvitation: vi.fn(),
    listInvitations: vi.fn(),
    resendInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    proveInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
    deleteInvitationAfterMailFailure: vi.fn(),
    voidInvitationAfterMailFailure: vi.fn(),
    holdsPermission: vi.fn(),
    holdsAnyGrant: vi.fn(),
  };
});

let txLog: { committed: boolean; rolledBack: boolean }[] = [];
const lastTx = () => txLog[txLog.length - 1] ?? { committed: false, rolledBack: false };

const db = vi.hoisted(() => ({
  withAppTransaction: vi.fn(),
  newId: vi.fn(() => "00000000-0000-4000-8000-000000000099"),
  appendAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("@community-hub/identity", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/identity")>("@community-hub/identity");
  return {
    ...actual,
    readSession: identity.readSession,
    readUserEmails: identity.readUserEmails,
    findUserByEmail: identity.findUserByEmail,
    findOrCreateUserByEmail: identity.findOrCreateUserByEmail,
    createInvitationEmail: identity.createInvitationEmail,
    refreshInvitationEmail: identity.refreshInvitationEmail,
    closeInvitationEmail: identity.closeInvitationEmail,
    openInvitationEmails: identity.openInvitationEmails,
    invitationAddressMatches: identity.invitationAddressMatches,
    sweepInvitationEmails: identity.sweepInvitationEmails,
  };
});

vi.mock("@community-hub/tenancy", () => tenancy);

vi.mock("@community-hub/billing", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/billing")>("@community-hub/billing");
  return { ...actual, assertWritable: billing.assertWritable };
});

vi.mock("@community-hub/access", async () => {
  const actual =
    await vi.importActual<typeof import("@community-hub/access")>("@community-hub/access");
  return {
    ...actual,
    AccessError: access.AccessError,
    createInvitation: access.createInvitation,
    listInvitations: access.listInvitations,
    resendInvitation: access.resendInvitation,
    revokeInvitation: access.revokeInvitation,
    proveInvitation: access.proveInvitation,
    acceptInvitation: access.acceptInvitation,
    deleteInvitationAfterMailFailure: access.deleteInvitationAfterMailFailure,
    voidInvitationAfterMailFailure: access.voidInvitationAfterMailFailure,
    holdsPermission: access.holdsPermission,
    holdsAnyGrant: access.holdsAnyGrant,
  };
});

vi.mock("@community-hub/db", async () => {
  const actual = await vi.importActual<typeof import("@community-hub/db")>("@community-hub/db");
  return {
    ...actual,
    withAppTransaction: db.withAppTransaction,
    newId: db.newId,
    appendAuditEvent: db.appendAuditEvent,
  };
});

import {
  buildInvitationToken,
  rejectingInvitationMail,
  type InvitationMail,
} from "@community-hub/access";
import { invitationRoutes, type InvitationRouteDeps } from "./invitation-routes.js";

const API_HOSTNAME = "api.example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const TOKEN = "secret-access-token";
const USER = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-000000000010";
const COMMUNITY = "00000000-0000-4000-8000-000000000011";
const INVITATION_ID = "00000000-0000-4000-8000-000000000099";
const PERSON_ID = "00000000-0000-4000-8000-000000000012";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";

const validSampleToken = buildInvitationToken({
  orgId: ORG,
  communityId: COMMUNITY,
  invitationId: INVITATION_ID,
}).token;

function request(
  path: string,
  hostname: string,
  body: unknown,
  authHeader?: string,
  method = "POST",
): Request {
  const headers = new Headers({
    "x-community-hub-hostname": hostname,
    "content-type": "application/json",
  });
  if (authHeader !== undefined) {
    headers.set("authorization", authHeader);
  }
  const init: RequestInit = {
    method,
    headers,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`https://${hostname}${path}`, init);
}

describe("invitation routes", () => {
  let mail: InvitationMail;
  let logCalls: { message: string; fields?: Record<string, unknown> }[];

  function makeDeps(overrides?: Partial<InvitationRouteDeps>): InvitationRouteDeps {
    return {
      checkout: (_role, run) => run({} as never),
      kms: {} as never,
      keyArn: "arn:aws:kms:ap-southeast-2:123456789012:key/mrk-example",
      now: () => new Date("2026-11-15T00:00:00.000Z"),
      apiHostname: API_HOSTNAME,
      adminOrigin: ADMIN_ORIGIN,
      mail,
      log: (message, fields) => {
        logCalls.push({ message, fields });
      },
      guardLog: () => undefined,
      ...overrides,
    };
  }

  function route(path: string, depsOverride?: InvitationRouteDeps) {
    const list = invitationRoutes(depsOverride ?? makeDeps());
    const found = list.find((r) => r.pattern === path);
    if (!found) {
      throw new Error(`Route ${path} not registered`);
    }
    return {
      ...found,
      handle: async (
        request: Request,
        context: Record<string, unknown> = { billing: found.billing, pattern: found.pattern },
      ): Promise<Response> =>
        found.handle(request, {
          billing: (context.billing as "write" | "read" | "exempt") ?? found.billing,
          pattern: (context.pattern as string) ?? found.pattern,
        }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    logCalls = [];
    txLog = [];

    mail = {
      send: vi.fn(async () => undefined),
    };

    db.withAppTransaction.mockImplementation(async (_sql, _scope, callback) => {
      const record = { committed: false, rolledBack: false };
      txLog.push(record);
      try {
        const result = await callback({} as never);
        record.committed = true;
        return result;
      } catch (err) {
        record.rolledBack = true;
        throw err;
      }
    });

    identity.readSession.mockResolvedValue({ userId: USER });
    identity.createInvitationEmail.mockResolvedValue({ ok: true });
    identity.refreshInvitationEmail.mockResolvedValue(true);
    identity.closeInvitationEmail.mockResolvedValue(undefined);
    identity.openInvitationEmails.mockResolvedValue(
      new Map([[INVITATION_ID, "invitee@example.test"]]),
    );
    identity.invitationAddressMatches.mockResolvedValue(true);
    identity.sweepInvitationEmails.mockResolvedValue({ erased: 0, deleted: 0 });

    tenancy.findCommunityBySlug.mockResolvedValue({
      id: COMMUNITY,
      organisationId: ORG,
      slug: "parish",
      region: "au",
    });
    tenancy.findCommunityById.mockResolvedValue({
      id: COMMUNITY,
      organisationId: ORG,
      slug: "parish",
    });

    billing.assertWritable.mockResolvedValue(undefined);

    access.holdsAnyGrant.mockResolvedValue(true);
    access.holdsPermission.mockResolvedValue(true);
    access.createInvitation.mockImplementation(async (_tx, addresses, input) => {
      await addresses.create({
        communityId: COMMUNITY,
        invitationId: input.invitationId,
        email: input.address,
        now: input.now,
      });
      return {
        invitationId: input.invitationId,
        token: validSampleToken,
        expiresAt: new Date("2026-11-22T00:00:00.000Z"),
      };
    });
    access.listInvitations.mockResolvedValue([
      {
        id: INVITATION_ID,
        email: "invitee@example.test",
        roleKey: "staff",
        customRoleId: null,
        linksContact: false,
        expiresAt: new Date("2026-11-22T00:00:00.000Z"),
      },
    ]);
    access.resendInvitation.mockResolvedValue({
      token: validSampleToken,
      expiresAt: new Date("2026-11-22T00:00:00.000Z"),
    });
    access.revokeInvitation.mockResolvedValue(undefined);
    access.proveInvitation.mockResolvedValue("ok");
    access.acceptInvitation.mockResolvedValue({
      invitationId: INVITATION_ID,
      communityId: COMMUNITY,
    });
    access.deleteInvitationAfterMailFailure.mockResolvedValue(undefined);
    access.voidInvitationAfterMailFailure.mockResolvedValue(undefined);
  });

  describe("Security Pins", () => {
    it("pin 39: create never reads identity.users, only readSession, sweepInvitationEmails, and createInvitationEmail", async () => {
      const resWithAccount = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/create").handle(
          request(
            "/v1/access/invitations/create",
            API_HOSTNAME,
            { communitySlug: "parish", email: "has-account@example.test", roleKey: "staff" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/create",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(resWithAccount.status).toBe(201);
      const dataWithAccount = createInvitationResponse.parse(await resWithAccount.json());

      const resWithoutAccount = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/create").handle(
          request(
            "/v1/access/invitations/create",
            API_HOSTNAME,
            { communitySlug: "parish", email: "no-account@example.test", roleKey: "staff" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/create",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(resWithoutAccount.status).toBe(201);
      const dataWithoutAccount = createInvitationResponse.parse(await resWithoutAccount.json());

      expect(Object.keys(dataWithAccount)).toEqual(Object.keys(dataWithoutAccount));

      // Assert no identity.users readers were called
      expect(identity.findUserByEmail).not.toHaveBeenCalled();
      expect(identity.readUserEmails).not.toHaveBeenCalled();
      expect(identity.invitationAddressMatches).not.toHaveBeenCalled();

      // Allowed calls
      expect(identity.readSession).toHaveBeenCalled();
      expect(identity.createInvitationEmail).toHaveBeenCalled();
    });

    it("pin 40 (a): accept proves the token before findCommunityById", async () => {
      const forgedToken = "v1.forged_token_that_fails_parsing_or_proof";
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/invitations/accept").handle(
          request(
            "/v1/invitations/accept",
            API_HOSTNAME,
            { token: forgedToken },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/invitations/accept",
            surface: "tenant",
            billing: "exempt",
          },
        ),
      );
      expect(res.status).toBe(404);
      expect(accessErrorBody.parse(await res.json())).toEqual({ error: "invitation_invalid" });
      expect(tenancy.findCommunityById).not.toHaveBeenCalled();
    });

    it("pin 40 (b): accept proves the token before assertWritable", async () => {
      const forgedToken = "v1.forged_token_that_fails_parsing_or_proof";
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/invitations/accept").handle(
          request(
            "/v1/invitations/accept",
            API_HOSTNAME,
            { token: forgedToken },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/invitations/accept",
            surface: "tenant",
            billing: "exempt",
          },
        ),
      );
      expect(res.status).toBe(404);
      expect(accessErrorBody.parse(await res.json())).toEqual({ error: "invitation_invalid" });
      expect(billing.assertWritable).not.toHaveBeenCalled();
    });

    it("pin 41 (a): create with a role without access.roles.manage gives 403 with no repository call", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm !== "access.roles.manage",
      );
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/create").handle(
          request(
            "/v1/access/invitations/create",
            API_HOSTNAME,
            { communitySlug: "parish", email: "user@example.test", roleKey: "staff" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/create",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(access.createInvitation).not.toHaveBeenCalled();
    });

    it("pin 41 (b): create with a contact without people.view gives 403 with no repository call", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm !== "people.view",
      );
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/create").handle(
          request(
            "/v1/access/invitations/create",
            API_HOSTNAME,
            { communitySlug: "parish", email: "user@example.test", personId: PERSON_ID },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/create",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(access.createInvitation).not.toHaveBeenCalled();
    });

    it("pin 41 (c): list with access.users.view only gives 403 with no repository call", async () => {
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm === "access.users.view",
      );
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/list").handle(
          request(
            "/v1/access/invitations/list",
            API_HOSTNAME,
            { communitySlug: "parish" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/list",
            surface: "tenant",
            billing: "read",
          },
        ),
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
      expect(access.listInvitations).not.toHaveBeenCalled();
    });

    it("pin 41 (d): resend and revoke require access.users.manage, while access.roles.manage alone gives 403", async () => {
      // Caller with only access.users.manage succeeds (204)
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm === "access.users.manage",
      );
      const resendOk = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/resend").handle(
          request(
            "/v1/access/invitations/resend",
            API_HOSTNAME,
            { communitySlug: "parish", invitationId: INVITATION_ID },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/resend",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(resendOk.status).toBe(204);

      const revokeOk = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/revoke").handle(
          request(
            "/v1/access/invitations/revoke",
            API_HOSTNAME,
            { communitySlug: "parish", invitationId: INVITATION_ID },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/revoke",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(revokeOk.status).toBe(204);

      // Caller with only access.roles.manage gets 403
      access.holdsPermission.mockImplementation(
        async (_tx: unknown, _userId: string, perm: string) => perm === "access.roles.manage",
      );
      const resendFail = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/resend").handle(
          request(
            "/v1/access/invitations/resend",
            API_HOSTNAME,
            { communitySlug: "parish", invitationId: INVITATION_ID },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/resend",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(resendFail.status).toBe(403);

      const revokeFail = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/revoke").handle(
          request(
            "/v1/access/invitations/revoke",
            API_HOSTNAME,
            { communitySlug: "parish", invitationId: INVITATION_ID },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/revoke",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(revokeFail.status).toBe(403);
    });

    it("pin 41 (e): mail check runs after permissions so caller without rights gets 403, and revoke succeeds with mail unset", async () => {
      const unsetMailDeps = makeDeps({ mail: rejectingInvitationMail });

      // Caller without permissions gets 403 (not 503) on create with mail unset
      access.holdsPermission.mockResolvedValue(false);
      const createNoPerm = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/create", unsetMailDeps).handle(
          request(
            "/v1/access/invitations/create",
            API_HOSTNAME,
            { communitySlug: "parish", email: "user@example.test", roleKey: "staff" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/create",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(createNoPerm.status).toBe(403);

      // Caller with permissions gets 204 on revoke with mail unset
      access.holdsPermission.mockResolvedValue(true);
      const revokeOk = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/revoke", unsetMailDeps).handle(
          request(
            "/v1/access/invitations/revoke",
            API_HOSTNAME,
            { communitySlug: "parish", invitationId: INVITATION_ID },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/revoke",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(revokeOk.status).toBe(204);
    });

    it("pin 42 (a): forced failure gives empty 500 without leaking error.message", async () => {
      const fixtureEmail = "leak-test@example.test";
      access.createInvitation.mockRejectedValueOnce(
        new Error(`database exploded with address ${fixtureEmail}`),
      );

      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/create").handle(
          request(
            "/v1/access/invitations/create",
            API_HOSTNAME,
            { communitySlug: "parish", email: fixtureEmail, roleKey: "staff" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/create",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("");
      expect(text).not.toContain(fixtureEmail);
      expect(text).not.toContain("database exploded");
    });

    it("pin 42 (b): every invitations list response carries cache-control: no-store", async () => {
      const resOk = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/list").handle(
          request(
            "/v1/access/invitations/list",
            API_HOSTNAME,
            { communitySlug: "parish" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/list",
            surface: "tenant",
            billing: "read",
          },
        ),
      );
      expect(resOk.status).toBe(200);
      expect(resOk.headers.get("cache-control")).toBe("no-store");

      access.holdsPermission.mockResolvedValueOnce(false);
      const resForbidden = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/list").handle(
          request(
            "/v1/access/invitations/list",
            API_HOSTNAME,
            { communitySlug: "parish" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/list",
            surface: "tenant",
            billing: "read",
          },
        ),
      );
      expect(resForbidden.status).toBe(403);
      expect(resForbidden.headers.get("cache-control")).toBe("no-store");

      access.listInvitations.mockRejectedValueOnce(new Error("failure"));
      const res500 = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/list").handle(
          request(
            "/v1/access/invitations/list",
            API_HOSTNAME,
            { communitySlug: "parish" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/list",
            surface: "tenant",
            billing: "read",
          },
        ),
      );
      expect(res500.status).toBe(500);
      expect(res500.headers.get("cache-control")).toBe("no-store");
    });

    it("pin 42 (c): logs contain primitive values only and never contain the address or the token", async () => {
      const fixtureEmail = "sensitive-logger@example.test";
      access.createInvitation.mockRejectedValueOnce(
        new Error(`internal fail with ${fixtureEmail} and token ${validSampleToken}`),
      );

      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/create").handle(
          request(
            "/v1/access/invitations/create",
            API_HOSTNAME,
            { communitySlug: "parish", email: fixtureEmail, roleKey: "staff" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/create",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(res.status).toBe(500);
      expect(logCalls.length).toBeGreaterThan(0);

      for (const call of logCalls) {
        if (call.fields) {
          for (const val of Object.values(call.fields)) {
            const isPrimitive =
              typeof val === "string" ||
              typeof val === "number" ||
              typeof val === "boolean" ||
              val === null ||
              val === undefined;
            expect(isPrimitive).toBe(true);
          }
        }
        const rendered = util.inspect(call, { depth: null });
        expect(rendered).not.toContain(fixtureEmail);
        expect(rendered).not.toContain(validSampleToken);
      }
    });

    it("pin 51: compensation calls closeInvitationEmail once when createInvitation throws after addresses.create", async () => {
      access.createInvitation.mockImplementationOnce(async (_tx, addresses, input) => {
        await addresses.create({
          invitationId: input.invitationId,
          communityId: COMMUNITY,
          address: input.address,
          expiresAt: new Date(),
        });
        throw new Error("audit failure");
      });

      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/create").handle(
          request(
            "/v1/access/invitations/create",
            API_HOSTNAME,
            { communitySlug: "parish", email: "user@example.test", roleKey: "staff" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/create",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");
      expect(identity.closeInvitationEmail).toHaveBeenCalledTimes(1);
      expect(identity.closeInvitationEmail).toHaveBeenCalledWith(expect.anything(), INVITATION_ID);
    });

    it("pin L5 (i): accept route commits fake transaction on invitation_void giving 409", async () => {
      access.acceptInvitation.mockRejectedValueOnce(new access.AccessError("invitation_void"));

      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/invitations/accept").handle(
          request(
            "/v1/invitations/accept",
            API_HOSTNAME,
            { token: validSampleToken },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/invitations/accept",
            surface: "tenant",
            billing: "exempt",
          },
        ),
      );
      expect(res.status).toBe(409);
      expect(accessErrorBody.parse(await res.json())).toEqual({ error: "invitation_void" });
      expect(lastTx().committed).toBe(true);
      expect(lastTx().rolledBack).toBe(false);
    });

    it("pin L5 (ii): create route rolls back fake transaction on already_invited giving 409", async () => {
      access.createInvitation.mockRejectedValueOnce(new access.AccessError("already_invited"));

      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/create").handle(
          request(
            "/v1/access/invitations/create",
            API_HOSTNAME,
            { communitySlug: "parish", email: "user@example.test", roleKey: "staff" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/create",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(res.status).toBe(409);
      expect(accessErrorBody.parse(await res.json())).toEqual({ error: "already_invited" });
      expect(lastTx().rolledBack).toBe(true);
      expect(lastTx().committed).toBe(false);
    });
  });

  describe("Handler flows and edge cases", () => {
    it("create: success returns 201 with invitationId and sends email", async () => {
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/create").handle(
          request(
            "/v1/access/invitations/create",
            API_HOSTNAME,
            { communitySlug: "parish", email: "new-user@example.test", roleKey: "staff" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/create",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(res.status).toBe(201);
      const data = createInvitationResponse.parse(await res.json());
      expect(data.invitationId).toBe(INVITATION_ID);
      expect(mail.send).toHaveBeenCalledWith({
        to: "new-user@example.test",
        communitySlug: "parish",
        link: `${ADMIN_ORIGIN}/#invite=${validSampleToken}`,
        expiresAt: expect.any(Date),
      });
    });

    it("create: mail failure calls deleteInvitationAfterMailFailure and returns empty 503", async () => {
      mail.send = vi.fn(async () => {
        throw new Error("SES send rejected");
      });
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/create").handle(
          request(
            "/v1/access/invitations/create",
            API_HOSTNAME,
            { communitySlug: "parish", email: "new-user@example.test", roleKey: "staff" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/create",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("");
      expect(access.deleteInvitationAfterMailFailure).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        {
          invitationId: INVITATION_ID,
          actorUserId: USER,
          now: expect.any(Date),
        },
      );
    });

    it("resend: success returns 204 and sends email", async () => {
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/resend").handle(
          request(
            "/v1/access/invitations/resend",
            API_HOSTNAME,
            { communitySlug: "parish", invitationId: INVITATION_ID },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/resend",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(res.status).toBe(204);
      expect(identity.openInvitationEmails).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        [INVITATION_ID],
      );
      expect(mail.send).toHaveBeenCalledWith({
        to: "invitee@example.test",
        communitySlug: "parish",
        link: `${ADMIN_ORIGIN}/#invite=${validSampleToken}`,
        expiresAt: expect.any(Date),
      });
    });

    it("resend: mail failure calls voidInvitationAfterMailFailure and returns empty 503", async () => {
      mail.send = vi.fn(async () => {
        throw new Error("SES send rejected");
      });
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/resend").handle(
          request(
            "/v1/access/invitations/resend",
            API_HOSTNAME,
            { communitySlug: "parish", invitationId: INVITATION_ID },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/resend",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("");
      expect(access.voidInvitationAfterMailFailure).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        {
          invitationId: INVITATION_ID,
          actorUserId: USER,
          now: expect.any(Date),
        },
      );
    });

    it("revoke: success returns 204 and sends no email", async () => {
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/revoke").handle(
          request(
            "/v1/access/invitations/revoke",
            API_HOSTNAME,
            { communitySlug: "parish", invitationId: INVITATION_ID },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/revoke",
            surface: "tenant",
            billing: "write",
          },
        ),
      );
      expect(res.status).toBe(204);
      expect(access.revokeInvitation).toHaveBeenCalled();
      expect(mail.send).not.toHaveBeenCalled();
    });

    it("list: success returns 200 with formatted invitations", async () => {
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/access/invitations/list").handle(
          request(
            "/v1/access/invitations/list",
            API_HOSTNAME,
            { communitySlug: "parish" },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/access/invitations/list",
            surface: "tenant",
            billing: "read",
          },
        ),
      );
      expect(res.status).toBe(200);
      const data = listInvitationsResponse.parse(await res.json());
      expect(data.invitations).toHaveLength(1);
      expect(data.invitations[0]?.email).toBe("invitee@example.test");
      expect(data.invitations[0]?.expiresAt).toBe("2026-11-22T00:00:00.000Z");
    });

    it("accept: success returns 200 with communitySlug", async () => {
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/invitations/accept").handle(
          request(
            "/v1/invitations/accept",
            API_HOSTNAME,
            { token: validSampleToken },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/invitations/accept",
            surface: "tenant",
            billing: "exempt",
          },
        ),
      );
      expect(res.status).toBe(200);
      const data = acceptInvitationResponse.parse(await res.json());
      expect(data.communitySlug).toBe("parish");
      expect(access.acceptInvitation).toHaveBeenCalled();
    });

    it("accept: billing read-only returns empty 402", async () => {
      billing.assertWritable.mockRejectedValueOnce(new BillingReadOnly("read_only"));
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/invitations/accept").handle(
          request(
            "/v1/invitations/accept",
            API_HOSTNAME,
            { token: validSampleToken },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/invitations/accept",
            surface: "tenant",
            billing: "exempt",
          },
        ),
      );
      expect(res.status).toBe(402);
      expect(await res.text()).toBe("");
      expect(access.acceptInvitation).not.toHaveBeenCalled();
    });

    it("accept: wrong_address returns 403 with json error", async () => {
      access.acceptInvitation.mockRejectedValueOnce(new access.AccessError("wrong_address"));
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        route("/v1/invitations/accept").handle(
          request(
            "/v1/invitations/accept",
            API_HOSTNAME,
            { token: validSampleToken },
            `Bearer ${TOKEN}`,
          ),
          {
            method: "POST",
            pattern: "/v1/invitations/accept",
            surface: "tenant",
            billing: "exempt",
          },
        ),
      );
      expect(res.status).toBe(403);
      expect(accessErrorBody.parse(await res.json())).toEqual({ error: "wrong_address" });
    });
  });
});
