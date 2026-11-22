import { blindIndex, type KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import {
  ageOn,
  normaliseEmail,
  normalisePhone,
  PERSON_SOURCES,
  type PersonSource,
  type PersonStatus,
} from "../domain/person.js";
import { existingCommunityFieldKeys, type PersonFieldKeys } from "./person-keys.js";
import { openField } from "./person.js";
import { readRosterNames } from "./roster-names.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ListPersonsInput = {
  kind?: "adults" | "minors";
  search?: string | null;
  cursor?: string | null;
  limit?: number;
  includeRestricted?: boolean;
  actorUserId: string;
  now?: Date;
  status?: PersonStatus;
  source?: PersonSource;
  personIds?: string[];
};

export type AdultListItem = {
  id: string;
  personId: string;
  isMinor: false;
  givenName: string;
  familyName: string;
  version: number;
  email: string | null;
  phone: string | null;
  age: number | null;
  createdAt: string;
  status: PersonStatus;
  source: PersonSource;
};

export type MinorListItem = {
  id: string;
  personId: string;
  isMinor: true;
  givenName: string;
  familyName: string;
  version: number;
};

export type PersonListItem = AdultListItem | MinorListItem;

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

function encodeCursor(payload: AdultCursor | MinorCursor | DeletedCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function escapeLike(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export type ListDeletedPersonsInput = {
  search?: string | null;
  cursor?: string | null;
  limit?: number;
  actorUserId: string;
};

export type DeletedPersonListItem = {
  id: string;
  givenName: string;
  familyName: string;
  deletedAt: string;
  purgeAfter: string;
  version: number;
};

export type ListDeletedPersonsResult = {
  items: DeletedPersonListItem[];
  nextCursor: string | null;
};

// The Deleted list's cursor carries deleted_at as the text Postgres prints (microseconds kept)
// and the id. A JS Date would cut it to milliseconds and skip or repeat rows that share one.
// The cast goes through text because the driver turns a timestamptz parameter into a Date.
type DeletedCursor = { d: string; i: string };

const TIMESTAMPTZ_TEXT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

function parseDeletedCursor(cursor: string): DeletedCursor {
  for (const encoding of ["base64url", "base64"] as const) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, encoding).toString("utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "d" in parsed &&
        "i" in parsed &&
        typeof parsed.d === "string" &&
        typeof parsed.i === "string" &&
        TIMESTAMPTZ_TEXT_RE.test(parsed.d) &&
        UUID_RE.test(parsed.i)
      ) {
        return { d: parsed.d, i: parsed.i };
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

// Hidden adults, newest hide first. It never opens a key, decrypts or returns email, phone or
// date of birth: a name, the two dates and the version are all the screen needs.
export async function listDeletedPersons(
  tx: AppTransaction,
  input: ListDeletedPersonsInput,
): Promise<ListDeletedPersonsResult> {
  if (typeof input.actorUserId !== "string" || !UUID_RE.test(input.actorUserId)) {
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

  let cursorClause = tx``;
  if (typeof input.cursor === "string" && input.cursor.length > 0) {
    const c = parseDeletedCursor(input.cursor);
    cursorClause = tx`and (
      deleted_at < ${c.d}::text::timestamptz
      or (deleted_at = ${c.d}::text::timestamptz and id > ${c.i}::uuid)
    )`;
  }

  let searchClause = tx``;
  if (term.length > 0) {
    const pattern = `${escapeLike(term)}%`;
    searchClause = tx`and (given_name ilike ${pattern} or family_name ilike ${pattern})`;
  }

  const rows = await tx<
    {
      id: string;
      given_name: string | null;
      family_name: string | null;
      version: number;
      deleted_at: Date | string;
      deleted_at_text: string;
      purge_after: Date | string;
    }[]
  >`
    select
      id::text as id,
      given_name,
      family_name,
      version,
      deleted_at,
      deleted_at::text as deleted_at_text,
      (deleted_at + interval '720 hours') as purge_after
    from app.persons
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = false
      and deleted_at is not null
      ${cursorClause}
      ${searchClause}
    order by deleted_at desc, id asc
    limit ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ d: last.deleted_at_text, i: last.id }) : null;

  if (pageRows.length > 0) {
    await appendAuditEvent(tx, {
      actorKind: "user",
      actorId: input.actorUserId,
      action: "people.person.listed_deleted",
      purpose: "people.person.listed_deleted",
      targetIds: pageRows.map((r) => r.id),
    });
  }

  return {
    items: pageRows.map((r) => ({
      id: r.id,
      givenName: r.given_name ?? "",
      familyName: r.family_name ?? "",
      deletedAt: toIso(r.deleted_at),
      purgeAfter: toIso(r.purge_after),
      version: r.version,
    })),
    nextCursor,
  };
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

  if (input.status !== undefined && input.status !== "active" && input.status !== "inactive") {
    throw new PeopleError("invalid_input");
  }

  if (input.source !== undefined && !PERSON_SOURCES.includes(input.source)) {
    throw new PeopleError("invalid_input");
  }

  if (input.personIds !== undefined) {
    for (const id of input.personIds) {
      if (!UUID_RE.test(id)) {
        throw new PeopleError("invalid_input");
      }
    }
  }

  if (kind === "adults") {
    if (input.personIds !== undefined && input.personIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    const now = input.now ?? new Date();

    let keysPromise: Promise<PersonFieldKeys | null> | null = null;
    const getKeys = (): Promise<PersonFieldKeys | null> => {
      if (!keysPromise) {
        keysPromise = existingCommunityFieldKeys(tx, kms, keyArn);
      }
      return keysPromise;
    };

    let cursorClause = tx``;
    if (typeof input.cursor === "string" && input.cursor.length > 0) {
      const c = parseAdultCursor(input.cursor);
      cursorClause = tx`and (family_name, given_name, id) > (${c.f}, ${c.g}, ${c.i}::uuid)`;
    }

    let searchClause = tx``;
    if (term.length > 0) {
      if (term.includes("@")) {
        let normEmail: string | null = null;
        try {
          normEmail = normaliseEmail(term);
        } catch {
          normEmail = null;
        }
        if (normEmail === null) {
          searchClause = tx`and 1 = 0`;
        } else {
          const keys = await getKeys();
          if (keys === null) {
            searchClause = tx`and 1 = 0`;
          } else {
            const mac = await blindIndex(
              keys.bidx,
              "people.email",
              new TextEncoder().encode(normEmail),
            );
            searchClause = tx`and email_bidx = ${mac}`;
          }
        }
      } else if (/\d/.test(term)) {
        let normPhone: string | null = null;
        try {
          normPhone = normalisePhone(term);
        } catch {
          normPhone = null;
        }
        if (normPhone === null) {
          searchClause = tx`and 1 = 0`;
        } else {
          const keys = await getKeys();
          if (keys === null) {
            searchClause = tx`and 1 = 0`;
          } else {
            const mac = await blindIndex(
              keys.bidx,
              "people.phone",
              new TextEncoder().encode(normPhone),
            );
            searchClause = tx`and phone_bidx = ${mac}`;
          }
        }
      } else {
        const pattern = `${escapeLike(term)}%`;
        searchClause = tx`and (given_name ilike ${pattern} or family_name ilike ${pattern})`;
      }
    }

    const statusClause = input.status !== undefined ? tx`and status = ${input.status}` : tx``;
    const sourceClause = input.source !== undefined ? tx`and source = ${input.source}` : tx``;
    const personIdsClause =
      input.personIds !== undefined ? tx`and id = any(${input.personIds}::uuid[])` : tx``;

    const rows = await tx<
      {
        id: string;
        given_name: string | null;
        family_name: string | null;
        version: number;
        status: PersonStatus;
        source: PersonSource;
        created_at: Date | string;
        date_of_birth: Uint8Array | null;
        email: Uint8Array | null;
        phone: Uint8Array | null;
      }[]
    >`
      select
        id::text as id,
        given_name,
        family_name,
        version,
        status,
        source,
        created_at,
        date_of_birth,
        email,
        phone
      from app.persons
      where org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
        and is_minor = false
        and deleted_at is null
        ${cursorClause}
        ${searchClause}
        ${statusClause}
        ${sourceClause}
        ${personIdsClause}
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

    if (pageRows.length > 0) {
      await appendAuditEvent(tx, {
        actorKind: "user",
        actorId: input.actorUserId,
        action: "people.person.listed",
        purpose: "people.person.listed",
        targetIds: pageRows.map((r) => r.id),
      });
    }

    const hasCiphertext = pageRows.some(
      (r) => r.email !== null || r.phone !== null || r.date_of_birth !== null,
    );

    let keys: PersonFieldKeys | null = null;
    let communityId: string | null = null;
    if (hasCiphertext) {
      keys = await getKeys();
      if (keys === null) {
        throw new Error("community key is missing");
      }
      const communityRows = await tx<{ community_id: string }[]>`
        select current_setting('app.community_id') as community_id
      `;
      communityId = communityRows[0]?.community_id ?? null;
      if (communityId === null) {
        throw new Error("tenant setting is missing");
      }
    }

    const items: AdultListItem[] = [];
    for (const r of pageRows) {
      let email: string | null = null;
      let phone: string | null = null;
      let age: number | null = null;
      if (keys !== null && communityId !== null) {
        email = await openField(r.email, keys.enc, r.id, communityId, "people.email");
        phone = await openField(r.phone, keys.enc, r.id, communityId, "people.phone");
        const dob = await openField(
          r.date_of_birth,
          keys.enc,
          r.id,
          communityId,
          "people.date_of_birth",
        );
        age = ageOn(dob, now);
      }
      const createdAt =
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : new Date(r.created_at).toISOString();
      items.push({
        id: r.id,
        personId: r.id,
        isMinor: false,
        givenName: r.given_name ?? "",
        familyName: r.family_name ?? "",
        version: r.version,
        email,
        phone,
        age,
        createdAt,
        status: r.status,
        source: r.source,
      });
    }

    return { items, nextCursor };
  }

  // Minors mode
  if (input.includeRestricted !== true) {
    throw new PeopleError("invalid_input");
  }

  let cursorClause = tx``;
  if (typeof input.cursor === "string" && input.cursor.length > 0) {
    const c = parseMinorCursor(input.cursor);
    cursorClause = tx`and id > ${c.i}::uuid`;
  }

  const rows = await tx<
    {
      id: string;
      version: number;
    }[]
  >`
    select id::text as id, version
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
  const versionMap = new Map(pageRows.map((r) => [r.id, r.version]));
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
    const version = versionMap.get(id);
    if (version === undefined) {
      throw new Error("minor version is missing");
    }
    return {
      id,
      personId: id,
      isMinor: true,
      givenName: r?.givenName ?? "",
      familyName: r?.familyName ?? "",
      version,
    };
  });

  return { items, nextCursor };
}
