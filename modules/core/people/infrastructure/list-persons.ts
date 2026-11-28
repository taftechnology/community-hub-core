import { blindIndex, type KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { type ChildView, isChildView } from "../domain/child-view.js";
import { PeopleError } from "../domain/error.js";
import {
  ageOn,
  normaliseEmail,
  normalisePhone,
  PERSON_SOURCES,
  type PersonSource,
  type PersonStatus,
} from "../domain/person.js";
import { childLabels } from "./child-labels.js";
import { openHouseholdLabel } from "./household.js";
import { existingCommunityFieldKeys, type PersonFieldKeys } from "./person-keys.js";
import { openField } from "./person.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ListAdultsInput = {
  kind?: "adults";
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

// Minors mode is the Community Admin's list of children, so childView is required and only
// "admin" is accepted: a caller that has not asked isCommunityAdmin has no business here.
export type ListMinorsInput = {
  kind: "minors";
  cursor?: string | null;
  limit?: number;
  actorUserId: string;
  childView: ChildView;
};

export type ListPersonsInput = ListAdultsInput | ListMinorsInput;

function isAdultsInput(input: ListPersonsInput): input is ListAdultsInput {
  return input.kind !== "minors";
}

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

// A child in the Community Admin's list: an id, a display label and the family. No field of the
// child is here, the name included. householdLabel is the family's own label, an adult-level
// field a Community Admin can already read.
export type MinorListItem = {
  personId: string;
  label: string;
  householdId: string;
  householdLabel: string | null;
};

export type PersonListItem = AdultListItem | MinorListItem;

export type ListAdultsResult = {
  items: AdultListItem[];
  nextCursor: string | null;
};

export type ListMinorsResult = {
  items: MinorListItem[];
  nextCursor: string | null;
};

export type ListPersonsResult = ListAdultsResult | ListMinorsResult;

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
// date of birth: a name, the two dates and the version are all the screen needs. A hidden child
// is never listed (is_minor = false): a child's name is encrypted and no reader but the Community
// Admin's View returns it.
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
  input: ListAdultsInput,
): Promise<ListAdultsResult>;
export async function listPersons(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ListMinorsInput,
): Promise<ListMinorsResult>;
export async function listPersons(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ListPersonsInput,
): Promise<ListPersonsResult>;
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

  if (isAdultsInput(input)) {
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

  return listChildren(tx, kms, keyArn, input, limit);
}

// The Community Admin's list of children: id, label, family. It decrypts no field of a child. The
// only thing opened is the family's label, which is an adult-level field.
async function listChildren(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ListMinorsInput,
  limit: number,
): Promise<ListMinorsResult> {
  if (!isChildView(input.childView) || input.childView !== "admin") {
    throw new PeopleError("invalid_input");
  }

  let cursorClause = tx``;
  if (typeof input.cursor === "string" && input.cursor.length > 0) {
    const c = parseMinorCursor(input.cursor);
    cursorClause = tx`and id > ${c.i}::uuid`;
  }

  const rows = await tx<{ id: string; household_id: string }[]>`
    select id::text as id, household_id::text as household_id
    from app.persons
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = true
      and deleted_at is null
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

  const householdIds = [...new Set(pageRows.map((r) => r.household_id))];
  const labelOf = new Map(
    (await childLabels(tx, householdIds)).map((entry) => [entry.personId, entry.label]),
  );
  const householdLabelOf = new Map<string, string | null>();
  for (const householdId of householdIds) {
    const opened = await openHouseholdLabel(tx, kms, keyArn, householdId);
    householdLabelOf.set(householdId, opened?.label ?? null);
  }

  const items: MinorListItem[] = [];
  for (const row of pageRows) {
    const label = labelOf.get(row.id);
    if (label === undefined) {
      // Hidden between the two reads: it is no longer in the list.
      continue;
    }
    items.push({
      personId: row.id,
      label,
      householdId: row.household_id,
      householdLabel: householdLabelOf.get(row.household_id) ?? null,
    });
  }

  return { items, nextCursor };
}
