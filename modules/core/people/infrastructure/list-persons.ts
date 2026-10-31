import { blindIndex, type KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import { normaliseEmail, normalisePhone } from "../domain/person.js";
import { derivePersonFieldKeys } from "./person-keys.js";
import { readRosterNames } from "./roster-names.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ListPersonsInput = {
  kind?: "adults" | "minors";
  search?: string | null;
  cursor?: string | null;
  limit?: number;
  includeRestricted?: boolean;
  actorUserId: string;
};

export type PersonListItem = {
  id: string;
  personId: string;
  isMinor: boolean;
  givenName: string;
  familyName: string;
};

export type ListPersonsResult = {
  items: PersonListItem[];
  nextCursor: string | null;
};

type AdultCursor = { f: string; g: string; i: string };
type MinorCursor = { i: string };

function parseAdultCursor(cursor: string): AdultCursor {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.f === "string" &&
      typeof parsed.g === "string" &&
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
      typeof parsed.f === "string" &&
      typeof parsed.g === "string" &&
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

function parseMinorCursor(cursor: string): MinorCursor {
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

function encodeCursor(payload: AdultCursor | MinorCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function escapeLike(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export async function listPersons(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ListPersonsInput,
): Promise<ListPersonsResult> {
  if (typeof input.actorUserId !== "string" || !UUID_RE.test(input.actorUserId)) {
    throw new PeopleError("invalid_input");
  }

  const kind = input.kind ?? "adults";
  if (kind !== "adults" && kind !== "minors") {
    throw new PeopleError("invalid_input");
  }

  const limit = input.limit ?? 50;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new PeopleError("invalid_input");
  }

  const term = typeof input.search === "string" ? input.search.trim() : "";
  if (term.length > 100) {
    throw new PeopleError("invalid_input");
  }

  if (kind === "adults") {
    let cursorClause = tx``;
    if (typeof input.cursor === "string" && input.cursor.length > 0) {
      const c = parseAdultCursor(input.cursor);
      cursorClause = tx`and (family_name, given_name, id) > (${c.f}, ${c.g}, ${c.i}::uuid)`;
    }

    let searchClause = tx``;
    if (term.length > 0) {
      if (term.includes("@")) {
        let emailBidx: Uint8Array | null = null;
        try {
          const normEmail = normaliseEmail(term);
          const keys = await derivePersonFieldKeys(tx, kms, keyArn, {
            isMinor: false,
            householdId: null,
          });
          const mac = await blindIndex(
            keys.bidx,
            "people.email",
            new TextEncoder().encode(normEmail),
          );
          emailBidx = mac;
        } catch {
          emailBidx = null;
        }
        if (emailBidx === null) {
          searchClause = tx`and 1 = 0`;
        } else {
          searchClause = tx`and email_bidx = ${emailBidx}`;
        }
      } else if (/\d/.test(term)) {
        let phoneBidx: Uint8Array | null = null;
        try {
          const normPhone = normalisePhone(term);
          const keys = await derivePersonFieldKeys(tx, kms, keyArn, {
            isMinor: false,
            householdId: null,
          });
          const mac = await blindIndex(
            keys.bidx,
            "people.phone",
            new TextEncoder().encode(normPhone),
          );
          phoneBidx = mac;
        } catch {
          phoneBidx = null;
        }
        if (phoneBidx === null) {
          searchClause = tx`and 1 = 0`;
        } else {
          searchClause = tx`and phone_bidx = ${phoneBidx}`;
        }
      } else {
        const pattern = `${escapeLike(term)}%`;
        searchClause = tx`and (given_name ilike ${pattern} or family_name ilike ${pattern})`;
      }
    }

    const rows = await tx<
      {
        id: string;
        given_name: string | null;
        family_name: string | null;
      }[]
    >`
      select
        id::text as id,
        given_name,
        family_name
      from app.persons
      where org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
        and is_minor = false
        ${cursorClause}
        ${searchClause}
      order by family_name asc, given_name asc, id asc
      limit ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            f: last.family_name ?? "",
            g: last.given_name ?? "",
            i: last.id,
          })
        : null;

    const items: PersonListItem[] = pageRows.map((r) => ({
      id: r.id,
      personId: r.id,
      isMinor: false,
      givenName: r.given_name ?? "",
      familyName: r.family_name ?? "",
    }));

    return { items, nextCursor };
  }

  // Minors mode
  let cursorClause = tx``;
  if (typeof input.cursor === "string" && input.cursor.length > 0) {
    const c = parseMinorCursor(input.cursor);
    cursorClause = tx`and id > ${c.i}::uuid`;
  }

  const rows = await tx<
    {
      id: string;
    }[]
  >`
    select id::text as id
    from app.persons
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = true
      ${cursorClause}
    order by id asc
    limit ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const pageIds = pageRows.map((r) => r.id);
  const lastId = pageIds[pageIds.length - 1];
  const nextCursor = hasMore && lastId ? encodeCursor({ i: lastId }) : null;

  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: input.actorUserId,
    action: "people.person.listed_minors",
    purpose: "people.person.listed_minors",
    targetIds: pageIds,
  });

  const roster = await readRosterNames(tx, kms, keyArn, {
    personIds: pageIds,
    includeRestricted: input.includeRestricted ?? false,
    actorUserId: input.actorUserId,
  });

  const rosterMap = new Map(roster.map((r) => [r.personId, r]));
  const items: PersonListItem[] = pageIds.map((id) => {
    const r = rosterMap.get(id);
    return {
      id,
      personId: id,
      isMinor: true,
      givenName: r?.givenName ?? "",
      familyName: r?.familyName ?? "",
    };
  });

  return { items, nextCursor };
}
