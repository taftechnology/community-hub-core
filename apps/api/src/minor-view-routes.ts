import {
  AccessError,
  finishMinorView,
  prepareMinorView,
  type MinorViewInput,
} from "@community-hub/access";
import { minorLifeEventViewBody, minorViewBody } from "@community-hub/contracts/people";
import { withAppTransaction } from "@community-hub/db";
import { consumeFreshFactor, readSession } from "@community-hub/identity";
import { getRequestContext } from "@community-hub/kernel";
import { findCommunityBySlug } from "@community-hub/tenancy";

import { bearer, empty, parse, presentedHostname } from "./auth-routes.js";
import type { Checkout } from "./checkout.js";
import { guardEntitlement } from "./entitlement-guard.js";
import type { GateRoute } from "./gate.js";
import type { BillingLogFields } from "./index.js";

type ViewSql = Parameters<typeof readSession>[0];

const HOUSEHOLDS_ENTITLEMENT = "people.households";

export type MinorViewLog = (message: string, fields?: Record<string, unknown>) => void;

export type MinorViewDeps = {
  checkout: Checkout<ViewSql>;
  kms: Parameters<typeof readSession>[1];
  keyArn: string;
  now: () => Date;
  apiHostname: string;
  log: MinorViewLog;
  guardLog: (message: string, fields: BillingLogFields) => void;
};

type ViewSchema<T> = {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
};

// A refusal from the View service. The service has already written its denial row, so this is
// called inside the transaction callback and the response is returned from there: an error that
// leaves the callback would roll the row back. Anything else is not ours to answer.
function refusal(error: unknown): Response {
  if (error instanceof AccessError && error.code === "forbidden") {
    return empty(403);
  }
  if (error instanceof AccessError && error.code === "not_found") {
    return empty(404);
  }
  throw error;
}

// The Community Admin's View of one field of one child (ADR 0017, plan P3). Both routes run the same
// steps in the same order:
//
//   session (401), body (400), community (403), the people.households entitlement (403, as every
//   household route), transaction A (role 403, then the child 404), the fresh-check consume
//   (403 with a code), transaction B (role again, the one field, one audit row, 200).
//
// Transaction A comes first on purpose: a refused View, whoever it is for, never uses up a check.
// Every answer, errors included, carries Cache-Control: no-store. Other refusals have empty bodies.
// Nothing here logs a value, a name or a SQL text: a request line holds the path and the status.
export function minorViewRoutes(deps: MinorViewDeps): GateRoute[] {
  function respond(request: Request, response: Response): Response {
    response.headers.set("cache-control", "no-store");
    deps.log("request", {
      path: new URL(request.url).pathname,
      status: response.status,
      requestId: getRequestContext().requestId,
    });
    return response;
  }

  async function run<T extends { communitySlug: string }>(
    request: Request,
    schema: ViewSchema<T>,
    toInput: (body: T, actorUserId: string) => MinorViewInput,
  ): Promise<Response> {
    try {
      if (presentedHostname(request) !== deps.apiHostname.toLowerCase()) {
        return respond(request, empty(404));
      }

      const token = bearer(request);
      if (token === undefined) {
        return respond(request, empty(401));
      }
      const session = await deps.checkout("identity", (sql) =>
        readSession(sql, deps.kms, deps.keyArn, { accessToken: token, now: deps.now() }),
      );
      if (session === null) {
        return respond(request, empty(401));
      }

      const body = await parse(request, schema);
      if (body === undefined) {
        return respond(request, empty(400));
      }

      const found = await deps.checkout("platform", (sql) =>
        findCommunityBySlug(sql, body.communitySlug),
      );
      if (found === null) {
        return respond(request, empty(403));
      }
      const scope = { orgId: found.organisationId, communityId: found.id };

      const blockedEntitlement = await guardEntitlement(
        { checkout: deps.checkout, now: deps.now, guardLog: deps.guardLog },
        scope,
        HOUSEHOLDS_ENTITLEMENT,
      );
      if (blockedEntitlement !== null) {
        return respond(request, blockedEntitlement);
      }

      const input = toInput(body, session.userId);

      const refused = await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          try {
            await prepareMinorView(tx, input);
            return null;
          } catch (error) {
            return refusal(error);
          }
        }),
      );
      if (refused !== null) {
        return respond(request, refused);
      }

      const consumed = await deps.checkout("identity", (sql) =>
        consumeFreshFactor({
          sql,
          kms: deps.kms,
          keyArn: deps.keyArn,
          accessToken: token,
          now: deps.now(),
        }),
      );
      if (consumed.outcome === "recovery") {
        return respond(request, Response.json({ code: "recovery_session" }, { status: 403 }));
      }
      if (consumed.outcome === "not_fresh") {
        return respond(request, Response.json({ code: "fresh_required" }, { status: 403 }));
      }

      // The check is used up from here. A role revoked since transaction A, a child hidden or
      // moved, a database or KMS failure: the admin checks again.
      const answered = await deps.checkout("app", (sql) =>
        withAppTransaction(sql, scope, async (tx) => {
          try {
            const value = await finishMinorView(tx, deps.kms, deps.keyArn, input);
            return Response.json({ value });
          } catch (error) {
            return refusal(error);
          }
        }),
      );
      return respond(request, answered);
    } catch {
      return respond(request, empty(500));
    }
  }

  return [
    {
      method: "POST",
      pattern: "/v1/people/minors/view",
      surface: "tenant",
      billing: "read",
      handle: (request) =>
        run(request, minorViewBody, (body, actorUserId) => ({
          actorUserId,
          personId: body.personId,
          field: body.field,
        })),
    },
    {
      method: "POST",
      pattern: "/v1/people/minors/life-events/view",
      surface: "tenant",
      billing: "read",
      handle: (request) =>
        run(request, minorLifeEventViewBody, (body, actorUserId) => ({
          actorUserId,
          personId: body.personId,
          lifeEventId: body.lifeEventId,
          field: body.field,
        })),
    },
  ];
}
