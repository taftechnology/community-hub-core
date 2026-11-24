import type { KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import { householdFieldKeys, openField, openHouseholdLabel } from "./household.js";
import type { HouseholdStatus } from "./household-status.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMPTZ_TEXT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const HOUSEHOLD_LISTED = "people.household.listed";
const HOUSEHOLD_LISTED_DELETED = "people.household.listed_deleted";

export type { HouseholdStatus };

export type ListHouseholdsInput = {
  cursor?: string | null;
  limit?: number;
  includeRestricted: boolean;
  actorUserId: string | null;
  status?: HouseholdStatus;
};

export type HouseholdListItem = {
  householdId: string;
  version: number;
  label: string | null;
  adultCount: number;
  status: HouseholdStatus;
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

type DeletedCursor = { d: string; i: string };

function parseDeletedCursor(cursor: string): DeletedCursor {
  for (const encoding of ["base64url", "base64"] as const) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, encoding).toString("utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "d" in parsed &&
        "i" in parsed &&
        typeof (parsed as { d: unknown }).d === "string" &&
        typeof (parsed as { i: unknown }).i === "string" &&
        TIMESTAMPTZ_TEXT_RE.test((parsed as { d: string }).d) &&
        UUID_RE.test((parsed as { i: string }).i)
      ) {
        return { d: (parsed as { d: string }).d, i: (parsed as { i: string }).i };
      }
    } catch {
      // try the next encoding
    }
  }
  throw new PeopleError("invalid_input");
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
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

  if (input.status !== undefined && input.status !== "active" && input.status !== "inactive") {
    throw new PeopleError("invalid_input");
  }

  let statusClause = tx``;
  if (input.status !== undefined) {
    statusClause = tx`and h.status = ${input.status}`;
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
      status: HouseholdStatus;
      adult_count: number;
    }[]
  >`
    select
      h.id::text as id,
      h.version,
      h.status,
      count(p.id)::int as adult_count
    from app.households h
    left join app.persons p
      on p.household_id = h.id
      and p.org_id = current_setting('app.org_id')::uuid
      and p.community_id = current_setting('app.community_id')::uuid
      and p.is_minor = false
      and p.deleted_at is null
    where h.org_id = current_setting('app.org_id')::uuid
      and h.community_id = current_setting('app.community_id')::uuid
      and h.deleted_at is null
      ${statusClause}
      ${cursorClause}
    group by h.id, h.version, h.status
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
      status: r.status,
    });
  }

  return { items, nextCursor };
}

export type ListDeletedHouseholdsInput = {
  cursor?: string | null;
  limit?: number;
  actorUserId: string | null;
};

export type DeletedHouseholdListItem = {
  householdId: string;
  label: string | null;
  adultCount: number;
  version: number;
  deletedAt: string;
  purgeAfter: string;
};

export type ListDeletedHouseholdsResult = {
  items: DeletedHouseholdListItem[];
  nextCursor: string | null;
};

export async function listDeletedHouseholds(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ListDeletedHouseholdsInput,
): Promise<ListDeletedHouseholdsResult> {
  const limit = input.limit ?? 25;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new PeopleError("invalid_input");
  }

  let cursorClause = tx``;
  if (typeof input.cursor === "string" && input.cursor.length > 0) {
    const c = parseDeletedCursor(input.cursor);
    cursorClause = tx`and (
      h.deleted_at < ${c.d}::text::timestamptz
      or (h.deleted_at = ${c.d}::text::timestamptz and h.id > ${c.i}::uuid)
    )`;
  }

  const rows = await tx<
    {
      id: string;
      version: number;
      deleted_at: Date | string;
      deleted_at_text: string;
      purge_after: Date | string;
      label: Uint8Array | null;
      adult_count: number;
    }[]
  >`
    select
      h.id::text as id,
      h.version,
      h.deleted_at,
      h.deleted_at::text as deleted_at_text,
      (h.deleted_at + interval '720 hours') as purge_after,
      h.label,
      (
        select count(p.id)::int
        from app.persons p
        where p.household_id = h.id
          and p.org_id = current_setting('app.org_id')::uuid
          and p.community_id = current_setting('app.community_id')::uuid
          and p.is_minor = false
          and p.deleted_at is null
      ) as adult_count
    from app.households h
    where h.org_id = current_setting('app.org_id')::uuid
      and h.community_id = current_setting('app.community_id')::uuid
      and h.deleted_at is not null
      ${cursorClause}
    order by h.deleted_at desc, h.id asc
    limit ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const pageIds = pageRows.map((r) => r.id);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(JSON.stringify({ d: last.deleted_at_text, i: last.id })).toString("base64url")
      : null;

  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: HOUSEHOLD_LISTED_DELETED,
    purpose: HOUSEHOLD_LISTED_DELETED,
    targetIds: pageIds,
  });

  const commRows = await tx<{ value: string }[]>`
    select current_setting('app.community_id') as value
  `;
  const communityId = commRows[0]?.value;
  if (!communityId) {
    throw new Error("tenant setting is missing");
  }

  const items: DeletedHouseholdListItem[] = [];
  for (const r of pageRows) {
    let label: string | null = null;
    if (r.label !== null) {
      const keys = await householdFieldKeys(tx, kms, keyArn, r.id);
      label = await openField(r.label, keys.enc, r.id, communityId, "people.household_label");
    }
    items.push({
      householdId: r.id,
      label,
      adultCount: r.adult_count,
      version: r.version,
      deletedAt: toIso(r.deleted_at),
      purgeAfter: toIso(r.purge_after),
    });
  }

  return { items, nextCursor };
}
