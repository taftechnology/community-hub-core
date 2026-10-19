import { withAppTransaction } from "@community-hub/db";
import { holdsAnyGrant } from "@community-hub/access";
import { assertWritable, BillingReadOnly } from "@community-hub/billing";
import { type readSession } from "@community-hub/identity";
import type { RouteContext } from "./gate.js";
import type { BillingLogFields } from "./index.js";
import type { Checkout } from "./checkout.js";

type GuardSql = Parameters<typeof readSession>[0];

export type BillingGuardDeps = {
  readonly checkout: Checkout<unknown>;
  readonly now: () => Date;
  readonly guardLog: (message: string, fields: BillingLogFields) => void;
};

export type CommunityScope = {
  readonly orgId: string;
  readonly communityId: string;
};

export async function guardWrite(
  deps: BillingGuardDeps,
  scope: CommunityScope,
  userId: string,
  context: RouteContext,
): Promise<Response | null> {
  if (context.billing !== "write") {
    return null;
  }

  try {
    const hasGrant = await deps.checkout("app", (sql) =>
      withAppTransaction(sql as GuardSql, scope, (tx) => holdsAnyGrant(tx, userId)),
    );
    if (!hasGrant) {
      return null;
    }

    await deps.checkout("platform", (sql) =>
      assertWritable(sql as GuardSql, scope.orgId, deps.now()),
    );
    return null;
  } catch (error) {
    if (error instanceof BillingReadOnly) {
      deps.guardLog("billing_write_blocked", {
        path: context.pattern,
        organisationId: scope.orgId,
      });
      return new Response(null, { status: 402 });
    }
    return new Response(null, { status: 503 });
  }
}
