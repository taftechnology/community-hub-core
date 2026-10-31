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
  readonly guardLog?: ((message: string, fields: { errorClass: string }) => void) | undefined;
};

function errorClassOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "constructor" in error) {
    return error.constructor.name;
  }
  return typeof error;
}

export async function isEntitlementEnabled(
  sql: unknown,
  community: CommunityScope,
  key: string,
  now: Date,
  guardLog?: ((message: string, fields: { errorClass: string }) => void) | undefined,
): Promise<boolean> {
  try {
    const snapshot = await readSnapshot(sql as Parameters<typeof readSnapshot>[0], {
      organisationId: community.orgId,
      communityId: community.communityId,
      now,
    });
    return evaluate(snapshot, key, now).ok;
  } catch (error) {
    guardLog?.("entitlement_guard_failed", { errorClass: errorClassOf(error) });
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
      isEntitlementEnabled(sql, scope, key, deps.now(), deps.guardLog),
    );
    if (!enabled) {
      return new Response(null, { status: 403 });
    }
    return null;
  } catch (error) {
    deps.guardLog?.("entitlement_guard_failed", { errorClass: errorClassOf(error) });
    return new Response(null, { status: 403 });
  }
}
