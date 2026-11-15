import { getRequestContext } from "@community-hub/kernel";
import { newId, withAppTransaction, type AppTransaction } from "@community-hub/db";
import {
  acceptInvitation,
  AccessError,
  createInvitation,
  deleteInvitationAfterMailFailure,
  holdsPermission,
  listInvitations,
  parseInvitationToken,
  proveInvitation,
  resendInvitation,
  revokeInvitation,
  rejectingInvitationMail,
  voidInvitationAfterMailFailure,
  type InvitationAddresses,
  type InvitationMail,
} from "@community-hub/access";
import { IdentityError, readSession } from "@community-hub/identity";
import { findCommunityById, findCommunityBySlug } from "@community-hub/tenancy";
import { assertWritable, BillingReadOnly } from "@community-hub/billing";
import {
  acceptInvitationBody,
  createInvitationBody,
  invitationActionBody,
  listInvitationsBody,
  type AccessErrorJsonCode,
} from "@community-hub/contracts/access";

import type { Checkout } from "./checkout.js";
import type { GateRoute, RouteContext } from "./gate.js";
import type { BillingLogFields } from "./index.js";
import { guardWrite } from "./billing-guard.js";
import { identityInvitationAddresses } from "./invitation-addresses.js";

type Scope = { orgId: string; communityId: string };

type InvitationSql = Parameters<typeof readSession>[0];

export type InvitationRouteDeps = {
  checkout: Checkout<InvitationSql>;
  kms: Parameters<typeof readSession>[1];
  keyArn: string;
  now: () => Date;
  apiHostname: string;
  adminOrigin?: string | undefined;
  mail: InvitationMail;
  log: (message: string, fields: Record<string, unknown>) => void;
  guardLog: (message: string, fields: BillingLogFields) => void;
};

function empty(status: number): Response {
  return new Response(null, { status });
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

function jsonError(status: number, code: AccessErrorJsonCode): Response {
  return Response.json({ error: code }, { status });
}

const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function errorClassFor(error: unknown): string {
  if (error instanceof Error) {
    const name: unknown = error.name;
    return typeof name === "string" && ERROR_CLASS.test(name) ? name : "Error";
  }
  return "NonError";
}

function presentedHostname(request: Request): string | undefined {
  const raw = request.headers.get("x-community-hub-hostname");
  if (raw === null || raw === "") {
    return undefined;
  }
  return raw.toLowerCase();
}

function jsonMediaType(request: Request): boolean {
  const raw = request.headers.get("content-type");
  if (raw === null) {
    return false;
  }
  return raw.split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function parse<T>(
  request: Request,
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
): Promise<T | undefined> {
  if (!jsonMediaType(request)) {
    return undefined;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

export function invitationStatus(error: AccessError): Response | undefined {
  if (error.code === "forbidden") {
    return empty(403);
  }
  if (error.code === "wrong_address") {
    return jsonError(403, "wrong_address");
  }
  if (
    error.code === "role_not_found" ||
    error.code === "person_not_found" ||
    error.code === "invitation_invalid" ||
    error.code === "invitation_not_found"
  ) {
    return jsonError(404, error.code);
  }
  if (
    error.code === "already_invited" ||
    error.code === "too_many" ||
    error.code === "person_linked" ||
    error.code === "invitation_void"
  ) {
    return jsonError(409, error.code);
  }
  if (error.code === "person_minor") {
    return jsonError(422, "person_minor");
  }
  return undefined;
}

const COMMIT_ON_ERRORS = new Set(["forbidden", "invitation_void"]);

export function invitationRoutes(deps: InvitationRouteDeps): GateRoute[] {
  function foreignHost(request: Request): Response | undefined {
    if (presentedHostname(request) !== deps.apiHostname.toLowerCase()) {
      return empty(404);
    }
    return undefined;
  }

  async function sessionUser(request: Request): Promise<{ userId: string } | Response> {
    const token = bearer(request);
    if (token === undefined) {
      return empty(401);
    }
    const session = await deps.checkout("identity", (sql) =>
      readSession(sql, deps.kms, deps.keyArn, {
        accessToken: token,
        now: deps.now(),
      }),
    );
    if (session === null) {
      return empty(401);
    }
    return { userId: session.userId };
  }

  async function communityScope(
    slug: string,
    context: RouteContext,
    userId: string,
  ): Promise<Scope | Response | null> {
    const found = await deps.checkout("platform", (sql) => findCommunityBySlug(sql, slug));
    if (found === null) {
      return null;
    }
    const scope = { orgId: found.organisationId, communityId: found.id };
    const blocked = await guardWrite(
      {
        checkout: deps.checkout,
        now: deps.now,
        guardLog: deps.guardLog,
      },
      scope,
      userId,
      context,
    );
    if (blocked !== null) {
      return blocked;
    }
    return scope;
  }

  function isMailConfigured(): boolean {
    return (
      deps.adminOrigin !== undefined &&
      deps.mail !== undefined &&
      deps.mail !== rejectingInvitationMail
    );
  }

  async function checkActorPermissions(
    scope: Scope,
    userId: string,
    permissions: string[],
  ): Promise<boolean> {
    return deps.checkout("app", (sql) =>
      withAppTransaction(sql, scope, async (tx) => {
        for (const perm of permissions) {
          const has = await holdsPermission(tx, userId, perm);
          if (!has) {
            return false;
          }
        }
        return true;
      }),
    );
  }

  async function transactInvitation<T>(
    scope: Scope,
    run: (tx: AppTransaction) => Promise<T>,
  ): Promise<T | AccessError> {
    let committedError: AccessError | undefined;
    try {
      const result = await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          try {
            return await run(tx);
          } catch (error) {
            if (error instanceof AccessError && COMMIT_ON_ERRORS.has(error.code)) {
              committedError = error;
              return undefined as unknown as T;
            }
            throw error;
          }
        }),
      );
      if (committedError !== undefined) {
        return committedError;
      }
      return result;
    } catch (error) {
      if (error instanceof AccessError) {
        return error;
      }
      throw error;
    }
  }

  return [
    {
      method: "POST",
      pattern: "/v1/access/invitations/create",
      surface: "tenant",
      billing: "write",
      handle: async (request, context) => {
        let createdInvitationId: string | undefined;
        let addressCreated = false;
        const baseAddresses = identityInvitationAddresses({
          checkout: deps.checkout,
          kms: deps.kms,
          keyArn: deps.keyArn,
        });

        try {
          const hidden = foreignHost(request);
          if (hidden !== undefined) {
            return hidden;
          }

          const body = await parse(request, createInvitationBody);
          if (body === undefined) {
            return empty(400);
          }
          const { communitySlug, email, roleKey, customRoleId, personId } = body;

          const actor = await sessionUser(request);
          if (actor instanceof Response) {
            return actor;
          }

          const scope = await communityScope(communitySlug, context, actor.userId);
          if (scope === null) {
            return empty(403);
          }
          if (scope instanceof Response) {
            return scope;
          }

          const requiredPerms = ["access.users.manage"];
          if (roleKey !== undefined || customRoleId !== undefined) {
            requiredPerms.push("access.roles.manage");
          }
          if (personId !== undefined) {
            requiredPerms.push("people.view");
          }

          const hasPerms = await checkActorPermissions(scope, actor.userId, requiredPerms);
          if (!hasPerms) {
            return empty(403);
          }

          if (!isMailConfigured()) {
            return empty(503);
          }

          createdInvitationId = newId();
          const targetInvitationId = createdInvitationId;

          const addresses: InvitationAddresses = {
            ...baseAddresses,
            async create(input) {
              const res = await baseAddresses.create(input);
              if (res.ok) {
                addressCreated = true;
              }
              return res;
            },
          };

          const outcome = await transactInvitation(scope, (tx) =>
            createInvitation(tx, addresses, {
              invitationId: targetInvitationId,
              actorUserId: actor.userId,
              address: email,
              roleKey: roleKey ?? null,
              customRoleId: customRoleId ?? null,
              personId: personId ?? null,
              now: deps.now(),
            }),
          );

          if (outcome instanceof AccessError) {
            if (addressCreated) {
              try {
                await baseAddresses.close(targetInvitationId);
              } catch (compErr) {
                deps.log("compensation", {
                  route: "invitations.create",
                  errorClass: errorClassFor(compErr),
                  requestId: getRequestContext().requestId,
                });
              }
            }
            return invitationStatus(outcome) ?? empty(500);
          }

          const link = `${deps.adminOrigin}/#invite=${outcome.token}`;
          try {
            await deps.mail.send({
              to: email,
              communitySlug,
              link,
              expiresAt: outcome.expiresAt,
            });
          } catch {
            try {
              await deps.checkout("app", (sql) =>
                withAppTransaction(sql, scope, (tx) =>
                  deleteInvitationAfterMailFailure(tx, baseAddresses, {
                    invitationId: targetInvitationId,
                    actorUserId: actor.userId,
                    now: deps.now(),
                  }),
                ),
              );
            } catch (cleanupErr) {
              deps.log("mail_cleanup", {
                route: "invitations.create",
                errorClass: errorClassFor(cleanupErr),
                requestId: getRequestContext().requestId,
              });
            }
            return empty(503);
          }

          return Response.json({ invitationId: targetInvitationId }, { status: 201 });
        } catch (error) {
          if (addressCreated && createdInvitationId !== undefined) {
            try {
              await baseAddresses.close(createdInvitationId);
            } catch (compErr) {
              deps.log("compensation", {
                route: "invitations.create",
                errorClass: errorClassFor(compErr),
                requestId: getRequestContext().requestId,
              });
            }
          }
          if (error instanceof IdentityError && error.code === "invalid_email") {
            return empty(400);
          }
          if (error instanceof AccessError) {
            const mapped = invitationStatus(error);
            if (mapped !== undefined) {
              return mapped;
            }
          }
          const errorClass = errorClassFor(error);
          deps.log("request", {
            path: new URL(request.url).pathname,
            status: 500,
            requestId: getRequestContext().requestId,
            errorClass,
          });
          return empty(500);
        }
      },
    },
    {
      method: "POST",
      pattern: "/v1/access/invitations/list",
      surface: "tenant",
      billing: "read",
      handle: async (request, context) => {
        try {
          const hidden = foreignHost(request);
          if (hidden !== undefined) {
            return noStore(hidden);
          }

          const body = await parse(request, listInvitationsBody);
          if (body === undefined) {
            return noStore(empty(400));
          }
          const { communitySlug } = body;

          const actor = await sessionUser(request);
          if (actor instanceof Response) {
            return noStore(actor);
          }

          const scope = await communityScope(communitySlug, context, actor.userId);
          if (scope === null) {
            return noStore(empty(403));
          }
          if (scope instanceof Response) {
            return noStore(scope);
          }

          const hasPerms = await checkActorPermissions(scope, actor.userId, [
            "access.users.view",
            "access.roles.view",
          ]);
          if (!hasPerms) {
            return noStore(empty(403));
          }

          const baseAddresses = identityInvitationAddresses({
            checkout: deps.checkout,
            kms: deps.kms,
            keyArn: deps.keyArn,
          });

          const outcome = await transactInvitation(scope, (tx) =>
            listInvitations(tx, baseAddresses, {
              actorUserId: actor.userId,
              now: deps.now(),
            }),
          );

          if (outcome instanceof AccessError) {
            const mapped = invitationStatus(outcome);
            return noStore(mapped ?? empty(500));
          }

          const items = outcome.map((item) => ({
            id: item.id,
            email: item.email,
            roleKey: item.roleKey,
            customRoleId: item.customRoleId,
            linksContact: item.linksContact,
            expiresAt: item.expiresAt.toISOString(),
          }));

          return noStore(Response.json({ invitations: items }));
        } catch (error) {
          if (error instanceof AccessError) {
            const mapped = invitationStatus(error);
            if (mapped !== undefined) {
              return noStore(mapped);
            }
          }
          const errorClass = errorClassFor(error);
          deps.log("request", {
            path: new URL(request.url).pathname,
            status: 500,
            requestId: getRequestContext().requestId,
            errorClass,
          });
          return noStore(empty(500));
        }
      },
    },
    {
      method: "POST",
      pattern: "/v1/access/invitations/resend",
      surface: "tenant",
      billing: "write",
      handle: async (request, context) => {
        try {
          const hidden = foreignHost(request);
          if (hidden !== undefined) {
            return hidden;
          }

          const body = await parse(request, invitationActionBody);
          if (body === undefined) {
            return empty(400);
          }
          const { communitySlug, invitationId } = body;

          const actor = await sessionUser(request);
          if (actor instanceof Response) {
            return actor;
          }

          const scope = await communityScope(communitySlug, context, actor.userId);
          if (scope === null) {
            return empty(403);
          }
          if (scope instanceof Response) {
            return scope;
          }

          const hasPerms = await checkActorPermissions(scope, actor.userId, [
            "access.users.manage",
          ]);
          if (!hasPerms) {
            return empty(403);
          }

          if (!isMailConfigured()) {
            return empty(503);
          }

          const baseAddresses = identityInvitationAddresses({
            checkout: deps.checkout,
            kms: deps.kms,
            keyArn: deps.keyArn,
          });

          const outcome = await transactInvitation(scope, (tx) =>
            resendInvitation(tx, baseAddresses, {
              invitationId,
              actorUserId: actor.userId,
              now: deps.now(),
            }),
          );

          if (outcome instanceof AccessError) {
            return invitationStatus(outcome) ?? empty(500);
          }

          const openMap = await baseAddresses.open([invitationId]);
          const to = openMap.get(invitationId);
          if (to === undefined) {
            try {
              await deps.checkout("app", (sql) =>
                withAppTransaction(sql, scope, (tx) =>
                  voidInvitationAfterMailFailure(tx, baseAddresses, {
                    invitationId,
                    actorUserId: actor.userId,
                    now: deps.now(),
                  }),
                ),
              );
            } catch (cleanupErr) {
              deps.log("mail_cleanup", {
                route: "invitations.resend",
                errorClass: errorClassFor(cleanupErr),
                requestId: getRequestContext().requestId,
              });
            }
            return empty(503);
          }

          const link = `${deps.adminOrigin}/#invite=${outcome.token}`;
          try {
            await deps.mail.send({
              to,
              communitySlug,
              link,
              expiresAt: outcome.expiresAt,
            });
          } catch {
            try {
              await deps.checkout("app", (sql) =>
                withAppTransaction(sql, scope, (tx) =>
                  voidInvitationAfterMailFailure(tx, baseAddresses, {
                    invitationId,
                    actorUserId: actor.userId,
                    now: deps.now(),
                  }),
                ),
              );
            } catch (cleanupErr) {
              deps.log("mail_cleanup", {
                route: "invitations.resend",
                errorClass: errorClassFor(cleanupErr),
                requestId: getRequestContext().requestId,
              });
            }
            return empty(503);
          }

          return empty(204);
        } catch (error) {
          if (error instanceof AccessError) {
            const mapped = invitationStatus(error);
            if (mapped !== undefined) {
              return mapped;
            }
          }
          const errorClass = errorClassFor(error);
          deps.log("request", {
            path: new URL(request.url).pathname,
            status: 500,
            requestId: getRequestContext().requestId,
            errorClass,
          });
          return empty(500);
        }
      },
    },
    {
      method: "POST",
      pattern: "/v1/access/invitations/revoke",
      surface: "tenant",
      billing: "write",
      handle: async (request, context) => {
        try {
          const hidden = foreignHost(request);
          if (hidden !== undefined) {
            return hidden;
          }

          const body = await parse(request, invitationActionBody);
          if (body === undefined) {
            return empty(400);
          }
          const { communitySlug, invitationId } = body;

          const actor = await sessionUser(request);
          if (actor instanceof Response) {
            return actor;
          }

          const scope = await communityScope(communitySlug, context, actor.userId);
          if (scope === null) {
            return empty(403);
          }
          if (scope instanceof Response) {
            return scope;
          }

          const hasPerms = await checkActorPermissions(scope, actor.userId, [
            "access.users.manage",
          ]);
          if (!hasPerms) {
            return empty(403);
          }

          const baseAddresses = identityInvitationAddresses({
            checkout: deps.checkout,
            kms: deps.kms,
            keyArn: deps.keyArn,
          });

          const outcome = await transactInvitation(scope, (tx) =>
            revokeInvitation(tx, baseAddresses, {
              invitationId,
              actorUserId: actor.userId,
              now: deps.now(),
            }),
          );

          if (outcome instanceof AccessError) {
            return invitationStatus(outcome) ?? empty(500);
          }

          return empty(204);
        } catch (error) {
          if (error instanceof AccessError) {
            const mapped = invitationStatus(error);
            if (mapped !== undefined) {
              return mapped;
            }
          }
          const errorClass = errorClassFor(error);
          deps.log("request", {
            path: new URL(request.url).pathname,
            status: 500,
            requestId: getRequestContext().requestId,
            errorClass,
          });
          return empty(500);
        }
      },
    },
    {
      method: "POST",
      pattern: "/v1/invitations/accept",
      surface: "tenant",
      billing: "exempt",
      handle: async (request) => {
        try {
          const hidden = foreignHost(request);
          if (hidden !== undefined) {
            return hidden;
          }

          const body = await parse(request, acceptInvitationBody);
          if (body === undefined) {
            return empty(400);
          }
          const { token } = body;

          const actor = await sessionUser(request);
          if (actor instanceof Response) {
            return actor;
          }

          const parsed = parseInvitationToken(token);
          if (parsed === "invalid") {
            return jsonError(404, "invitation_invalid");
          }

          const scope = { orgId: parsed.orgId, communityId: parsed.communityId };

          const proved = await deps.checkout("app", (sql) =>
            withAppTransaction(sql, scope, async (tx) => {
              return proveInvitation(tx, { token, now: deps.now() });
            }),
          );

          if (proved !== "ok") {
            return jsonError(404, "invitation_invalid");
          }

          const community = await deps.checkout("platform", (sql) =>
            findCommunityById(sql, {
              organisationId: parsed.orgId,
              communityId: parsed.communityId,
            }),
          );

          if (community === null) {
            return jsonError(404, "invitation_invalid");
          }

          try {
            await deps.checkout("platform", (sql) => assertWritable(sql, parsed.orgId, deps.now()));
          } catch (billingErr) {
            if (
              billingErr instanceof BillingReadOnly ||
              (billingErr instanceof Error && billingErr.name === "BillingReadOnly")
            ) {
              return empty(402);
            }
            throw billingErr;
          }

          const baseAddresses = identityInvitationAddresses({
            checkout: deps.checkout,
            kms: deps.kms,
            keyArn: deps.keyArn,
          });

          const outcome = await transactInvitation(scope, (tx) =>
            acceptInvitation(tx, baseAddresses, {
              token,
              userId: actor.userId,
              now: deps.now(),
            }),
          );

          if (outcome instanceof AccessError) {
            return invitationStatus(outcome) ?? empty(500);
          }

          return Response.json({ communitySlug: community.slug });
        } catch (error) {
          if (error instanceof AccessError) {
            const mapped = invitationStatus(error);
            if (mapped !== undefined) {
              return mapped;
            }
          }
          const errorClass = errorClassFor(error);
          deps.log("request", {
            path: new URL(request.url).pathname,
            status: 500,
            requestId: getRequestContext().requestId,
            errorClass,
          });
          return empty(500);
        }
      },
    },
  ];
}
