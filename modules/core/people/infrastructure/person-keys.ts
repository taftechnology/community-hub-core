import type { webcrypto } from "node:crypto";

import { deriveKeys, unwrapKey, unwrapKmsRoot, type KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { PeopleError } from "../domain/error.js";
import { ensureCommunityKey } from "./keys.js";

export type PersonFieldKeys = {
  enc: webcrypto.CryptoKey;
  bidx: webcrypto.CryptoKey;
  keyId: string;
};

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function setting(
  tx: AppTransaction,
  name: "app.org_id" | "app.community_id",
): Promise<string> {
  const rows = await tx<{ value: string }[]>`
    select current_setting(${name}) as value
  `;
  const value = rows[0]?.value;
  if (value === undefined || value.length === 0) {
    throw new Error("tenant setting is missing");
  }
  return value;
}

async function communityRoot(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
): Promise<{ hkdf: webcrypto.CryptoKey; keyId: string }> {
  const { keyId } = await ensureCommunityKey(tx, kms, keyArn);
  const communities = await tx<{ id: string; wrapped: Uint8Array; parent_key_id: string }[]>`
    select id::text as id, wrapped, parent_key_id::text as parent_key_id
    from app.community_keys
    where id = ${keyId}::uuid
  `;
  const community = communities[0];
  if (community === undefined) {
    throw new Error("community key is missing");
  }
  const organisations = await tx<{ wrapped: Uint8Array }[]>`
    select wrapped from app.organisation_keys where id = ${community.parent_key_id}::uuid
  `;
  const organisation = organisations[0];
  if (organisation === undefined) {
    throw new Error("organisation key is missing");
  }
  const orgId = await setting(tx, "app.org_id");
  const orgHkdfKey = await unwrapKmsRoot(kms, keyArn, organisation.wrapped, {
    key_kind: "org",
    org_id: orgId,
    key_version: "1",
  });
  const { wrap: orgWrap } = await deriveKeys(orgHkdfKey);
  const communityId = await setting(tx, "app.community_id");
  const hkdf = await unwrapKey(community.wrapped, orgWrap, {
    tag: "chub/wrap/v1",
    childKind: "community",
    childId: uuidToBytes(communityId),
    childKeyId: uuidToBytes(community.id),
    parentKeyId: uuidToBytes(community.parent_key_id),
  });
  return { hkdf, keyId: community.id };
}

export async function communityFieldKeys(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
): Promise<PersonFieldKeys> {
  const { hkdf, keyId } = await communityRoot(tx, kms, keyArn);
  const { enc, bidx } = await deriveKeys(hkdf);
  return { enc, bidx, keyId };
}

export async function householdFieldKeys(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  householdId: string,
): Promise<PersonFieldKeys> {
  const { hkdf: communityHkdf } = await communityRoot(tx, kms, keyArn);
  const { wrap } = await deriveKeys(communityHkdf);
  const keys = await tx<{ id: string; wrapped: Uint8Array; parent_key_id: string }[]>`
    select id::text as id, wrapped, parent_key_id::text as parent_key_id
    from app.household_keys
    where household_id = ${householdId}::uuid
  `;
  const householdKey = keys[0];
  if (householdKey === undefined) {
    throw new Error("household key is missing");
  }
  const hkdf = await unwrapKey(householdKey.wrapped, wrap, {
    tag: "chub/wrap/v1",
    childKind: "household",
    childId: uuidToBytes(householdId),
    childKeyId: uuidToBytes(householdKey.id),
    parentKeyId: uuidToBytes(householdKey.parent_key_id),
  });
  const { enc, bidx } = await deriveKeys(hkdf);
  return { enc, bidx, keyId: householdKey.id };
}

export async function derivePersonFieldKeys(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  person: { isMinor: boolean; householdId: string | null },
): Promise<{ enc: webcrypto.CryptoKey; bidx: webcrypto.CryptoKey }> {
  if (person.isMinor) {
    if (person.householdId === null) {
      throw new PeopleError("household_required");
    }
    const keys = await householdFieldKeys(tx, kms, keyArn, person.householdId);
    return { enc: keys.enc, bidx: keys.bidx };
  }
  const keys = await communityFieldKeys(tx, kms, keyArn);
  return { enc: keys.enc, bidx: keys.bidx };
}

const PERSON_READ = "people.person.read";

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
}

export async function openPersonFieldKeys(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: { personId: string; actorUserId: string | null },
): Promise<{ enc: webcrypto.CryptoKey; bidx: webcrypto.CryptoKey } | null> {
  const rows = await tx<{ is_minor: boolean; household_id: string | null }[]>`
    select is_minor, household_id::text as household_id
    from app.persons
    where id = ${input.personId}::uuid
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const keys = await derivePersonFieldKeys(tx, kms, keyArn, {
    isMinor: row.is_minor,
    householdId: row.household_id,
  });
  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: PERSON_READ,
    purpose: PERSON_READ,
    targetIds: [input.personId],
  });
  return { enc: keys.enc, bidx: keys.bidx };
}
