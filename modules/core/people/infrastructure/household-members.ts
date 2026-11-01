import type { KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import { isMinor } from "../domain/person.js";
import { linkGuardian, type GuardianInput } from "./guardian.js";
import { createPerson } from "./person.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSON_HOUSEHOLD_MOVED = "people.person.household_moved";

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
}

export type MoveAdultInput = {
  personId: string;
  version: number;
  householdId: string | null;
  actorUserId: string | null;
};

export type AddMinorInput = {
  now: Date;
  householdId: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  guardianId: string;
  rights?: {
    consent?: boolean;
    pickup?: boolean;
    view?: boolean;
    manage?: boolean;
  };
  actorUserId: string | null;
};

export async function moveAdult(
  tx: AppTransaction,
  input: MoveAdultInput,
): Promise<{ version: number }> {
  if (
    typeof input.personId !== "string" ||
    !UUID_RE.test(input.personId) ||
    typeof input.version !== "number" ||
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    (input.householdId !== null &&
      (typeof input.householdId !== "string" || !UUID_RE.test(input.householdId)))
  ) {
    throw new PeopleError("invalid_input");
  }

  // Pin 12: Verify target household inside scoped transaction
  if (input.householdId !== null) {
    const targetHouseholds = await tx<{ id: string }[]>`
      select id::text as id
      from app.households
      where id = ${input.householdId}::uuid
        and org_id = current_setting('app.org_id')::uuid
        and community_id = current_setting('app.community_id')::uuid
    `;
    if (targetHouseholds[0] === undefined) {
      throw new PeopleError("not_found");
    }
  }

  // Pin 23: Lock the person row for update before checking links
  const persons = await tx<
    {
      id: string;
      version: number;
      is_minor: boolean;
      household_id: string | null;
    }[]
  >`
    select
      id::text as id,
      version,
      is_minor,
      household_id::text as household_id
    from app.persons
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    for update
  `;
  const person = persons[0];
  if (person === undefined) {
    throw new PeopleError("not_found");
  }

  // Pin 6: Minors cannot move
  if (person.is_minor) {
    throw new PeopleError("minor_not_movable");
  }

  // Pin 8: Version check
  if (person.version !== input.version) {
    throw new PeopleError("conflict");
  }

  // Pin 5: Adult holding a guardian link cannot move
  const links = await tx<{ count: number }[]>`
    select count(*)::int as count
    from app.guardian_links
    where guardian_person_id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  if ((links[0]?.count ?? 0) > 0) {
    throw new PeopleError("adult_cannot_move_with_links");
  }

  const targetHouseholdUuid = input.householdId === null ? null : input.householdId;
  const updated = await tx<{ version: number }[]>`
    update app.persons
    set
      household_id = ${targetHouseholdUuid}::uuid,
      version = version + 1
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and version = ${input.version}
    returning version
  `;
  if (updated[0] === undefined) {
    throw new PeopleError("conflict");
  }

  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: PERSON_HOUSEHOLD_MOVED,
    purpose: PERSON_HOUSEHOLD_MOVED,
    targetIds: [input.personId, ...(input.householdId ? [input.householdId] : [])],
  });

  return { version: updated[0].version };
}

export async function addMinor(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: AddMinorInput,
): Promise<{ personId: string; linkId: string }> {
  const raw = input as { email?: unknown; phone?: unknown };
  if (
    (raw.email !== undefined && raw.email !== null) ||
    (raw.phone !== undefined && raw.phone !== null)
  ) {
    throw new PeopleError("invalid_input");
  }

  if (
    typeof input.householdId !== "string" ||
    !UUID_RE.test(input.householdId) ||
    typeof input.guardianId !== "string" ||
    !UUID_RE.test(input.guardianId) ||
    typeof input.dateOfBirth !== "string" ||
    !input.dateOfBirth ||
    typeof input.givenName !== "string" ||
    typeof input.familyName !== "string"
  ) {
    throw new PeopleError("invalid_input");
  }

  // Pin 6: Date of birth check BEFORE calling createPerson (under 18, resolved)
  if (!isMinor(input.dateOfBirth, input.now)) {
    throw new PeopleError("invalid_date");
  }

  // Pin 12: Verify target household inside scoped transaction
  const households = await tx<{ id: string }[]>`
    select id::text as id
    from app.households
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  if (households[0] === undefined) {
    throw new PeopleError("not_found");
  }

  // Create minor person
  const created = await createPerson(tx, kms, keyArn, {
    now: input.now,
    declaredAdult: false,
    householdId: input.householdId,
    dateOfBirth: input.dateOfBirth,
    givenName: input.givenName,
    familyName: input.familyName,
    email: null,
    phone: null,
    actorUserId: input.actorUserId,
  });

  // Pin 7: Link guardian inside the same transaction; rights default view and consent
  const linkInput: GuardianInput = {
    now: input.now,
    householdId: input.householdId,
    guardianPersonId: input.guardianId,
    childPersonId: created.personId,
    consent: input.rights?.consent ?? true,
    pickup: input.rights?.pickup ?? false,
    view: input.rights?.view ?? true,
    manage: input.rights?.manage ?? false,
    actorUserId: input.actorUserId,
  };
  const linked = await linkGuardian(tx, linkInput);

  return { personId: created.personId, linkId: linked.linkId };
}
