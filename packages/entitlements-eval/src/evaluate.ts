export type EntitlementLimit = {
  key: string;
  limit: number | null;
};

export type EntitlementFlag = {
  key: string;
  enabled: boolean;
  organisationId: string | null;
  communityId: string | null;
  planKey: string | null;
  region: string | null;
};

export type EntitlementSnapshot = {
  organisationId: string;
  communityId: string;
  region: "au";
  planKey: string | null;
  loadedAt: Date;
  planEntitlements: readonly EntitlementLimit[];
  addOnEntitlements: readonly EntitlementLimit[];
  allocations: readonly string[];
  toggles: readonly { key: string; enabled: boolean }[];
  overrides: readonly { key: string; expiresAt: Date }[];
  flags: readonly EntitlementFlag[];
};

export type EvaluateResult =
  { ok: true } | { ok: false; step: "flag" | "entitlement" | "allocation" | "toggle" };

function sameOrOpen(target: string | null, actual: string | null): boolean {
  return target === null || target === actual;
}

function flagMatches(snapshot: EntitlementSnapshot, flag: EntitlementFlag, key: string): boolean {
  return (
    flag.key === key &&
    sameOrOpen(flag.organisationId, snapshot.organisationId) &&
    sameOrOpen(flag.communityId, snapshot.communityId) &&
    sameOrOpen(flag.planKey, snapshot.planKey) &&
    sameOrOpen(flag.region, snapshot.region)
  );
}

function includesKey(rows: readonly { key: string }[], key: string): boolean {
  return rows.some((row) => row.key === key);
}

export function evaluate(snapshot: EntitlementSnapshot, key: string, now: Date): EvaluateResult {
  const matching = snapshot.flags.filter((flag) => flagMatches(snapshot, flag, key));
  if (matching.some((flag) => flag.enabled === false)) {
    return { ok: false, step: "flag" };
  }

  const override = snapshot.overrides.some(
    (row) => row.key === key && row.expiresAt.getTime() > now.getTime(),
  );
  const entitled =
    includesKey(snapshot.planEntitlements, key) ||
    includesKey(snapshot.addOnEntitlements, key) ||
    override;
  if (!entitled) {
    return { ok: false, step: "entitlement" };
  }

  if (!snapshot.allocations.includes(key)) {
    return { ok: false, step: "allocation" };
  }

  const toggle = snapshot.toggles.find((row) => row.key === key);
  if (toggle !== undefined && toggle.enabled === false) {
    return { ok: false, step: "toggle" };
  }

  return { ok: true };
}

export function limit(snapshot: EntitlementSnapshot, key: string): number | null {
  const plan = snapshot.planEntitlements.find((row) => row.key === key);
  if (plan !== undefined) {
    return plan.limit;
  }

  let smallest: number | null = null;
  for (const row of snapshot.addOnEntitlements) {
    if (row.key !== key || row.limit === null) {
      continue;
    }
    if (smallest === null || row.limit < smallest) {
      smallest = row.limit;
    }
  }
  return smallest;
}
