import { holdsPermission } from "@community-hub/access";
import { checkoutBody, portalBody } from "@community-hub/contracts/billing";
import { appendAuditEvent, withAppTransaction } from "@community-hub/db";
import {
  checkoutDecision,
  currentSettings,
  readAccount,
  trialDaysFor,
  type StripeBilling,
} from "@community-hub/billing";
import { planBilling } from "@community-hub/entitlements";
import { readSession } from "@community-hub/identity";
import { getRequestContext } from "@community-hub/kernel";
import { findCommunityBySlug, listCommunityIds } from "@community-hub/tenancy";

import type { Checkout } from "./checkout.js";
import { presentedHostname, type GateRoute } from "./gate.js";

const DENIED = "billing.permission.denied";
const MANAGE = "billing.manage";

type Scope = { orgId: string; communityId: string };

export type BillingRouteLog = (message: string, fields?: Record<string, unknown>) => void;

export type BillingRoutesDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly checkout: Checkout<any>;
  readonly kms: Parameters<typeof readSession>[1];
  readonly keyArn: string;
  readonly now: () => Date;
  readonly apiHostname: string;
  readonly adminOrigin?: string | undefined;
  readonly port: StripeBilling;
  readonly log: BillingRouteLog;
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
    permission: "billing.manage",
  ): Promise<boolean> {
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

  async function handleCheckout(request: Request): Promise<Response> {
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
    const scope = await communityScope(body.communitySlug);
    if (scope === null) {
      return finish(request, empty(403));
    }
    const allowed = await authorise(scope, actor.userId, MANAGE);
    if (!allowed) {
      return finish(request, empty(403));
    }

    try {
      const account = await deps.checkout("platform", (sql) => readAccount(sql, scope.orgId));
      const decision = checkoutDecision(account);
      if (decision === "conflict") {
        return finish(request, empty(409));
      }

      const planInfo = await deps.checkout("platform", (sql) => planBilling(sql, body.planKey));
      if (planInfo === null || planInfo.stripeLookupKey === null) {
        return finish(request, empty(422));
      }

      const settings = await deps.checkout("platform", (sql) => currentSettings(sql));
      if (settings === null || settings.stripeTaxRateId === null) {
        return finish(request, empty(503));
      }

      const price = await deps.port.findPriceByLookupKey(planInfo.stripeLookupKey);
      if (price === null) {
        return finish(request, empty(503));
      }

      const communityIds = await deps.checkout("platform", (sql) =>
        listCommunityIds(sql, scope.orgId),
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
    } catch {
      return finish(request, empty(503));
    }
  }

  async function handlePortal(request: Request): Promise<Response> {
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
    const scope = await communityScope(body.communitySlug);
    if (scope === null) {
      return finish(request, empty(403));
    }
    const allowed = await authorise(scope, actor.userId, MANAGE);
    if (!allowed) {
      return finish(request, empty(403));
    }

    try {
      const account = await deps.checkout("platform", (sql) => readAccount(sql, scope.orgId));
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
    } catch {
      return finish(request, empty(503));
    }
  }

  return [
    {
      method: "POST",
      pattern: "/v1/billing/checkout",
      surface: "tenant",
      handle: handleCheckout,
    },
    {
      method: "POST",
      pattern: "/v1/billing/portal",
      surface: "tenant",
      handle: handlePortal,
    },
  ];
}
