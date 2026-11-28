import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember } from "@community-hub/access/testing";
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
import { createHousehold, createLifeEvent, createPerson } from "@community-hub/people";

import {
  bootstrapOwner,
  finishMinorView,
  grantRole,
  prepareMinorView,
  revokeRole,
} from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

type Kms = ReturnType<typeof createLocalKmsPort>;
type Scope = { orgId: string; communityId: string };

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
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
  dateOfBirth: "2019-06-07",
};
const EVENT_ONE = {
  type: "baptism",
  date: "2019-03-03",
  place: "Zephyr Chapel",
  notes: "Quillonwick godparents",
};

// A phone is stored without the plus sign, so both forms are scanned for.
const SEEDED_VALUES = [
  CHILD_ONE.givenName,
  CHILD_ONE.familyName,
  CHILD_ONE.email,
  CHILD_ONE.phone,
  CHILD_ONE.phone.slice(1),
  CHILD_ONE.dateOfBirth,
  CHILD_TWO.givenName,
  CHILD_TWO.familyName,
  CHILD_TWO.dateOfBirth,
  EVENT_ONE.place,
  EVENT_ONE.notes,
];

let platform: ReturnType<typeof createPlaintextPlatformSql>;
let app: ReturnType<typeof createPlaintextAppSql>;
let directSql: ReturnType<typeof createPlaintextDirectSql>;
const kms: Kms = createLocalKmsPort();

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

// One organisation with two communities, and a second organisation with one community.
async function newScopes(): Promise<{ a1: Scope; a2: Scope; b1: Scope }> {
  const orgA = newId();
  const orgB = newId();
  const commA1 = newId();
  const commA2 = newId();
  const commB1 = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.organisations (id, slug, region, kind)
      values
        (${orgA}, ${`mv-org-a-${orgA}`}, 'au', 'implicit'),
        (${orgB}, ${`mv-org-b-${orgB}`}, 'au', 'implicit')
    `;
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values
        (${commA1}, ${orgA}, ${`mv-comm-a1-${commA1}`}, 'au'),
        (${commA2}, ${orgA}, ${`mv-comm-a2-${commA2}`}, 'au'),
        (${commB1}, ${orgB}, ${`mv-comm-b1-${commB1}`}, 'au')
    `;
  });
  return {
    a1: { orgId: orgA, communityId: commA1 },
    a2: { orgId: orgA, communityId: commA2 },
    b1: { orgId: orgB, communityId: commB1 },
  };
}

function inScope<T>(scope: Scope, run: (tx: AppTransaction) => Promise<T>): Promise<T> {
  return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, run));
}

type Parish = {
  scope: Scope;
  owner: string;
  staff: string;
  householdId: string;
  adultId: string;
  childOneId: string;
  childTwoId: string;
  eventOneId: string;
  eventTwoId: string;
  adultEventId: string;
};

// A community with a Community Admin (the bootstrapped owner), a staff member, and a family of one
// adult and two children. Child one has every field; child two has no email, phone, place or notes.
async function seedParish(scope: Scope, firstOfOrganisation = true): Promise<Parish> {
  return inScope(scope, async (tx) => {
    const owner = newId();
    const staff = newId();
    if (firstOfOrganisation) {
      await bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner });
    } else {
      // The organisation was bootstrapped through its first community. This community's admin is
      // granted directly, as the Community Admin tests do.
      await addMember(tx, owner);
      await tx`
        insert into app.community_role_grants (
          id, org_id, community_id, user_id, role_key, custom_role_id
        ) values (
          ${newId()}::uuid,
          current_setting('app.org_id')::uuid,
          current_setting('app.community_id')::uuid,
          ${owner}::uuid,
          'community_admin',
          null
        )
      `;
    }
    await addMember(tx, staff);
    await grantRole(tx, {
      now: NOW,
      userId: staff,
      roleKey: "staff",
      customRoleId: null,
      actorUserId: owner,
    });
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
      ...EVENT_ONE,
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
      scope,
      owner,
      staff,
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

type AuditRow = {
  action: string;
  purpose: string;
  actor_kind: string;
  actor_id: string | null;
  target_ids: string[];
};

async function auditRows(tx: AppTransaction, action: string): Promise<AuditRow[]> {
  return tx<AuditRow[]>`
    select
      action,
      purpose,
      actor_kind,
      actor_id::text as actor_id,
      target_ids::text[] as target_ids
    from app.audit_events
    where action = ${action}
    order by seq
  `;
}

const VIEWED = "people.minor.field_viewed";
const DENIED = "access.permission.denied";

type PersonField = "name" | "dateOfBirth" | "email" | "phone";
type EventField = "type" | "date" | "place" | "notes";

// The View as the route runs it, minus the fresh-check consume between the two calls (identity's
// job): prepare, then finish, in one transaction.
async function view(
  tx: AppTransaction,
  actorUserId: string,
  personId: string,
  field: PersonField,
): Promise<unknown> {
  await prepareMinorView(tx, { actorUserId, personId, field });
  return finishMinorView(tx, kms, KEY_ARN, { actorUserId, personId, field });
}

async function viewEvent(
  tx: AppTransaction,
  actorUserId: string,
  personId: string,
  lifeEventId: string,
  field: EventField,
): Promise<unknown> {
  await prepareMinorView(tx, { actorUserId, personId, lifeEventId, field });
  return finishMinorView(tx, kms, KEY_ARN, { actorUserId, personId, lifeEventId, field });
}

describe("the Community Admin's View of one child field", () => {
  it("returns each of the eight fields, and a missing value as null", async () => {
    const parish = await seedParish((await newScopes()).a1);
    await inScope(parish.scope, async (tx) => {
      const admin = parish.owner;
      expect(await view(tx, admin, parish.childOneId, "name")).toEqual({
        given: CHILD_ONE.givenName,
        family: CHILD_ONE.familyName,
      });
      expect(await view(tx, admin, parish.childOneId, "dateOfBirth")).toBe(CHILD_ONE.dateOfBirth);
      expect(await view(tx, admin, parish.childOneId, "email")).toBe(CHILD_ONE.email);
      expect(await view(tx, admin, parish.childOneId, "phone")).toBe("61400555301");
      expect(await viewEvent(tx, admin, parish.childOneId, parish.eventOneId, "type")).toBe(
        EVENT_ONE.type,
      );
      expect(await viewEvent(tx, admin, parish.childOneId, parish.eventOneId, "date")).toBe(
        EVENT_ONE.date,
      );
      expect(await viewEvent(tx, admin, parish.childOneId, parish.eventOneId, "place")).toBe(
        EVENT_ONE.place,
      );
      expect(await viewEvent(tx, admin, parish.childOneId, parish.eventOneId, "notes")).toBe(
        EVENT_ONE.notes,
      );

      // Child two has none of these: each is null, with no error.
      expect(await view(tx, admin, parish.childTwoId, "email")).toBeNull();
      expect(await view(tx, admin, parish.childTwoId, "phone")).toBeNull();
      expect(await viewEvent(tx, admin, parish.childTwoId, parish.eventTwoId, "place")).toBeNull();
      expect(await viewEvent(tx, admin, parish.childTwoId, parish.eventTwoId, "notes")).toBeNull();
    });
  });

  it("pin 65: one people.minor.field_viewed row with the right purpose per View", async () => {
    const parish = await seedParish((await newScopes()).a1);
    await inScope(parish.scope, async (tx) => {
      const admin = parish.owner;
      expect(await auditRows(tx, VIEWED)).toEqual([]);

      await view(tx, admin, parish.childOneId, "name");
      await view(tx, admin, parish.childOneId, "dateOfBirth");
      await view(tx, admin, parish.childOneId, "email");
      await view(tx, admin, parish.childOneId, "phone");
      await viewEvent(tx, admin, parish.childOneId, parish.eventOneId, "type");
      await viewEvent(tx, admin, parish.childOneId, parish.eventOneId, "date");
      await viewEvent(tx, admin, parish.childOneId, parish.eventOneId, "place");
      await viewEvent(tx, admin, parish.childOneId, parish.eventOneId, "notes");

      const rows = await auditRows(tx, VIEWED);
      expect(rows.map((row) => row.purpose)).toEqual([
        "people.minor_view.name",
        "people.minor_view.date_of_birth",
        "people.minor_view.email",
        "people.minor_view.phone",
        "people.minor_view.life_event_type",
        "people.minor_view.life_event_date",
        "people.minor_view.life_event_place",
        "people.minor_view.life_event_notes",
      ]);
      for (const row of rows) {
        expect(row.actor_kind).toBe("user");
        expect(row.actor_id).toBe(admin);
      }
    });
  });

  it("pin 66: the audit row holds only the person id, and the life event id for a life-event field", async () => {
    const parish = await seedParish((await newScopes()).a1);
    await inScope(parish.scope, async (tx) => {
      const admin = parish.owner;
      await view(tx, admin, parish.childOneId, "name");
      await viewEvent(tx, admin, parish.childOneId, parish.eventOneId, "place");

      const rows = await auditRows(tx, VIEWED);
      expect(rows.map((row) => row.target_ids)).toEqual([
        [parish.childOneId],
        [parish.childOneId, parish.eventOneId],
      ]);

      // Nothing the child's record holds is anywhere in the whole row, whatever its column.
      const whole = await tx<{ row: unknown }[]>`
        select to_jsonb(e) as row from app.audit_events e where action = ${VIEWED}
      `;
      const text = JSON.stringify(whole);
      for (const value of SEEDED_VALUES) {
        expect(text).not.toContain(value);
      }
    });
  });

  it("pin 61: a non-admin gets forbidden for a missing id and for a child's id alike", async () => {
    const parish = await seedParish((await newScopes()).a1);
    await inScope(parish.scope, async (tx) => {
      const staff = parish.staff;
      const missing = newId();
      // A missing id, a child, a hidden-family child, an adult and a life event of a child: the
      // role check is first, so each answer is the same and says nothing about the id.
      const attempts: Array<() => Promise<unknown>> = [
        () => prepareMinorView(tx, { actorUserId: staff, personId: missing, field: "name" }),
        () =>
          prepareMinorView(tx, { actorUserId: staff, personId: parish.childOneId, field: "name" }),
        () => prepareMinorView(tx, { actorUserId: staff, personId: parish.adultId, field: "name" }),
        () =>
          prepareMinorView(tx, {
            actorUserId: staff,
            personId: parish.childOneId,
            lifeEventId: parish.eventOneId,
            field: "place",
          }),
        () =>
          prepareMinorView(tx, {
            actorUserId: staff,
            personId: missing,
            lifeEventId: newId(),
            field: "place",
          }),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({ code: "forbidden" });
      }
    });
  });

  it("a refused View writes one denial row with the person id and no value, and no View row", async () => {
    const parish = await seedParish((await newScopes()).a1);
    await inScope(parish.scope, async (tx) => {
      await expect(
        prepareMinorView(tx, {
          actorUserId: parish.staff,
          personId: parish.childOneId,
          field: "dateOfBirth",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });

      expect(await auditRows(tx, VIEWED)).toEqual([]);
      const denied = await auditRows(tx, DENIED);
      expect(denied).toEqual([
        {
          action: DENIED,
          purpose: "people.minor_view.date_of_birth",
          actor_kind: "user",
          actor_id: parish.staff,
          target_ids: [parish.childOneId],
        },
      ]);
      const text = JSON.stringify(denied);
      for (const value of SEEDED_VALUES) {
        expect(text).not.toContain(value);
      }
    });
  });

  it("pin 62: a grant revoked after the consume answers forbidden and no value", async () => {
    const parish = await seedParish((await newScopes()).a1);
    await inScope(parish.scope, async (tx) => {
      const second = newId();
      await addMember(tx, second);
      const grant = await grantRole(tx, {
        now: NOW,
        userId: second,
        roleKey: "community_admin",
        customRoleId: null,
        actorUserId: parish.owner,
      });

      // Transaction A passes while the role is held.
      await prepareMinorView(tx, {
        actorUserId: second,
        personId: parish.childOneId,
        field: "name",
      });

      // The consume happens here in the route. The role goes before transaction B.
      await revokeRole(tx, {
        now: NOW,
        grantId: grant.grantId,
        scope: "community",
        actorUserId: parish.owner,
      });

      const error = await finishMinorView(tx, kms, KEY_ARN, {
        actorUserId: second,
        personId: parish.childOneId,
        field: "name",
      }).then(
        (value) => ({ value }),
        (thrown: unknown) => ({ thrown }),
      );
      expect(error).toMatchObject({ thrown: { code: "forbidden" } });
      expect(error).not.toHaveProperty("value");
      expect((error as { thrown: Error }).thrown.message).toBe("forbidden");

      // Nothing was viewed, and the refusal is one denial row.
      expect(await auditRows(tx, VIEWED)).toEqual([]);
      expect((await auditRows(tx, DENIED)).map((row) => row.target_ids)).toEqual([
        [parish.childOneId],
      ]);
    });
  });

  it("a Community Admin gets not_found for an adult, a missing id, and a life event of another child", async () => {
    const parish = await seedParish((await newScopes()).a1);
    await inScope(parish.scope, async (tx) => {
      const admin = parish.owner;
      const attempts: Array<() => Promise<unknown>> = [
        () => prepareMinorView(tx, { actorUserId: admin, personId: parish.adultId, field: "name" }),
        () => prepareMinorView(tx, { actorUserId: admin, personId: newId(), field: "name" }),
        // The adult's own life event is not a child's.
        () =>
          prepareMinorView(tx, {
            actorUserId: admin,
            personId: parish.adultId,
            lifeEventId: parish.adultEventId,
            field: "place",
          }),
        // Child two's event under child one's id.
        () =>
          prepareMinorView(tx, {
            actorUserId: admin,
            personId: parish.childOneId,
            lifeEventId: parish.eventTwoId,
            field: "place",
          }),
        // A missing life event of a real child.
        () =>
          prepareMinorView(tx, {
            actorUserId: admin,
            personId: parish.childOneId,
            lifeEventId: newId(),
            field: "place",
          }),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({ code: "not_found" });
      }
      // None of them is a View.
      expect(await auditRows(tx, VIEWED)).toEqual([]);
    });
  });

  it("a child of another community or another organisation answers not_found, in prepare and in finish", async () => {
    const scopes = await newScopes();
    const here = await seedParish(scopes.a1);
    const sameOrganisation = await seedParish(scopes.a2, false);
    const otherOrganisation = await seedParish(scopes.b1);

    await inScope(here.scope, async (tx) => {
      const admin = here.owner;
      for (const stranger of [sameOrganisation, otherOrganisation]) {
        await expect(
          prepareMinorView(tx, {
            actorUserId: admin,
            personId: stranger.childOneId,
            field: "name",
          }),
        ).rejects.toMatchObject({ code: "not_found" });
        await expect(
          prepareMinorView(tx, {
            actorUserId: admin,
            personId: stranger.childOneId,
            lifeEventId: stranger.eventOneId,
            field: "place",
          }),
        ).rejects.toMatchObject({ code: "not_found" });
        // finish alone, as if the child had moved between the two transactions.
        await expect(
          finishMinorView(tx, kms, KEY_ARN, {
            actorUserId: admin,
            personId: stranger.childOneId,
            field: "name",
          }),
        ).rejects.toMatchObject({ code: "not_found" });
      }
      expect(await auditRows(tx, VIEWED)).toEqual([]);
    });
  });

  it("a child hidden after the check answers not_found from finish, with no View row", async () => {
    const parish = await seedParish((await newScopes()).a1);
    // A child cannot be hidden through the product (the user triggers refuse it), so the test sets
    // deleted_at in a short committed transaction as the migrator with the user triggers off, as
    // the other hidden-child tests do.
    await withAppTransaction(directSql, parish.scope, async (tx) => {
      await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
      await tx`
        update app.persons
        set deleted_at = now() - interval '1 hour', deleted_by = ${newId()}::uuid
        where id = ${parish.childOneId}::uuid
      `;
      await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
    });
    await inScope(parish.scope, async (tx) => {
      await expect(
        finishMinorView(tx, kms, KEY_ARN, {
          actorUserId: parish.owner,
          personId: parish.childOneId,
          field: "name",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        prepareMinorView(tx, {
          actorUserId: parish.owner,
          personId: parish.childOneId,
          field: "name",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await auditRows(tx, VIEWED)).toEqual([]);
    });
  });

  it("every refusal carries only a code: no value, name or id in the message", async () => {
    const parish = await seedParish((await newScopes()).a1);
    await inScope(parish.scope, async (tx) => {
      const thrown: Error[] = [];
      for (const attempt of [
        () =>
          prepareMinorView(tx, {
            actorUserId: parish.staff,
            personId: parish.childOneId,
            field: "name",
          }),
        () => prepareMinorView(tx, { actorUserId: parish.owner, personId: newId(), field: "name" }),
        () =>
          finishMinorView(tx, kms, KEY_ARN, {
            actorUserId: parish.staff,
            personId: parish.childOneId,
            field: "name",
          }),
      ]) {
        thrown.push(
          await attempt().then(
            () => new Error("did not throw"),
            (error: unknown) => error as Error,
          ),
        );
      }
      expect(thrown.map((error) => error.message)).toEqual(["forbidden", "not_found", "forbidden"]);
      const text = JSON.stringify(
        thrown.map((error) => [error.name, error.message, String(error.cause ?? "")]),
      );
      for (const value of [...SEEDED_VALUES, parish.childOneId]) {
        expect(text).not.toContain(value);
      }
    });
  });
});
