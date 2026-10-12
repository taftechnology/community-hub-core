import type { EntitlementSnapshot } from "@community-hub/entitlements-eval";
import type { Sql } from "postgres";

const FRESH_FOR_MS = 60_000;

const snapshots = new Map<string, EntitlementSnapshot>();

type SnapshotQuery = {
  organisationId: string;
  communityId: string;
  now: Date;
};

function cacheKey(organisationId: string, communityId: string): string {
  return `${organisationId}:${communityId}`;
}

export function clearSnapshotCache(): void {
  snapshots.clear();
}

export function clearSnapshotPair(organisationId: string, communityId: string): void {
  snapshots.delete(cacheKey(organisationId, communityId));
}

export async function loadSnapshot(sql: Sql, input: SnapshotQuery): Promise<EntitlementSnapshot> {
  const planRows = await sql<
    { plan_key: string; entitlement_key: string | null; limit_value: number | null }[]
  >`
    select plans.key as plan_key, entitlement.entitlement_key, entitlement.limit_value
    from platform.organisation_plans assigned
    join platform.plans plans on plans.id = assigned.plan_id
    left join platform.plan_entitlements entitlement on entitlement.plan_id = plans.id
    where assigned.organisation_id = ${input.organisationId}::uuid
  `;
  const planKey = planRows[0]?.plan_key ?? null;
  const planEntitlements = planRows.flatMap((row) =>
    row.entitlement_key === null ? [] : [{ key: row.entitlement_key, limit: row.limit_value }],
  );

  const addOnRows = await sql<{ entitlement_key: string; limit_value: number | null }[]>`
    select entitlement.entitlement_key, entitlement.limit_value
    from platform.organisation_add_ons assigned
    join platform.add_on_entitlements entitlement on entitlement.add_on_id = assigned.add_on_id
    where assigned.organisation_id = ${input.organisationId}::uuid
  `;
  const allocationRows = await sql<{ entitlement_key: string }[]>`
    select entitlement_key
    from platform.community_allocations
    where community_id = ${input.communityId}::uuid
  `;
  const toggleRows = await sql<{ entitlement_key: string; enabled: boolean }[]>`
    select entitlement_key, enabled
    from platform.community_toggles
    where community_id = ${input.communityId}::uuid
  `;
  const overrideRows = await sql<{ entitlement_key: string; expires_at: Date }[]>`
    select entitlement_key, expires_at
    from platform.entitlement_overrides
    where organisation_id = ${input.organisationId}::uuid
  `;
  const flagRows =
    planKey === null
      ? await sql<
          {
            key: string;
            enabled: boolean;
            organisation_id: string | null;
            community_id: string | null;
            plan_key: string | null;
            region: string | null;
          }[]
        >`
          select key, enabled, organisation_id, community_id, plan_key, region
          from platform.feature_flags
          where (organisation_id is null or organisation_id = ${input.organisationId}::uuid)
            and (community_id is null or community_id = ${input.communityId}::uuid)
            and (region is null or region = 'au')
            and plan_key is null
        `
      : await sql<
          {
            key: string;
            enabled: boolean;
            organisation_id: string | null;
            community_id: string | null;
            plan_key: string | null;
            region: string | null;
          }[]
        >`
          select key, enabled, organisation_id, community_id, plan_key, region
          from platform.feature_flags
          where (organisation_id is null or organisation_id = ${input.organisationId}::uuid)
            and (community_id is null or community_id = ${input.communityId}::uuid)
            and (region is null or region = 'au')
            and (plan_key is null or plan_key = ${planKey})
        `;

  return {
    organisationId: input.organisationId,
    communityId: input.communityId,
    region: "au",
    planKey,
    loadedAt: new Date(input.now.getTime()),
    planEntitlements,
    addOnEntitlements: addOnRows.map((row) => ({
      key: row.entitlement_key,
      limit: row.limit_value,
    })),
    allocations: allocationRows.map((row) => row.entitlement_key),
    toggles: toggleRows.map((row) => ({ key: row.entitlement_key, enabled: row.enabled })),
    overrides: overrideRows.map((row) => ({
      key: row.entitlement_key,
      expiresAt: row.expires_at,
    })),
    flags: flagRows.map((row) => ({
      key: row.key,
      enabled: row.enabled,
      organisationId: row.organisation_id,
      communityId: row.community_id,
      planKey: row.plan_key,
      region: row.region,
    })),
  };
}

export async function readSnapshot(sql: Sql, input: SnapshotQuery): Promise<EntitlementSnapshot> {
  const key = cacheKey(input.organisationId, input.communityId);
  const stored = snapshots.get(key);
  const stale =
    stored !== undefined && input.now.getTime() - stored.loadedAt.getTime() >= FRESH_FOR_MS;
  if (stored !== undefined && !stale) {
    return stored;
  }
  const loaded = await loadSnapshot(sql, input);
  snapshots.set(key, loaded);
  return loaded;
}
