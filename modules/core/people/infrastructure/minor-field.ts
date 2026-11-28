import type { KmsPort } from "@community-hub/crypto";
import type { AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import { derivePersonFieldKeys } from "./person-keys.js";
import { openField } from "./person.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MinorPersonField = "name" | "dateOfBirth" | "email" | "phone";
export type MinorLifeEventField = "type" | "date" | "place" | "notes";

// A child's name is two parts. Either can be null: this reader answers an empty part as null and
// never throws for it.
export type MinorName = {
  given: string | null;
  family: string | null;
};

export type OpenMinorPersonFieldInput = {
  personId: string;
  field: MinorPersonField;
};

export type OpenMinorLifeEventFieldInput = {
  personId: string;
  lifeEventId: string;
  field: MinorLifeEventField;
};

export type OpenMinorFieldInput = OpenMinorPersonFieldInput | OpenMinorLifeEventFieldInput;

const PERSON_FIELDS: ReadonlySet<string> = new Set<MinorPersonField>([
  "name",
  "dateOfBirth",
  "email",
  "phone",
]);
const LIFE_EVENT_FIELDS: ReadonlySet<string> = new Set<MinorLifeEventField>([
  "type",
  "date",
  "place",
  "notes",
]);

// The field labels the values were sealed under (they are part of the ciphertext's context).
const LABEL_GIVEN = "people.given_name";
const LABEL_FAMILY = "people.family_name";
const LABEL_DATE_OF_BIRTH = "people.date_of_birth";
const LABEL_EMAIL = "people.email";
const LABEL_PHONE = "people.phone";
const LABEL_EVENT_TYPE = "people.life_event_type";
const LABEL_EVENT_DATE = "people.life_event_date";
const LABEL_EVENT_PLACE = "people.life_event_place";
const LABEL_EVENT_NOTES = "people.life_event_notes";

// The one reader that opens a child's field (ADR 0017, plan P1). It opens exactly one field of one
// child, under the child's household key, and returns that value and nothing else. It is exported
// for the Community Admin's View service, and a static test (pin 41) keeps every other file from
// importing it. It does not decide who may call it: the caller has run isCommunityAdmin in the
// same transaction. It writes no audit row; the View service audits, with ids only.
//
// Anything that is not a child who is not hidden is not found, and so is a life event that is not
// that child's: the answer is the same PeopleError("not_found") whichever it is, with no value.
export async function openMinorField(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: { personId: string; field: "name" },
): Promise<MinorName>;
export async function openMinorField(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: { personId: string; field: "dateOfBirth" | "email" | "phone" },
): Promise<string | null>;
export async function openMinorField(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: OpenMinorLifeEventFieldInput,
): Promise<string | null>;
export async function openMinorField(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: OpenMinorFieldInput,
): Promise<MinorName | string | null>;
export async function openMinorField(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: OpenMinorFieldInput,
): Promise<MinorName | string | null> {
  if (typeof input.personId !== "string" || !UUID_RE.test(input.personId)) {
    throw new PeopleError("invalid_input");
  }
  if (Object.prototype.hasOwnProperty.call(input, "lifeEventId")) {
    const eventInput = input as OpenMinorLifeEventFieldInput;
    if (
      typeof eventInput.lifeEventId !== "string" ||
      !UUID_RE.test(eventInput.lifeEventId) ||
      !LIFE_EVENT_FIELDS.has(eventInput.field)
    ) {
      throw new PeopleError("invalid_input");
    }
    return openLifeEventField(tx, kms, keyArn, eventInput);
  }
  if (!PERSON_FIELDS.has(input.field)) {
    throw new PeopleError("invalid_input");
  }
  return openPersonField(tx, kms, keyArn, input as OpenMinorPersonFieldInput);
}

async function openPersonField(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: OpenMinorPersonFieldInput,
): Promise<MinorName | string | null> {
  // The child is loaded under the tenant scope: a child of another community or organisation is a
  // missing row. A hidden child and an adult are not children for this reader.
  const rows = await tx<
    {
      id: string;
      community_id: string;
      household_id: string | null;
      given_name_restricted: Uint8Array | null;
      family_name_restricted: Uint8Array | null;
      date_of_birth: Uint8Array | null;
      email: Uint8Array | null;
      phone: Uint8Array | null;
    }[]
  >`
    select
      id::text as id,
      community_id::text as community_id,
      household_id::text as household_id,
      given_name_restricted,
      family_name_restricted,
      date_of_birth,
      email,
      phone
    from app.persons
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = true
      and deleted_at is null
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new PeopleError("not_found");
  }
  const { enc } = await derivePersonFieldKeys(tx, kms, keyArn, {
    isMinor: true,
    householdId: row.household_id,
  });
  switch (input.field) {
    case "name":
      return {
        given: await openField(
          row.given_name_restricted,
          enc,
          row.id,
          row.community_id,
          LABEL_GIVEN,
        ),
        family: await openField(
          row.family_name_restricted,
          enc,
          row.id,
          row.community_id,
          LABEL_FAMILY,
        ),
      };
    case "dateOfBirth":
      return openField(row.date_of_birth, enc, row.id, row.community_id, LABEL_DATE_OF_BIRTH);
    case "email":
      return openField(row.email, enc, row.id, row.community_id, LABEL_EMAIL);
    case "phone":
      return openField(row.phone, enc, row.id, row.community_id, LABEL_PHONE);
  }
}

async function openLifeEventField(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: OpenMinorLifeEventFieldInput,
): Promise<string | null> {
  const people = await tx<{ household_id: string | null }[]>`
    select household_id::text as household_id
    from app.persons
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = true
      and deleted_at is null
  `;
  const person = people[0];
  if (person === undefined) {
    throw new PeopleError("not_found");
  }
  // The event has to be this child's own: a sibling's event is under the same household key, so
  // the person match is what keeps one child's id from opening another child's event.
  const events = await tx<
    {
      id: string;
      community_id: string;
      event_type: Uint8Array;
      event_date: Uint8Array;
      place: Uint8Array | null;
      notes: Uint8Array | null;
    }[]
  >`
    select
      id::text as id,
      community_id::text as community_id,
      event_type,
      event_date,
      place,
      notes
    from app.life_events
    where id = ${input.lifeEventId}::uuid
      and person_id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const event = events[0];
  if (event === undefined) {
    throw new PeopleError("not_found");
  }
  const { enc } = await derivePersonFieldKeys(tx, kms, keyArn, {
    isMinor: true,
    householdId: person.household_id,
  });
  // The row id in the ciphertext's context is the event's id, as when it was sealed.
  switch (input.field) {
    case "type":
      return openField(event.event_type, enc, event.id, event.community_id, LABEL_EVENT_TYPE);
    case "date":
      return openField(event.event_date, enc, event.id, event.community_id, LABEL_EVENT_DATE);
    case "place":
      return openField(event.place, enc, event.id, event.community_id, LABEL_EVENT_PLACE);
    case "notes":
      return openField(event.notes, enc, event.id, event.community_id, LABEL_EVENT_NOTES);
  }
}
