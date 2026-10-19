import { holdsAnyGrant, holdsPermission } from "@community-hub/access";
import { checkoutBody, portalBody, statusBody, plansBody } from "@community-hub/contracts/billing";
import { appendAuditEvent, withAppTransaction } from "@community-hub/db";
import {
  BillingUnavailable,
  checkoutDecision,
  currentSettings,
  deriveState,
  readAccount,
  trialDaysFor,
  type StripeBilling,
} from "@community-hub/billing";
import {
  currentPlan,
  listCheckoutPlans,
  planBilling,
  planByLookupKey,
} from "@community-hub/entitlements";
import { readSession } from "@community-hub/identity";
import { getRequestContext } from "@community-hub/kernel";
import { findCommunityBySlug, listCommunityIds } from "@community-hub/tenancy";

import type { Checkout } from "./checkout.js";
import { presentedHostname, type GateRoute, type RouteContext } from "./gate.js";
import type { BillingLogFields } from "./index.js";
import { guardWrite } from "./billing-guard.js";

const DENIED = "billing.permission.denied";
const VIEW = "billing.view";
const MANAGE = "billing.manage";

type Scope = { orgId: string; communityId: string };

type BillingSql = Parameters<typeof readSession>[0];

function asSql(sql: unknown): BillingSql {
  return sql as BillingSql;
}

export type BillingRouteLog = (message: string, fields?: Record<string, unknown>) => void;

export type BillingRoutesDeps = {
  readonly checkout: Checkout<unknown>;
  readonly kms: Parameters<typeof readSession>[1];
  readonly keyArn: string;
  readonly now: () => Date;
  readonly apiHostname: string;
  readonly adminOrigin?: string | undefined;
  readonly port: StripeBilling;
  readonly log: BillingRouteLog;
  readonly guardLog: (message: string, fields: BillingLogFields) => void;
};

function empty(status: number): Response {
  return new Response(null, { status });
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

export function billingRoutes(deps: BillingRoutesDeps): GateRoute[] {
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
      readSession(asSql(sql), deps.kms, deps.keyArn, {
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
    const found = await deps.checkout("platform", (sql) => findCommunityBySlug(asSql(sql), slug));
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

  async function authorise(
    scope: Scope,
    userId: string,
    permission: "billing.manage",
  ): Promise<boolean> {
    return deps.checkout("app", (sql) =>
      withAppTransaction(
        asSql(sql),
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          const allowed = await holdsPermission(tx, userId, permission);
          if (!allowed) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: userId,
              action: DENIED,
              purpose: DENIED,
              targetIds: [scope.orgId, scope.communityId],
            });
            return false;
          }
          return true;
        },
      ),
    );
  }

  async function handleCheckout(request: Request, context: RouteContext): Promise<Response> {
    const hidden = foreignHost(request);
    if (hidden !== undefined) {
      return finish(request, hidden);
    }
    const body = await parse(request, checkoutBody);
    if (body === undefined) {
      return finish(request, empty(400));
    }
    const actor = await sessionUser(request);
    if (actor instanceof Response) {
      return finish(request, actor);
    }
    const scope = await communityScope(body.communitySlug, context, actor.userId);
    if (scope === null) {
      return finish(request, empty(403));
    }
    if (scope instanceof Response) {
      return finish(request, scope);
    }
    const allowed = await authorise(scope, actor.userId, MANAGE);
    if (!allowed) {
      return finish(request, empty(403));
    }

    try {
      const account = await deps.checkout("platform", (sql) =>
        readAccount(asSql(sql), scope.orgId),
      );
      const decision = checkoutDecision(account);
      if (decision === "conflict") {
        return finish(request, empty(409));
      }

      const planInfo = await deps.checkout("platform", (sql) =>
        planBilling(asSql(sql), body.planKey),
      );
      if (planInfo === null || planInfo.stripeLookupKey === null) {
        return finish(request, empty(422));
      }

      const settings = await deps.checkout("platform", (sql) => currentSettings(asSql(sql)));
      if (settings === null || settings.stripeTaxRateId === null) {
        return finish(request, empty(503));
      }

      const price = await deps.port.findPriceByLookupKey(planInfo.stripeLookupKey);
      if (price === null) {
        deps.log("billing", {
          errorCode: "BILLING_UNKNOWN_PRICE",
        });
        return finish(request, empty(503));
      }

      const communityIds = await deps.checkout("platform", (sql) =>
        listCommunityIds(asSql(sql), scope.orgId),
      );
      const quantity = communityIds.length;

      const trialDays = trialDaysFor(planInfo, account, settings);

      if (deps.adminOrigin === undefined) {
        return finish(request, empty(503));
      }
      const adminBase = deps.adminOrigin.replace(/\/+$/, "");
      const requestId = getRequestContext().requestId;
      const idempotencyKey = `checkout:${scope.orgId}:${requestId}`;

      const session = await deps.port.createCheckoutSession({
        priceId: price.id,
        quantity,
        taxRateId: settings.stripeTaxRateId,
        ...(trialDays !== undefined ? { trialDays } : {}),
        ...(account?.stripeCustomerId ? { customerId: account.stripeCustomerId } : {}),
        organisationId: scope.orgId,
        successUrl: `${adminBase}/?billing=done`,
        cancelUrl: `${adminBase}/?billing=cancelled`,
        idempotencyKey,
      });

      return finish(request, Response.json({ url: session.url }));
    } catch (error) {
      if (error instanceof BillingUnavailable) {
        return finish(request, empty(503));
      }
      throw error;
    }
  }

  async function handlePortal(request: Request, context: RouteContext): Promise<Response> {
    const hidden = foreignHost(request);
    if (hidden !== undefined) {
      return finish(request, hidden);
    }
    const body = await parse(request, portalBody);
    if (body === undefined) {
      return finish(request, empty(400));
    }
    const actor = await sessionUser(request);
    if (actor instanceof Response) {
      return finish(request, actor);
    }
    const scope = await communityScope(body.communitySlug, context, actor.userId);
    if (scope === null) {
      return finish(request, empty(403));
    }
    if (scope instanceof Response) {
      return finish(request, scope);
    }
    const allowed = await authorise(scope, actor.userId, MANAGE);
    if (!allowed) {
      return finish(request, empty(403));
    }

    try {
      const account = await deps.checkout("platform", (sql) =>
        readAccount(asSql(sql), scope.orgId),
      );
      if (account === null || account.stripeCustomerId === null) {
        return finish(request, empty(409));
      }

      if (deps.adminOrigin === undefined) {
        return finish(request, empty(503));
      }
      const adminBase = deps.adminOrigin.replace(/\/+$/, "");
      const requestId = getRequestContext().requestId;
      const idempotencyKey = `portal:${scope.orgId}:${requestId}`;

      const session = await deps.port.createPortalSession({
        customerId: account.stripeCustomerId,
        returnUrl: `${adminBase}/?billing=portal`,
        idempotencyKey,
      });

      return finish(request, Response.json({ url: session.url }));
    } catch (error) {
      if (error instanceof BillingUnavailable) {
        return finish(request, empty(503));
      }
      throw error;
    }
  }

  async function handleStatus(request: Request, context: RouteContext): Promise<Response> {
    const hidden = foreignHost(request);
    if (hidden !== undefined) {
      return finish(request, hidden);
    }
    const body = await parse(request, statusBody);
    if (body === undefined) {
      return finish(request, empty(400));
    }
    const actor = await sessionUser(request);
    if (actor instanceof Response) {
      return finish(request, actor);
    }
    const scope = await communityScope(body.communitySlug, context, actor.userId);
    if (scope === null) {
      return finish(request, empty(403));
    }
    if (scope instanceof Response) {
      return finish(request, scope);
    }

    const auth = await deps.checkout("app", (sql) =>
      withAppTransaction(
        asSql(sql),
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          const canView = await holdsPermission(tx, actor.userId, VIEW);
          const canManage = await holdsPermission(tx, actor.userId, MANAGE);
          if (canView) {
            return { allowed: true, canView, canManage, bannerOnly: false };
          }
          const anyGrant = await holdsAnyGrant(tx, actor.userId);
          if (!anyGrant) {
            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: DENIED,
              purpose: DENIED,
              targetIds: [scope.orgId, scope.communityId],
            });
            return { allowed: false, canView: false, canManage: false, bannerOnly: false };
          }
          return { allowed: true, canView: false, canManage: false, bannerOnly: true };
        },
      ),
    );

    if (!auth.allowed) {
      return finish(request, empty(403));
    }

    const account = await deps.checkout("platform", (sql) => readAccount(asSql(sql), scope.orgId));
    const state = deriveState(account, deps.now());

    if (auth.bannerOnly) {
      return finish(
        request,
        Response.json({
          state,
          trial_end: account?.trialEnd ? account.trialEnd.toISOString() : null,
          grace_until: account?.graceUntil ? account.graceUntil.toISOString() : null,
          canView: auth.canView,
          canManage: auth.canManage,
        }),
      );
    }

    let planKey: string | null = null;
    if (account?.planLookupKey) {
      const byLookup = await deps.checkout("platform", (sql) =>
        planByLookupKey(asSql(sql), account.planLookupKey!),
      );
      planKey = byLookup?.key ?? null;
    }
    if (planKey === null) {
      const current = await deps.checkout("platform", (sql) =>
        currentPlan(asSql(sql), scope.orgId),
      );
      planKey = current?.key ?? null;
    }

    return finish(
      request,
      Response.json({
        state,
        planKey,
        quantity: account?.quantity ?? null,
        current_period_end: account?.currentPeriodEnd
          ? account.currentPeriodEnd.toISOString()
          : null,
        trial_end: account?.trialEnd ? account.trialEnd.toISOString() : null,
        grace_until: account?.graceUntil ? account.graceUntil.toISOString() : null,
        canView: auth.canView,
        canManage: auth.canManage,
      }),
    );
  }

  async function handlePlans(request: Request, context: RouteContext): Promise<Response> {
    const hidden = foreignHost(request);
    if (hidden !== undefined) {
      return finish(request, hidden);
    }
    const body = await parse(request, plansBody);
    if (body === undefined) {
      return finish(request, empty(400));
    }
    const actor = await sessionUser(request);
    if (actor instanceof Response) {
      return finish(request, actor);
    }
    const scope = await communityScope(body.communitySlug, context, actor.userId);
    if (scope === null) {
      return finish(request, empty(403));
    }
    if (scope instanceof Response) {
      return finish(request, scope);
    }
    const allowed = await authorise(scope, actor.userId, MANAGE);
    if (!allowed) {
      return finish(request, empty(403));
    }

    const plans = await deps.checkout("platform", (sql) => listCheckoutPlans(asSql(sql)));
    const settings = await deps.checkout("platform", (sql) => currentSettings(asSql(sql)));
    const account = await deps.checkout("platform", (sql) => readAccount(asSql(sql), scope.orgId));

    const planItems = plans.map((plan) => {
      const trialAvailable =
        settings !== null &&
        trialDaysFor({ trialEligible: plan.trialEligible }, account, settings) !== undefined;
      return {
        key: plan.key,
        trialAvailable,
      };
    });

    return finish(request, Response.json({ plans: planItems }));
  }

  return [
    {
      method: "POST",
      pattern: "/v1/billing/checkout",
      surface: "tenant",
      billing: "exempt",
      handle: handleCheckout,
    },
    {
      method: "POST",
      pattern: "/v1/billing/portal",
      surface: "tenant",
      billing: "exempt",
      handle: handlePortal,
    },
    {
      method: "POST",
      pattern: "/v1/billing/status",
      surface: "tenant",
      billing: "exempt",
      handle: handleStatus,
    },
    {
      method: "POST",
      pattern: "/v1/billing/plans",
      surface: "tenant",
      billing: "exempt",
      handle: handlePlans,
    },
  ];
}
