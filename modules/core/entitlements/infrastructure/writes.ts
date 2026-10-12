import { newId } from "@community-hub/db";
import { listCommunityIds } from "@community-hub/tenancy";
import type { Sql } from "postgres";

import { EntitlementError } from "../domain/error.js";
import { parseEntitlementKey, parsePlanKey } from "../domain/keys.js";

type EntitlementLimit = {
  key: string;
  limit: number | null;
};

type CatalogueKind = "plan" | "add_on";

function parseLimits(entitlements: EntitlementLimit[]): EntitlementLimit[] {
  const seen = new Set<string>();
  return entitlements.map((entry) => {
    const key = parseEntitlementKey(entry.key);
    if (seen.has(key)) {
      throw new EntitlementError("invalid_key");
    }
    seen.add(key);
    if (
      entry.limit !== null &&
      (typeof entry.limit !== "number" || !Number.isInteger(entry.limit) || entry.limit < 0)
    ) {
      throw new EntitlementError("invalid_limit");
    }
    return { key, limit: entry.limit };
  });
}

function requireFuture(expiresAt: Date, now: Date): void {
  if (
    !(expiresAt instanceof Date) ||
    !(now instanceof Date) ||
    Number.isNaN(expiresAt.getTime()) ||
    Number.isNaN(now.getTime()) ||
    !(expiresAt > now)
  ) {
    throw new EntitlementError("invalid_expiry");
  }
}

async function upsertCatalogue(
  sql: Sql,
  kind: CatalogueKind,
  key: string,
  entitlements: EntitlementLimit[],
): Promise<void> {
  const parsedKey = parsePlanKey(key);
  const rows = parseLimits(entitlements);
  await sql.begin(async (tx) => {
    const existing =
      kind === "plan"
        ? await tx<{ id: string }[]>`select id from platform.plans where key = ${parsedKey}`
        : await tx<{ id: string }[]>`select id from platform.add_ons where key = ${parsedKey}`;
    let catalogueId = existing[0]?.id;
    if (catalogueId === undefined) {
      catalogueId = newId();
      if (kind === "plan") {
        await tx`insert into platform.plans (id, key) values (${catalogueId}, ${parsedKey})`;
      } else {
        await tx`insert into platform.add_ons (id, key) values (${catalogueId}, ${parsedKey})`;
      }
    }
    if (kind === "plan") {
      await tx`
        delete from platform.plan_entitlements
        where plan_id = ${catalogueId}::uuid
      `;
    } else {
      await tx`
        delete from platform.add_on_entitlements
        where add_on_id = ${catalogueId}::uuid
      `;
    }
    for (const row of rows) {
      if (kind === "plan") {
        await tx`
          insert into platform.plan_entitlements (plan_id, entitlement_key, limit_value)
          values (${catalogueId}::uuid, ${row.key}, ${row.limit})
        `;
      } else {
        await tx`
          insert into platform.add_on_entitlements (add_on_id, entitlement_key, limit_value)
          values (${catalogueId}::uuid, ${row.key}, ${row.limit})
        `;
      }
    }
  });
}

export async function upsertPlan(
  sql: Sql,
  input: { key: string; entitlements: EntitlementLimit[] },
): Promise<void> {
  await upsertCatalogue(sql, "plan", input.key, input.entitlements);
}

export async function upsertAddOn(
  sql: Sql,
  input: { key: string; entitlements: EntitlementLimit[] },
): Promise<void> {
  await upsertCatalogue(sql, "add_on", input.key, input.entitlements);
}

export async function assignPlan(
  sql: Sql,
  input: { organisationId: string; planKey: string; now: Date },
): Promise<void> {
  const planKey = parsePlanKey(input.planKey);
  await sql.begin(async (tx) => {
    const plans = await tx<{ id: string }[]>`
      select id from platform.plans where key = ${planKey}
    `;
    const planId = plans[0]?.id;
    if (planId === undefined) {
      throw new EntitlementError("not_found");
    }
    const organisations = await tx<{ id: string }[]>`
      select id from platform.organisations where id = ${input.organisationId}::uuid
    `;
    if (organisations.length === 0) {
      throw new EntitlementError("not_found");
    }
    await tx`
      insert into platform.organisation_plans (organisation_id, plan_id)
      values (${input.organisationId}::uuid, ${planId}::uuid)
      on conflict (organisation_id) do update set plan_id = excluded.plan_id
    `;
    const planKeys = await tx<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.plan_entitlements
      where plan_id = ${planId}::uuid
    `;
    const addOnKeys = await tx<{ entitlement_key: string }[]>`
      select granted.entitlement_key
      from platform.organisation_add_ons assigned
      join platform.add_on_entitlements granted on granted.add_on_id = assigned.add_on_id
      where assigned.organisation_id = ${input.organisationId}::uuid
    `;
    const overrideKeys = await tx<{ entitlement_key: string }[]>`
      select entitlement_key
      from platform.entitlement_overrides
      where organisation_id = ${input.organisationId}::uuid
        and expires_at > ${input.now}
    `;
    const keys = [
      ...new Set([...planKeys, ...addOnKeys, ...overrideKeys].map((row) => row.entitlement_key)),
    ];
    const communityIds = await listCommunityIds(tx as unknown as Sql, input.organisationId);
    for (const communityId of communityIds) {
      await tx`
        delete from platform.community_allocations
        where community_id = ${communityId}::uuid
      `;
      for (const entitlementKey of keys) {
        await tx`
          insert into platform.community_allocations (community_id, entitlement_key)
          values (${communityId}::uuid, ${entitlementKey})
        `;
      }
    }
  });
}

export async function allocate(
  sql: Sql,
  input: { communityId: string; key: string },
): Promise<void> {
  const key = parseEntitlementKey(input.key);
  const communities = await sql<{ id: string }[]>`
    select id from platform.communities where id = ${input.communityId}::uuid
  `;
  if (communities.length === 0) {
    throw new EntitlementError("not_found");
  }
  const existing = await sql<{ community_id: string }[]>`
    select community_id
    from platform.community_allocations
    where community_id = ${input.communityId}::uuid
      and entitlement_key = ${key}
  `;
  if (existing.length > 0) {
    throw new EntitlementError("duplicate_allocation");
  }
  await sql`
    insert into platform.community_allocations (community_id, entitlement_key)
    values (${input.communityId}::uuid, ${key})
  `;
}

export async function grantOverride(
  sql: Sql,
  input: { organisationId: string; key: string; expiresAt: Date; now: Date },
): Promise<void> {
  const key = parseEntitlementKey(input.key);
  requireFuture(input.expiresAt, input.now);
  await sql.begin(async (tx) => {
    const organisations = await tx<{ id: string }[]>`
      select id from platform.organisations where id = ${input.organisationId}::uuid
    `;
    if (organisations.length === 0) {
      throw new EntitlementError("not_found");
    }
    const existing = await tx<{ id: string }[]>`
      select id
      from platform.entitlement_overrides
      where organisation_id = ${input.organisationId}::uuid
        and entitlement_key = ${key}
    `;
    const overrideId = existing[0]?.id;
    if (overrideId === undefined) {
      await tx`
        insert into platform.entitlement_overrides (id, organisation_id, entitlement_key, expires_at)
        values (${newId()}, ${input.organisationId}::uuid, ${key}, ${input.expiresAt})
      `;
      return;
    }
    await tx`
      update platform.entitlement_overrides
      set expires_at = ${input.expiresAt}
      where id = ${overrideId}::uuid
    `;
  });
}

export async function setFeatureFlag(
  sql: Sql,
  input: {
    key: string;
    enabled: boolean;
    organisationId: string | null;
    communityId: string | null;
    planKey: string | null;
    region: string | null;
  },
): Promise<void> {
  const key = parseEntitlementKey(input.key);
  if (input.planKey !== null) {
    parsePlanKey(input.planKey);
  }
  if (input.region !== null && input.region !== "au") {
    throw new EntitlementError("invalid_region");
  }
  await sql.begin(async (tx) => {
    const existing = await tx<{ id: string }[]>`
      select id
      from platform.feature_flags
      where key = ${key}
        and organisation_id is not distinct from ${input.organisationId}::uuid
        and community_id is not distinct from ${input.communityId}::uuid
        and plan_key is not distinct from ${input.planKey}
        and region is not distinct from ${input.region}
    `;
    const flagId = existing[0]?.id;
    if (flagId === undefined) {
      await tx`
        insert into platform.feature_flags (
          id, key, enabled, organisation_id, community_id, plan_key, region
        )
        values (
          ${newId()},
          ${key},
          ${input.enabled},
          ${input.organisationId}::uuid,
          ${input.communityId}::uuid,
          ${input.planKey},
          ${input.region}
        )
      `;
      return;
    }
    await tx`
      update platform.feature_flags
      set enabled = ${input.enabled}
      where id = ${flagId}::uuid
    `;
  });
}
