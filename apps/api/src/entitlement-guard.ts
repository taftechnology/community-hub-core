import { readSnapshot } from "@community-hub/entitlements";
import { evaluate } from "@community-hub/entitlements-eval";
import type { Checkout } from "./checkout.js";

export type CommunityScope = {
  readonly orgId: string;
  readonly communityId: string;
};

export type EntitlementGuardDeps = {
  readonly checkout: Checkout<unknown>;
  readonly now: () => Date;
};

export async function isEntitlementEnabled(
  sql: unknown,
  community: CommunityScope,
  key: string,
  now: Date,
): Promise<boolean> {
  try {
    const snapshot = await readSnapshot(sql as Parameters<typeof readSnapshot>[0], {
      organisationId: community.orgId,
      communityId: community.communityId,
      now,
    });
    return evaluate(snapshot, key, now).ok;
  } catch {
    return false;
  }
}

export async function guardEntitlement(
  deps: EntitlementGuardDeps,
  scope: CommunityScope,
  key: string,
): Promise<Response | null> {
  try {
    const enabled = await deps.checkout("platform", (sql) =>
      isEntitlementEnabled(sql, scope, key, deps.now()),
    );
    if (!enabled) {
      return new Response(null, { status: 403 });
    }
    return null;
  } catch {
    return new Response(null, { status: 403 });
  }
}
