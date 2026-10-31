import {
  AccessError,
  holdsAnyGrant,
  holdsPermission,
  readPersonForActor,
} from "@community-hub/access";
import {
  createPersonBody,
  listPeopleBody,
  peopleAccessBody,
  readPersonBody,
  updatePersonBody,
} from "@community-hub/contracts/people";
import { appendAuditEvent, withAppTransaction } from "@community-hub/db";
import { readSession } from "@community-hub/identity";
import { getRequestContext } from "@community-hub/kernel";
import {
  createPerson,
  listPersons,
  PeopleError,
  updatePerson,
  type UpdatePersonChanges,
} from "@community-hub/people";
import { findCommunityBySlug } from "@community-hub/tenancy";

import { guardWrite } from "./billing-guard.js";
import type { Checkout } from "./checkout.js";
import { checkEntitlement, guardEntitlement } from "./entitlement-guard.js";
import type { GateRoute, RouteContext } from "./gate.js";
import type { BillingLogFields } from "./index.js";

type PeopleSql = Parameters<typeof readSession>[0];

const DENIED = "people.permission.denied";
const VIEW = "people.view";
const MANAGE = "people.manage";
const RESTRICTED = "people.restricted.read";
const ADULT_VIEW_PURPOSE = "people.person.view";
const DIRECTORY_ENTITLEMENT = "people.directory";

type Scope = { orgId: string; communityId: string };

export type PeopleLog = (message: string, fields?: Record<string, unknown>) => void;

export type PeopleDeps = {
  checkout: Checkout<PeopleSql>;
  kms: Parameters<typeof readSession>[1];
  keyArn: string;
  now: () => Date;
  apiHostname: string;
  log: PeopleLog;
  guardLog: (message: string, fields: BillingLogFields) => void;
};

function empty(status: number): Response {
  return new Response(null, { status });
}

function statusForPeople(error: PeopleError): Response | undefined {
  if (
    error.code === "duplicate_email" ||
    error.code === "duplicate_phone" ||
    error.code === "conflict"
  ) {
    return empty(409);
  }
  if (error.code === "not_found") {
    return empty(404);
  }
  if (
    error.code === "invalid_date" ||
    error.code === "invalid_declaration" ||
    error.code === "invalid_name" ||
    error.code === "invalid_email" ||
    error.code === "invalid_phone" ||
    error.code === "invalid_input" ||
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

export function peopleRoutes(deps: PeopleDeps): GateRoute[] {
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
      DIRECTORY_ENTITLEMENT,
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
    const prep = await prepare(request, context, listPeopleBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    return deps.checkout("app", (sql) =>
      withAppTransaction(sql, scope, async (tx) => {
        try {
          const isMinorsMode = body.kind === "minors";
          if (isMinorsMode) {
            const allowed = await holdsPermission(tx, actor.userId, RESTRICTED);
            if (!allowed) {
              await appendAuditEvent(tx, {
                actorKind: "user",
                actorId: actor.userId,
                action: DENIED,
                purpose: RESTRICTED,
                targetIds: [scope.orgId, scope.communityId],
              });
              return finish(request, empty(403));
            }
            const result = await listPersons(tx, deps.kms, deps.keyArn, {
              kind: "minors",
              cursor: body.cursor ?? null,
              ...(body.limit !== undefined ? { limit: body.limit } : {}),
              includeRestricted: true,
              actorUserId: actor.userId,
            });
            return finish(request, Response.json(result));
          }

          const allowed = await holdsPermission(tx, actor.userId, VIEW);
          if (!allowed) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: DENIED,
              purpose: ADULT_VIEW_PURPOSE,
              targetIds: [scope.orgId, scope.communityId],
            });
            return finish(request, empty(403));
          }

          const result = await listPersons(tx, deps.kms, deps.keyArn, {
            kind: "adults",
            search: body.search ?? null,
            cursor: body.cursor ?? null,
            ...(body.limit !== undefined ? { limit: body.limit } : {}),
            includeRestricted: false,
            actorUserId: actor.userId,
          });
          return finish(request, Response.json(result));
        } catch (error) {
          if (error instanceof PeopleError) {
            const mapped = statusForPeople(error);
            if (mapped !== undefined) {
              return finish(request, mapped);
            }
          }
          throw error;
        }
      }),
    );
  }

  async function read(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, readPersonBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    return deps.checkout("app", (sql) =>
      withAppTransaction(sql, scope, async (tx) => {
        const canView = await holdsPermission(tx, actor.userId, VIEW);
        const canRestricted = await holdsPermission(tx, actor.userId, RESTRICTED);
        if (!canView && !canRestricted) {
          await appendAuditEvent(tx, {
            actorKind: "user",
            actorId: actor.userId,
            action: DENIED,
            purpose: ADULT_VIEW_PURPOSE,
            targetIds: [scope.orgId, scope.communityId],
          });
          return finish(request, empty(403));
        }

        try {
          const person = await readPersonForActor(tx, deps.kms, deps.keyArn, {
            personId: body.personId,
            actorUserId: actor.userId,
          });
          return finish(request, Response.json(person));
        } catch (error) {
          if (error instanceof AccessError && error.code === "forbidden") {
            return finish(request, empty(404));
          }
          if (error instanceof AccessError && error.code === "not_found") {
            return finish(request, empty(404));
          }
          throw error;
        }
      }),
    );
  }

  async function create(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, createPersonBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    return deps.checkout("app", (sql) =>
      withAppTransaction(sql, scope, async (tx) => {
        const allowed = await holdsPermission(tx, actor.userId, MANAGE);
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

        try {
          const result = await createPerson(tx, deps.kms, deps.keyArn, {
            now: deps.now(),
            declaredAdult: true,
            householdId: null,
            dateOfBirth: body.dateOfBirth ?? null,
            givenName: body.givenName,
            familyName: body.familyName,
            email: body.email ?? null,
            phone: body.phone ?? null,
            actorUserId: actor.userId,
          });
          return finish(request, Response.json({ personId: result.personId }, { status: 201 }));
        } catch (error) {
          if (error instanceof PeopleError) {
            const mapped = statusForPeople(error);
            if (mapped !== undefined) {
              return finish(request, mapped);
            }
          }
          throw error;
        }
      }),
    );
  }

  async function update(request: Request, context: RouteContext): Promise<Response> {
    const prep = await prepare(request, context, updatePersonBody);
    if (!prep.ok) {
      return prep.response;
    }
    const { body, actor, scope } = prep;

    return deps.checkout("app", (sql) =>
      withAppTransaction(sql, scope, async (tx) => {
        const allowed = await holdsPermission(tx, actor.userId, MANAGE);
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

        const changes: UpdatePersonChanges = {};
        if (body.givenName !== undefined) {
          changes.givenName = body.givenName;
        }
        if (body.familyName !== undefined) {
          changes.familyName = body.familyName;
        }
        if (body.email !== undefined) {
          changes.email = body.email;
        }
        if (body.phone !== undefined) {
          changes.phone = body.phone;
        }
        if (body.dateOfBirth !== undefined) {
          changes.dateOfBirth = body.dateOfBirth;
        }

        try {
          const result = await updatePerson(tx, deps.kms, deps.keyArn, {
            personId: body.personId,
            version: body.version,
            changes,
            actorUserId: actor.userId,
            now: deps.now(),
          });
          return finish(request, Response.json({ version: result.version }));
        } catch (error) {
          if (error instanceof PeopleError) {
            const mapped = statusForPeople(error);
            if (mapped !== undefined) {
              return finish(request, mapped);
            }
          }
          throw error;
        }
      }),
    );
  }

  async function access(request: Request): Promise<Response> {
    const hidden = foreignHost(request);
    if (hidden !== undefined) {
      return finish(request, hidden);
    }
    const body = await parse(request, peopleAccessBody);
    if (body === undefined) {
      return finish(request, empty(400));
    }
    const actor = await sessionUser(request);
    if (actor instanceof Response) {
      return finish(request, actor);
    }
    const found = await deps.checkout("platform", (sql) =>
      findCommunityBySlug(sql, body.communitySlug),
    );
    if (found === null) {
      return finish(request, empty(403));
    }
    const scope = { orgId: found.organisationId, communityId: found.id };

    const perms = await deps.checkout("app", (sql) =>
      withAppTransaction(sql, scope, async (tx) => {
        const hasRole = await holdsAnyGrant(tx, actor.userId);
        if (!hasRole) {
          return null;
        }
        const [canView, canManage, canReadMinors] = await Promise.all([
          holdsPermission(tx, actor.userId, VIEW),
          holdsPermission(tx, actor.userId, MANAGE),
          holdsPermission(tx, actor.userId, RESTRICTED),
        ]);
        return { canView, canManage, canReadMinors };
      }),
    );

    if (perms === null) {
      return finish(request, empty(403));
    }

    const directoryEnabled = await checkEntitlement(
      { checkout: deps.checkout, now: deps.now, guardLog: deps.guardLog },
      scope,
      DIRECTORY_ENTITLEMENT,
    );

    return finish(
      request,
      Response.json({
        directoryEnabled,
        canView: perms.canView,
        canManage: perms.canManage,
        canReadMinors: perms.canReadMinors,
      }),
    );
  }

  return [
    {
      method: "POST",
      pattern: "/v1/people/list",
      surface: "tenant",
      billing: "read",
      handle: list,
    },
    {
      method: "POST",
      pattern: "/v1/people/read",
      surface: "tenant",
      billing: "read",
      handle: read,
    },
    {
      method: "POST",
      pattern: "/v1/people/create",
      surface: "tenant",
      billing: "write",
      handle: create,
    },
    {
      method: "POST",
      pattern: "/v1/people/update",
      surface: "tenant",
      billing: "write",
      handle: update,
    },
    {
      method: "POST",
      pattern: "/v1/people/access",
      surface: "tenant",
      billing: "read",
      handle: access,
    },
  ];
}
