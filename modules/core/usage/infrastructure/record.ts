import type { AppTransaction } from "@community-hub/db";

import { utcDay } from "../domain/day.js";
import { parseFeatureKey } from "../domain/keys.js";

export async function recordSuccess(
  tx: AppTransaction,
  featureKey: string,
  at: Date,
): Promise<void> {
  const key = parseFeatureKey(featureKey);
  const day = utcDay(at);

  await tx`
    insert into app.usage_facts_daily (org_id, community_id, feature_key, day, success_count)
    values (current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid, ${key}, ${day}::date, 1)
    on conflict (org_id, community_id, feature_key, day)
    do update set success_count = app.usage_facts_daily.success_count + 1
  `;
}
