import type { webcrypto } from "node:crypto";

import { blindIndex, encrypt, type KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import {
  birthdayMd,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  resolveAge,
} from "../domain/person.js";
import { derivePersonFieldKeys } from "./person-keys.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UpdatePersonChanges = {
  givenName?: string;
  familyName?: string;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
};

export type UpdatePersonInput = {
  personId: string;
  version: number;
  changes: UpdatePersonChanges;
  actorUserId: string | null;
  now?: Date;
};

export type UpdatePersonResult = {
  version: number;
};

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
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

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "23505") {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
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

export async function updatePerson(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: UpdatePersonInput,
): Promise<UpdatePersonResult> {
  if (typeof input.personId !== "string" || !UUID_RE.test(input.personId)) {
    throw new PeopleError("invalid_input");
  }
  if (typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 1) {
    throw new PeopleError("invalid_input");
  }
  if (
    input.actorUserId !== null &&
    (typeof input.actorUserId !== "string" || !UUID_RE.test(input.actorUserId))
  ) {
    throw new PeopleError("invalid_input");
  }
  if (
    typeof input.changes !== "object" ||
    input.changes === null ||
    Object.keys(input.changes).length === 0
  ) {
    throw new PeopleError("invalid_input");
  }

  // Look up existing person in current tenant scope
  const existingRows = await tx<
    {
      id: string;
      version: number;
      is_minor: boolean;
    }[]
  >`
    select
      id::text as id,
      version,
      is_minor
    from app.persons
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;

  const existing = existingRows[0];
  if (existing === undefined) {
    throw new PeopleError("not_found");
  }
  if (existing.is_minor) {
    throw new PeopleError("not_found");
  }
  if (existing.version !== input.version) {
    throw new PeopleError("conflict");
  }

  const { changes } = input;
  const now = input.now ?? new Date();

  const givenName = changes.givenName !== undefined ? normaliseName(changes.givenName) : undefined;
  const familyName =
    changes.familyName !== undefined ? normaliseName(changes.familyName) : undefined;
  const email =
    changes.email !== undefined
      ? changes.email === null
        ? null
        : normaliseEmail(changes.email)
      : undefined;
  const phone =
    changes.phone !== undefined
      ? changes.phone === null
        ? null
        : normalisePhone(changes.phone)
      : undefined;

  let dobDate: string | null | undefined = undefined;
  let monthDay: number | null | undefined = undefined;
  let ageBasis: string | undefined = undefined;
  if (changes.dateOfBirth !== undefined) {
    if (changes.dateOfBirth === null) {
      dobDate = null;
      monthDay = null;
      ageBasis = "declared_adult";
    } else {
      const age = resolveAge(changes.dateOfBirth, true, now);
      if (age.isMinor) {
        throw new PeopleError("invalid_declaration");
      }
      dobDate = changes.dateOfBirth;
      monthDay = birthdayMd(changes.dateOfBirth);
      ageBasis = age.ageBasis;
    }
  }

  if (
    givenName === undefined &&
    familyName === undefined &&
    email === undefined &&
    phone === undefined &&
    dobDate === undefined
  ) {
    throw new PeopleError("invalid_input");
  }

  let emailBytes: Uint8Array | null | undefined = undefined;
  let emailBidx: Uint8Array | null | undefined = undefined;
  let phoneBytes: Uint8Array | null | undefined = undefined;
  let phoneBidx: Uint8Array | null | undefined = undefined;
  let dobBytes: Uint8Array | null | undefined = undefined;

  const needsCrypto = email !== undefined || phone !== undefined || dobDate !== undefined;

  if (needsCrypto) {
    const communityId = await setting(tx, "app.community_id");
    const keys = await derivePersonFieldKeys(tx, kms, keyArn, {
      isMinor: false,
      householdId: null,
    });
    const fieldKeyId = (
      await tx<{ id: string }[]>`
        select id::text as id from app.community_keys where community_id = ${communityId}::uuid
      `
    )[0]?.id;
    if (fieldKeyId === undefined) {
      throw new Error("field key is missing");
    }

    if (email !== undefined) {
      emailBytes = await seal(
        keys.enc,
        fieldKeyId,
        input.personId,
        communityId,
        "people.email",
        email,
      );
      emailBidx = await indexOf(keys.bidx, "people.email", email);
    }
    if (phone !== undefined) {
      phoneBytes = await seal(
        keys.enc,
        fieldKeyId,
        input.personId,
        communityId,
        "people.phone",
        phone,
      );
      phoneBidx = await indexOf(keys.bidx, "people.phone", phone);
    }
    if (dobDate !== undefined) {
      dobBytes = await seal(
        keys.enc,
        fieldKeyId,
        input.personId,
        communityId,
        "people.date_of_birth",
        dobDate,
      );
    }
  }

  let newVersion = 0;
  try {
    await tx.savepoint("person_update", async (sp) => {
      const givenClause = givenName !== undefined ? sp`, given_name = ${givenName}` : sp``;
      const familyClause = familyName !== undefined ? sp`, family_name = ${familyName}` : sp``;
      const emailClause =
        email !== undefined
          ? sp`, ${sp("email")} = ${emailBytes ?? null}, email_bidx = ${emailBidx ?? null}`
          : sp``;
      const phoneClause =
        phone !== undefined
          ? sp`, ${sp("phone")} = ${phoneBytes ?? null}, phone_bidx = ${phoneBidx ?? null}`
          : sp``;
      const dobClause =
        dobDate !== undefined
          ? sp`, ${sp("date_of_birth")} = ${dobBytes ?? null}, birthday_md = ${monthDay ?? null}, age_basis = ${ageBasis ?? null}`
          : sp``;

      const updated = await sp<{ version: number }[]>`
        update app.persons
        set
          version = version + 1
          ${givenClause}
          ${familyClause}
          ${emailClause}
          ${phoneClause}
          ${dobClause}
        where id = ${input.personId}::uuid
          and org_id = current_setting('app.org_id')::uuid
          and community_id = current_setting('app.community_id')::uuid
          and is_minor = false
          and version = ${input.version}
        returning version
      `;
      if (updated[0] === undefined) {
        throw new PeopleError("conflict");
      }
      newVersion = updated[0].version;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PeopleError("conflict");
    }
    throw error;
  }

  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: "people.person.updated",
    purpose: "people.person.updated",
    targetIds: [input.personId],
  });

  return { version: newVersion };
}
