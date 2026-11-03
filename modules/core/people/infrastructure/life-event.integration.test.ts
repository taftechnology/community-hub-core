import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { decrypt, type Ciphertext, type KmsPort } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";
import { isAuditAction, isAuditPurpose } from "@community-hub/kernel/module";

import {
  createHousehold,
  createLifeEvent,
  createPerson,
  listLifeEvents,
  PeopleError,
  updateLifeEvent,
} from "../public/index.js";
import { communityFieldKeys, householdFieldKeys } from "./person-keys.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-01T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function extractEnvelopeKeyId(blob: Uint8Array): Uint8Array {
  // Envelope format (packages/crypto): 1 byte version prefix (0x01) followed by 16 bytes keyId
  return new Uint8Array(blob.subarray(1, 17));
}

function asCiphertext(bytes: Uint8Array): Ciphertext {
  return bytes as never;
}

beforeAll(async () => {
  const runtime = loadRuntime();
  const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

describe("life events", () => {
  it("registers audit actions and purposes with past-participle convention", () => {
    expect(isAuditAction("people.life_event.listed")).toBe(true);
    expect(isAuditPurpose("people.life_event.listed")).toBe(true);
    expect(isAuditAction("people.life_event.created")).toBe(true);
    expect(isAuditPurpose("people.life_event.created")).toBe(true);
    expect(isAuditAction("people.life_event.updated")).toBe(true);
    expect(isAuditPurpose("people.life_event.updated")).toBe(true);
  });

  it("creates, lists, and updates life events for an adult and minor fixture", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'life-event-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'life-event-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          // Create adult
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: null,
            dateOfBirth: "1990-05-15",
            givenName: "Adult",
            familyName: "Subject",
            email: "adult@example.test",
            phone: null,
            actorUserId: null,
          });

          // Create household and minor
          const household = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: null,
            givenName: "Minor",
            familyName: "Subject",
            email: null,
            phone: null,
            actorUserId: null,
          });

          // Create event for adult
          const adultCreated = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: adult.personId,
            type: "marriage",
            date: "2020-06-20",
            place: "St Joseph's",
            notes: "Married with witnesses",
            actorUserId: null,
            now: NOW,
          });
          expect(adultCreated.eventId).toBeDefined();
          expect(adultCreated.version).toBe(1);

          // Create event for minor
          const minorCreated = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: minor.personId,
            type: "baptism",
            date: "2024-03-10",
            place: "St Patrick's",
            notes: "Baptism record",
            actorUserId: null,
            now: NOW,
          });
          expect(minorCreated.eventId).toBeDefined();
          expect(minorCreated.version).toBe(1);

          // List adult events
          const adultList = await listLifeEvents(tx, kms, KEY_ARN, {
            personId: adult.personId,
            actorUserId: null,
          });
          expect(adultList.items).toHaveLength(1);
          expect(adultList.items[0]).toEqual({
            eventId: adultCreated.eventId,
            version: 1,
            type: "marriage",
            date: "2020-06-20",
            place: "St Joseph's",
            notes: "Married with witnesses",
          });

          // List minor events
          const minorList = await listLifeEvents(tx, kms, KEY_ARN, {
            personId: minor.personId,
            actorUserId: null,
          });
          expect(minorList.items).toHaveLength(1);
          expect(minorList.items[0]).toEqual({
            eventId: minorCreated.eventId,
            version: 1,
            type: "baptism",
            date: "2024-03-10",
            place: "St Patrick's",
            notes: "Baptism record",
          });

          // Update adult event
          const updated = await updateLifeEvent(tx, kms, KEY_ARN, {
            eventId: adultCreated.eventId,
            version: 1,
            type: "marriage",
            date: "2020-06-20",
            place: "St Joseph's Cathedral",
            notes: "Corrected cathedral name",
            actorUserId: null,
            now: NOW,
          });
          expect(updated.version).toBe(2);

          const adultListAfter = await listLifeEvents(tx, kms, KEY_ARN, {
            personId: adult.personId,
            actorUserId: null,
          });
          expect(adultListAfter.items[0]?.place).toBe("St Joseph's Cathedral");
          expect(adultListAfter.items[0]?.version).toBe(2);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("Pin 3: A minor's event opens only with the household key", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'pin3-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'pin3-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const household = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: null,
            givenName: "Child",
            familyName: "Three",
            email: null,
            phone: null,
            actorUserId: null,
          });

          const created = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: minor.personId,
            type: "first_communion",
            date: "2025-05-18",
            place: "St Jude's",
            notes: null,
            actorUserId: null,
            now: NOW,
          });

          const [row] = await tx<{ event_type: Uint8Array }[]>`
            select event_type from app.life_events where id = ${created.eventId}::uuid
          `;
          expect(row?.event_type).toBeDefined();

          const commKeys = await communityFieldKeys(tx, kms, KEY_ARN);
          const hhKeys = await householdFieldKeys(tx, kms, KEY_ARN, household.householdId);

          const aad = {
            tag: "chub/field/v1" as const,
            label: "people.life_event_type",
            rowId: uuidToBytes(created.eventId),
            communityId: uuidToBytes(communityId),
          };

          // Decrypt with community key MUST fail
          await expect(
            decrypt(asCiphertext(row!.event_type), async () => commKeys.enc, aad),
          ).rejects.toThrow();

          // Decrypt with household key MUST succeed
          const decrypted = await decrypt(
            asCiphertext(row!.event_type),
            async () => hhKeys.enc,
            aad,
          );
          expect(new TextDecoder().decode(decrypted)).toBe("first_communion");

          // Update minor's event: must also seal under household key
          const updated = await updateLifeEvent(tx, kms, KEY_ARN, {
            eventId: created.eventId,
            version: 1,
            type: "first_communion",
            date: "2025-05-19",
            place: "St Jude's Chapel",
            notes: "Updated communion note",
            actorUserId: null,
            now: NOW,
          });
          expect(updated.version).toBe(2);

          const [updatedRow] = await tx<
            {
              event_type: Uint8Array;
              place: Uint8Array;
              notes: Uint8Array;
            }[]
          >`
            select event_type, place, notes from app.life_events where id = ${created.eventId}::uuid
          `;
          expect(updatedRow?.event_type).toBeDefined();
          expect(updatedRow?.place).toBeDefined();
          expect(updatedRow?.notes).toBeDefined();

          // After update: event_type ciphertext fails with community key, opens with household key
          await expect(
            decrypt(asCiphertext(updatedRow!.event_type), async () => commKeys.enc, aad),
          ).rejects.toThrow();
          const decryptedTypeAfter = await decrypt(
            asCiphertext(updatedRow!.event_type),
            async () => hhKeys.enc,
            aad,
          );
          expect(new TextDecoder().decode(decryptedTypeAfter)).toBe("first_communion");

          // place ciphertext fails with community key, opens with household key
          const placeAad = {
            tag: "chub/field/v1" as const,
            label: "people.life_event_place",
            rowId: uuidToBytes(created.eventId),
            communityId: uuidToBytes(communityId),
          };
          await expect(
            decrypt(asCiphertext(updatedRow!.place), async () => commKeys.enc, placeAad),
          ).rejects.toThrow();
          const decryptedPlaceAfter = await decrypt(
            asCiphertext(updatedRow!.place),
            async () => hhKeys.enc,
            placeAad,
          );
          expect(new TextDecoder().decode(decryptedPlaceAfter)).toBe("St Jude's Chapel");

          // notes ciphertext fails with community key, opens with household key
          const notesAad = {
            tag: "chub/field/v1" as const,
            label: "people.life_event_notes",
            rowId: uuidToBytes(created.eventId),
            communityId: uuidToBytes(communityId),
          };
          await expect(
            decrypt(asCiphertext(updatedRow!.notes), async () => commKeys.enc, notesAad),
          ).rejects.toThrow();
          const decryptedNotesAfter = await decrypt(
            asCiphertext(updatedRow!.notes),
            async () => hhKeys.enc,
            notesAad,
          );
          expect(new TextDecoder().decode(decryptedNotesAfter)).toBe("Updated communion note");

          // Assert the envelope still decrypts after the update (a list returns the new values)
          const listed = await listLifeEvents(tx, kms, KEY_ARN, {
            personId: minor.personId,
            actorUserId: null,
          });
          expect(listed.items).toHaveLength(1);
          expect(listed.items[0]?.place).toBe("St Jude's Chapel");
          expect(listed.items[0]?.notes).toBe("Updated communion note");
          expect(listed.items[0]?.date).toBe("2025-05-19");
          expect(listed.items[0]?.version).toBe(2);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("Pin 4: An adult's event opens only with the community key", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'pin4-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'pin4-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const household = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: household.householdId,
            dateOfBirth: null,
            givenName: "Adult",
            familyName: "Four",
            email: null,
            phone: null,
            actorUserId: null,
          });

          const created = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: adult.personId,
            type: "funeral",
            date: "2026-01-15",
            place: "Memorial Chapel",
            notes: null,
            actorUserId: null,
            now: NOW,
          });

          const [row] = await tx<{ event_type: Uint8Array }[]>`
            select event_type from app.life_events where id = ${created.eventId}::uuid
          `;
          expect(row?.event_type).toBeDefined();

          const commKeys = await communityFieldKeys(tx, kms, KEY_ARN);
          const hhKeys = await householdFieldKeys(tx, kms, KEY_ARN, household.householdId);

          const aad = {
            tag: "chub/field/v1" as const,
            label: "people.life_event_type",
            rowId: uuidToBytes(created.eventId),
            communityId: uuidToBytes(communityId),
          };

          // Decrypt with community key MUST succeed
          const decrypted = await decrypt(
            asCiphertext(row!.event_type),
            async () => commKeys.enc,
            aad,
          );
          expect(new TextDecoder().decode(decrypted)).toBe("funeral");

          // Decrypt with household key MUST fail
          await expect(
            decrypt(asCiphertext(row!.event_type), async () => hhKeys.enc, aad),
          ).rejects.toThrow();
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("Pin 5: AAD binds the row: ciphertext copied to another row does not open", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const organisationId = newId();
    const communityId = newId();
    const community2Id = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'pin5-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values
            (${communityId}, ${organisationId}, 'pin5-comm1', 'au'),
            (${community2Id}, ${organisationId}, 'pin5-comm2', 'au')
        `;
      });

      let event1Id = "";
      let event2Id = "";
      let personId = "";

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Adult",
            familyName: "Five",
            email: null,
            phone: null,
            actorUserId: null,
          });
          personId = adult.personId;

          const e1 = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: adult.personId,
            type: "baptism",
            date: "2015-01-01",
            place: null,
            notes: null,
            actorUserId: null,
            now: NOW,
          });
          const e2 = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: adult.personId,
            type: "marriage",
            date: "2020-01-01",
            place: null,
            notes: null,
            actorUserId: null,
            now: NOW,
          });
          event1Id = e1.eventId;
          event2Id = e2.eventId;
        }),
      );

      // Copy event_type from event1 to event2 via direct SQL
      await directSql`
        update app.life_events
        set event_type = (select event_type from app.life_events where id = ${event1Id}::uuid)
        where id = ${event2Id}::uuid
      `;

      // 1. Reading as service must fail because AAD rowId does not match:
      // Assert specific DOMException OperationError and that no LifeEventItem is returned
      let listResult1: unknown;
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          let error: unknown;
          try {
            listResult1 = await listLifeEvents(tx, kms, KEY_ARN, {
              personId,
              actorUserId: null,
            });
          } catch (e) {
            error = e;
          }
          expect(error).toBeInstanceOf(DOMException);
          expect((error as DOMException).name).toBe("OperationError");
          expect((error as DOMException).message).toBe("decryption failed");
          expect(listResult1).toBeUndefined();
        }),
      );

      // 2. Fails across communities (ciphertext copied to a row in another community does not open; row id differs):
      // Create person and event in community2
      let comm2PersonId = "";
      let comm2EventId = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: organisationId, communityId: community2Id },
          async (tx) => {
            const adult2 = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Adult",
              familyName: "FiveComm2",
              email: null,
              phone: null,
              actorUserId: null,
            });
            comm2PersonId = adult2.personId;

            const e = await createLifeEvent(tx, kms, KEY_ARN, {
              personId: comm2PersonId,
              type: "first_communion",
              date: "2020-01-01",
              place: null,
              notes: null,
              actorUserId: null,
              now: NOW,
            });
            comm2EventId = e.eventId;
          },
        ),
      );

      // Copy event_type from community1 event to community2 event via direct SQL
      await directSql`
        update app.life_events
        set event_type = (select event_type from app.life_events where id = ${event1Id}::uuid)
        where id = ${comm2EventId}::uuid
      `;

      // Reading in community2 fails because row id differs (AAD rowId mismatch; community id also differs)
      let listResult2: unknown;
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(
          app,
          { orgId: organisationId, communityId: community2Id },
          async (tx) => {
            let error: unknown;
            try {
              listResult2 = await listLifeEvents(tx, kms, KEY_ARN, {
                personId: comm2PersonId,
                actorUserId: null,
              });
            } catch (e) {
              error = e;
            }
            expect(error).toBeInstanceOf(DOMException);
            expect((error as DOMException).name).toBe("OperationError");
            expect((error as DOMException).message).toBe("decryption failed");
            expect(listResult2).toBeUndefined();
          },
        ),
      );
    } finally {
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("Pin 9: Tenancy: person and event ids in another community or organisation give 404 (life_event_not_found)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const org1Id = newId();
    const org2Id = newId();
    const comm1A = newId();
    const comm1B = newId();
    const comm2 = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values
            (${org1Id}, 'tenancy-org1', 'au', 'implicit'),
            (${org2Id}, 'tenancy-org2', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values
            (${comm1A}, ${org1Id}, 'comm1a', 'au'),
            (${comm1B}, ${org1Id}, 'comm1b', 'au'),
            (${comm2}, ${org2Id}, 'comm2', 'au')
        `;
      });

      let personInComm1A = "";
      let eventInComm1A = "";

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: org1Id, communityId: comm1A }, async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Tenancy",
            familyName: "Subject",
            email: null,
            phone: null,
            actorUserId: null,
          });
          personInComm1A = person.personId;

          const created = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: person.personId,
            type: "baptism",
            date: "2020-01-01",
            place: null,
            notes: null,
            actorUserId: null,
            now: NOW,
          });
          eventInComm1A = created.eventId;
        }),
      );

      // Caller in another community of same org (comm1B)
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: org1Id, communityId: comm1B }, async (tx) => {
          await expect(
            listLifeEvents(tx, kms, KEY_ARN, { personId: personInComm1A, actorUserId: null }),
          ).rejects.toThrowError(new PeopleError("life_event_not_found"));

          await expect(
            createLifeEvent(tx, kms, KEY_ARN, {
              personId: personInComm1A,
              type: "marriage",
              date: "2021-01-01",
              place: null,
              notes: null,
              actorUserId: null,
              now: NOW,
            }),
          ).rejects.toThrowError(new PeopleError("life_event_not_found"));

          await expect(
            updateLifeEvent(tx, kms, KEY_ARN, {
              eventId: eventInComm1A,
              version: 1,
              type: "marriage",
              date: "2021-01-01",
              place: null,
              notes: null,
              actorUserId: null,
              now: NOW,
            }),
          ).rejects.toThrowError(new PeopleError("life_event_not_found"));

          // As app, querying life_events for another community's event id returns no rows
          const rowsFromOtherCommunity = await tx<{ id: string }[]>`
            select id::text from app.life_events where id = ${eventInComm1A}::uuid
          `;
          expect(rowsFromOtherCommunity).toHaveLength(0);
        }),
      );

      // Caller in another organisation (org2 / comm2)
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: org2Id, communityId: comm2 }, async (tx) => {
          await expect(
            listLifeEvents(tx, kms, KEY_ARN, { personId: personInComm1A, actorUserId: null }),
          ).rejects.toThrowError(new PeopleError("life_event_not_found"));

          await expect(
            createLifeEvent(tx, kms, KEY_ARN, {
              personId: personInComm1A,
              type: "marriage",
              date: "2021-01-01",
              place: null,
              notes: null,
              actorUserId: null,
              now: NOW,
            }),
          ).rejects.toThrowError(new PeopleError("life_event_not_found"));

          await expect(
            updateLifeEvent(tx, kms, KEY_ARN, {
              eventId: eventInComm1A,
              version: 1,
              type: "marriage",
              date: "2021-01-01",
              place: null,
              notes: null,
              actorUserId: null,
              now: NOW,
            }),
          ).rejects.toThrowError(new PeopleError("life_event_not_found"));

          // As app, querying life_events for another community's event id returns no rows
          const rowsFromOtherCommunity = await tx<{ id: string }[]>`
            select id::text from app.life_events where id = ${eventInComm1A}::uuid
          `;
          expect(rowsFromOtherCommunity).toHaveLength(0);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("Pin 10: Update takes version and bumps it; stale version throws conflict", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const appB = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'pin10-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'pin10-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Version",
            familyName: "Subject",
            email: null,
            phone: null,
            actorUserId: null,
          });

          const created = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: person.personId,
            type: "baptism",
            date: "2020-01-01",
            place: "Old Church",
            notes: null,
            actorUserId: null,
            now: NOW,
          });
          expect(created.version).toBe(1);

          const auditsBefore = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events where action = 'people.life_event.updated'
          `;

          // Stale version (e.g. 99 instead of 1)
          await expect(
            updateLifeEvent(tx, kms, KEY_ARN, {
              eventId: created.eventId,
              version: 99,
              type: "baptism",
              date: "2020-01-01",
              place: "New Church",
              notes: null,
              actorUserId: null,
              now: NOW,
            }),
          ).rejects.toThrowError(new PeopleError("conflict"));

          // Row unchanged
          const list = await listLifeEvents(tx, kms, KEY_ARN, {
            personId: person.personId,
            actorUserId: null,
          });
          expect(list.items[0]?.place).toBe("Old Church");
          expect(list.items[0]?.version).toBe(1);

          // No audit event written
          const auditsAfter = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events where action = 'people.life_event.updated'
          `;
          expect(auditsAfter[0]?.n).toBe(auditsBefore[0]?.n);
        }),
      );

      // Deterministic concurrent two-connection test:
      // Writer A reads version 1 and passes in-code check, then waits.
      // Writer B updates to version 2 and commits.
      // Writer A resumes and executes SQL update where version = 1.
      // Only the SQL guard stops Writer A from overwriting Writer B.
      function createDeferred<T = void>() {
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      }

      const aHasRead = createDeferred<void>();
      const bHasCommitted = createDeferred<void>();

      const kmsA: KmsPort = {
        ...kms,
        async decrypt(keyId, blob, context) {
          aHasRead.resolve();
          await bHasCommitted.promise;
          return kms.decrypt(keyId, blob, context);
        },
      };

      let concurrentPersonId = "";
      let concurrentEventId = "";

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Concurrent",
            familyName: "Subject",
            email: null,
            phone: null,
            actorUserId: null,
          });
          concurrentPersonId = person.personId;

          const created = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: concurrentPersonId,
            type: "baptism",
            date: "2020-01-01",
            place: "Original Place",
            notes: null,
            actorUserId: null,
            now: NOW,
          });
          concurrentEventId = created.eventId;
        }),
      );

      const auditsBeforeA = await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const rows = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events where action = 'people.life_event.updated'
          `;
          return rows[0]?.n ?? 0;
        }),
      );

      // Writer A starts in background transaction
      const writerAPromise = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (txA) => {
          return updateLifeEvent(txA, kmsA, KEY_ARN, {
            eventId: concurrentEventId,
            version: 1,
            type: "baptism",
            date: "2020-01-01",
            place: "Writer A Place",
            notes: null,
            actorUserId: null,
            now: NOW,
          });
        }),
      );

      // Wait until Writer A has read row with version 1 and passed in-code check
      await aHasRead.promise;

      // Writer B updates row to version 2 on a second connection and commits
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(appB, { orgId: organisationId, communityId }, async (txB) => {
          const updatedB = await updateLifeEvent(txB, kms, KEY_ARN, {
            eventId: concurrentEventId,
            version: 1,
            type: "baptism",
            date: "2020-01-01",
            place: "Writer B Place",
            notes: null,
            actorUserId: null,
            now: NOW,
          });
          expect(updatedB.version).toBe(2);
        }),
      );

      // Let Writer A resume and attempt its SQL update
      bHasCommitted.resolve();

      // Writer A must be stopped by the SQL and version = 1 guard and throw conflict
      await expect(writerAPromise).rejects.toThrowError(new PeopleError("conflict"));

      // Verify row retains Writer B's update (place is "Writer B Place", version is 2)
      // and no audit event was written for Writer A
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const list = await listLifeEvents(tx, kms, KEY_ARN, {
            personId: concurrentPersonId,
            actorUserId: null,
          });
          expect(list.items[0]?.place).toBe("Writer B Place");
          expect(list.items[0]?.version).toBe(2);

          const auditsAfter = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events where action = 'people.life_event.updated'
          `;
          // Exactly 1 new audit event from Writer B, 0 from Writer A
          expect(auditsAfter[0]?.n).toBe(auditsBeforeA + 1);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await appB.end({ timeout: 1 });
    }
  }, 20_000);

  it("Pin 11: Audit row written for list, create and update, holding ids only", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'pin11-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'pin11-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Audit",
            familyName: "Subject",
            email: null,
            phone: null,
            actorUserId: null,
          });

          // Empty list audit: targetIds has [person.personId]
          await listLifeEvents(tx, kms, KEY_ARN, {
            personId: person.personId,
            actorUserId: null,
          });

          const emptyListAudits = await tx<{ action: string; target_ids: string[] }[]>`
            select action, target_ids
            from app.audit_events
            where action = 'people.life_event.listed'
            order by seq desc limit 1
          `;
          expect(emptyListAudits[0]?.target_ids).toEqual([person.personId]);

          // Create audit
          const SECRET_PLACE = "SecretCathedral123";
          const SECRET_NOTE = "PrivateNoteContent456";
          const created = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: person.personId,
            type: "marriage",
            date: "2022-04-12",
            place: SECRET_PLACE,
            notes: SECRET_NOTE,
            actorUserId: null,
            now: NOW,
          });

          const createAudits = await tx<
            { action: string; target_ids: string[]; payload: unknown }[]
          >`
            select action, target_ids, to_jsonb(a.*) as payload
            from app.audit_events a
            where action = 'people.life_event.created'
            order by seq desc limit 1
          `;
          expect(createAudits[0]?.target_ids).toEqual([created.eventId]);
          const createRowStr = JSON.stringify(createAudits[0]?.payload);
          expect(createRowStr).not.toContain(SECRET_PLACE);
          expect(createRowStr).not.toContain(SECRET_NOTE);
          expect(createRowStr).not.toContain("marriage");
          expect(createRowStr).not.toContain("2022-04-12");

          // List audit with events: targetIds has event IDs
          await listLifeEvents(tx, kms, KEY_ARN, {
            personId: person.personId,
            actorUserId: null,
          });

          const listAudits = await tx<{ action: string; target_ids: string[]; payload: unknown }[]>`
            select action, target_ids, to_jsonb(a.*) as payload
            from app.audit_events a
            where action = 'people.life_event.listed'
            order by seq desc limit 1
          `;
          expect(listAudits[0]?.target_ids).toEqual([created.eventId]);
          const listRowStr = JSON.stringify(listAudits[0]?.payload);
          expect(listRowStr).not.toContain(SECRET_PLACE);
          expect(listRowStr).not.toContain(SECRET_NOTE);

          // Update audit
          await updateLifeEvent(tx, kms, KEY_ARN, {
            eventId: created.eventId,
            version: 1,
            type: "marriage",
            date: "2022-04-12",
            place: "AnotherPlace",
            notes: "AnotherNote",
            actorUserId: null,
            now: NOW,
          });

          const updateAudits = await tx<
            { action: string; target_ids: string[]; payload: unknown }[]
          >`
            select action, target_ids, to_jsonb(a.*) as payload
            from app.audit_events a
            where action = 'people.life_event.updated'
            order by seq desc limit 1
          `;
          expect(updateAudits[0]?.target_ids).toEqual([created.eventId]);
          const updateRowStr = JSON.stringify(updateAudits[0]?.payload);
          expect(updateRowStr).not.toContain("AnotherPlace");
          expect(updateRowStr).not.toContain("AnotherNote");
          expect(updateRowStr).not.toContain("marriage");
          expect(updateRowStr).not.toContain("2022-04-12");

          // Update audit with non-null actorUserId: proves actor_id is the user and payload still holds no field value
          const actorUserId = newId();
          await updateLifeEvent(tx, kms, KEY_ARN, {
            eventId: created.eventId,
            version: 2,
            type: "marriage",
            date: "2022-04-12",
            place: "ActorPlace",
            notes: "ActorNote",
            actorUserId,
            now: NOW,
          });

          const actorAudits = await tx<
            { action: string; actor_id: string; target_ids: string[]; payload: unknown }[]
          >`
            select action, actor_id, target_ids, to_jsonb(a.*) as payload
            from app.audit_events a
            where action = 'people.life_event.updated'
            order by seq desc limit 1
          `;
          expect(actorAudits[0]?.target_ids).toEqual([created.eventId]);
          expect(actorAudits[0]?.actor_id).toBe(actorUserId);
          const actorRowStr = JSON.stringify(actorAudits[0]?.payload);
          expect(actorRowStr).not.toContain("ActorPlace");
          expect(actorRowStr).not.toContain("ActorNote");
          expect(actorRowStr).not.toContain("2022-04-12");
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("Pin 12: Rejected create and update write no row, no audit row, and make no KMS call", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'pin12-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'pin12-parish', 'au')
        `;
      });

      let personId = "";
      let eventId = "";

      // Setup initial person and 1 valid life event
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Pin12",
            familyName: "Subject",
            email: null,
            phone: null,
            actorUserId: null,
          });
          personId = person.personId;

          const created = await createLifeEvent(tx, kms, KEY_ARN, {
            personId,
            type: "baptism",
            date: "2020-01-01",
            place: "Valid Church",
            notes: null,
            actorUserId: null,
            now: NOW,
          });
          eventId = created.eventId;
        }),
      );

      // Spy on KMS to ensure no unwrap/decrypt is called when validation rejects
      let kmsDecryptCalls = 0;
      let kmsGenerateCalls = 0;
      const spiedKms: KmsPort = {
        async decrypt(keyId, blob, context) {
          kmsDecryptCalls += 1;
          return kms.decrypt(keyId, blob, context);
        },
        async generateDataKey(keyId, context) {
          kmsGenerateCalls += 1;
          return kms.generateDataKey(keyId, context);
        },
      };

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const eventsBefore = await tx<{ n: number }[]>`
            select count(*)::int as n from app.life_events where person_id = ${personId}::uuid
          `;
          const createdAuditsBefore = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events where action = 'people.life_event.created'
          `;
          const updatedAuditsBefore = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events where action = 'people.life_event.updated'
          `;

          // 1. Rejected create with future date: throws invalid_life_event
          await expect(
            createLifeEvent(tx, spiedKms, KEY_ARN, {
              personId,
              type: "marriage",
              date: "2099-01-01",
              place: null,
              notes: null,
              actorUserId: null,
              now: NOW,
            }),
          ).rejects.toThrowError(new PeopleError("invalid_life_event"));

          // No row written, no audit row written, no KMS call made
          const eventsAfterCreate = await tx<{ n: number }[]>`
            select count(*)::int as n from app.life_events where person_id = ${personId}::uuid
          `;
          expect(eventsAfterCreate[0]?.n).toBe(eventsBefore[0]?.n);

          const createdAuditsAfter = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events where action = 'people.life_event.created'
          `;
          expect(createdAuditsAfter[0]?.n).toBe(createdAuditsBefore[0]?.n);
          expect(kmsDecryptCalls).toBe(0);
          expect(kmsGenerateCalls).toBe(0);

          // 2. Rejected update with future date: throws invalid_life_event
          await expect(
            updateLifeEvent(tx, spiedKms, KEY_ARN, {
              eventId,
              version: 1,
              type: "marriage",
              date: "2099-01-01",
              place: "Future Church",
              notes: null,
              actorUserId: null,
              now: NOW,
            }),
          ).rejects.toThrowError(new PeopleError("invalid_life_event"));

          // Row unchanged, no update audit row written, no KMS call made
          const updatedAuditsAfter = await tx<{ n: number }[]>`
            select count(*)::int as n from app.audit_events where action = 'people.life_event.updated'
          `;
          expect(updatedAuditsAfter[0]?.n).toBe(updatedAuditsBefore[0]?.n);
          expect(kmsDecryptCalls).toBe(0);
          expect(kmsGenerateCalls).toBe(0);

          const list = await listLifeEvents(tx, kms, KEY_ARN, {
            personId,
            actorUserId: null,
          });
          expect(list.items[0]?.place).toBe("Valid Church");
          expect(list.items[0]?.version).toBe(1);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("Pin 13: Cap of 50 events per person throws too_many on 51st event", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'pin13-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'pin13-parish', 'au')
        `;
      });

      let personId = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Cap",
            familyName: "Subject",
            email: null,
            phone: null,
            actorUserId: null,
          });
          personId = person.personId;
        }),
      );

      // Create 50 events using createLifeEvent (1 to 50 succeed)
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          for (let i = 0; i < 50; i += 1) {
            await createLifeEvent(tx, kms, KEY_ARN, {
              personId,
              type: "baptism",
              date: "2020-01-01",
              place: null,
              notes: null,
              actorUserId: null,
              now: NOW,
            });
          }
        }),
      );

      // Exactly 50 events:
      // 1) listLifeEvents MUST succeed and return 50 items
      // 2) createLifeEvent MUST throw too_many and write no row
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const listed = await listLifeEvents(tx, kms, KEY_ARN, {
            personId,
            actorUserId: null,
          });
          expect(listed.items).toHaveLength(50);

          await expect(
            createLifeEvent(tx, kms, KEY_ARN, {
              personId,
              type: "marriage",
              date: "2021-01-01",
              place: null,
              notes: null,
              actorUserId: null,
              now: NOW,
            }),
          ).rejects.toThrowError(new PeopleError("too_many"));

          const countRows = await tx<{ count: string }[]>`
            select count(*)::text as count
            from app.life_events
            where person_id = ${personId}::uuid
          `;
          expect(Number(countRows[0]?.count)).toBe(50);
        }),
      );

      // Direct insert 1 more to reach 51 total rows for person to test list cap
      const [sample] = await directSql<
        {
          event_type: Uint8Array;
          event_date: Uint8Array;
        }[]
      >`
        select event_type, event_date from app.life_events where person_id = ${personId}::uuid limit 1
      `;
      expect(sample).toBeDefined();

      const extraId = newId();
      await directSql`
        insert into app.life_events (
          id, org_id, community_id, person_id, version, event_type, event_date
        ) values (
          ${extraId}::uuid, ${organisationId}::uuid, ${communityId}::uuid, ${personId}::uuid, 1,
          ${sample!.event_type}, ${sample!.event_date}
        )
      `;

      // 51 events total: listLifeEvents MUST throw too_many
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          await expect(
            listLifeEvents(tx, kms, KEY_ARN, {
              personId,
              actorUserId: null,
            }),
          ).rejects.toThrowError(new PeopleError("too_many"));
        }),
      );
    } finally {
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("Pin 19: Create is atomic with its audit event and usage fact", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'pin19-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'pin19-parish', 'au')
        `;
      });

      let personId = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Atomic",
            familyName: "Subject",
            email: null,
            phone: null,
            actorUserId: null,
          });
          personId = person.personId;
        }),
      );

      // Case A: createLifeEvent resolves before a subsequent forced tx failure
      let createdResult: { eventId: string; version: number } | undefined;
      await expect(
        withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
            createdResult = await createLifeEvent(tx, kms, KEY_ARN, {
              personId,
              type: "baptism",
              date: "2020-01-01",
              place: null,
              notes: null,
              actorUserId: null,
              now: NOW,
            });
            // Assert createLifeEvent resolved inside transaction before forced failure
            expect(createdResult.eventId).toBeDefined();
            expect(createdResult.version).toBe(1);

            // Force tx failure
            await tx`select 'force failure'::int`;
          }),
        ),
      ).rejects.toThrow();

      expect(createdResult).toBeDefined();
      const failedEventId = createdResult!.eventId;

      // Check from direct connection: no life_events row, no audit row, and no usage fact exist
      const rowsA = await directSql<{ id: string }[]>`
        select id::text from app.life_events where id = ${failedEventId}::uuid
      `;
      expect(rowsA).toHaveLength(0);

      const auditRowsA = await directSql<{ id: string }[]>`
        select id::text from app.audit_events
        where org_id = ${organisationId}::uuid
          and action = 'people.life_event.created'
      `;
      expect(auditRowsA).toHaveLength(0);

      const usageRowsA = await directSql<{ org_id: string }[]>`
        select org_id::text from app.usage_facts_daily
        where org_id = ${organisationId}::uuid
          and feature_key = 'people.households'
      `;
      expect(usageRowsA).toHaveLength(0);

      // Case B: Case where audit append fails during createLifeEvent
      // Invalid requestId causes appendAuditEvent to reject after event and usage fact inserts
      await expect(
        withRequest({ requestId: "not-a-valid-uuid" }, () =>
          withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
            await createLifeEvent(tx, kms, KEY_ARN, {
              personId,
              type: "baptism",
              date: "2020-01-01",
              place: null,
              notes: null,
              actorUserId: null,
              now: NOW,
            });
          }),
        ),
      ).rejects.toThrow(/requestId must be a UUID/);

      // Assert from direct connection (second connection) that everything rolled back:
      // no event row, no audit row, and no usage fact exist
      const rowsB = await directSql<{ id: string }[]>`
        select id::text from app.life_events where person_id = ${personId}::uuid
      `;
      expect(rowsB).toHaveLength(0);

      const auditRowsB = await directSql<{ id: string }[]>`
        select id::text from app.audit_events
        where org_id = ${organisationId}::uuid
          and action = 'people.life_event.created'
      `;
      expect(auditRowsB).toHaveLength(0);

      const usageRowsB = await directSql<{ org_id: string }[]>`
        select org_id::text from app.usage_facts_daily
        where org_id = ${organisationId}::uuid
          and feature_key = 'people.households'
      `;
      expect(usageRowsB).toHaveLength(0);
    } finally {
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("sorts life events newest date first in memory after decryption", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'sort-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'sort-parish', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Sort",
            familyName: "Subject",
            email: null,
            phone: null,
            actorUserId: null,
          });

          // Insert out of chronological order
          await createLifeEvent(tx, kms, KEY_ARN, {
            personId: person.personId,
            type: "baptism",
            date: "2010-01-01",
            now: NOW,
            actorUserId: null,
          });
          await createLifeEvent(tx, kms, KEY_ARN, {
            personId: person.personId,
            type: "first_communion",
            date: "2018-05-20",
            now: NOW,
            actorUserId: null,
          });
          await createLifeEvent(tx, kms, KEY_ARN, {
            personId: person.personId,
            type: "marriage",
            date: "2025-10-15",
            now: NOW,
            actorUserId: null,
          });

          const list = await listLifeEvents(tx, kms, KEY_ARN, {
            personId: person.personId,
            actorUserId: null,
          });

          expect(list.items.map((i) => i.date)).toEqual(["2025-10-15", "2018-05-20", "2010-01-01"]);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("F1: serialises concurrent creates on the person row so cap of 50 is strictly enforced", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'f1-concurrency-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'f1-concurrency-parish', 'au')
        `;
      });

      const scope = { orgId: organisationId, communityId };
      let personId = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Concurrency",
            familyName: "Subject",
            email: null,
            phone: null,
            actorUserId: null,
          });
          personId = person.personId;
        }),
      );

      // Seed 49 events
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          for (let i = 0; i < 49; i += 1) {
            await createLifeEvent(tx, kms, KEY_ARN, {
              personId,
              type: "baptism",
              date: "2020-01-01",
              place: null,
              notes: null,
              actorUserId: null,
              now: NOW,
            });
          }
        }),
      );

      // Tx1 acquires lock and creates 50th event, then holds open until releaseTx1
      let releaseTx1!: () => void;
      const tx1Hold = new Promise<void>((resolve) => {
        releaseTx1 = resolve;
      });
      let tx1Started = false;

      const p1 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx1) => {
          const created = await createLifeEvent(tx1, kms, KEY_ARN, {
            personId,
            type: "marriage",
            date: "2020-01-02",
            place: "Church 1",
            notes: null,
            actorUserId: null,
            now: NOW,
          });
          tx1Started = true;
          await tx1Hold;
          return created;
        }),
      );

      while (!tx1Started) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Tx2 and Tx3 attempt concurrent createLifeEvent for the same person
      let tx2Pid: number | null = null;

      const p2 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx2) => {
          const pidRows = await tx2<{ pid: number }[]>`select pg_backend_pid() as pid`;
          tx2Pid = pidRows[0]!.pid;
          return createLifeEvent(tx2, kms, KEY_ARN, {
            personId,
            type: "funeral",
            date: "2020-01-03",
            place: "Church 2",
            notes: null,
            actorUserId: null,
            now: NOW,
          });
        }),
      );

      const p3 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx3) => {
          return createLifeEvent(tx3, kms, KEY_ARN, {
            personId,
            type: "first_communion",
            date: "2020-01-04",
            place: "Church 3",
            notes: null,
            actorUserId: null,
            now: NOW,
          });
        }),
      );

      // Wait until Tx2 is waiting on 'Lock' in pg_stat_activity
      const start = Date.now();
      let tx2Locked = false;
      while (Date.now() - start < 10000) {
        if (tx2Pid !== null) {
          const stat = await directSql<{ wait_event_type: string | null }[]>`
            select wait_event_type from pg_stat_activity where pid = ${tx2Pid}
          `;
          if (stat[0]?.wait_event_type === "Lock") {
            tx2Locked = true;
            break;
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(tx2Locked).toBe(true);

      // Release Tx1 and let all complete
      releaseTx1();

      const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);

      // Exactly one succeeds, the other two reject with too_many
      expect(r1.status).toBe("fulfilled");
      expect(r2.status).toBe("rejected");
      expect(r3.status).toBe("rejected");
      expect((r2 as PromiseRejectedResult).reason).toEqual(new PeopleError("too_many"));
      expect((r3 as PromiseRejectedResult).reason).toEqual(new PeopleError("too_many"));

      // Total row count is exactly 50
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const countRows = await tx<{ count: string }[]>`
            select count(*)::text as count
            from app.life_events
            where person_id = ${personId}::uuid
              and org_id = current_setting('app.org_id')::uuid
              and community_id = current_setting('app.community_id')::uuid
          `;
          expect(Number(countRows[0]?.count)).toBe(50);

          // listLifeEvents still succeeds
          const list = await listLifeEvents(tx, kms, KEY_ARN, {
            personId,
            actorUserId: null,
          });
          expect(list.items).toHaveLength(50);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("asserts key id in stored ciphertext envelope: household key for minor on create and update, community key for adult on create and update", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'envelope-keyid-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'envelope-keyid-comm', 'au')
        `;
      });

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const household = await createHousehold(tx, kms, KEY_ARN, {
            label: "Smith Family",
            actorUserId: null,
            now: NOW,
          });

          const guardian = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: household.householdId,
            dateOfBirth: null,
            givenName: "John",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId: null,
          });

          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: "2015-06-01",
            givenName: "Tommy",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId: null,
          });

          const commKeys = await communityFieldKeys(tx, kms, KEY_ARN);
          const hhKeys = await householdFieldKeys(tx, kms, KEY_ARN, household.householdId);

          const expectedCommKeyBytes = uuidToBytes(commKeys.keyId);
          const expectedHhKeyBytes = uuidToBytes(hhKeys.keyId);

          // 1. Minor event create: stored envelope has household key id
          const minorCreated = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: minor.personId,
            type: "first_communion",
            date: "2025-05-18",
            place: "St Jude's",
            notes: "Communion notes",
            actorUserId: null,
            now: NOW,
          });

          const [minorCreateRow] = await tx<
            {
              event_type: Uint8Array;
              place: Uint8Array;
              notes: Uint8Array;
            }[]
          >`
            select event_type, place, notes from app.life_events where id = ${minorCreated.eventId}::uuid
          `;
          expect(extractEnvelopeKeyId(minorCreateRow!.event_type)).toEqual(expectedHhKeyBytes);
          expect(extractEnvelopeKeyId(minorCreateRow!.place)).toEqual(expectedHhKeyBytes);
          expect(extractEnvelopeKeyId(minorCreateRow!.notes)).toEqual(expectedHhKeyBytes);

          // 2. Minor event update: stored envelope has household key id
          await updateLifeEvent(tx, kms, KEY_ARN, {
            eventId: minorCreated.eventId,
            version: 1,
            type: "first_communion",
            date: "2025-05-19",
            place: "St Jude's Cathedral",
            notes: "Updated notes",
            actorUserId: null,
            now: NOW,
          });

          const [minorUpdateRow] = await tx<
            {
              event_type: Uint8Array;
              place: Uint8Array;
              notes: Uint8Array;
            }[]
          >`
            select event_type, place, notes from app.life_events where id = ${minorCreated.eventId}::uuid
          `;
          expect(extractEnvelopeKeyId(minorUpdateRow!.event_type)).toEqual(expectedHhKeyBytes);
          expect(extractEnvelopeKeyId(minorUpdateRow!.place)).toEqual(expectedHhKeyBytes);
          expect(extractEnvelopeKeyId(minorUpdateRow!.notes)).toEqual(expectedHhKeyBytes);

          // 3. Adult event create: stored envelope has community key id
          const adultCreated = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: guardian.personId,
            type: "marriage",
            date: "2010-09-12",
            place: "St Joseph's",
            notes: "Marriage record",
            actorUserId: null,
            now: NOW,
          });

          const [adultCreateRow] = await tx<
            {
              event_type: Uint8Array;
              place: Uint8Array;
              notes: Uint8Array;
            }[]
          >`
            select event_type, place, notes from app.life_events where id = ${adultCreated.eventId}::uuid
          `;
          expect(extractEnvelopeKeyId(adultCreateRow!.event_type)).toEqual(expectedCommKeyBytes);
          expect(extractEnvelopeKeyId(adultCreateRow!.place)).toEqual(expectedCommKeyBytes);
          expect(extractEnvelopeKeyId(adultCreateRow!.notes)).toEqual(expectedCommKeyBytes);

          // 4. Adult event update: stored envelope has community key id
          await updateLifeEvent(tx, kms, KEY_ARN, {
            eventId: adultCreated.eventId,
            version: 1,
            type: "marriage",
            date: "2010-09-12",
            place: "St Joseph's Cathedral",
            notes: "Updated marriage record",
            actorUserId: null,
            now: NOW,
          });

          const [adultUpdateRow] = await tx<
            {
              event_type: Uint8Array;
              place: Uint8Array;
              notes: Uint8Array;
            }[]
          >`
            select event_type, place, notes from app.life_events where id = ${adultCreated.eventId}::uuid
          `;
          expect(extractEnvelopeKeyId(adultUpdateRow!.event_type)).toEqual(expectedCommKeyBytes);
          expect(extractEnvelopeKeyId(adultUpdateRow!.place)).toEqual(expectedCommKeyBytes);
          expect(extractEnvelopeKeyId(adultUpdateRow!.notes)).toEqual(expectedCommKeyBytes);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
