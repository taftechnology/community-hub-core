import { evaluate } from "@community-hub/entitlements-eval";
import type { Sql } from "postgres";

import { EntitlementError } from "../domain/error.js";
import { parseEntitlementKey } from "../domain/keys.js";
import { clearSnapshotPair, loadSnapshot } from "./snapshot.js";

export async function setToggle(
  sql: Sql,
  input: {
    organisationId: string;
    communityId: string;
    key: string;
    enabled: boolean;
    now: Date;
  },
): Promise<"changed" | "unchanged"> {
  const key = parseEntitlementKey(input.key);
  const owned = await sql<{ id: string }[]>`
    select id
    from platform.communities
    where id = ${input.communityId}::uuid
      and organisation_id = ${input.organisationId}::uuid
  `;
  if (owned.length === 0) {
    throw new EntitlementError("not_found");
  }
  const fresh = await loadSnapshot(sql, {
    organisationId: input.organisationId,
    communityId: input.communityId,
    now: input.now,
  });
  const decision = evaluate({ ...fresh, toggles: [] }, key, input.now);
  if (!decision.ok) {
    throw new EntitlementError("not_allocated");
  }
  const current = fresh.toggles.find((row) => row.key === key);
  const storedEnabled = current === undefined ? true : current.enabled;
  if (storedEnabled === input.enabled) {
    clearSnapshotPair(input.organisationId, input.communityId);
    return "unchanged";
  }
  if (input.enabled) {
    await sql`
      delete from platform.community_toggles
      where community_id = ${input.communityId}::uuid
        and entitlement_key = ${key}
    `;
  } else {
    await sql`
      insert into platform.community_toggles (community_id, entitlement_key, enabled)
      values (${input.communityId}::uuid, ${key}, false)
    `;
  }
  clearSnapshotPair(input.organisationId, input.communityId);
  return "changed";
}
