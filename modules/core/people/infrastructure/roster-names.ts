import type { webcrypto } from "node:crypto";

import { decrypt, type Ciphertext, type KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import { householdFieldKeys, type PersonFieldKeys } from "./person-keys.js";

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

export type ReadRosterNamesInput = {
  personIds: string[];
  includeRestricted: boolean;
  actorUserId: string;
};

export type RosterPerson = {
  personId: string;
  isMinor: boolean;
  givenName: string;
  familyName: string;
};

export async function readRosterNames(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ReadRosterNamesInput,
): Promise<RosterPerson[]> {
  if (typeof input.actorUserId !== "string" || !UUID_RE.test(input.actorUserId)) {
    throw new PeopleError("invalid_input");
  }

  const ids = [...new Set(input.personIds)].filter((id) => UUID_RE.test(id));
  if (ids.length === 0) {
    return [];
  }

  const rows = await tx<
    {
      id: string;
      is_minor: boolean;
      household_id: string | null;
      given_name: string | null;
      family_name: string | null;
      given_name_restricted: Uint8Array | null;
      family_name_restricted: Uint8Array | null;
    }[]
  >`
    select
      id::text as id,
      is_minor,
      household_id::text as household_id,
      given_name,
      family_name,
      given_name_restricted,
      family_name_restricted
    from app.persons
    where id = any(${ids}::uuid[])
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;

  if (rows.length === 0) {
    return [];
  }

  const householdKeyMap = new Map<string, PersonFieldKeys>();
  async function getHouseholdKeys(householdId: string): Promise<PersonFieldKeys> {
    let keys = householdKeyMap.get(householdId);
    if (keys === undefined) {
      keys = await householdFieldKeys(tx, kms, keyArn, householdId);
      householdKeyMap.set(householdId, keys);
    }
    return keys;
  }

  let communityId: string | null = null;
  async function getCommunityId(): Promise<string> {
    if (communityId === null) {
      communityId = await setting(tx, "app.community_id");
    }
    return communityId;
  }

  const decryptedTargetIds: string[] = [];
  const results: RosterPerson[] = [];

  for (const row of rows) {
    if (!row.is_minor) {
      results.push({
        personId: row.id,
        isMinor: false,
        givenName: row.given_name ?? "",
        familyName: row.family_name ?? "",
      });
      continue;
    }

    if (!input.includeRestricted) {
      results.push({
        personId: row.id,
        isMinor: true,
        givenName: "",
        familyName: "",
      });
      continue;
    }

    if (row.household_id === null) {
      throw new PeopleError("household_required");
    }

    const keys = await getHouseholdKeys(row.household_id);
    const commId = await getCommunityId();

    const givenName = await openField(
      row.given_name_restricted,
      keys.enc,
      row.id,
      commId,
      "people.given_name",
    );
    const familyName = await openField(
      row.family_name_restricted,
      keys.enc,
      row.id,
      commId,
      "people.family_name",
    );
    if (givenName === null || familyName === null) {
      throw new Error("person name is missing");
    }

    decryptedTargetIds.push(row.id);
    results.push({
      personId: row.id,
      isMinor: true,
      givenName,
      familyName,
    });
  }

  if (decryptedTargetIds.length > 0) {
    await appendAuditEvent(tx, {
      actorKind: "user",
      actorId: input.actorUserId,
      action: "people.person.read",
      purpose: "people.person.read",
      targetIds: decryptedTargetIds,
    });
  }

  return results;
}
