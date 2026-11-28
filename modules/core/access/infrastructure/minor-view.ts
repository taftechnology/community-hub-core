import { appendAuditEvent, type AppTransaction } from "@community-hub/db";
import {
  openMinorField,
  PeopleError,
  type MinorLifeEventField,
  type MinorName,
  type MinorPersonField,
} from "@community-hub/people";

import { AccessError } from "../domain/error.js";
import { parseUuid } from "../domain/role.js";
import { isCommunityAdmin } from "./community-admin.js";

// The Community Admin's View of one field of one child (ADR 0017, plan P3). It is the only caller
// of people's field opener (pin 41). The route runs the two functions in this order, with the
// identity service's fresh-check consume between them:
//
//   1. prepareMinorView: the role (403), then whether the child exists (404). Nothing is opened,
//      and nothing is used up.
//   2. consumeFreshFactor (identity).
//   3. finishMinorView: the role again (a grant can go between 1 and 3), then the one field, then
//      one audit row.
//
// Both throw an AccessError with a bare code: no value, name, label or id goes in a message. A
// refusal is audited here, so the route has to catch the error inside its transaction callback and
// return the response from there: an error that leaves the callback rolls the denial row back.

const DENIED = "access.permission.denied";
const FIELD_VIEWED = "people.minor.field_viewed";

// The audit purpose of each field. Three segments, as the audit table requires, and registered in
// public/index.ts. Own properties only: a field outside these tables is refused before anything is
// read.
const PERSON_PURPOSE: Readonly<Record<MinorPersonField, string>> = {
  name: "people.minor_view.name",
  dateOfBirth: "people.minor_view.date_of_birth",
  email: "people.minor_view.email",
  phone: "people.minor_view.phone",
};

const LIFE_EVENT_PURPOSE: Readonly<Record<MinorLifeEventField, string>> = {
  type: "people.minor_view.life_event_type",
  date: "people.minor_view.life_event_date",
  place: "people.minor_view.life_event_place",
  notes: "people.minor_view.life_event_notes",
};

type OpenMinorField = typeof openMinorField;

export type MinorViewInput =
  | { actorUserId: string; personId: string; field: MinorPersonField; lifeEventId?: undefined }
  | {
      actorUserId: string;
      personId: string;
      lifeEventId: string;
      field: MinorLifeEventField;
    };

// A child's name is two parts, each null when it is not recorded. Every other field is a string,
// or null when it is not recorded.
export type MinorViewValue = MinorName | string | null;

type Checked =
  | {
      kind: "person";
      actorUserId: string;
      personId: string;
      purpose: string;
      field: MinorPersonField;
    }
  | {
      kind: "life_event";
      actorUserId: string;
      personId: string;
      purpose: string;
      field: MinorLifeEventField;
      lifeEventId: string;
    };

// Checks the caller's own input only: the shape of the ids and which field is asked for. Nothing
// here depends on a record, so it tells a caller nothing about an id.
function checked(input: MinorViewInput): Checked {
  const actorUserId = parseUuid(input.actorUserId);
  const personId = parseUuid(input.personId);
  if (input.lifeEventId === undefined) {
    if (!Object.hasOwn(PERSON_PURPOSE, input.field)) {
      throw new PeopleError("invalid_input");
    }
    return {
      kind: "person",
      actorUserId,
      personId,
      purpose: PERSON_PURPOSE[input.field],
      field: input.field,
    };
  }
  if (!Object.hasOwn(LIFE_EVENT_PURPOSE, input.field)) {
    throw new PeopleError("invalid_input");
  }
  return {
    kind: "life_event",
    actorUserId,
    personId,
    purpose: LIFE_EVENT_PURPOSE[input.field],
    field: input.field,
    lifeEventId: parseUuid(input.lifeEventId),
  };
}

// The role comes before every lookup, so a caller who is not a Community Admin gets this one
// answer for a missing id, an adult and a child alike. The denial is one audit row: the person id
// the caller sent, and no value.
async function requireCommunityAdmin(tx: AppTransaction, target: Checked): Promise<void> {
  if (await isCommunityAdmin(tx, target.actorUserId)) {
    return;
  }
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: target.actorUserId,
    action: DENIED,
    purpose: target.purpose,
    targetIds: [target.personId],
  });
  throw new AccessError("forbidden");
}

export async function prepareMinorView(tx: AppTransaction, input: MinorViewInput): Promise<void> {
  const target = checked(input);
  await requireCommunityAdmin(tx, target);

  // Only a Community Admin gets here, and only a Community Admin learns whether an id is a child.
  // The child is a minor, not hidden, in the scoped community (RLS limits the organisation, and
  // the community is named for the same reason as in the field opener).
  const children = await tx<{ id: string }[]>`
    select id::text as id
    from app.persons
    where id = ${target.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = true
      and deleted_at is null
  `;
  if (children[0] === undefined) {
    throw new AccessError("not_found");
  }
  if (target.kind === "person") {
    return;
  }
  // A life event has to be that child's own.
  const events = await tx<{ id: string }[]>`
    select id::text as id
    from app.life_events
    where id = ${target.lifeEventId}::uuid
      and person_id = ${target.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  if (events[0] === undefined) {
    throw new AccessError("not_found");
  }
}

export async function finishMinorView(
  tx: AppTransaction,
  kms: Parameters<OpenMinorField>[1],
  keyArn: Parameters<OpenMinorField>[2],
  input: MinorViewInput,
): Promise<MinorViewValue> {
  const target = checked(input);
  // The role again: the check was used up between the two calls, and the grant may be gone.
  await requireCommunityAdmin(tx, target);

  let value: MinorViewValue;
  try {
    value = await openMinorField(
      tx,
      kms,
      keyArn,
      target.kind === "person"
        ? { personId: target.personId, field: target.field }
        : { personId: target.personId, lifeEventId: target.lifeEventId, field: target.field },
    );
  } catch (error) {
    // The child was hidden, moved or deleted since the first call: the same answer as a child that
    // was never there.
    if (error instanceof PeopleError && error.code === "not_found") {
      throw new AccessError("not_found");
    }
    throw error;
  }

  // One row per View, after the value was read: ids only. If this append fails the transaction
  // rolls back and no value leaves.
  await appendAuditEvent(tx, {
    actorKind: "user",
    actorId: target.actorUserId,
    action: FIELD_VIEWED,
    purpose: target.purpose,
    targetIds: target.kind === "person" ? [target.personId] : [target.personId, target.lifeEventId],
  });
  return value;
}
