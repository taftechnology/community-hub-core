import type { webcrypto } from "node:crypto";

import {
  decrypt,
  deriveKeys,
  encrypt,
  generateAndWrap,
  unwrapKey,
  unwrapKmsRoot,
  type Ciphertext,
  type KmsPort,
} from "@community-hub/crypto";
import { appendAuditEvent, newId, type AppTransaction } from "@community-hub/db";

import { normaliseName } from "../domain/person.js";
import { ensureCommunityKey } from "./keys.js";

const HOUSEHOLD_CREATED = "people.household.created";
const HOUSEHOLD_READ = "people.household.read";
const LABEL = "people.household_label";

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

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
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

async function communityWrapKey(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  communityKeyId: string,
): Promise<webcrypto.CryptoKey> {
  const communities = await tx<{ id: string; wrapped: Uint8Array; parent_key_id: string }[]>`
    select id::text as id, wrapped, parent_key_id::text as parent_key_id
    from app.community_keys
    where id = ${communityKeyId}::uuid
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
  const communityHkdfKey = await unwrapKey(community.wrapped, orgWrap, {
    tag: "chub/wrap/v1",
    childKind: "community",
    childId: uuidToBytes(communityId),
    childKeyId: uuidToBytes(community.id),
    parentKeyId: uuidToBytes(community.parent_key_id),
  });
  const { wrap } = await deriveKeys(communityHkdfKey);
  return wrap;
}

async function householdEncKey(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  householdId: string,
): Promise<webcrypto.CryptoKey> {
  const keys = await tx<{ id: string; wrapped: Uint8Array; parent_key_id: string }[]>`
    select id::text as id, wrapped, parent_key_id::text as parent_key_id
    from app.household_keys
    where household_id = ${householdId}::uuid
  `;
  const householdKey = keys[0];
  if (householdKey === undefined) {
    throw new Error("household key is missing");
  }
  const wrap = await communityWrapKey(tx, kms, keyArn, householdKey.parent_key_id);
  const childHkdfKey = await unwrapKey(householdKey.wrapped, wrap, {
    tag: "chub/wrap/v1",
    childKind: "household",
    childId: uuidToBytes(householdId),
    childKeyId: uuidToBytes(householdKey.id),
    parentKeyId: uuidToBytes(householdKey.parent_key_id),
  });
  const { enc } = await deriveKeys(childHkdfKey);
  return enc;
}

async function openHouseholdLabel(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  householdId: string,
): Promise<{ householdId: string; label: string | null } | null> {
  const rows = await tx<{ id: string; label: Uint8Array | null }[]>`
    select id::text as id, label
    from app.households
    where id = ${householdId}::uuid
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  if (row.label === null) {
    return { householdId: row.id, label: null };
  }
  const enc = await householdEncKey(tx, kms, keyArn, row.id);
  const communityId = await setting(tx, "app.community_id");
  const plain = await decrypt(asCiphertext(row.label), async () => enc, {
    tag: "chub/field/v1",
    label: LABEL,
    rowId: uuidToBytes(row.id),
    communityId: uuidToBytes(communityId),
  });
  return { householdId: row.id, label: new TextDecoder().decode(plain) };
}

export async function createHousehold(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: { now: Date; label: string | null; actorUserId: string | null },
): Promise<{ householdId: string }> {
  const label = input.label === null ? null : normaliseName(input.label);
  const { keyId: communityKeyId } = await ensureCommunityKey(tx, kms, keyArn);
  const communityId = await setting(tx, "app.community_id");
  const wrap = await communityWrapKey(tx, kms, keyArn, communityKeyId);
  const householdId = newId();
  const householdKeyId = newId();
  const wrapped = await generateAndWrap(wrap, {
    tag: "chub/wrap/v1",
    childKind: "household",
    childId: uuidToBytes(householdId),
    childKeyId: uuidToBytes(householdKeyId),
    parentKeyId: uuidToBytes(communityKeyId),
  });
  const { enc } = await deriveKeys(wrapped.childHkdfKey);
  let labelBytes: Uint8Array | null = null;
  if (label !== null) {
    const ciphertext = await encrypt(
      enc,
      new TextEncoder().encode(label),
      uuidToBytes(householdKeyId),
      {
        tag: "chub/field/v1",
        label: LABEL,
        rowId: uuidToBytes(householdId),
        communityId: uuidToBytes(communityId),
      },
    );
    // A tagged template cannot take the branded value. The insert stores the bytes.
    labelBytes = ciphertext;
  }
  await tx`
    insert into app.households (id, org_id, community_id, label)
    values (
      ${householdId}::uuid,
      current_setting('app.org_id')::uuid,
      current_setting('app.community_id')::uuid,
      ${labelBytes}
    )
  `;
  await tx`
    insert into app.household_keys (
      id, org_id, community_id, household_id, wrapped, key_version, parent_key_id
    ) values (
      ${householdKeyId}::uuid,
      current_setting('app.org_id')::uuid,
      current_setting('app.community_id')::uuid,
      ${householdId}::uuid,
      ${wrapped.blob},
      '1',
      ${communityKeyId}::uuid
    )
  `;
  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: HOUSEHOLD_CREATED,
    purpose: HOUSEHOLD_CREATED,
    targetIds: [householdId],
  });
  return { householdId };
}

export async function readHousehold(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: { householdId: string; actorUserId: string | null },
): Promise<{ householdId: string; label: string | null } | null> {
  const opened = await openHouseholdLabel(tx, kms, keyArn, input.householdId);
  if (opened === null) {
    return null;
  }
  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: HOUSEHOLD_READ,
    purpose: HOUSEHOLD_READ,
    targetIds: [opened.householdId],
  });
  return opened;
}
