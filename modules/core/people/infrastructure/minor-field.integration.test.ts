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
  createHousehold,
  createLifeEvent,
  createPerson,
  openMinorField,
  PeopleError,
} from "../public/index.js";

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
  phone: "+61400555301",
  dateOfBirth: "2018-05-05",
};
const CHILD_TWO = {
  givenName: "Quillon",
  familyName: "Zephyrwick",
  email: "quillon.zephyrwick@zephyr.example.test",
  phone: "+61400555302",
  dateOfBirth: "2019-06-07",
};

let platform: ReturnType<typeof createPlaintextPlatformSql>;
let app: ReturnType<typeof createPlaintextAppSql>;
let directSql: ReturnType<typeof createPlaintextDirectSql>;
const kms: KmsPort = createLocalKmsPort();

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

async function newScope(): Promise<Scope> {
  const orgId = newId();
  const communityId = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.organisations (id, slug, region, kind)
      values (${orgId}, ${`minor-field-org-${orgId}`}, 'au', 'implicit')
    `;
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`minor-field-comm-${communityId}`}, 'au')
    `;
  });
  return { orgId, communityId };
}

function inScope<T>(scope: Scope, run: (tx: AppTransaction) => Promise<T>): Promise<T> {
  return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, run));
}

type Family = {
  householdId: string;
  adultId: string;
  childOneId: string;
  childTwoId: string;
  // childOne has a full event; childTwo has an event with no place and no notes; the adult has one.
  eventOneId: string;
  eventTwoId: string;
  adultEventId: string;
};

async function seedFamily(scope: Scope): Promise<Family> {
  return inScope(scope, async (tx) => {
    const household = await createHousehold(tx, kms, KEY_ARN, {
      now: NOW,
      label: "Marchetti",
      actorUserId: null,
    });
    const householdId = household.householdId;
    const adult = await createPerson(tx, kms, KEY_ARN, {
      now: NOW,
      declaredAdult: true,
      householdId,
      dateOfBirth: "1984-02-02",
      givenName: "Aurelia",
      familyName: "Marchetti",
      email: "aurelia.marchetti@parish.example.test",
      phone: "+61400555300",
      actorUserId: null,
    });
    const childOne = await createPerson(tx, kms, KEY_ARN, {
      now: NOW,
      declaredAdult: false,
      householdId,
      ...CHILD_ONE,
      actorUserId: null,
    });
    // Child two has no email and no phone, so those two fields are empty.
    const childTwo = await createPerson(tx, kms, KEY_ARN, {
      now: new Date(NOW.getTime() + 3_600_000),
      declaredAdult: false,
      householdId,
      ...CHILD_TWO,
      email: null,
      phone: null,
      actorUserId: null,
    });
    const eventOne = await createLifeEvent(tx, kms, KEY_ARN, {
      personId: childOne.personId,
      type: "baptism",
      date: "2019-03-03",
      place: "Zephyr Chapel",
      notes: "Quillonwick godparents",
      actorUserId: null,
      now: NOW,
    });
    const eventTwo = await createLifeEvent(tx, kms, KEY_ARN, {
      personId: childTwo.personId,
      type: "first_communion",
      date: "2026-05-10",
      actorUserId: null,
      now: NOW,
    });
    const adultEvent = await createLifeEvent(tx, kms, KEY_ARN, {
      personId: adult.personId,
      type: "baptism",
      date: "1984-04-04",
      place: "Marchetti Cathedral",
      actorUserId: null,
      now: NOW,
    });
    return {
      householdId,
      adultId: adult.personId,
      childOneId: childOne.personId,
      childTwoId: childTwo.personId,
      eventOneId: eventOne.eventId,
      eventTwoId: eventTwo.eventId,
      adultEventId: adultEvent.eventId,
    };
  });
}

// Hides a child the way a later chunk will: deleted_at and deleted_by are set. Today the user
// triggers refuse that, so it is done as the migrator with them off (see the other hidden-row tests).
async function hideChild(scope: Scope, personId: string): Promise<void> {
  const deletedBy = newId();
  await withAppTransaction(directSql, scope, async (tx) => {
    await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
    await tx`
      update app.persons
      set deleted_at = now() - interval '1 hour', deleted_by = ${deletedBy}::uuid
      where id = ${personId}::uuid
    `;
    await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
  });
}

async function auditCount(scope: Scope): Promise<number> {
  const rows = await directSql<{ n: number }[]>`
    select count(*)::int as n from app.audit_events where org_id = ${scope.orgId}::uuid
  `;
  return rows[0]?.n ?? -1;
}

describe("openMinorField opens one field of one child", () => {
  it("pin 38: openMinorField opens one field and returns that value alone", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope);

    await inScope(scope, async (tx) => {
      const dateOfBirth = await openMinorField(tx, kms, KEY_ARN, {
        personId: family.childOneId,
        field: "dateOfBirth",
      });
      expect(typeof dateOfBirth).toBe("string");
      expect(dateOfBirth).toBe("2018-05-05");

      const email = await openMinorField(tx, kms, KEY_ARN, {
        personId: family.childOneId,
        field: "email",
      });
      expect(email).toBe("zephyrine.quillonwick@zephyr.example.test");
      const phone = await openMinorField(tx, kms, KEY_ARN, {
        personId: family.childOneId,
        field: "phone",
      });
      // A phone is stored normalised, without the plus sign.
      expect(phone).toBe("61400555301");

      // The name is two parts, and only the two parts: no other field comes with it.
      const name = await openMinorField(tx, kms, KEY_ARN, {
        personId: family.childOneId,
        field: "name",
      });
      expect(name).toEqual({ given: "Zephyrine", family: "Quillonwick" });
      expect(Object.keys(name).sort()).toEqual(["family", "given"]);

      // The other child's value is the other child's.
      const second = await openMinorField(tx, kms, KEY_ARN, {
        personId: family.childTwoId,
        field: "name",
      });
      expect(second).toEqual({ given: "Quillon", family: "Zephyrwick" });

      // A value never carries a neighbour: opening the date of birth does not reveal anything else.
      const text = JSON.stringify(dateOfBirth);
      for (const other of [
        CHILD_ONE.givenName,
        CHILD_ONE.familyName,
        CHILD_ONE.email,
        CHILD_ONE.phone.slice(1),
      ]) {
        expect(text).not.toContain(other);
      }
    });
  });

  it("pin 38: a life event opens one field at a time", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope);

    await inScope(scope, async (tx) => {
      const expected = {
        type: "baptism",
        date: "2019-03-03",
        place: "Zephyr Chapel",
        notes: "Quillonwick godparents",
      } as const;
      for (const field of ["type", "date", "place", "notes"] as const) {
        const value = await openMinorField(tx, kms, KEY_ARN, {
          personId: family.childOneId,
          lifeEventId: family.eventOneId,
          field,
        });
        expect(value).toBe(expected[field]);
      }
    });
  });

  it("answers null for an empty field, and for a missing name part, with no throw", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope);

    await inScope(scope, async (tx) => {
      expect(
        await openMinorField(tx, kms, KEY_ARN, { personId: family.childTwoId, field: "email" }),
      ).toBeNull();
      expect(
        await openMinorField(tx, kms, KEY_ARN, { personId: family.childTwoId, field: "phone" }),
      ).toBeNull();
      for (const field of ["place", "notes"] as const) {
        expect(
          await openMinorField(tx, kms, KEY_ARN, {
            personId: family.childTwoId,
            lifeEventId: family.eventTwoId,
            field,
          }),
        ).toBeNull();
      }
    });

    // A child's name parts are both required by a check constraint (persons_name_split), so a
    // missing part cannot be stored. The constraint is dropped inside one transaction that is rolled
    // back, so the reader's own handling of a missing part is shown and nothing is left behind.
    const rollback = new Error("roll back");
    let seen: unknown[] = [];
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(directSql, scope, async (tx) => {
        await tx.unsafe("ALTER TABLE app.persons DROP CONSTRAINT persons_name_split");
        await tx`
          update app.persons set given_name_restricted = null where id = ${family.childOneId}::uuid
        `;
        const noGiven = await openMinorField(tx, kms, KEY_ARN, {
          personId: family.childOneId,
          field: "name",
        });
        await tx`
          update app.persons set family_name_restricted = null where id = ${family.childOneId}::uuid
        `;
        const noName = await openMinorField(tx, kms, KEY_ARN, {
          personId: family.childOneId,
          field: "name",
        });
        seen = [noGiven, noName];
        throw rollback;
      }).catch((error: unknown) => {
        if (error !== rollback) {
          throw error;
        }
      }),
    );
    expect(seen).toEqual([
      { given: null, family: "Quillonwick" },
      { given: null, family: null },
    ]);
  });

  it("pin 39: openMinorField refuses an adult, and a person that does not exist, as not_found", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope);

    await inScope(scope, async (tx) => {
      for (const field of ["name", "dateOfBirth", "email", "phone"] as const) {
        await expect(
          openMinorField(tx, kms, KEY_ARN, { personId: family.adultId, field }),
        ).rejects.toMatchObject({ code: "not_found" });
      }
      for (const field of ["type", "date", "place", "notes"] as const) {
        await expect(
          openMinorField(tx, kms, KEY_ARN, {
            personId: family.adultId,
            lifeEventId: family.adultEventId,
            field,
          }),
        ).rejects.toMatchObject({ code: "not_found" });
      }
      await expect(
        openMinorField(tx, kms, KEY_ARN, { personId: newId(), field: "name" }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  it("pin 39b: openMinorField refuses a hidden child as not_found", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope);
    await hideChild(scope, family.childOneId);

    // The seeded state is what the test says it is: child one, and only child one, is hidden.
    const hidden = await directSql<{ id: string }[]>`
      select id::text as id from app.persons
      where household_id = ${family.householdId}::uuid and deleted_at is not null
    `;
    expect(hidden.map((row) => row.id)).toEqual([family.childOneId]);

    await inScope(scope, async (tx) => {
      for (const field of ["name", "dateOfBirth", "email", "phone"] as const) {
        await expect(
          openMinorField(tx, kms, KEY_ARN, { personId: family.childOneId, field }),
        ).rejects.toMatchObject({ code: "not_found" });
      }
      await expect(
        openMinorField(tx, kms, KEY_ARN, {
          personId: family.childOneId,
          lifeEventId: family.eventOneId,
          field: "place",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      // The sibling is untouched.
      expect(
        await openMinorField(tx, kms, KEY_ARN, { personId: family.childTwoId, field: "name" }),
      ).toEqual({ given: "Quillon", family: "Zephyrwick" });
    });
  });

  it("pin 40: a life event opens only for the child it belongs to", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope);

    await inScope(scope, async (tx) => {
      // The other child's event, the adult's event and an id that does not exist.
      for (const lifeEventId of [family.eventTwoId, family.adultEventId, newId()]) {
        for (const field of ["type", "date", "place", "notes"] as const) {
          await expect(
            openMinorField(tx, kms, KEY_ARN, {
              personId: family.childOneId,
              lifeEventId,
              field,
            }),
          ).rejects.toMatchObject({ code: "not_found" });
        }
      }
      // Its own event still opens.
      expect(
        await openMinorField(tx, kms, KEY_ARN, {
          personId: family.childTwoId,
          lifeEventId: family.eventTwoId,
          field: "type",
        }),
      ).toBe("first_communion");
    });
  });

  it("refuses a child of another community or organisation, as not_found", async () => {
    const home = await newScope();
    const otherOrg = await newScope();
    const family = await seedFamily(home);

    // Same organisation, another community.
    const siblingCommunityId = newId();
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${siblingCommunityId}, ${home.orgId}, ${`minor-field-sib-${siblingCommunityId}`}, 'au')
      `;
    });

    for (const scope of [otherOrg, { orgId: home.orgId, communityId: siblingCommunityId }]) {
      await inScope(scope, async (tx) => {
        await expect(
          openMinorField(tx, kms, KEY_ARN, { personId: family.childOneId, field: "name" }),
        ).rejects.toMatchObject({ code: "not_found" });
        await expect(
          openMinorField(tx, kms, KEY_ARN, {
            personId: family.childOneId,
            lifeEventId: family.eventOneId,
            field: "place",
          }),
        ).rejects.toMatchObject({ code: "not_found" });
      });
    }
  });

  it("writes no audit row (the View service audits), and a refusal carries only a code", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope);
    const before = await auditCount(scope);

    await inScope(scope, async (tx) => {
      await openMinorField(tx, kms, KEY_ARN, { personId: family.childOneId, field: "name" });
      await openMinorField(tx, kms, KEY_ARN, {
        personId: family.childOneId,
        lifeEventId: family.eventOneId,
        field: "notes",
      });
      const error = await openMinorField(tx, kms, KEY_ARN, {
        personId: family.adultId,
        field: "name",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PeopleError);
      expect((error as PeopleError).message).toBe("not_found");
      expect(JSON.stringify(error)).not.toContain(CHILD_ONE.givenName);
    });

    expect(await auditCount(scope)).toBe(before);
  });

  it("refuses a malformed id or an unknown field as invalid_input", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope);

    await inScope(scope, async (tx) => {
      await expect(
        openMinorField(tx, kms, KEY_ARN, { personId: "not-a-uuid", field: "name" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        openMinorField(tx, kms, KEY_ARN, {
          personId: family.childOneId,
          lifeEventId: "not-a-uuid",
          field: "place",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      // A person field asked of a life event, a life-event field asked of a person, and a field
      // that does not exist, are refused before anything is read.
      await expect(
        openMinorField(tx, kms, KEY_ARN, {
          personId: family.childOneId,
          lifeEventId: family.eventOneId,
          field: "email",
        } as never),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        openMinorField(tx, kms, KEY_ARN, { personId: family.childOneId, field: "place" } as never),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        openMinorField(tx, kms, KEY_ARN, { personId: family.childOneId, field: "ssn" } as never),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });
});
