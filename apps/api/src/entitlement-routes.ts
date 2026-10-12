import { holdsPermission } from "@community-hub/access";
import { listEntitlementsBody, toggleEntitlementBody } from "@community-hub/contracts/entitlements";
import { appendAuditEvent, withAppTransaction } from "@community-hub/db";
import { EntitlementError, readSnapshot, setToggle } from "@community-hub/entitlements";
import { evaluate, type EntitlementSnapshot } from "@community-hub/entitlements-eval";
import { readSession } from "@community-hub/identity";
import { getRequestContext } from "@community-hub/kernel";
import { findCommunityBySlug } from "@community-hub/tenancy";

import type { Checkout } from "./checkout.js";
import type { GateRoute } from "./gate.js";

type EntitlementSql = Parameters<typeof readSession>[0];

const DENIED = "entitlements.permission.denied";
const VIEW = "entitlements.view";
const MANAGE = "entitlements.manage";
const VIEW_PURPOSE = "entitlements.toggles.view";
const MANAGE_PURPOSE = "entitlements.toggles.manage";
const TOGGLED = "entitlements.toggle.changed";

type Scope = { orgId: string; communityId: string };

export type EntitlementLog = (message: string, fields: Record<string, unknown>) => void;

export type EntitlementDeps = {
  checkout: Checkout<EntitlementSql>;
  kms: Parameters<typeof readSession>[1];
  keyArn: string;
  now: () => Date;
  apiHostname: string;
  log: EntitlementLog;
};

function empty(status: number): Response {
  return new Response(null, { status });
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

function listedKeys(snapshot: EntitlementSnapshot, now: Date): { key: string; enabled: boolean }[] {
  const names = new Set<string>();
  for (const row of snapshot.planEntitlements) {
    names.add(row.key);
  }
  for (const row of snapshot.addOnEntitlements) {
    names.add(row.key);
  }
  for (const key of snapshot.allocations) {
    names.add(key);
  }
  for (const row of snapshot.overrides) {
    names.add(row.key);
  }
  for (const row of snapshot.flags) {
    names.add(row.key);
  }
  for (const row of snapshot.toggles) {
    names.add(row.key);
  }
  const open: EntitlementSnapshot = { ...snapshot, toggles: [] };
  return [...names]
    .filter((key) => evaluate(open, key, now).ok)
    .sort()
    .map((key) => {
      const toggle = snapshot.toggles.find((row) => row.key === key);
      return { key, enabled: toggle === undefined || toggle.enabled };
    });
}

export function entitlementRoutes(deps: EntitlementDeps): GateRoute[] {
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

  async function communityScope(slug: string): Promise<Scope | null> {
    const found = await deps.checkout("platform", (sql) => findCommunityBySlug(sql, slug));
    if (found === null) {
      return null;
    }
    return { orgId: found.organisationId, communityId: found.id };
  }

  async function authorise(
    scope: Scope,
    userId: string,
    permission: string,
    purpose: string,
  ): Promise<{ allowed: false } | { allowed: true; canManage: boolean }> {
    return deps.checkout("app", (sql) =>
      withAppTransaction(
        sql,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          const allowed = await holdsPermission(tx, userId, permission);
          if (!allowed) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: userId,
              action: DENIED,
              purpose,
              targetIds: [scope.orgId, scope.communityId],
            });
            return { allowed: false as const };
          }
          const canManage =
            permission === MANAGE ? true : await holdsPermission(tx, userId, MANAGE);
          return { allowed: true as const, canManage };
        },
      ),
    );
  }

  async function list(request: Request): Promise<Response> {
    const hidden = foreignHost(request);
    if (hidden !== undefined) {
      return finish(request, hidden);
    }
    const body = await parse(request, listEntitlementsBody);
    if (body === undefined) {
      return finish(request, empty(400));
    }
    const actor = await sessionUser(request);
    if (actor instanceof Response) {
      return finish(request, actor);
    }
    const scope = await communityScope(body.communitySlug);
    if (scope === null) {
      return finish(request, empty(404));
    }
    const gate = await authorise(scope, actor.userId, VIEW, VIEW_PURPOSE);
    if (!gate.allowed) {
      return finish(request, empty(403));
    }
    const now = deps.now();
    const snapshot = await deps.checkout("platform", (sql) =>
      readSnapshot(sql, {
        organisationId: scope.orgId,
        communityId: scope.communityId,
        now,
      }),
    );
    return finish(
      request,
      Response.json({
        keys: listedKeys(snapshot, now),
        canManage: gate.canManage,
      }),
    );
  }

  async function toggle(request: Request): Promise<Response> {
    const hidden = foreignHost(request);
    if (hidden !== undefined) {
      return finish(request, hidden);
    }
    const body = await parse(request, toggleEntitlementBody);
    if (body === undefined) {
      return finish(request, empty(400));
    }
    const actor = await sessionUser(request);
    if (actor instanceof Response) {
      return finish(request, actor);
    }
    const scope = await communityScope(body.communitySlug);
    if (scope === null) {
      return finish(request, empty(404));
    }
    const gate = await authorise(scope, actor.userId, MANAGE, MANAGE_PURPOSE);
    if (!gate.allowed) {
      return finish(request, empty(403));
    }
    let outcome: "changed" | "unchanged";
    try {
      outcome = await deps.checkout("platform", (sql) =>
        setToggle(sql, {
          organisationId: scope.orgId,
          communityId: scope.communityId,
          key: body.key,
          enabled: body.enabled,
          now: deps.now(),
        }),
      );
    } catch (error) {
      if (
        error instanceof EntitlementError &&
        (error.code === "not_allocated" || error.code === "invalid_key")
      ) {
        return finish(request, empty(400));
      }
      throw error;
    }
    if (outcome === "unchanged") {
      return finish(request, empty(200));
    }
    try {
      await deps.checkout("app", (sql) =>
        withAppTransaction(sql, { orgId: scope.orgId, communityId: scope.communityId }, (tx) =>
          appendAuditEvent(tx, {
            actorKind: "user",
            actorId: actor.userId,
            action: TOGGLED,
            purpose: MANAGE_PURPOSE,
            targetIds: [scope.orgId, scope.communityId],
          }),
        ),
      );
    } catch {
      try {
        await deps.checkout("platform", (sql) =>
          setToggle(sql, {
            organisationId: scope.orgId,
            communityId: scope.communityId,
            key: body.key,
            enabled: !body.enabled,
            now: deps.now(),
          }),
        );
      } catch {
        return finish(request, empty(500));
      }
      return finish(request, empty(500));
    }
    return finish(request, empty(200));
  }

  return [
    {
      method: "POST",
      pattern: "/v1/entitlements/list",
      surface: "tenant",
      handle: list,
    },
    {
      method: "POST",
      pattern: "/v1/entitlements/toggle",
      surface: "tenant",
      handle: toggle,
    },
  ];
}
