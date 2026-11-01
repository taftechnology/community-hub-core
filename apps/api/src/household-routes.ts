import { holdsPermission } from "@community-hub/access";
import {
  addMinorBody,
  createHouseholdBody,
  linkGuardianBody,
  listHouseholdsBody,
  moveAdultBody,
  readHouseholdBody,
  renameHouseholdBody,
  unlinkGuardianBody,
} from "@community-hub/contracts/households";
import { appendAuditEvent, withAppTransaction } from "@community-hub/db";
import { readSession } from "@community-hub/identity";
import { getRequestContext } from "@community-hub/kernel";
import {
  addMinor,
  createHousehold,
  linkGuardian,
  listHouseholds,
  moveAdult,
  PeopleError,
  readHouseholdDetail,
  renameHousehold,
  unlinkGuardian,
} from "@community-hub/people";
import { findCommunityBySlug } from "@community-hub/tenancy";

import { guardWrite } from "./billing-guard.js";
import type { Checkout } from "./checkout.js";
import { guardEntitlement } from "./entitlement-guard.js";
import type { GateRoute, RouteContext } from "./gate.js";
import type { BillingLogFields } from "./index.js";

type HouseholdSql = Parameters<typeof readSession>[0];

const DENIED = "people.permission.denied";
const VIEW = "people.view";
const MANAGE = "people.manage";
const RESTRICTED = "people.restricted.read";
const HOUSEHOLDS_ENTITLEMENT = "people.households";

type Scope = { orgId: string; communityId: string };

export type HouseholdLog = (message: string, fields?: Record<string, unknown>) => void;

export type HouseholdDeps = {
  checkout: Checkout<HouseholdSql>;
  kms: Parameters<typeof readSession>[1];
  keyArn: string;
  now: () => Date;
  apiHostname: string;
  log: HouseholdLog;
  guardLog: (message: string, fields: BillingLogFields) => void;
};

function empty(status: number): Response {
  return new Response(null, { status });
}

export function statusForHouseholds(error: PeopleError): Response | undefined {
  if (
    error.code === "conflict" ||
    error.code === "duplicate_guardian_link" ||
    error.code === "last_guardian" ||
    error.code === "adult_cannot_move_with_links"
  ) {
    return empty(409);
  }
  if (error.code === "not_found") {
    return empty(404);
  }
  if (
    error.code === "invalid_input" ||
    error.code === "invalid_guardian" ||
    error.code === "minor_not_movable" ||
    error.code === "invalid_date" ||
    error.code === "invalid_name" ||
    error.code === "invalid_declaration" ||
    error.code === "household_required"
  ) {
    return empty(400);
  }
  return undefined;
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
  const raw = request.headers.get("authorization");
  if (raw === null) {
    return undefined;
  }
  const match = /^Bearer (\S+)$/i.exec(raw);
  return match?.[1];
}

export function householdRoutes(deps: HouseholdDeps): GateRoute[] {
  function finish(request: Request, response: Response): Response {
    deps.log("request", {
      path: new URL(request.url).pathname,
      status: response.status,
      requestId: getRequestContext().requestId,
    });
    return response;
  }

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

    const blockedEntitlement = await guardEntitlement(
      { checkout: deps.checkout, now: deps.now, guardLog: deps.guardLog },
      scope,
      HOUSEHOLDS_ENTITLEMENT,
    );
    if (blockedEntitlement !== null) {
      return blockedEntitlement;
    }

    const blockedBilling = await guardWrite(
      {
        checkout: deps.checkout,
        now: deps.now,
        guardLog: deps.guardLog,
      },
      scope,
      userId,
      context,
    );
    if (blockedBilling !== null) {
      return blockedBilling;
    }
    return scope;
  }

  type Prepared<T> =
    | { ok: true; body: T; actor: { userId: string }; scope: Scope }
    | { ok: false; response: Response };

  async function prepare<T extends { communitySlug: string }>(
    request: Request,
    context: RouteContext,
    schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
  ): Promise<Prepared<T>> {
    const hidden = foreignHost(request);
    if (hidden !== undefined) {
      return { ok: false, response: finish(request, hidden) };
    }
    const body = await parse(request, schema);
    if (body === undefined) {
      return { ok: false, response: finish(request, empty(400)) };
    }
    const actor = await sessionUser(request);
    if (actor instanceof Response) {
      return { ok: false, response: finish(request, actor) };
    }
    const scope = await communityScope(body.communitySlug, context, actor.userId);
    if (scope === null) {
      return { ok: false, response: finish(request, empty(403)) };
    }
    if (scope instanceof Response) {
      return { ok: false, response: finish(request, scope) };
    }
    return { ok: true, body, actor, scope };
  }

  async function list(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, listHouseholdsBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    try {
      return await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          const allowed = await holdsPermission(tx, actor.userId, VIEW);
          if (!allowed) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: DENIED,
              purpose: VIEW,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          const includeRestricted = await holdsPermission(tx, actor.userId, RESTRICTED);
          const result = await listHouseholds(tx, deps.kms, deps.keyArn, {
            cursor: body.cursor ?? null,
            ...(body.limit !== undefined ? { limit: body.limit } : {}),
            includeRestricted,
            actorUserId: actor.userId,
          });
          return finish(request, Response.json(result));
        }),
      );
    } catch (error) {
      if (error instanceof PeopleError) {
        const mapped = statusForHouseholds(error);
        if (mapped !== undefined) {
          return finish(request, mapped);
        }
      }
      return finish(request, empty(500));
    }
  }

  async function read(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, readHouseholdBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    try {
      return await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          const [canView, canRestricted] = await Promise.all([
            holdsPermission(tx, actor.userId, VIEW),
            holdsPermission(tx, actor.userId, RESTRICTED),
          ]);
          if (!canView && !canRestricted) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: DENIED,
              purpose: VIEW,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          const includeRestricted = canRestricted;
          const result = await readHouseholdDetail(tx, deps.kms, deps.keyArn, {
            householdId: body.householdId,
            includeRestricted,
            actorUserId: actor.userId,
          });
          if (result === null) {
            return finish(request, empty(404));
          }
          return finish(request, Response.json(result));
        }),
      );
    } catch (error) {
      if (error instanceof PeopleError) {
        const mapped = statusForHouseholds(error);
        if (mapped !== undefined) {
          return finish(request, mapped);
        }
      }
      return finish(request, empty(500));
    }
  }

  async function create(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, createHouseholdBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    try {
      return await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          const allowed = await holdsPermission(tx, actor.userId, MANAGE);
          if (!allowed) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: DENIED,
              purpose: MANAGE,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          const result = await createHousehold(tx, deps.kms, deps.keyArn, {
            now: deps.now(),
            label: body.label ?? null,
            actorUserId: actor.userId,
          });
          return finish(request, Response.json(result, { status: 201 }));
        }),
      );
    } catch (error) {
      if (error instanceof PeopleError) {
        const mapped = statusForHouseholds(error);
        if (mapped !== undefined) {
          return finish(request, mapped);
        }
      }
      return finish(request, empty(500));
    }
  }

  async function rename(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, renameHouseholdBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    try {
      return await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          const [canManage, canRestricted] = await Promise.all([
            holdsPermission(tx, actor.userId, MANAGE),
            holdsPermission(tx, actor.userId, RESTRICTED),
          ]);
          if (!canManage || !canRestricted) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: DENIED,
              purpose: !canManage ? MANAGE : RESTRICTED,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          const result = await renameHousehold(tx, deps.kms, deps.keyArn, {
            householdId: body.householdId,
            version: body.version,
            label: body.label,
            actorUserId: actor.userId,
          });
          return finish(request, Response.json(result));
        }),
      );
    } catch (error) {
      if (error instanceof PeopleError) {
        const mapped = statusForHouseholds(error);
        if (mapped !== undefined) {
          return finish(request, mapped);
        }
      }
      return finish(request, empty(500));
    }
  }

  async function moveAdultMember(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, moveAdultBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    try {
      return await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          const [canManage, canRestricted] = await Promise.all([
            holdsPermission(tx, actor.userId, MANAGE),
            holdsPermission(tx, actor.userId, RESTRICTED),
          ]);
          if (!canManage || !canRestricted) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: DENIED,
              purpose: !canManage ? MANAGE : RESTRICTED,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          const result = await moveAdult(tx, {
            personId: body.personId,
            householdId: body.householdId,
            version: body.version,
            actorUserId: actor.userId,
          });
          return finish(request, Response.json(result));
        }),
      );
    } catch (error) {
      if (error instanceof PeopleError) {
        const mapped = statusForHouseholds(error);
        if (mapped !== undefined) {
          return finish(request, mapped);
        }
      }
      return finish(request, empty(500));
    }
  }

  async function addMinorMember(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, addMinorBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    try {
      return await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          const [canManage, canRestricted] = await Promise.all([
            holdsPermission(tx, actor.userId, MANAGE),
            holdsPermission(tx, actor.userId, RESTRICTED),
          ]);
          if (!canManage || !canRestricted) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: DENIED,
              purpose: !canManage ? MANAGE : RESTRICTED,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          const result = await addMinor(tx, deps.kms, deps.keyArn, {
            now: deps.now(),
            householdId: body.householdId,
            givenName: body.givenName,
            familyName: body.familyName,
            dateOfBirth: body.dateOfBirth,
            guardianId: body.guardianId,
            ...(body.rights !== undefined ? { rights: body.rights } : {}),
            actorUserId: actor.userId,
          });
          return finish(request, Response.json(result, { status: 201 }));
        }),
      );
    } catch (error) {
      if (error instanceof PeopleError) {
        const mapped = statusForHouseholds(error);
        if (mapped !== undefined) {
          return finish(request, mapped);
        }
      }
      return finish(request, empty(500));
    }
  }

  async function linkGuardianHandler(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, linkGuardianBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    try {
      return await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          const [canManage, canRestricted] = await Promise.all([
            holdsPermission(tx, actor.userId, MANAGE),
            holdsPermission(tx, actor.userId, RESTRICTED),
          ]);
          if (!canManage || !canRestricted) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: DENIED,
              purpose: !canManage ? MANAGE : RESTRICTED,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          const rights =
            body.rights !== undefined
              ? {
                  consent: body.rights.consent,
                  pickup: body.rights.pickup,
                  view: body.rights.view,
                  manage: body.rights.manage,
                }
              : {
                  consent: true,
                  pickup: false,
                  view: true,
                  manage: false,
                };

          const result = await linkGuardian(tx, {
            now: deps.now(),
            householdId: body.householdId,
            guardianPersonId: body.guardianId,
            childPersonId: body.childId,
            ...rights,
            actorUserId: actor.userId,
          });
          return finish(request, Response.json(result, { status: 201 }));
        }),
      );
    } catch (error) {
      if (error instanceof PeopleError) {
        const mapped = statusForHouseholds(error);
        if (mapped !== undefined) {
          return finish(request, mapped);
        }
      }
      return finish(request, empty(500));
    }
  }

  async function unlinkGuardianHandler(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, unlinkGuardianBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    try {
      return await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          const [canManage, canRestricted] = await Promise.all([
            holdsPermission(tx, actor.userId, MANAGE),
            holdsPermission(tx, actor.userId, RESTRICTED),
          ]);
          if (!canManage || !canRestricted) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: DENIED,
              purpose: !canManage ? MANAGE : RESTRICTED,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          await unlinkGuardian(tx, {
            now: deps.now(),
            householdId: body.householdId,
            linkId: body.linkId,
            actorUserId: actor.userId,
          });
          return finish(request, Response.json({}));
        }),
      );
    } catch (error) {
      if (error instanceof PeopleError) {
        const mapped = statusForHouseholds(error);
        if (mapped !== undefined) {
          return finish(request, mapped);
        }
      }
      return finish(request, empty(500));
    }
  }

  return [
    {
      method: "POST",
      pattern: "/v1/households/list",
      surface: "tenant",
      billing: "read",
      handle: (request, context) => list(request, context),
    },
    {
      method: "POST",
      pattern: "/v1/households/read",
      surface: "tenant",
      billing: "read",
      handle: (request, context) => read(request, context),
    },
    {
      method: "POST",
      pattern: "/v1/households/create",
      surface: "tenant",
      billing: "write",
      handle: (request, context) => create(request, context),
    },
    {
      method: "POST",
      pattern: "/v1/households/rename",
      surface: "tenant",
      billing: "write",
      handle: (request, context) => rename(request, context),
    },
    {
      method: "POST",
      pattern: "/v1/households/members/move-adult",
      surface: "tenant",
      billing: "write",
      handle: (request, context) => moveAdultMember(request, context),
    },
    {
      method: "POST",
      pattern: "/v1/households/members/add-minor",
      surface: "tenant",
      billing: "write",
      handle: (request, context) => addMinorMember(request, context),
    },
    {
      method: "POST",
      pattern: "/v1/households/guardians/link",
      surface: "tenant",
      billing: "write",
      handle: (request, context) => linkGuardianHandler(request, context),
    },
    {
      method: "POST",
      pattern: "/v1/households/guardians/unlink",
      surface: "tenant",
      billing: "write",
      handle: (request, context) => unlinkGuardianHandler(request, context),
    },
  ];
}
