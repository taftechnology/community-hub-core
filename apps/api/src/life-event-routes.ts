import { holdsPermission } from "@community-hub/access";
import {
  createLifeEventBody,
  listLifeEventsBody,
  updateLifeEventBody,
} from "@community-hub/contracts/life-events";
import { appendAuditEvent, withAppTransaction } from "@community-hub/db";
import { readSession } from "@community-hub/identity";
import { getRequestContext } from "@community-hub/kernel";
import {
  createLifeEvent,
  listLifeEvents,
  PeopleError,
  updateLifeEvent,
} from "@community-hub/people";
import { findCommunityBySlug } from "@community-hub/tenancy";

import { guardWrite } from "./billing-guard.js";
import type { Checkout } from "./checkout.js";
import { guardEntitlement } from "./entitlement-guard.js";
import type { GateRoute, RouteContext } from "./gate.js";
import type { BillingLogFields } from "./index.js";
import { empty, statusForPeople } from "./people-routes.js";

type LifeEventSql = Parameters<typeof readSession>[0];

const DENIED = "people.permission.denied";
const MANAGE = "people.manage";
const RESTRICTED = "people.restricted.read";
const HOUSEHOLDS_ENTITLEMENT = "people.households";

type Scope = { orgId: string; communityId: string };

export type LifeEventLog = (message: string, fields?: Record<string, unknown>) => void;

export type LifeEventDeps = {
  checkout: Checkout<LifeEventSql>;
  kms: Parameters<typeof readSession>[1];
  keyArn: string;
  now: () => Date;
  apiHostname: string;
  log: LifeEventLog;
  guardLog: (message: string, fields: BillingLogFields) => void;
};

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

export function lifeEventRoutes(deps: LifeEventDeps): GateRoute[] {
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
    const prep = await prepare(request, context, listLifeEventsBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    try {
      return await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          const allowed = await holdsPermission(tx, actor.userId, RESTRICTED);
          if (!allowed) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: DENIED,
              purpose: DENIED,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          const result = await listLifeEvents(tx, deps.kms, deps.keyArn, {
            personId: body.personId,
            actorUserId: actor.userId,
          });
          return finish(request, Response.json(result));
        }),
      );
    } catch (error) {
      if (error instanceof PeopleError) {
        const mapped = statusForPeople(error);
        if (mapped !== undefined) {
          return finish(request, mapped);
        }
      }
      return finish(request, empty(500));
    }
  }

  async function create(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, createLifeEventBody);
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
              purpose: DENIED,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          const result = await createLifeEvent(tx, deps.kms, deps.keyArn, {
            personId: body.personId,
            type: body.type,
            date: body.date,
            place: body.place ?? null,
            notes: body.notes ?? null,
            actorUserId: actor.userId,
            now: deps.now(),
          });
          return finish(request, Response.json(result, { status: 201 }));
        }),
      );
    } catch (error) {
      if (error instanceof PeopleError) {
        const mapped = statusForPeople(error);
        if (mapped !== undefined) {
          return finish(request, mapped);
        }
      }
      return finish(request, empty(500));
    }
  }

  async function update(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, updateLifeEventBody);
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
              purpose: DENIED,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          const result = await updateLifeEvent(tx, deps.kms, deps.keyArn, {
            eventId: body.eventId,
            version: body.version,
            type: body.type,
            date: body.date,
            place: body.place ?? null,
            notes: body.notes ?? null,
            actorUserId: actor.userId,
            now: deps.now(),
          });
          return finish(request, Response.json(result));
        }),
      );
    } catch (error) {
      if (error instanceof PeopleError) {
        const mapped = statusForPeople(error);
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
      pattern: "/v1/people/life-events/list",
      surface: "tenant",
      billing: "read",
      handle: (request, context) => list(request, context),
    },
    {
      method: "POST",
      pattern: "/v1/people/life-events/create",
      surface: "tenant",
      billing: "write",
      handle: (request, context) => create(request, context),
    },
    {
      method: "POST",
      pattern: "/v1/people/life-events/update",
      surface: "tenant",
      billing: "write",
      handle: (request, context) => update(request, context),
    },
  ];
}
