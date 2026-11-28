import type { KmsPort } from "@community-hub/crypto";
import type { AppTransaction } from "@community-hub/db";

import { isChildView, type ChildView } from "../domain/child-view.js";
import { PeopleError } from "../domain/error.js";
import { childLabels } from "./child-labels.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReadRosterNamesInput = {
  personIds: string[];
  // Required, with no default. "admin" is passed only by code that has just asked
  // isCommunityAdmin; everyone else passes "presence".
  childView: ChildView;
  actorUserId: string;
};

// An adult, by name. This is the row as it always was.
export type RosterPerson = {
  personId: string;
  isMinor: false;
  givenName: string;
  familyName: string;
};

// A child, for a Community Admin: an id and the label childLabels gives it. Never a name.
export type RosterChild = {
  personId: string;
  label: string;
};

export type ReadRosterNamesResult = {
  adults: RosterPerson[];
  // Under "admin", each child that exists and is not hidden. Always empty under "presence".
  children: RosterChild[];
  // The children among the requested ids that exist and are not hidden, under both views.
  minorCount: number;
};

// The names of the requested people, for a roster. An adult's name is in clear columns. A child is
// never named: under "presence" a child is only counted, and under "admin" a child is an id and a
// label. Nothing here opens a key or decrypts a field, so `kms` and `keyArn` are not used; they
// stay in the signature so that a caller does not change with the view.
export async function readRosterNames(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ReadRosterNamesInput,
): Promise<ReadRosterNamesResult> {
  if (!isChildView(input.childView)) {
    throw new PeopleError("invalid_input");
  }

  if (typeof input.actorUserId !== "string" || !UUID_RE.test(input.actorUserId)) {
    throw new PeopleError("invalid_input");
  }

  if (
    !Array.isArray(input.personIds) ||
    input.personIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))
  ) {
    throw new PeopleError("invalid_input");
  }

  const ids = [...new Set(input.personIds)];
  if (ids.length === 0) {
    return { adults: [], children: [], minorCount: 0 };
  }

  const rows = await tx<
    {
      id: string;
      is_minor: boolean;
      household_id: string | null;
      given_name: string | null;
      family_name: string | null;
    }[]
  >`
    select
      id::text as id,
      is_minor,
      household_id::text as household_id,
      given_name,
      family_name
    from app.persons
    where id = any(${ids}::uuid[])
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and deleted_at is null
  `;

  const adults: RosterPerson[] = [];
  const minors: { personId: string; householdId: string | null }[] = [];
  for (const row of rows) {
    if (row.is_minor) {
      minors.push({ personId: row.id, householdId: row.household_id });
    } else {
      adults.push({
        personId: row.id,
        isMinor: false,
        givenName: row.given_name ?? "",
        familyName: row.family_name ?? "",
      });
    }
  }

  if (input.childView === "presence") {
    return { adults, children: [], minorCount: minors.length };
  }

  // A Community Admin's view: each child is an id and its label, from clear columns.
  const householdIds = [
    ...new Set(minors.flatMap((minor) => (minor.householdId === null ? [] : [minor.householdId]))),
  ];
  const labelOf = new Map(
    (await childLabels(tx, householdIds)).map((entry) => [entry.personId, entry.label]),
  );
  const children: RosterChild[] = [];
  for (const minor of minors) {
    const label = labelOf.get(minor.personId);
    // A child with no label was hidden between the two reads: it is not listed or counted.
    if (label !== undefined) {
      children.push({ personId: minor.personId, label });
    }
  }
  return { adults, children, minorCount: children.length };
}

export type VisiblePersonIdsOptions = {
  // Required, with no default. Under "presence" a child's id is never returned.
  childView: ChildView;
  lock?: "share";
};

// The subset of ids that exist in the current scope and are not hidden, in the order given. Under
// "presence" a child's id is left out, as if the child were hidden: only a Community Admin's view
// ("admin") keeps it. Groups uses it to leave hidden contacts, and children for anyone else, out
// of its own reads. A write passes { lock: "share" } to read the contacts FOR SHARE in id order,
// so it waits for a delete in flight; the read callers stay unlocked.
export async function visiblePersonIds(
  tx: AppTransaction,
  ids: string[],
  options: VisiblePersonIdsOptions,
): Promise<string[]> {
  if (typeof options !== "object" || options === null || !isChildView(options.childView)) {
    throw new PeopleError("invalid_input");
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
    throw new PeopleError("invalid_input");
  }
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) {
    return [];
  }
  // One statement either way: a child is in the answer only for a Community Admin's view.
  const withChildren = options.childView === "admin";
  const rows =
    options.lock === "share"
      ? await tx<{ id: string }[]>`
          select id::text as id
          from app.persons
          where id = any(${wanted}::uuid[])
            and org_id = current_setting('app.org_id')::uuid
            and community_id = current_setting('app.community_id')::uuid
            and deleted_at is null
            and (${withChildren}::boolean or is_minor = false)
          order by id asc
          for share
        `
      : await tx<{ id: string }[]>`
          select id::text as id
          from app.persons
          where id = any(${wanted}::uuid[])
            and org_id = current_setting('app.org_id')::uuid
            and community_id = current_setting('app.community_id')::uuid
            and deleted_at is null
            and (${withChildren}::boolean or is_minor = false)
        `;
  const found = new Set(rows.map((r) => r.id));
  return wanted.filter((id) => found.has(id));
}
