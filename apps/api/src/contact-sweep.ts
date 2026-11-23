import { withAppTransaction } from "@community-hub/db";
import type { readSession } from "@community-hub/identity";
import { purgeDeletedPersons } from "@community-hub/people";

import { type CommunityScope, guardWrite } from "./billing-guard.js";
import type { Checkout } from "./checkout.js";
import type { RouteContext } from "./gate.js";
import type { BillingLogFields } from "./index.js";

type SweepSql = Parameters<typeof readSession>[0];

// One call purges at most this many contacts; the people function itself refuses more than 50.
const SWEEP_LIMIT = 50;

const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type SweepDeps = {
  readonly checkout: Checkout<SweepSql>;
  readonly now: () => Date;
  readonly guardLog: (message: string, fields: BillingLogFields) => void;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
};

function errorClassFor(error: unknown): string {
  if (error instanceof Error) {
    const name: unknown = error.name;
    return typeof name === "string" && ERROR_CLASS.test(name) ? name : "Error";
  }
  return "NonError";
}

// Permanently deletes the community's contacts that have been hidden for 720 hours or more.
// Called by the people routes after a permitted 200 (adult list, Deleted list, delete, restore),
// once the route's own transaction has committed, and awaited before the response returns.
// It never changes the route's answer: a read-only community, a failed billing check and a
// failed purge all return quietly, and a failure is logged by error class only.
export async function sweepDeletedContacts(
  deps: SweepDeps,
  scope: CommunityScope,
  userId: string,
  context: RouteContext,
): Promise<void> {
  const blocked = await guardWrite(deps, scope, userId, {
    billing: "write",
    pattern: context.pattern,
  });
  if (blocked !== null) {
    return;
  }

  try {
    await deps.checkout("app", (sql) =>
      withAppTransaction(sql, scope, (tx) => purgeDeletedPersons(tx, SWEEP_LIMIT)),
    );
  } catch (error) {
    deps.log("contact_sweep_failed", {
      errorClass: errorClassFor(error),
      path: context.pattern,
    });
  }
}
