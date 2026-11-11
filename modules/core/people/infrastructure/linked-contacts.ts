import type { webcrypto } from "node:crypto";

import { decrypt, deriveKeys, type Ciphertext, type KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import { openExistingCommunityHkdf } from "./keys.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export type ReadLinkedContactsInput = {
  personIds: readonly string[];
  includePhone: boolean;
  actorUserId: string;
};

export type LinkedContact =
  | { minor: true }
  | {
      minor: false;
      given: string;
      family: string;
      phone: string | null;
    };

export async function readLinkedContacts(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ReadLinkedContactsInput,
): Promise<Map<string, LinkedContact>> {
  if (input.personIds.length === 0) {
    return new Map();
  }

  if (input.personIds.length > 500) {
    throw new PeopleError("invalid_input");
  }

  if (typeof input.actorUserId !== "string" || !UUID_RE.test(input.actorUserId)) {
    throw new PeopleError("invalid_input");
  }

  for (const id of input.personIds) {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw new PeopleError("invalid_input");
    }
  }

  const ids = [...new Set(input.personIds)];

  const rows = await tx<
    {
      id: string;
      given_name: string | null;
      family_name: string | null;
      is_minor: boolean;
      phone: Uint8Array | null;
    }[]
  >`
    select
      id::text as id,
      given_name,
      family_name,
      is_minor,
      phone
    from app.persons
    where id = any(${ids}::uuid[])
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;

  if (rows.length === 0) {
    return new Map();
  }

  const adultsWithPhone = input.includePhone
    ? rows.filter((r) => !r.is_minor && r.phone !== null)
    : [];

  let encKey: webcrypto.CryptoKey | undefined;
  let communityId: string | undefined;

  if (adultsWithPhone.length > 0) {
    const { hkdf } = await openExistingCommunityHkdf(tx, kms, keyArn);
    const derived = await deriveKeys(hkdf);
    encKey = derived.enc;

    const settings = await tx<{ value: string }[]>`
      select current_setting('app.community_id') as value
    `;
    const cid = settings[0]?.value;
    if (cid === undefined || cid.length === 0) {
      throw new Error("tenant setting is missing");
    }
    communityId = cid;
  }

  const result = new Map<string, LinkedContact>();
  const openedPhonePersonIds: string[] = [];

  for (const row of rows) {
    if (row.is_minor) {
      result.set(row.id, { minor: true });
      continue;
    }

    if (row.given_name === null || row.family_name === null) {
      throw new Error("person name is missing");
    }

    let phone: string | null = null;
    if (
      input.includePhone &&
      row.phone !== null &&
      encKey !== undefined &&
      communityId !== undefined
    ) {
      phone = await openField(row.phone, encKey, row.id, communityId, "people.phone");
      openedPhonePersonIds.push(row.id);
    }

    result.set(row.id, {
      minor: false,
      given: row.given_name,
      family: row.family_name,
      phone,
    });
  }

  if (openedPhonePersonIds.length > 0) {
    await appendAuditEvent(tx, {
      actorKind: "user",
      actorId: input.actorUserId,
      action: "people.person.read",
      purpose: "people.person.read",
      targetIds: openedPhonePersonIds,
    });
  }

  return result;
}
