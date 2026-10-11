import type { webcrypto } from "node:crypto";

import { blindIndex, decrypt, encrypt, type Ciphertext, type KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, newId, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import {
  type AgeBasis,
  birthdayMd,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  resolveAge,
} from "../domain/person.js";
import { derivePersonFieldKeys } from "./person-keys.js";

const PERSON_CREATED = "people.person.created";
const PERSON_READ = "people.person.read";

type PersonInput = {
  now: Date;
  declaredAdult: boolean;
  householdId: string | null;
  dateOfBirth: string | null;
  givenName: string;
  familyName: string;
  email: string | null;
  phone: string | null;
  actorUserId: string | null;
};

type StoredPerson = {
  id: string;
  household_id: string | null;
  is_minor: boolean;
  age_basis: string;
  birthday_md: number | null;
  given_name: string | null;
  family_name: string | null;
  given_name_restricted: Uint8Array | null;
  family_name_restricted: Uint8Array | null;
  date_of_birth: Uint8Array | null;
  email: Uint8Array | null;
  phone: Uint8Array | null;
};

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function asCiphertext(bytes: Uint8Array): Ciphertext {
  return bytes as never;
}

function ageBasisOf(value: string): AgeBasis {
  if (value === "date_of_birth" || value === "declared_adult" || value === "unknown") {
    return value;
  }
  throw new Error("age basis is missing");
}

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
}

function duplicateError(error: unknown): PeopleError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      typeof current.constraint_name === "string"
    ) {
      if (current.constraint_name.includes("email")) {
        return new PeopleError("duplicate_email");
      }
      if (current.constraint_name.includes("phone")) {
        return new PeopleError("duplicate_phone");
      }
      return undefined;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

async function setting(tx: AppTransaction, name: "app.community_id"): Promise<string> {
  const rows = await tx<{ value: string }[]>`
    select current_setting(${name}) as value
  `;
  const value = rows[0]?.value;
  if (value === undefined || value.length === 0) {
    throw new Error("tenant setting is missing");
  }
  return value;
}

async function requireHousehold(tx: AppTransaction, householdId: string): Promise<void> {
  const rows = await tx<{ id: string }[]>`
    select id::text as id from app.households where id = ${householdId}::uuid
  `;
  if (rows[0] === undefined) {
    throw new PeopleError("not_found");
  }
}

async function seal(
  enc: webcrypto.CryptoKey,
  keyId: string,
  personId: string,
  communityId: string,
  label: string,
  value: string | null,
): Promise<Uint8Array | null> {
  if (value === null) {
    return null;
  }
  const ciphertext = await encrypt(enc, new TextEncoder().encode(value), uuidToBytes(keyId), {
    tag: "chub/field/v1",
    label,
    rowId: uuidToBytes(personId),
    communityId: uuidToBytes(communityId),
  });
  const bytes: Uint8Array = ciphertext;
  return bytes;
}

async function indexOf(
  bidx: webcrypto.CryptoKey,
  purpose: "people.email" | "people.phone",
  value: string | null,
): Promise<Uint8Array | null> {
  if (value === null) {
    return null;
  }
  const mac = await blindIndex(bidx, purpose, new TextEncoder().encode(value));
  const bytes: Uint8Array = mac;
  return bytes;
}

async function openField(
  bytes: Uint8Array | null,
  enc: webcrypto.CryptoKey,
  personId: string,
  communityId: string,
  label: string,
): Promise<string | null> {
  if (bytes === null) {
    return null;
  }
  const plain = await decrypt(asCiphertext(bytes), async () => enc, {
    tag: "chub/field/v1",
    label,
    rowId: uuidToBytes(personId),
    communityId: uuidToBytes(communityId),
  });
  return new TextDecoder().decode(plain);
}

export async function createPerson(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: PersonInput,
): Promise<{ personId: string; isMinor: boolean }> {
  const age = resolveAge(input.dateOfBirth, input.declaredAdult, input.now);
  const minor = age.isMinor;
  const monthDay = birthdayMd(input.dateOfBirth);
  if (minor && input.householdId === null) {
    throw new PeopleError("household_required");
  }
  if (input.householdId !== null) {
    await requireHousehold(tx, input.householdId);
  }
  const givenName = normaliseName(input.givenName);
  const familyName = normaliseName(input.familyName);
  const email = input.email === null ? null : normaliseEmail(input.email);
  const phone = input.phone === null ? null : normalisePhone(input.phone);
  const personId = newId();
  const communityId = await setting(tx, "app.community_id");
  const keys = await derivePersonFieldKeys(tx, kms, keyArn, {
    isMinor: minor,
    householdId: input.householdId,
  });
  const keyId = minor ? input.householdId : communityId;
  if (keyId === null) {
    throw new PeopleError("household_required");
  }
  const fieldKeyId = (
    await (minor
      ? tx<{ id: string }[]>`
          select id::text as id from app.household_keys where household_id = ${keyId}::uuid
        `
      : tx<{ id: string }[]>`
          select id::text as id from app.community_keys where community_id = ${keyId}::uuid
        `)
  )[0]?.id;
  if (fieldKeyId === undefined) {
    throw new Error("field key is missing");
  }
  const givenRestricted = minor
    ? await seal(keys.enc, fieldKeyId, personId, communityId, "people.given_name", givenName)
    : null;
  const familyRestricted = minor
    ? await seal(keys.enc, fieldKeyId, personId, communityId, "people.family_name", familyName)
    : null;
  const dateOfBirth = await seal(
    keys.enc,
    fieldKeyId,
    personId,
    communityId,
    "people.date_of_birth",
    input.dateOfBirth,
  );
  const emailBytes = await seal(keys.enc, fieldKeyId, personId, communityId, "people.email", email);
  const phoneBytes = await seal(keys.enc, fieldKeyId, personId, communityId, "people.phone", phone);
  const emailBidx = await indexOf(keys.bidx, "people.email", email);
  const phoneBidx = await indexOf(keys.bidx, "people.phone", phone);
  const clearGiven = minor ? null : givenName;
  const clearFamily = minor ? null : familyName;
  try {
    await tx.savepoint("person_insert", async (sp) => {
      await sp`
        insert into app.persons (
          id, org_id, community_id, household_id, is_minor, age_basis, birthday_md,
          given_name, family_name, given_name_restricted, family_name_restricted,
          date_of_birth, email, email_bidx, phone, phone_bidx
        ) values (
          ${personId}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${input.householdId}::uuid,
          ${minor},
          ${age.ageBasis},
          ${monthDay},
          ${clearGiven},
          ${clearFamily},
          ${givenRestricted},
          ${familyRestricted},
          ${dateOfBirth},
          ${emailBytes},
          ${emailBidx},
          ${phoneBytes},
          ${phoneBidx}
        )
      `;
      const activityId = newId();
      await sp`
        insert into app.person_activity (
          id, org_id, community_id, person_id, actor_user_id, kind, occurred_at
        ) values (
          ${activityId}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${personId}::uuid,
          ${input.actorUserId}::uuid,
          'created',
          ${input.now}
        )
      `;
    });
  } catch (error) {
    const duplicate = duplicateError(error);
    if (duplicate !== undefined) {
      throw duplicate;
    }
    throw error;
  }
  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: PERSON_CREATED,
    purpose: PERSON_CREATED,
    targetIds: [personId],
  });
  return { personId, isMinor: minor };
}

export async function readPerson(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: { personId: string; actorUserId: string | null },
): Promise<{
  personId: string;
  householdId: string | null;
  isMinor: boolean;
  ageBasis: AgeBasis;
  birthdayMd: number | null;
  givenName: string;
  familyName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
} | null> {
  const rows = await tx<StoredPerson[]>`
    select
      id::text as id,
      household_id::text as household_id,
      is_minor,
      age_basis,
      birthday_md,
      given_name,
      family_name,
      given_name_restricted,
      family_name_restricted,
      date_of_birth,
      email,
      phone
    from app.persons
    where id = ${input.personId}::uuid
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const communityId = await setting(tx, "app.community_id");
  const keys = await derivePersonFieldKeys(tx, kms, keyArn, {
    isMinor: row.is_minor,
    householdId: row.household_id,
  });
  const givenName = row.is_minor
    ? await openField(row.given_name_restricted, keys.enc, row.id, communityId, "people.given_name")
    : row.given_name;
  const familyName = row.is_minor
    ? await openField(
        row.family_name_restricted,
        keys.enc,
        row.id,
        communityId,
        "people.family_name",
      )
    : row.family_name;
  if (givenName === null || familyName === null) {
    throw new Error("person name is missing");
  }
  const email = await openField(row.email, keys.enc, row.id, communityId, "people.email");
  const phone = await openField(row.phone, keys.enc, row.id, communityId, "people.phone");
  const dateOfBirth = await openField(
    row.date_of_birth,
    keys.enc,
    row.id,
    communityId,
    "people.date_of_birth",
  );
  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: PERSON_READ,
    purpose: PERSON_READ,
    targetIds: [row.id],
  });
  return {
    personId: row.id,
    householdId: row.household_id,
    isMinor: row.is_minor,
    ageBasis: ageBasisOf(row.age_basis),
    birthdayMd: row.birthday_md,
    givenName,
    familyName,
    email,
    phone,
    dateOfBirth,
  };
}
