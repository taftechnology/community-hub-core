import { encrypt, type KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, type AppTransaction } from "@community-hub/db";

import { validateEmergencyContacts, type EmergencyContact } from "../domain/emergency-contact.js";
import { PeopleError } from "../domain/error.js";
import { householdFieldKeys, openField } from "./household.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMERGENCY_CONTACTS_READ = "people.household.emergency_contacts_read";
const EMERGENCY_CONTACTS_UPDATED = "people.household.emergency_contacts_updated";

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function setting(
  tx: AppTransaction,
  name: "app.org_id" | "app.community_id",
): Promise<string> {
  const rows = await tx<{ value: string }[]>`
    select current_setting(${name}) as value
  `;
  const val = rows[0]?.value;
  if (val === undefined || val === "") {
    throw new Error("tenant setting is missing");
  }
  return val;
}

export type ReadEmergencyContactsInput = {
  householdId: string;
  actorUserId: string | null;
};

export type ReadEmergencyContactsResult = {
  householdId: string;
  version: number;
  contacts: EmergencyContact[];
};

export type SaveEmergencyContactsInput = {
  householdId: string;
  version: number;
  contacts: unknown;
  actorUserId: string | null;
};

export type SaveEmergencyContactsResult = {
  householdId: string;
  version: number;
};

export async function readEmergencyContacts(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ReadEmergencyContactsInput,
): Promise<ReadEmergencyContactsResult | null> {
  if (typeof input.householdId !== "string" || !UUID_RE.test(input.householdId)) {
    throw new PeopleError("invalid_input");
  }
  if (
    input.actorUserId !== null &&
    (typeof input.actorUserId !== "string" || !UUID_RE.test(input.actorUserId))
  ) {
    throw new PeopleError("invalid_input");
  }

  const rows = await tx<
    {
      id: string;
      version: number;
      emergency_contacts: Uint8Array | null;
    }[]
  >`
    select
      id::text as id,
      version,
      emergency_contacts
    from app.households
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and deleted_at is null
  `;

  const household = rows[0];
  if (household === undefined) {
    return null;
  }

  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: EMERGENCY_CONTACTS_READ,
    purpose: EMERGENCY_CONTACTS_READ,
    targetIds: [input.householdId],
  });

  if (household.emergency_contacts === null) {
    return {
      householdId: household.id,
      version: household.version,
      contacts: [],
    };
  }

  const communityId = await setting(tx, "app.community_id");
  const { enc } = await householdFieldKeys(tx, kms, keyArn, input.householdId);
  try {
    const jsonText = await openField(
      household.emergency_contacts,
      enc,
      input.householdId,
      communityId,
      "people.household_emergency_contacts",
    );
    if (jsonText === null) {
      throw new Error("malformed stored emergency contacts");
    }
    const parsed: unknown = JSON.parse(jsonText);
    const contacts = validateEmergencyContacts(parsed);
    return {
      householdId: household.id,
      version: household.version,
      contacts,
    };
  } catch {
    throw new Error("malformed stored emergency contacts");
  }
}

export async function saveEmergencyContacts(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: SaveEmergencyContactsInput,
): Promise<SaveEmergencyContactsResult> {
  if (typeof input.householdId !== "string" || !UUID_RE.test(input.householdId)) {
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

  const cleanContacts = validateEmergencyContacts(input.contacts);

  const rows = await tx<{ id: string; version: number }[]>`
    select id::text as id, version
    from app.households
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
      and deleted_at is null
    for update
  `;

  const household = rows[0];
  if (household === undefined) {
    throw new PeopleError("not_found");
  }

  if (household.version !== input.version) {
    throw new PeopleError("conflict");
  }

  let contactBytes: Uint8Array | null = null;
  if (cleanContacts.length > 0) {
    const { enc, keyId } = await householdFieldKeys(tx, kms, keyArn, input.householdId);
    const communityId = await setting(tx, "app.community_id");
    const jsonText = JSON.stringify(cleanContacts);
    const plaintext = new TextEncoder().encode(jsonText);
    const ciphertext = await encrypt(enc, plaintext, uuidToBytes(keyId), {
      tag: "chub/field/v1",
      label: "people.household_emergency_contacts",
      rowId: uuidToBytes(input.householdId),
      communityId: uuidToBytes(communityId),
    });
    contactBytes = ciphertext;
  }

  const updated = await tx<{ id: string; version: number }[]>`
    update app.households
    set
      version = version + 1,
      ${tx("emergency_contacts")} = ${contactBytes}
    where id = ${input.householdId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    returning id::text as id, version
  `;

  const row = updated[0];
  if (row === undefined) {
    throw new PeopleError("not_found");
  }

  const rec = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: rec.actorKind,
    actorId: rec.actorId,
    action: EMERGENCY_CONTACTS_UPDATED,
    purpose: EMERGENCY_CONTACTS_UPDATED,
    targetIds: [input.householdId],
  });

  return {
    householdId: row.id,
    version: row.version,
  };
}
