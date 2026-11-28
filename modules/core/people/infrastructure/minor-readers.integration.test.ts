import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { KmsPort } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import {
  applyProductMigrations,
  newId,
  withAppTransaction,
  type AppTransaction,
} from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import {
  attachTag,
  createHousehold,
  createLifeEvent,
  createPerson,
  createTag,
  detachTag,
  hidePerson,
  linkGuardian,
  listDeletedPersons,
  listLifeEvents,
  listPersonActivity,
  listPersons,
  listPersonTags,
  openPersonFieldKeys,
  PeopleError,
  readHousehold,
  readHouseholdDetail,
  readLinkedContacts,
  readPerson,
  readRosterNames,
  visiblePersonIds,
} from "../public/index.js";
import { childLabels } from "./child-labels.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

type Scope = { orgId: string; communityId: string };

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
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-15T00:00:00+11:00");

// Seeded child values are unusual on purpose: a substring hit is never a coincidence.
const CHILD_ONE = {
  givenName: "Zephyrine",
  familyName: "Quillonwick",
  email: "zephyrine.quillonwick@zephyr.example.test",
  phone: "+61400555101",
  dateOfBirth: "2018-05-05",
};
const CHILD_TWO = {
  givenName: "Quillon",
  familyName: "Zephyrwick",
  email: "quillon.zephyrwick@zephyr.example.test",
  phone: "+61400555102",
  dateOfBirth: "2019-06-07",
};
const CHILD_VALUES = [
  CHILD_ONE.givenName,
  CHILD_ONE.familyName,
  CHILD_ONE.email,
  CHILD_ONE.phone,
  CHILD_ONE.dateOfBirth,
  CHILD_TWO.givenName,
  CHILD_TWO.familyName,
  CHILD_TWO.email,
  CHILD_TWO.phone,
  CHILD_TWO.dateOfBirth,
];

let platform: ReturnType<typeof createPlaintextPlatformSql>;
let app: ReturnType<typeof createPlaintextAppSql>;
let directSql: ReturnType<typeof createPlaintextDirectSql>;
const baseKms = createLocalKmsPort();

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

beforeAll(async () => {
  const runtime = loadRuntime();
  directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
  await applyProductMigrations(directSql);
  platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  app = createPlaintextAppSql(roleUrl(runtime, "app"));
});

afterAll(async () => {
  await Promise.all([
    platform?.end({ timeout: 1 }),
    app?.end({ timeout: 1 }),
    directSql?.end({ timeout: 1 }),
  ]);
});

// Wraps a KMS port and counts its Decrypt calls, so a test can show that a reader opened no key.
function countingKms(inner: KmsPort): { kms: KmsPort; calls: () => number; reset: () => void } {
  let count = 0;
  return {
    kms: {
      generateDataKey(keyId, context) {
        return inner.generateDataKey(keyId, context);
      },
      decrypt(keyId, blob, context) {
        count += 1;
        return inner.decrypt(keyId, blob, context);
      },
    },
    calls: () => count,
    reset: () => {
      count = 0;
    },
  };
}

async function newScope(): Promise<Scope> {
  const orgId = newId();
  const communityId = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.organisations (id, slug, region, kind)
      values (${orgId}, ${`minor-readers-org-${orgId}`}, 'au', 'implicit')
    `;
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`minor-readers-comm-${communityId}`}, 'au')
    `;
  });
  return { orgId, communityId };
}

function inScope<T>(scope: Scope, run: (tx: AppTransaction) => Promise<T>): Promise<T> {
  return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, run));
}

type Family = {
  householdId: string;
  version: number;
  adultId: string;
  childOneId: string;
  childTwoId: string;
};

// One adult and two children in one household. The second child is created an hour later, so
// the labels are Child 1 and Child 2 by created_at and do not depend on id order (ids are
// time-prefixed but not monotonic inside one millisecond).
async function seedFamily(
  tx: AppTransaction,
  actorUserId: string,
  label: string | null,
): Promise<Family> {
  const household = await createHousehold(tx, baseKms, KEY_ARN, {
    now: NOW,
    label,
    actorUserId,
  });
  const adult = await createPerson(tx, baseKms, KEY_ARN, {
    now: NOW,
    declaredAdult: true,
    householdId: household.householdId,
    dateOfBirth: null,
    givenName: "Aurelia",
    familyName: "Marchetti",
    email: "aurelia.marchetti@parish.example.test",
    phone: null,
    actorUserId,
  });
  const childOne = await createPerson(tx, baseKms, KEY_ARN, {
    now: NOW,
    declaredAdult: false,
    householdId: household.householdId,
    ...CHILD_ONE,
    actorUserId,
  });
  const childTwo = await createPerson(tx, baseKms, KEY_ARN, {
    now: new Date(NOW.getTime() + 3_600_000),
    declaredAdult: false,
    householdId: household.householdId,
    ...CHILD_TWO,
    actorUserId,
  });
  return {
    householdId: household.householdId,
    version: household.version,
    adultId: adult.personId,
    childOneId: childOne.personId,
    childTwoId: childTwo.personId,
  };
}

// Hides children the way a later chunk will (Family Records: children): deleted_at and deleted_by
// are set. Today the user triggers refuse that, and no function hides a child, so it is done in a
// short committed transaction as the migrator with the user triggers off, as the other hidden-row
// tests do (Global constraints: seeding rows the product cannot yet create).
async function hideChildren(scope: Scope, personIds: string[]): Promise<void> {
  const deletedBy = newId();
  await withAppTransaction(directSql, scope, async (tx) => {
    await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
    for (const personId of personIds) {
      await tx`
        update app.persons
        set deleted_at = now() - interval '1 hour', deleted_by = ${deletedBy}::uuid
        where id = ${personId}::uuid
      `;
    }
    await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
  });
}

function expectNoChildValue(value: unknown): void {
  const text = JSON.stringify(value);
  for (const forbidden of CHILD_VALUES) {
    expect(text).not.toContain(forbidden);
  }
}

describe("people readers carry no minor fields", () => {
  it("pin 21: readPerson answers null for a minor and decrypts nothing", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const counting = countingKms(baseKms);
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));

    await inScope(scope, async (tx) => {
      counting.reset();
      const asActor = await readPerson(tx, counting.kms, KEY_ARN, {
        personId: family.childOneId,
        actorUserId,
      });
      const asSystem = await readPerson(tx, counting.kms, KEY_ARN, {
        personId: family.childTwoId,
        actorUserId: null,
      });
      const missing = await readPerson(tx, counting.kms, KEY_ARN, {
        personId: newId(),
        actorUserId,
      });
      expect(asActor).toBeNull();
      expect(asSystem).toBeNull();
      expect(missing).toBeNull();
      expect(counting.calls()).toBe(0);

      const reads = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.audit_events
        where action = 'people.person.read'
          and (${family.childOneId}::uuid = any(target_ids)
            or ${family.childTwoId}::uuid = any(target_ids))
      `;
      expect(reads[0]?.n).toBe(0);

      const adult = await readPerson(tx, counting.kms, KEY_ARN, {
        personId: family.adultId,
        actorUserId,
      });
      expect(adult).toMatchObject({
        isMinor: false,
        givenName: "Aurelia",
        familyName: "Marchetti",
      });
    });
  });

  it("pin 22: minors mode returns only personId, label, householdId and householdLabel", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const { familyA, familyB, soleChildId } = await inScope(scope, async (tx) => {
      const a = await seedFamily(tx, actorUserId, "Marchetti household");
      const b = await createHousehold(tx, baseKms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId,
      });
      const sole = await createPerson(tx, baseKms, KEY_ARN, {
        now: NOW,
        declaredAdult: false,
        householdId: b.householdId,
        dateOfBirth: "2021-01-12",
        givenName: "Cassiopeia",
        familyName: "Vanterpool",
        email: null,
        phone: null,
        actorUserId,
      });
      return { familyA: a, familyB: b, soleChildId: sole.personId };
    });

    await inScope(scope, async (tx) => {
      const result = await listPersons(tx, baseKms, KEY_ARN, {
        kind: "minors",
        childView: "admin",
        actorUserId,
      });
      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(3);
      for (const item of result.items) {
        expect(Object.keys(item).sort()).toEqual([
          "householdId",
          "householdLabel",
          "label",
          "personId",
        ]);
      }
      const byId = new Map(result.items.map((item) => [item.personId, item]));
      expect(byId.get(familyA.childOneId)).toEqual({
        personId: familyA.childOneId,
        label: "Child 1",
        householdId: familyA.householdId,
        householdLabel: "Marchetti household",
      });
      expect(byId.get(familyA.childTwoId)).toEqual({
        personId: familyA.childTwoId,
        label: "Child 2",
        householdId: familyA.householdId,
        householdLabel: "Marchetti household",
      });
      expect(byId.get(soleChildId)).toEqual({
        personId: soleChildId,
        label: "Child 1",
        householdId: familyB.householdId,
        householdLabel: null,
      });
      const ids = result.items.map((item) => item.personId);
      expect(ids).toEqual([...ids].sort());
      expectNoChildValue(result);
      expect(JSON.stringify(result)).not.toContain("Cassiopeia");
      expect(JSON.stringify(result)).not.toContain("Vanterpool");
    });
  });

  it("pin 22 (continued): a community whose households have no label opens no key in minors mode", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const counting = countingKms(baseKms);
    await inScope(scope, (tx) => seedFamily(tx, actorUserId, null));

    await inScope(scope, async (tx) => {
      counting.reset();
      const result = await listPersons(tx, counting.kms, KEY_ARN, {
        kind: "minors",
        childView: "admin",
        actorUserId,
      });
      expect(result.items).toHaveLength(2);
      expect(result.items.every((item) => item.householdLabel === null)).toBe(true);
      expect(counting.calls()).toBe(0);
    });
  });

  it("pin 22 (continued): minors mode refuses presence and a missing childView, and audits nothing", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));

    await inScope(scope, async (tx) => {
      await expect(
        listPersons(tx, baseKms, KEY_ARN, { kind: "minors", childView: "presence", actorUserId }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        listPersons(tx, baseKms, KEY_ARN, { kind: "minors", actorUserId } as never),
      ).rejects.toBeInstanceOf(PeopleError);
      const audits = await tx<{ n: number }[]>`
        select count(*)::int as n from app.audit_events where action = 'people.person.listed_minors'
      `;
      expect(audits[0]?.n).toBe(0);
    });
  });

  it("pin 23: minors mode leaves out a hidden minor and numbers the rest", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));

    await inScope(scope, async (tx) => {
      const before = await listPersons(tx, baseKms, KEY_ARN, {
        kind: "minors",
        childView: "admin",
        actorUserId,
      });
      expect(before.items.map((item) => item.personId).sort()).toEqual(
        [family.childOneId, family.childTwoId].sort(),
      );
      expect(before.items.map((item) => item.label).sort()).toEqual(["Child 1", "Child 2"]);
    });

    await hideChildren(scope, [family.childOneId]);

    await inScope(scope, async (tx) => {
      const after = await listPersons(tx, baseKms, KEY_ARN, {
        kind: "minors",
        childView: "admin",
        actorUserId,
      });
      expect(after.items.map((item) => item.personId)).toEqual([family.childTwoId]);
      expect(after.items[0]?.label).toBe("Child 1");
    });
  });

  it("pin 24: listDeletedPersons never lists a hidden minor", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));
    await inScope(scope, (tx) => hidePerson(tx, { personId: family.adultId, actorUserId }));
    await hideChildren(scope, [family.childOneId, family.childTwoId]);

    // The seeded state is what the test says it is: the adult and both children are hidden.
    const hidden = await directSql<{ id: string }[]>`
      select id::text as id
      from app.persons
      where household_id = ${family.householdId}::uuid and deleted_at is not null
    `;
    expect(hidden.map((row) => row.id).sort()).toEqual(
      [family.adultId, family.childOneId, family.childTwoId].sort(),
    );

    await inScope(scope, async (tx) => {
      const deleted = await listDeletedPersons(tx, { actorUserId });
      const ids = deleted.items.map((item) => item.id);
      expect(ids).toContain(family.adultId);
      expect(ids).not.toContain(family.childOneId);
      expect(ids).not.toContain(family.childTwoId);
      expectNoChildValue(deleted);
    });
  });

  it("pin 25: openPersonFieldKeys answers null for a minor, whoever the actor is", async () => {
    const scope = await newScope();
    const adminUserId = newId();
    const counting = countingKms(baseKms);
    const family = await inScope(scope, (tx) => seedFamily(tx, adminUserId, "Marchetti"));

    await inScope(scope, async (tx) => {
      counting.reset();
      const asAdmin = await openPersonFieldKeys(tx, counting.kms, KEY_ARN, {
        personId: family.childOneId,
        actorUserId: adminUserId,
      });
      const asSystem = await openPersonFieldKeys(tx, counting.kms, KEY_ARN, {
        personId: family.childTwoId,
        actorUserId: null,
      });
      expect(asAdmin).toBeNull();
      expect(asSystem).toBeNull();
      expect(counting.calls()).toBe(0);

      const adult = await openPersonFieldKeys(tx, counting.kms, KEY_ARN, {
        personId: family.adultId,
        actorUserId: adminUserId,
      });
      expect(adult).not.toBeNull();
    });
  });

  it("pin 26: listPersonActivity answers as for a missing person when the person is a minor", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));

    await inScope(scope, async (tx) => {
      const forMinor = await listPersonActivity(tx, family.childOneId);
      const forMissing = await listPersonActivity(tx, newId());
      expect(forMissing).toBeNull();
      expect(forMinor).toBeNull();
      const forAdult = await listPersonActivity(tx, family.adultId);
      expect(forAdult?.map((entry) => entry.kind)).toEqual(["created"]);
    });
  });

  it("pin 27: listPersonTags answers as for a missing person when the person is a minor", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));

    await inScope(scope, async (tx) => {
      const forMinor = await listPersonTags(tx, family.childOneId);
      const forMissing = await listPersonTags(tx, newId());
      expect(forMissing).toBeNull();
      expect(forMinor).toBeNull();
      const forAdult = await listPersonTags(tx, family.adultId);
      expect(forAdult).toEqual([]);
    });
  });

  it("pin 28: attachTag on a minor answers not_found and writes no link", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));
    const tag = await inScope(scope, (tx) => createTag(tx, { label: "choir" }));

    await inScope(scope, async (tx) => {
      await expect(
        attachTag(tx, {
          now: NOW,
          personId: family.childOneId,
          tagId: tag.tagId,
          actorUserId,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      const links = await tx<{ n: number }[]>`
        select count(*)::int as n from app.person_tag_links where person_id = ${family.childOneId}::uuid
      `;
      expect(links[0]?.n).toBe(0);
      const tagged = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.person_activity
        where person_id = ${family.childOneId}::uuid and kind = 'tagged'
      `;
      expect(tagged[0]?.n).toBe(0);

      await attachTag(tx, { now: NOW, personId: family.adultId, tagId: tag.tagId, actorUserId });
      expect(await listPersonTags(tx, family.adultId)).toEqual([
        { tagId: tag.tagId, label: "choir" },
      ]);
    });
  });

  it("pin 28b: detachTag on a minor answers not_found and leaves an existing link", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));
    const tag = await inScope(scope, (tx) => createTag(tx, { label: "servers" }));
    // The link is written as the owner role: attachTag now refuses a minor, so this is the only
    // way a link on a child can exist (for example an old row).
    await directSql`
      insert into app.person_tag_links (org_id, community_id, person_id, tag_id)
      values (
        ${scope.orgId}::uuid, ${scope.communityId}::uuid,
        ${family.childOneId}::uuid, ${tag.tagId}::uuid
      )
    `;

    await inScope(scope, async (tx) => {
      await expect(
        detachTag(tx, {
          now: NOW,
          personId: family.childOneId,
          tagId: tag.tagId,
          actorUserId,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    const left = await directSql<{ n: number }[]>`
      select count(*)::int as n from app.person_tag_links where person_id = ${family.childOneId}::uuid
    `;
    expect(left[0]?.n).toBe(1);
  });

  it("pin 29: readLinkedContacts has no contact for a minor under presence and { minor: true } under admin", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const counting = countingKms(baseKms);
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));
    const personIds = [family.adultId, family.childOneId, family.childTwoId];

    await inScope(scope, async (tx) => {
      counting.reset();
      const presence = await readLinkedContacts(tx, counting.kms, KEY_ARN, {
        personIds,
        includePhone: true,
        actorUserId,
        childView: "presence",
      });
      expect(presence.get(family.childOneId)).toBeUndefined();
      expect(presence.get(family.childTwoId)).toBeUndefined();
      expect(presence.has(family.childOneId)).toBe(false);
      expect(presence.get(family.adultId)).toEqual({
        minor: false,
        given: "Aurelia",
        family: "Marchetti",
        phone: null,
      });
      expect(counting.calls()).toBe(0);

      const admin = await readLinkedContacts(tx, counting.kms, KEY_ARN, {
        personIds,
        includePhone: true,
        actorUserId,
        childView: "admin",
      });
      expect(admin.get(family.childOneId)).toEqual({ minor: true });
      expect(admin.get(family.childTwoId)).toEqual({ minor: true });
      expect(admin.get(family.adultId)).toMatchObject({ minor: false, given: "Aurelia" });
      expect(counting.calls()).toBe(0);
      expectNoChildValue([...presence.entries(), ...admin.entries()]);

      await expect(
        readLinkedContacts(tx, counting.kms, KEY_ARN, {
          personIds,
          includePhone: true,
          actorUserId,
        } as never),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  it("pin 37: listLifeEvents of a minor returns eventId only and decrypts nothing", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const counting = countingKms(baseKms);
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));
    const events = await inScope(scope, async (tx) => {
      const first = await createLifeEvent(tx, baseKms, KEY_ARN, {
        personId: family.childOneId,
        type: "baptism",
        date: "2019-03-03",
        place: "Zephyr Chapel",
        notes: "Quillonwick godparents",
        actorUserId,
        now: NOW,
      });
      const second = await createLifeEvent(tx, baseKms, KEY_ARN, {
        personId: family.childOneId,
        type: "first_communion",
        date: "2026-05-05",
        place: null,
        notes: null,
        actorUserId,
        now: NOW,
      });
      const adultEvent = await createLifeEvent(tx, baseKms, KEY_ARN, {
        personId: family.adultId,
        type: "marriage",
        date: "2010-01-01",
        place: "Saint Aldric",
        notes: null,
        actorUserId,
        now: NOW,
      });
      return { first: first.eventId, second: second.eventId, adult: adultEvent.eventId };
    });

    await inScope(scope, async (tx) => {
      counting.reset();
      const forAdmin = await listLifeEvents(tx, counting.kms, KEY_ARN, {
        personId: family.childOneId,
        actorUserId,
        childView: "admin",
      });
      expect(forAdmin.items.map((item) => Object.keys(item))).toEqual([["eventId"], ["eventId"]]);
      expect(forAdmin.items.map((item) => item.eventId).sort()).toEqual(
        [events.first, events.second].sort(),
      );
      expect(counting.calls()).toBe(0);
      for (const forbidden of ["baptism", "first_communion", "Zephyr Chapel", "godparents"]) {
        expect(JSON.stringify(forAdmin)).not.toContain(forbidden);
      }

      // Under presence a minor's events are refused, as for a person that does not exist.
      await expect(
        listLifeEvents(tx, counting.kms, KEY_ARN, {
          personId: family.childOneId,
          actorUserId,
          childView: "presence",
        }),
      ).rejects.toMatchObject({ code: "life_event_not_found" });
      await expect(
        listLifeEvents(tx, counting.kms, KEY_ARN, {
          personId: newId(),
          actorUserId,
          childView: "presence",
        }),
      ).rejects.toMatchObject({ code: "life_event_not_found" });
      expect(counting.calls()).toBe(0);

      // An adult's events are unchanged under both views.
      const adultPresence = await listLifeEvents(tx, counting.kms, KEY_ARN, {
        personId: family.adultId,
        actorUserId,
        childView: "presence",
      });
      expect(adultPresence.items).toEqual([
        {
          eventId: events.adult,
          version: 1,
          type: "marriage",
          date: "2010-01-01",
          place: "Saint Aldric",
          notes: null,
        },
      ]);
      const adultAdmin = await listLifeEvents(tx, counting.kms, KEY_ARN, {
        personId: family.adultId,
        actorUserId,
        childView: "admin",
      });
      expect(adultAdmin.items).toEqual(adultPresence.items);
    });
  });

  it("pin 35: readRosterNames under presence has no minor row and reports minorCount", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const counting = countingKms(baseKms);
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));
    const personIds = [family.adultId, family.childOneId, family.childTwoId];

    await inScope(scope, async (tx) => {
      counting.reset();
      const presence = await readRosterNames(tx, counting.kms, KEY_ARN, {
        personIds,
        childView: "presence",
        actorUserId,
      });
      expect(Object.keys(presence).sort()).toEqual(["adults", "children", "minorCount"]);
      // The adult is unchanged: the same four keys as before this chunk.
      expect(presence.adults).toEqual([
        { personId: family.adultId, isMinor: false, givenName: "Aurelia", familyName: "Marchetti" },
      ]);
      // No minor row at all: not a name, not a label and not an id.
      expect(presence.children).toEqual([]);
      expect(presence.minorCount).toBe(2);
      const text = JSON.stringify(presence);
      expect(text).not.toContain(family.childOneId);
      expect(text).not.toContain(family.childTwoId);
      expect(text).not.toContain("Child");
      expectNoChildValue(presence);
      // Nothing was decrypted, so no key was opened and no read was audited.
      expect(counting.calls()).toBe(0);
      const reads = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.audit_events
        where action = 'people.person.read'
          and (${family.childOneId}::uuid = any(target_ids)
            or ${family.childTwoId}::uuid = any(target_ids))
      `;
      expect(reads[0]?.n).toBe(0);

      // Only children asked for: no row and a count.
      const onlyChildren = await readRosterNames(tx, counting.kms, KEY_ARN, {
        personIds: [family.childOneId, family.childTwoId],
        childView: "presence",
        actorUserId,
      });
      expect(onlyChildren).toEqual({ adults: [], children: [], minorCount: 2 });
      // An id that is not a person adds nothing to the count.
      const withStranger = await readRosterNames(tx, counting.kms, KEY_ARN, {
        personIds: [family.childOneId, newId()],
        childView: "presence",
        actorUserId,
      });
      expect(withStranger).toEqual({ adults: [], children: [], minorCount: 1 });
    });

    // A hidden child is neither listed nor counted.
    await hideChildren(scope, [family.childTwoId]);
    await inScope(scope, async (tx) => {
      const after = await readRosterNames(tx, baseKms, KEY_ARN, {
        personIds,
        childView: "presence",
        actorUserId,
      });
      expect(after.minorCount).toBe(1);
      expect(after.children).toEqual([]);
    });

    // The view is required, with no default, and is checked before anything else.
    await inScope(scope, async (tx) => {
      for (const bad of [undefined, "", "Admin", null, true]) {
        await expect(
          readRosterNames(tx, baseKms, KEY_ARN, {
            personIds,
            childView: bad as never,
            actorUserId,
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });
      }
      await expect(
        readRosterNames(tx, baseKms, KEY_ARN, { personIds: [], actorUserId } as never),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  it("pin 36: readRosterNames under admin returns a minor as personId and label only", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const counting = countingKms(baseKms);
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));
    const personIds = [family.adultId, family.childOneId, family.childTwoId];

    await inScope(scope, async (tx) => {
      counting.reset();
      const admin = await readRosterNames(tx, counting.kms, KEY_ARN, {
        personIds,
        childView: "admin",
        actorUserId,
      });
      // Each child is exactly an id and the label childLabels gives it: Child 1 was created
      // first and Child 2 an hour later.
      expect(admin.children.map((child) => Object.keys(child).sort())).toEqual([
        ["label", "personId"],
        ["label", "personId"],
      ]);
      const labelled = Object.fromEntries(admin.children.map((c) => [c.personId, c.label]));
      expect(labelled).toEqual({
        [family.childOneId]: "Child 1",
        [family.childTwoId]: "Child 2",
      });
      expect(admin.minorCount).toBe(2);
      expect(admin.adults).toEqual([
        { personId: family.adultId, isMinor: false, givenName: "Aurelia", familyName: "Marchetti" },
      ]);
      // It never names a minor: no key was opened and no seeded child value is in the answer.
      expect(counting.calls()).toBe(0);
      expectNoChildValue(admin);
      const reads = await tx<{ n: number }[]>`
        select count(*)::int as n
        from app.audit_events
        where action = 'people.person.read'
          and (${family.childOneId}::uuid = any(target_ids)
            or ${family.childTwoId}::uuid = any(target_ids))
      `;
      expect(reads[0]?.n).toBe(0);

      // The label is the same one every other screen shows.
      const labels = await childLabels(tx, [family.householdId]);
      expect(Object.fromEntries(labels.map((entry) => [entry.personId, entry.label]))).toEqual(
        labelled,
      );
    });

    // A hidden child is neither listed nor counted, and the rest are renumbered.
    await hideChildren(scope, [family.childOneId]);
    await inScope(scope, async (tx) => {
      const after = await readRosterNames(tx, baseKms, KEY_ARN, {
        personIds,
        childView: "admin",
        actorUserId,
      });
      expect(after.children).toEqual([{ personId: family.childTwoId, label: "Child 1" }]);
      expect(after.minorCount).toBe(1);
    });
  });

  it("pin 44b: visiblePersonIds under presence has no minor id", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const family = await inScope(scope, (tx) => seedFamily(tx, actorUserId, "Marchetti"));
    const stranger = newId();
    const asked = [family.childOneId, stranger, family.adultId, family.childTwoId, family.adultId];

    await inScope(scope, async (tx) => {
      const presence = await visiblePersonIds(tx, asked, { childView: "presence" });
      expect(presence).toEqual([family.adultId]);
      expect(JSON.stringify(presence)).not.toContain(family.childOneId);
      expect(JSON.stringify(presence)).not.toContain(family.childTwoId);
      // Only children asked for: nothing comes back.
      await expect(
        visiblePersonIds(tx, [family.childOneId, family.childTwoId], { childView: "presence" }),
      ).resolves.toEqual([]);
      // The write path takes the same view and the same lock.
      await expect(
        visiblePersonIds(tx, asked, { childView: "presence", lock: "share" }),
      ).resolves.toEqual([family.adultId]);

      // A Community Admin's view keeps the ids, in the order asked and each once.
      await expect(visiblePersonIds(tx, asked, { childView: "admin" })).resolves.toEqual([
        family.childOneId,
        family.adultId,
        family.childTwoId,
      ]);
      await expect(
        visiblePersonIds(tx, asked, { childView: "admin", lock: "share" }),
      ).resolves.toEqual([family.childOneId, family.adultId, family.childTwoId]);

      // The view is required, with no default, and is checked before anything else.
      for (const bad of [undefined, "", "Admin", null]) {
        await expect(
          visiblePersonIds(tx, asked, { childView: bad as never }),
        ).rejects.toMatchObject({ code: "invalid_input" });
      }
      await expect(visiblePersonIds(tx, [], {} as never)).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(visiblePersonIds(tx, asked, undefined as never)).rejects.toMatchObject({
        code: "invalid_input",
      });
    });

    // A hidden child is not visible under either view.
    await hideChildren(scope, [family.childOneId]);
    await inScope(scope, async (tx) => {
      await expect(
        visiblePersonIds(tx, [family.childOneId, family.childTwoId], { childView: "admin" }),
      ).resolves.toEqual([family.childTwoId]);
    });
  });
});

describe("child labels", () => {
  it("childLabels numbers the children of each household by created_at, then id, and skips hidden ones", async () => {
    const scope = await newScope();
    const actorUserId = newId();
    const ids = await inScope(scope, async (tx) => {
      const household = await createHousehold(tx, baseKms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId,
      });
      const other = await createHousehold(tx, baseKms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId,
      });
      const made: string[] = [];
      for (const [givenName, householdId] of [
        ["Aldous", household.householdId],
        ["Brisa", household.householdId],
        ["Corvin", household.householdId],
        ["Dessa", household.householdId],
        ["Evander", other.householdId],
      ] as const) {
        const created = await createPerson(tx, baseKms, KEY_ARN, {
          now: NOW,
          declaredAdult: false,
          householdId,
          dateOfBirth: "2018-05-05",
          givenName,
          familyName: "Labelling",
          email: null,
          phone: null,
          actorUserId,
        });
        made.push(created.personId);
      }
      return { household: household.householdId, other: other.householdId, made };
    });
    const [aldous, brisa, corvin, dessa, evander] = ids.made as [
      string,
      string,
      string,
      string,
      string,
    ];

    // Corvin was created third but is the earliest by created_at; Aldous and Brisa tie, so the
    // id decides; Dessa is hidden.
    await directSql`
      update app.persons set created_at = '2026-01-01T00:00:00Z' where id = ${corvin}::uuid
    `;
    await directSql`
      update app.persons set created_at = '2026-02-01T00:00:00Z'
      where id in (${aldous}::uuid, ${brisa}::uuid)
    `;
    await directSql`
      update app.persons set created_at = '2026-03-01T00:00:00Z' where id = ${dessa}::uuid
    `;
    await hideChildren(scope, [dessa]);

    await inScope(scope, async (tx) => {
      expect(await childLabels(tx, [])).toEqual([]);
      const labels = await childLabels(tx, [ids.household, ids.other, ids.household]);
      const byPerson = new Map(labels.map((entry) => [entry.personId, entry]));
      expect(byPerson.get(corvin)).toEqual({
        personId: corvin,
        householdId: ids.household,
        label: "Child 1",
      });
      const tied = [aldous, brisa].sort();
      expect(byPerson.get(tied[0]!)?.label).toBe("Child 2");
      expect(byPerson.get(tied[1]!)?.label).toBe("Child 3");
      expect(byPerson.has(dessa)).toBe(false);
      expect(byPerson.get(evander)).toEqual({
        personId: evander,
        householdId: ids.other,
        label: "Child 1",
      });
      expect(labels).toHaveLength(4);
    });
  });
});

// Checkpoint 1, L2. Organisation A has two communities (A1 and A2) and organisation B has one (B1).
// Each community holds a family: an adult, two children with unusual names, a guardian link to each
// child and a life event for each child. A Community Admin's view in one community must never show
// a child, a label, a household or a life event of another community or of another organisation.
// The readers filter on the scope's org_id and community_id and RLS backs both, so these are tests
// and not pins: there is no source line to weaken. The people readers take the admin view as a
// parameter (the role check is isCommunityAdmin's, in the access package, with its own tests), so
// the actor here is simply the admin of the community being read.

// A second community in an organisation that exists already.
async function newCommunityIn(orgId: string): Promise<Scope> {
  const communityId = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`minor-readers-comm-${communityId}`}, 'au')
    `;
  });
  return { orgId, communityId };
}

type IsolationChildSpec = {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  place: string;
  notes: string;
};

function isolationChild(
  givenName: string,
  familyName: string,
  phone: string,
  dateOfBirth: string,
): IsolationChildSpec {
  return {
    givenName,
    familyName,
    email: `${givenName}.${familyName}@isolation.example.test`.toLowerCase(),
    phone,
    dateOfBirth,
    place: `${familyName} Chapel`,
    notes: `${givenName} godparents`,
  };
}

type IsolationChild = { personId: string; eventId: string };

type IsolationFamily = {
  scope: Scope;
  label: string;
  householdId: string;
  adultId: string;
  children: IsolationChild[];
  // Every id of the family, and every value of its children and its household label, so a text
  // search of an answer can show that none of them is there.
  ids: string[];
  values: string[];
};

async function seedIsolationFamily(
  scope: Scope,
  actorUserId: string,
  spec: {
    label: string;
    adultGivenName: string;
    adultFamilyName: string;
    children: [IsolationChildSpec, IsolationChildSpec];
  },
): Promise<IsolationFamily> {
  return inScope(scope, async (tx) => {
    const household = await createHousehold(tx, baseKms, KEY_ARN, {
      now: NOW,
      label: spec.label,
      actorUserId,
    });
    const adult = await createPerson(tx, baseKms, KEY_ARN, {
      now: NOW,
      declaredAdult: true,
      householdId: household.householdId,
      dateOfBirth: null,
      givenName: spec.adultGivenName,
      familyName: spec.adultFamilyName,
      email: `${spec.adultGivenName}.${spec.adultFamilyName}@isolation.example.test`.toLowerCase(),
      phone: null,
      actorUserId,
    });
    const children: IsolationChild[] = [];
    for (const [index, child] of spec.children.entries()) {
      const created = await createPerson(tx, baseKms, KEY_ARN, {
        // The second child is created an hour later, so the labels are Child 1 and Child 2 by
        // created_at and do not depend on id order.
        now: new Date(NOW.getTime() + index * 3_600_000),
        declaredAdult: false,
        householdId: household.householdId,
        dateOfBirth: child.dateOfBirth,
        givenName: child.givenName,
        familyName: child.familyName,
        email: child.email,
        phone: child.phone,
        actorUserId,
      });
      await linkGuardian(tx, {
        now: NOW,
        householdId: household.householdId,
        guardianPersonId: adult.personId,
        childPersonId: created.personId,
        consent: true,
        pickup: true,
        view: true,
        manage: false,
        actorUserId: null,
      });
      const event = await createLifeEvent(tx, baseKms, KEY_ARN, {
        personId: created.personId,
        type: index === 0 ? "baptism" : "first_communion",
        date: "2021-02-02",
        place: child.place,
        notes: child.notes,
        actorUserId,
        now: NOW,
      });
      children.push({ personId: created.personId, eventId: event.eventId });
    }
    return {
      scope,
      label: spec.label,
      householdId: household.householdId,
      adultId: adult.personId,
      children,
      ids: [
        household.householdId,
        adult.personId,
        ...children.flatMap((child) => [child.personId, child.eventId]),
      ],
      values: [
        spec.label,
        ...spec.children.flatMap((child) => [
          child.givenName,
          child.familyName,
          child.email,
          child.phone,
          child.dateOfBirth,
          child.place,
          child.notes,
        ]),
      ],
    };
  });
}

// Reads every child reader in `reader`'s scope as its Community Admin and shows that only the
// reader's own family comes back, and that no other family's id, label or value does.
async function expectNoChildOfAnotherScope(
  reader: IsolationFamily,
  others: IsolationFamily[],
  adminUserId: string,
): Promise<void> {
  const ownChildIds = reader.children.map((child) => child.personId).sort();
  const everyone = [reader, ...others].flatMap((family) => [
    family.adultId,
    ...family.children.map((child) => child.personId),
  ]);

  await inScope(reader.scope, async (tx) => {
    // listPersons, minors mode: the reader's two children, each in the reader's household.
    const list = await listPersons(tx, baseKms, KEY_ARN, {
      kind: "minors",
      childView: "admin",
      actorUserId: adminUserId,
    });
    expect(list.nextCursor).toBeNull();
    expect(list.items.map((item) => item.personId).sort()).toEqual(ownChildIds);
    expect(list.items.map((item) => item.label).sort()).toEqual(["Child 1", "Child 2"]);
    expect(list.items.every((item) => item.householdId === reader.householdId)).toBe(true);
    expect(list.items.every((item) => item.householdLabel === reader.label)).toBe(true);

    // readHouseholdDetail: the reader's own household shows its own children and links, and a
    // household of another community or organisation is not there, as if it did not exist.
    const own = await readHouseholdDetail(tx, baseKms, KEY_ARN, {
      householdId: reader.householdId,
      includeRestricted: true,
      childView: "admin",
      actorUserId: adminUserId,
    });
    expect(own?.minors.childCount).toBe(2);
    expect(own?.minors.children?.map((child) => child.personId).sort()).toEqual(ownChildIds);
    expect(own?.guardians.map((link) => link.childId).sort()).toEqual(ownChildIds);
    expect(own?.guardians.map((link) => link.child?.personId).sort()).toEqual(ownChildIds);
    const foreignDetails = [];
    for (const other of others) {
      const detail = await readHouseholdDetail(tx, baseKms, KEY_ARN, {
        householdId: other.householdId,
        includeRestricted: true,
        childView: "admin",
        actorUserId: adminUserId,
      });
      const summary = await readHousehold(tx, baseKms, KEY_ARN, {
        householdId: other.householdId,
        childView: "admin",
        actorUserId: adminUserId,
      });
      expect(detail).toBeNull();
      expect(summary).toBeNull();
      foreignDetails.push(detail, summary);
    }

    // readLinkedContacts: only the reader's own people have an entry, and each child is only
    // { minor: true }. Another scope's adult and children have none, as if they did not exist.
    const contacts = await readLinkedContacts(tx, baseKms, KEY_ARN, {
      personIds: everyone,
      includePhone: true,
      actorUserId: adminUserId,
      childView: "admin",
    });
    expect([...contacts.keys()].sort()).toEqual([reader.adultId, ...ownChildIds].sort());
    for (const childId of ownChildIds) {
      expect(contacts.get(childId)).toEqual({ minor: true });
    }

    // listLifeEvents: the reader's own children list their event ids, and a child of another
    // scope is refused as a person that does not exist.
    const ownEvents = [];
    for (const child of reader.children) {
      const events = await listLifeEvents(tx, baseKms, KEY_ARN, {
        personId: child.personId,
        actorUserId: adminUserId,
        childView: "admin",
      });
      expect(events.items).toEqual([{ eventId: child.eventId }]);
      ownEvents.push(events);
    }
    for (const other of others) {
      for (const child of other.children) {
        await expect(
          listLifeEvents(tx, baseKms, KEY_ARN, {
            personId: child.personId,
            actorUserId: adminUserId,
            childView: "admin",
          }),
        ).rejects.toMatchObject({ code: "life_event_not_found" });
      }
    }

    // No id and no value of another scope's family is anywhere in what the readers returned.
    const answers = JSON.stringify({
      list,
      own,
      foreignDetails,
      contacts: [...contacts.entries()],
      ownEvents,
    });
    for (const other of others) {
      for (const id of other.ids) {
        expect(answers).not.toContain(id);
      }
      for (const value of other.values) {
        expect(answers).not.toContain(value);
      }
    }
  });
}

describe("child readers never cross a community or an organisation (checkpoint 1, L2)", () => {
  it("a Community Admin of A1 reads no child, label, household or life event of A2 or B1", async () => {
    const a1 = await newScope();
    const a2 = await newCommunityIn(a1.orgId);
    const b1 = await newScope();
    expect(a2.orgId).toBe(a1.orgId);
    expect(a2.communityId).not.toBe(a1.communityId);
    expect(b1.orgId).not.toBe(a1.orgId);

    const adminA1 = newId();
    const adminA2 = newId();
    const adminB1 = newId();
    const familyA1 = await seedIsolationFamily(a1, adminA1, {
      label: "Brackenhallow household",
      adultGivenName: "Marguerite",
      adultFamilyName: "Ashcombe",
      children: [
        isolationChild("Ignatia", "Brackenhallow", "+61400555201", "2017-03-03"),
        isolationChild("Jerrold", "Brackenhallow", "+61400555202", "2018-04-04"),
      ],
    });
    const familyA2 = await seedIsolationFamily(a2, adminA2, {
      label: "Fenwhistle household",
      adultGivenName: "Lucinda",
      adultFamilyName: "Fenwhistle",
      children: [
        isolationChild("Ottoline", "Fenwhistle", "+61400555211", "2016-05-05"),
        isolationChild("Perrin", "Fenwhistle", "+61400555212", "2019-06-06"),
      ],
    });
    const familyB1 = await seedIsolationFamily(b1, adminB1, {
      label: "Thornquist household",
      adultGivenName: "Cordelia",
      adultFamilyName: "Thornquist",
      children: [
        isolationChild("Rosalind", "Thornquist", "+61400555221", "2015-07-07"),
        isolationChild("Tobias", "Thornquist", "+61400555222", "2020-08-08"),
      ],
    });

    // The required case: A1's admin sees A1's two children and nothing of A2 or B1.
    await expectNoChildOfAnotherScope(familyA1, [familyA2, familyB1], adminA1);

    // The same from the other two communities, so the isolation is not one-directional.
    await expectNoChildOfAnotherScope(familyA2, [familyA1, familyB1], adminA2);
    await expectNoChildOfAnotherScope(familyB1, [familyA1, familyA2], adminB1);
  });
});
