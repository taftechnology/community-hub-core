import type { KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import { openHouseholdLabel } from "./household.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUSEHOLD_LISTED = "people.household.listed";

export type ListHouseholdsInput = {
  cursor?: string | null;
  limit?: number;
  includeRestricted: boolean;
  actorUserId: string | null;
};

export type HouseholdListItem = {
  householdId: string;
  version: number;
  label: string | null;
  adultCount: number;
};

export type ListHouseholdsResult = {
  items: HouseholdListItem[];
  nextCursor: string | null;
};

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
}

function parseCursor(cursor: string): { i: string } {
  if (UUID_RE.test(cursor)) {
    return { i: cursor };
  }
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.i === "string" &&
      UUID_RE.test(parsed.i)
    ) {
      return parsed;
    }
  } catch {
    // try standard base64
  }
  try {
    const raw = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.i === "string" &&
      UUID_RE.test(parsed.i)
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  throw new PeopleError("invalid_input");
}

export async function listHouseholds(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ListHouseholdsInput,
): Promise<ListHouseholdsResult> {
  const limit = input.limit ?? 25;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new PeopleError("invalid_input");
  }

  let cursorClause = tx``;
  if (typeof input.cursor === "string" && input.cursor.length > 0) {
    const c = parseCursor(input.cursor);
    cursorClause = tx`and h.id > ${c.i}::uuid`;
  }

  const rows = await tx<
    {
      id: string;
      version: number;
      adult_count: number;
    }[]
  >`
    select
      h.id::text as id,
      h.version,
      count(p.id)::int as adult_count
    from app.households h
    left join app.persons p
      on p.household_id = h.id
      and p.org_id = current_setting('app.org_id')::uuid
      and p.community_id = current_setting('app.community_id')::uuid
      and p.is_minor = false
    where h.org_id = current_setting('app.org_id')::uuid
      and h.community_id = current_setting('app.community_id')::uuid
      ${cursorClause}
    group by h.id, h.version
    order by h.id asc
    limit ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const pageIds = pageRows.map((r) => r.id);
  const lastId = pageIds[pageIds.length - 1];
  const nextCursor =
    hasMore && lastId ? Buffer.from(JSON.stringify({ i: lastId })).toString("base64url") : null;

  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: HOUSEHOLD_LISTED,
    purpose: HOUSEHOLD_LISTED,
    targetIds: pageIds,
  });

  const items: HouseholdListItem[] = [];
  for (const r of pageRows) {
    let label: string | null = null;
    if (input.includeRestricted) {
      const opened = await openHouseholdLabel(tx, kms, keyArn, r.id);
      label = opened?.label ?? null;
    }
    items.push({
      householdId: r.id,
      version: r.version,
      label,
      adultCount: r.adult_count,
    });
  }

  return { items, nextCursor };
}
