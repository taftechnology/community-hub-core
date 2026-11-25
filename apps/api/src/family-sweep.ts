import { withAppTransaction } from "@community-hub/db";
import { purgeDeletedHouseholds } from "@community-hub/people";

import { type CommunityScope, guardWrite } from "./billing-guard.js";
import { errorClassFor, type SweepDeps } from "./contact-sweep.js";
import type { RouteContext } from "./gate.js";

// One call purges at most this many households; the people function itself refuses more than 50.
const SWEEP_LIMIT = 50;

// Permanently deletes the community's families that have been hidden for 720 hours or more.
// Called by the household routes after a permitted 200 (household list, Deleted list, delete, restore),
// once the route's own transaction has committed, and awaited before the response returns.
// It never changes the route's answer: a read-only community, a failed billing check and a
// failed purge all return quietly, and a failure is logged by error class only.
export async function sweepDeletedHouseholds(
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
      withAppTransaction(sql, scope, (tx) => purgeDeletedHouseholds(tx, SWEEP_LIMIT)),
    );
  } catch (error) {
    deps.log("family_sweep_failed", {
      errorClass: errorClassFor(error),
      path: context.pattern,
    });
  }
}
