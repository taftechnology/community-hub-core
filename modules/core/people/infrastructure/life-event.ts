import type { webcrypto } from "node:crypto";

import { decrypt, encrypt, type Ciphertext, type KmsPort } from "@community-hub/crypto";
import { appendAuditEvent, newId, type AppTransaction } from "@community-hub/db";
import { recordSuccess } from "@community-hub/usage";

import { PeopleError } from "../domain/error.js";
import { validateLifeEventInput, type LifeEventType } from "../domain/life-event.js";
import { derivePersonFieldKeys } from "./person-keys.js";

const LIFE_EVENT_LISTED = "people.life_event.listed";
const LIFE_EVENT_CREATED = "people.life_event.created";
const LIFE_EVENT_UPDATED = "people.life_event.updated";

export type ListLifeEventsInput = {
  personId: string;
  actorUserId: string | null;
  now?: Date;
};

export type LifeEventItem = {
  eventId: string;
  version: number;
  type: LifeEventType;
  date: string;
  place: string | null;
  notes: string | null;
};

export type ListLifeEventsResult = {
  items: LifeEventItem[];
};

export type CreateLifeEventInput = {
  personId: string;
  type: string;
  date: string;
  place?: string | null | undefined;
  notes?: string | null | undefined;
  actorUserId: string | null;
  now: Date;
};

export type CreateLifeEventResult = {
  eventId: string;
  version: number;
};

export type UpdateLifeEventInput = {
  eventId: string;
  version: number;
  type: string;
  date: string;
  place?: string | null | undefined;
  notes?: string | null | undefined;
  actorUserId: string | null;
  now: Date;
};

export type UpdateLifeEventResult = {
  version: number;
};

type StoredLifeEvent = {
  id: string;
  version: number;
  event_type: Uint8Array;
  event_date: Uint8Array;
  place: Uint8Array | null;
  notes: Uint8Array | null;
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

function actor(actorUserId: string | null): {
  actorKind: "system" | "user";
  actorId: string | null;
} {
  if (actorUserId === null) {
    return { actorKind: "system", actorId: null };
  }
  return { actorKind: "user", actorId: actorUserId };
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
  eventId: string,
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
    rowId: uuidToBytes(eventId),
    communityId: uuidToBytes(communityId),
  });
  return ciphertext;
}

async function openField(
  bytes: Uint8Array | null,
  enc: webcrypto.CryptoKey,
  eventId: string,
  communityId: string,
  label: string,
): Promise<string | null> {
  if (bytes === null) {
    return null;
  }
  const plain = await decrypt(asCiphertext(bytes), async () => enc, {
    tag: "chub/field/v1",
    label,
    rowId: uuidToBytes(eventId),
    communityId: uuidToBytes(communityId),
  });
  return new TextDecoder().decode(plain);
}

export async function listLifeEvents(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: ListLifeEventsInput,
): Promise<ListLifeEventsResult> {
  const persons = await tx<
    {
      id: string;
      is_minor: boolean;
      household_id: string | null;
    }[]
  >`
    select id::text as id, is_minor, household_id::text as household_id
    from app.persons
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const person = persons[0];
  if (person === undefined) {
    throw new PeopleError("life_event_not_found");
  }

  const rows = await tx<StoredLifeEvent[]>`
    select
      id::text as id,
      version,
      event_type,
      event_date,
      place,
      notes
    from app.life_events
    where person_id = ${person.id}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  if (rows.length > 50) {
    throw new PeopleError("too_many");
  }

  const communityId = await setting(tx, "app.community_id");
  const keys = await derivePersonFieldKeys(tx, kms, keyArn, {
    isMinor: person.is_minor,
    householdId: person.household_id,
  });

  const items: LifeEventItem[] = [];
  for (const row of rows) {
    const typeStr = await openField(
      row.event_type,
      keys.enc,
      row.id,
      communityId,
      "people.life_event_type",
    );
    const dateStr = await openField(
      row.event_date,
      keys.enc,
      row.id,
      communityId,
      "people.life_event_date",
    );
    const place = await openField(
      row.place,
      keys.enc,
      row.id,
      communityId,
      "people.life_event_place",
    );
    const notes = await openField(
      row.notes,
      keys.enc,
      row.id,
      communityId,
      "people.life_event_notes",
    );
    if (typeStr === null || dateStr === null) {
      throw new Error("life event field is missing");
    }
    items.push({
      eventId: row.id,
      version: row.version,
      type: typeStr as LifeEventType,
      date: dateStr,
      place,
      notes,
    });
  }

  items.sort((a, b) => b.date.localeCompare(a.date));

  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: LIFE_EVENT_LISTED,
    purpose: LIFE_EVENT_LISTED,
    targetIds: items.length === 0 ? [person.id] : items.map((item) => item.eventId),
  });

  return { items };
}

export async function createLifeEvent(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: CreateLifeEventInput,
): Promise<CreateLifeEventResult> {
  const validated = validateLifeEventInput(
    {
      type: input.type,
      date: input.date,
      place: input.place,
      notes: input.notes,
    },
    input.now,
  );

  const persons = await tx<
    {
      id: string;
      is_minor: boolean;
      household_id: string | null;
    }[]
  >`
    select id::text as id, is_minor, household_id::text as household_id
    from app.persons
    where id = ${input.personId}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    for update
  `;
  const person = persons[0];
  if (person === undefined) {
    throw new PeopleError("life_event_not_found");
  }

  const countRows = await tx<{ count: string }[]>`
    select count(*)::text as count
    from app.life_events
    where person_id = ${person.id}::uuid
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  if (Number(countRows[0]?.count ?? 0) >= 50) {
    throw new PeopleError("too_many");
  }

  const communityId = await setting(tx, "app.community_id");
  const keys = await derivePersonFieldKeys(tx, kms, keyArn, {
    isMinor: person.is_minor,
    householdId: person.household_id,
  });

  const eventId = newId();
  const eventType = await seal(
    keys.enc,
    keys.keyId,
    eventId,
    communityId,
    "people.life_event_type",
    validated.type,
  );
  const eventDate = await seal(
    keys.enc,
    keys.keyId,
    eventId,
    communityId,
    "people.life_event_date",
    validated.date,
  );
  const place = await seal(
    keys.enc,
    keys.keyId,
    eventId,
    communityId,
    "people.life_event_place",
    validated.place,
  );
  const notes = await seal(
    keys.enc,
    keys.keyId,
    eventId,
    communityId,
    "people.life_event_notes",
    validated.notes,
  );

  await tx`
    insert into app.life_events (
      id,
      org_id,
      community_id,
      person_id,
      version,
      event_type,
      event_date,
      place,
      notes
    ) values (
      ${eventId}::uuid,
      current_setting('app.org_id')::uuid,
      current_setting('app.community_id')::uuid,
      ${person.id}::uuid,
      1,
      ${eventType},
      ${eventDate},
      ${place},
      ${notes}
    )
  `;

  await recordSuccess(tx, "people.households", input.now);

  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: LIFE_EVENT_CREATED,
    purpose: LIFE_EVENT_CREATED,
    targetIds: [eventId],
  });

  return { eventId, version: 1 };
}

export async function updateLifeEvent(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
  input: UpdateLifeEventInput,
): Promise<UpdateLifeEventResult> {
  const validated = validateLifeEventInput(
    {
      type: input.type,
      date: input.date,
      place: input.place,
      notes: input.notes,
    },
    input.now,
  );

  const rows = await tx<
    {
      id: string;
      person_id: string;
      version: number;
      is_minor: boolean;
      household_id: string | null;
    }[]
  >`
    select
      e.id::text as id,
      e.person_id::text as person_id,
      e.version,
      p.is_minor,
      p.household_id::text as household_id
    from app.life_events e
    inner join app.persons p on p.id = e.person_id
    where e.id = ${input.eventId}::uuid
      and e.org_id = current_setting('app.org_id')::uuid
      and e.community_id = current_setting('app.community_id')::uuid
      and p.org_id = current_setting('app.org_id')::uuid
      and p.community_id = current_setting('app.community_id')::uuid
  `;
  const existing = rows[0];
  if (existing === undefined) {
    throw new PeopleError("life_event_not_found");
  }
  if (existing.version !== input.version) {
    throw new PeopleError("conflict");
  }

  const communityId = await setting(tx, "app.community_id");
  const keys = await derivePersonFieldKeys(tx, kms, keyArn, {
    isMinor: existing.is_minor,
    householdId: existing.household_id,
  });

  const eventType = await seal(
    keys.enc,
    keys.keyId,
    input.eventId,
    communityId,
    "people.life_event_type",
    validated.type,
  );
  const eventDate = await seal(
    keys.enc,
    keys.keyId,
    input.eventId,
    communityId,
    "people.life_event_date",
    validated.date,
  );
  const place = await seal(
    keys.enc,
    keys.keyId,
    input.eventId,
    communityId,
    "people.life_event_place",
    validated.place,
  );
  const notes = await seal(
    keys.enc,
    keys.keyId,
    input.eventId,
    communityId,
    "people.life_event_notes",
    validated.notes,
  );

  const nextVersion = input.version + 1;
  const updated = await tx<{ version: number }[]>`
    update app.life_events
    set
      version = ${nextVersion},
      event_type = ${eventType},
      event_date = ${eventDate},
      place = ${place},
      notes = ${notes}
    where id = ${input.eventId}::uuid
      and version = ${input.version}
      and org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
    returning version
  `;
  if (updated[0] === undefined) {
    throw new PeopleError("conflict");
  }

  const recorded = actor(input.actorUserId);
  await appendAuditEvent(tx, {
    actorKind: recorded.actorKind,
    actorId: recorded.actorId,
    action: LIFE_EVENT_UPDATED,
    purpose: LIFE_EVENT_UPDATED,
    targetIds: [input.eventId],
  });

  return { version: nextVersion };
}
