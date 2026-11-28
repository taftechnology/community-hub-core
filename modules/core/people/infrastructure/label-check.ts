import type { KmsPort } from "@community-hub/crypto";
import type { AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import { openField } from "./household.js";
import { derivePersonFieldKeys } from "./person-keys.js";

// A family's label may not hold a child's given name (spec D5, O3). Everyone who may read the family
// reads its label, while a child's name is otherwise opened only by the Community Admin's View.
//
// It is the one decrypt of a child's field outside that View, and it returns nothing. The names are
// compared in memory inside the write transaction, never in SQL, and are never returned, logged or
// audited; a refusal carries the code alone. A child's family name is never read. It is internal to
// people (not exported from public/): renameHousehold and createPerson's minor branch call it.

// The field label a child's given name was sealed under (part of the ciphertext's context).
const GIVEN_NAME = "people.given_name";

// A given name is split on white space and hyphens, and the parts of two or more letters count.
const SEPARATORS = /[\p{White_Space}\p{Pd}]+/u;
const LETTER = /\p{L}/gu;
const MIN_LETTERS = 2;

// Case, compatibility forms (full-width letters) and accents do not matter: "Zoë" and "Zoe" are one
// name. The text is decomposed (NFKD), its combining marks are dropped, and it is composed again
// (NFKC) before the case is folded. Both sides, the label and every given name, go through here.
const COMBINING_MARKS = /\p{M}/gu;

function normalise(value: string): string {
  return value
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .normalize("NFKC")
    .toLocaleLowerCase("und");
}

function nameParts(givenName: string): string[] {
  return normalise(givenName)
    .split(SEPARATORS)
    .filter((part) => (part.match(LETTER)?.length ?? 0) >= MIN_LETTERS);
}

// True when the part stands in the text as a whole word: no letter right before it or after it.
function hasWord(text: string, part: string): boolean {
  const escaped = part.replace(/[\^$\\.*+?()[\]{}|/]/g, "\\$&");
  return new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, "u").test(text);
}

// The given names of the family's children, hidden children included until they are purged.
async function childGivenNames(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  householdId: string,
): Promise<string[]> {
  const rows = await tx<
    { id: string; community_id: string; given_name_restricted: Uint8Array | null }[]
  >`
    select id::text as id, community_id::text as community_id, given_name_restricted
    from app.persons
    where household_id = ${householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = true
  `;
  if (rows.length === 0) {
    return [];
  }
  const { enc } = await derivePersonFieldKeys(tx, kms, keyArn, { isMinor: true, householdId });
  const names: string[] = [];
  for (const row of rows) {
    const name = await openField(
      row.given_name_restricted,
      enc,
      row.id,
      row.community_id,
      GIVEN_NAME,
    );
    if (name !== null) {
      names.push(name);
    }
  }
  return names;
}

// The given names of the family's adults who are not hidden (a clear column).
async function adultGivenNames(tx: AppTransaction, householdId: string): Promise<string[]> {
  const rows = await tx<{ given_name: string | null }[]>`
    select given_name
    from app.persons
    where household_id = ${householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and is_minor = false
      and deleted_at is null
  `;
  return rows.flatMap((row) => (row.given_name === null ? [] : [row.given_name]));
}

export async function assertLabelFreeOfChildNames(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: { householdId: string; label: string; newChildGivenName?: string },
): Promise<void> {
  const children = await childGivenNames(tx, kms, keyArn, input.householdId);
  if (input.newChildGivenName !== undefined) {
    children.push(input.newChildGivenName);
  }
  // A part that is also part of an adult's given name is skipped: the label then says only what a
  // reader of the family already sees about that adult.
  const shared = new Set((await adultGivenNames(tx, input.householdId)).flatMap(nameParts));
  const childParts = children.flatMap(nameParts).filter((part) => !shared.has(part));
  const label = normalise(input.label);
  if (childParts.some((part) => hasWord(label, part))) {
    throw new PeopleError("label_contains_child_name");
  }
}
