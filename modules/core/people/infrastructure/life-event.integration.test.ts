import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { decrypt, type Ciphertext } from "@community-hub/crypto";
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
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'pin5-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'pin5-parish', 'au')
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

      // Reading as service must fail because AAD rowId does not match
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          await expect(
            listLifeEvents(tx, kms, KEY_ARN, {
              personId,
              actorUserId: null,
            }),
          ).rejects.toThrow();
        }),
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
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

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

          // Create 1 real event
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
      );

      // Direct insert to reach 51 total rows for person
      const [sample] = await directSql<
        {
          event_type: Uint8Array;
          event_date: Uint8Array;
        }[]
      >`
        select event_type, event_date from app.life_events where person_id = ${personId}::uuid limit 1
      `;
      expect(sample).toBeDefined();

      for (let i = 0; i < 50; i += 1) {
        const id = newId();
        await directSql`
          insert into app.life_events (
            id, org_id, community_id, person_id, version, event_type, event_date
          ) values (
            ${id}::uuid, ${organisationId}::uuid, ${communityId}::uuid, ${personId}::uuid, 1,
            ${sample!.event_type}, ${sample!.event_date}
          )
        `;
      }

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

      // Force failure during transaction (e.g. invalid action in subsequent statement)
      await expect(
        withRequest({ requestId: REQUEST_ID }, () =>
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
            // Force tx failure
            await tx`select 'force failure'::int`;
          }),
        ),
      ).rejects.toThrow();

      // Check from direct connection: no life_events row exists
      const rows = await directSql<{ id: string }[]>`
        select id::text from app.life_events where person_id = ${personId}::uuid
      `;
      expect(rows).toHaveLength(0);
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
});
