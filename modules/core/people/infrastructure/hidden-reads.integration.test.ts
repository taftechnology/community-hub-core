import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  addMinor,
  createHousehold,
  createLifeEvent,
  createPerson,
  hidePerson,
  linkGuardian,
  listDeletedPersons,
  listHouseholds,
  listLifeEvents,
  listPersons,
  lockPersonForDelete,
  openPersonFieldKeys,
  readHouseholdDetail,
  readLinkedContacts,
  readPerson,
  readRosterNames,
  summarisePersons,
  visiblePersonIds,
  type ListDeletedPersonsResult,
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
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-10-31T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

describe("hidden reads", () => {
  let runtime: Runtime;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let migrator: ReturnType<typeof createPlaintextDirectSql>;
  const kms = createLocalKmsPort();
  let counter = 0;

  beforeAll(async () => {
    runtime = loadRuntime();
    migrator = createPlaintextDirectSql(runtime.productOnlyUrl);
    await applyProductMigrations(migrator);
    platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    app = createPlaintextAppSql(roleUrl(runtime, "app"));
  });

  afterAll(async () => {
    await app.end({ timeout: 1 });
    await platform.end({ timeout: 1 });
    await migrator.end({ timeout: 1 });
  });

  async function setupTenant(slugPrefix: string): Promise<Scope> {
    const orgId = newId();
    const communityId = newId();
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${orgId}, ${`${slugPrefix}-${orgId}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${orgId}, ${`${slugPrefix}-${communityId}`}, 'au')
      `;
    });
    return { orgId, communityId };
  }

  function inScope<T>(scope: Scope, fn: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, fn));
  }

  async function addAdultPerson(
    scope: Scope,
    givenName: string,
    familyName: string,
    householdId: string | null = null,
  ): Promise<string> {
    counter += 1;
    const n = counter;
    return inScope(scope, async (tx) => {
      const created = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId,
        dateOfBirth: null,
        givenName,
        familyName,
        email: `hidden-reads.${n}@example.test`,
        phone: `+61 411 555 ${String(100 + (n % 900))}`,
        actorUserId: null,
      });
      return created.personId;
    });
  }

  async function hide(scope: Scope, personId: string): Promise<{ purgeAfter: Date }> {
    return inScope(scope, async (tx) => {
      await lockPersonForDelete(tx, { personId, version: 1 });
      const hidden = await hidePerson(tx, { personId, actorUserId: newId() });
      return { purgeAfter: hidden.purgeAfter };
    });
  }

  async function createHouseholdRow(scope: Scope, label: string): Promise<string> {
    return inScope(scope, async (tx) => {
      const household = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label,
        actorUserId: null,
      });
      return household.householdId;
    });
  }

  // Sets a hidden contact's deleted_at to an exact time, in a short committed transaction as
  // the migrator with the user triggers off (Global constraints: seeding aged rows).
  async function setDeletedAt(
    scope: Scope,
    rows: { personId: string; micros: number }[],
  ): Promise<void> {
    const deletedBy = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
      for (const row of rows) {
        await tx`
          update app.persons
          set deleted_at = date_trunc('millisecond', now() - interval '2 hours')
                + (${row.micros} * interval '1 microsecond'),
              deleted_by = ${deletedBy}
          where id = ${row.personId}::uuid
        `;
      }
      await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
    });
  }

  async function listedDeletedEvents(scope: Scope): Promise<string[][]> {
    const rows = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and action = 'people.person.listed_deleted'
        order by id asc
      `;
    });
    return rows.map((r) => r.target_ids);
  }

  it("the adult list leaves out a hidden contact", async () => {
    const scope = await setupTenant("hr33");
    const visible = await addAdultPerson(scope, "Vera", "Smithson");
    const hidden = await addAdultPerson(scope, "Hugo", "Smithson");
    await hide(scope, hidden);
    const actorUserId = newId();

    await inScope(scope, async (tx) => {
      const plain = await listPersons(tx, kms, KEY_ARN, { actorUserId, now: NOW });
      expect(plain.items.map((i) => i.id)).toEqual([visible]);

      const searched = await listPersons(tx, kms, KEY_ARN, {
        actorUserId,
        now: NOW,
        search: "Smith",
      });
      expect(searched.items.map((i) => i.id)).toEqual([visible]);

      const filtered = await listPersons(tx, kms, KEY_ARN, {
        actorUserId,
        now: NOW,
        status: "active",
        source: "manual",
      });
      expect(filtered.items.map((i) => i.id)).toEqual([visible]);

      const byIds = await listPersons(tx, kms, KEY_ARN, {
        actorUserId,
        now: NOW,
        personIds: [visible, hidden],
      });
      expect(byIds.items.map((i) => i.id)).toEqual([visible]);
    });
  });

  it("the summary does not count a hidden contact", async () => {
    const scope = await setupTenant("hr34");
    await addAdultPerson(scope, "Vera", "Summary");
    await addAdultPerson(scope, "Vince", "Summary");
    const hidden = await addAdultPerson(scope, "Hugo", "Summary");
    await hide(scope, hidden);

    await inScope(scope, async (tx) => {
      const summary = await summarisePersons(tx, { addedSince: new Date(0) });
      expect(summary).toEqual({ total: 2, active: 2, inactive: 0, addedSince: 2 });
    });
  });

  it("readPerson answers not found for a hidden contact", async () => {
    const scope = await setupTenant("hr35");
    const visible = await addAdultPerson(scope, "Vera", "Reader");
    const hidden = await addAdultPerson(scope, "Hugo", "Reader");
    await hide(scope, hidden);

    await inScope(scope, async (tx) => {
      const seen = await readPerson(tx, kms, KEY_ARN, { personId: visible, actorUserId: null });
      expect(seen).not.toBeNull();
      expect(seen?.personId).toBe(visible);

      await expect(
        readPerson(tx, kms, KEY_ARN, { personId: hidden, actorUserId: null }),
      ).resolves.toBeNull();
    });
  });

  it("family detail leaves out a hidden guardian's link", async () => {
    const scope = await setupTenant("hr36");
    const householdId = await createHouseholdRow(scope, "Link Family");
    const hiddenGuardian = await addAdultPerson(scope, "Hugo", "Guardian", householdId);
    const visibleGuardian = await addAdultPerson(scope, "Vera", "Guardian", householdId);

    await inScope(scope, async (tx) => {
      const child = await addMinor(tx, kms, KEY_ARN, {
        now: NOW,
        householdId,
        givenName: "Child",
        familyName: "Guardian",
        dateOfBirth: "2018-03-04",
        guardianId: hiddenGuardian,
        actorUserId: null,
      });
      await linkGuardian(tx, {
        now: NOW,
        householdId,
        guardianPersonId: visibleGuardian,
        childPersonId: child.personId,
        consent: true,
        pickup: true,
        view: true,
        manage: true,
        actorUserId: null,
      });
    });
    await hide(scope, hiddenGuardian);

    await inScope(scope, async (tx) => {
      const detail = await readHouseholdDetail(tx, kms, KEY_ARN, {
        householdId,
        includeRestricted: true,
        actorUserId: newId(),
      });
      expect(detail).not.toBeNull();
      expect(detail?.adults.map((a) => a.personId)).toEqual([visibleGuardian]);
      expect(detail?.guardians.map((g) => g.guardianId)).toEqual([visibleGuardian]);
    });
  });

  it("the family list does not count a hidden adult", async () => {
    const scope = await setupTenant("hr37");
    const householdId = await createHouseholdRow(scope, "Count Family");
    await addAdultPerson(scope, "Vera", "Counted", householdId);
    const hidden = await addAdultPerson(scope, "Hugo", "Counted", householdId);
    await hide(scope, hidden);

    await inScope(scope, async (tx) => {
      const listed = await listHouseholds(tx, kms, KEY_ARN, {
        includeRestricted: false,
        actorUserId: newId(),
      });
      const row = listed.items.find((h) => h.householdId === householdId);
      expect(row?.adultCount).toBe(1);
    });
  });

  it("linked contacts leave out a hidden contact", async () => {
    const scope = await setupTenant("hr38");
    const visible = await addAdultPerson(scope, "Vera", "Linked");
    const hidden = await addAdultPerson(scope, "Hugo", "Linked");
    await hide(scope, hidden);

    await inScope(scope, async (tx) => {
      const linked = await readLinkedContacts(tx, kms, KEY_ARN, {
        personIds: [visible, hidden],
        includePhone: true,
        actorUserId: newId(),
      });
      expect([...linked.keys()]).toEqual([visible]);
    });
  });

  it("roster names leave out a hidden contact", async () => {
    const scope = await setupTenant("hr39");
    const visible = await addAdultPerson(scope, "Vera", "Roster");
    const hidden = await addAdultPerson(scope, "Hugo", "Roster");
    await hide(scope, hidden);

    await inScope(scope, async (tx) => {
      const roster = await readRosterNames(tx, kms, KEY_ARN, {
        personIds: [visible, hidden],
        includeRestricted: false,
        actorUserId: newId(),
      });
      expect(roster.map((r) => r.personId)).toEqual([visible]);
    });
  });

  it("the life-event list leaves out a hidden contact's events", async () => {
    const scope = await setupTenant("hr40");
    const visible = await addAdultPerson(scope, "Vera", "Events");
    const hidden = await addAdultPerson(scope, "Hugo", "Events");
    await inScope(scope, async (tx) => {
      for (const personId of [visible, hidden]) {
        await createLifeEvent(tx, kms, KEY_ARN, {
          personId,
          type: "marriage",
          date: "2020-06-20",
          place: "Synthetic Church",
          notes: null,
          actorUserId: null,
          now: NOW,
        });
      }
    });
    await hide(scope, hidden);

    await inScope(scope, async (tx) => {
      const seen = await listLifeEvents(tx, kms, KEY_ARN, { personId: visible, actorUserId: null });
      expect(seen.items).toHaveLength(1);

      await expect(
        listLifeEvents(tx, kms, KEY_ARN, { personId: hidden, actorUserId: null }),
      ).rejects.toMatchObject({ code: "life_event_not_found" });
    });
  });

  it("openPersonFieldKeys answers null for a hidden contact", async () => {
    const scope = await setupTenant("hr41");
    const visible = await addAdultPerson(scope, "Vera", "Keys");
    const hidden = await addAdultPerson(scope, "Hugo", "Keys");
    await hide(scope, hidden);

    await inScope(scope, async (tx) => {
      const keys = await openPersonFieldKeys(tx, kms, KEY_ARN, {
        personId: visible,
        actorUserId: null,
      });
      expect(keys).not.toBeNull();

      await expect(
        openPersonFieldKeys(tx, kms, KEY_ARN, { personId: hidden, actorUserId: null }),
      ).resolves.toBeNull();
    });
  });

  it("the deleted list returns names and dates only, with no KMS call", async () => {
    const scope = await setupTenant("hr42");
    const visible = await addAdultPerson(scope, "Vera", "Deleted");
    const first = await addAdultPerson(scope, "Hugo", "Deleted");
    const second = await addAdultPerson(scope, "Hana", "Deleted");
    const firstHidden = await hide(scope, first);
    await hide(scope, second);

    // listDeletedPersons takes no KMS port, so no KMS call is possible. The test also records
    // every statement it runs: none may touch a key table or a ciphertext column.
    const statements: string[] = [];
    const result = await inScope(scope, async (tx) => {
      const recording = new Proxy(tx, {
        apply(target, thisArg, args: unknown[]) {
          const strings = args[0];
          if (Array.isArray(strings)) {
            statements.push(strings.join("?"));
          }
          return Reflect.apply(target, thisArg, args) as unknown;
        },
      });
      return await listDeletedPersons(recording, { actorUserId: newId() });
    });

    expect(result.items.map((i) => i.id)).toEqual([second, first]);
    expect(result.items.map((i) => i.id)).not.toContain(visible);
    expect(result.nextCursor).toBeNull();
    for (const item of result.items) {
      expect(Object.keys(item).sort()).toEqual([
        "deletedAt",
        "familyName",
        "givenName",
        "id",
        "purgeAfter",
        "version",
      ]);
      expect(item.version).toBe(2);
      expect(Date.parse(item.purgeAfter) - Date.parse(item.deletedAt)).toBe(720 * 3600 * 1000);
    }
    const firstItem = result.items.find((i) => i.id === first);
    expect(firstItem?.givenName).toBe("Hugo");
    expect(firstItem?.familyName).toBe("Deleted");
    expect(Date.parse(firstItem?.purgeAfter ?? "")).toBe(firstHidden.purgeAfter.getTime());

    expect(statements.length).toBeGreaterThan(0);
    const sql = statements.join("\n").toLowerCase();
    for (const forbidden of [
      "community_keys",
      "organisation_keys",
      "household_keys",
      "email",
      "phone",
      "date_of_birth",
    ]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it("the deleted list pages rows that share a millisecond without repeats or gaps", async () => {
    const scope = await setupTenant("hr43");
    const visible = await addAdultPerson(scope, "Vera", "Paged");
    const a = await addAdultPerson(scope, "Ada", "Paged");
    const b = await addAdultPerson(scope, "Bea", "Paged");
    const c = await addAdultPerson(scope, "Cal", "Paged");
    for (const id of [a, b, c]) {
      await hide(scope, id);
    }
    // Same millisecond, different microseconds. Newest first: b (900), c (200), a (100).
    await setDeletedAt(scope, [
      { personId: a, micros: 100 },
      { personId: b, micros: 900 },
      { personId: c, micros: 200 },
    ]);
    const expected = [b, c, a];

    for (const size of [1, 2]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const currentCursor: string | null = cursor;
        const page: ListDeletedPersonsResult = await inScope(scope, (tx) =>
          listDeletedPersons(tx, { actorUserId: newId(), limit: size, cursor: currentCursor }),
        );
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(4);
      } while (cursor !== null);
      expect(seen).toEqual(expected);
      expect(seen).not.toContain(visible);
      expect(pages).toBe(Math.ceil(3 / size));
    }
  });

  it("the deleted list audits each non-empty page once and an empty page never", async () => {
    const scope = await setupTenant("hr44");
    const visible = await addAdultPerson(scope, "Vera", "Audited");
    const first = await addAdultPerson(scope, "Hugo", "Audited");
    const second = await addAdultPerson(scope, "Hana", "Audited");
    await hide(scope, first);
    await hide(scope, second);

    // Page 1 holds the newest (second), page 2 holds first.
    const page1 = await inScope(scope, (tx) =>
      listDeletedPersons(tx, { actorUserId: newId(), limit: 1 }),
    );
    expect(page1.items.map((i) => i.id)).toEqual([second]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await inScope(scope, (tx) =>
      listDeletedPersons(tx, { actorUserId: newId(), limit: 1, cursor: page1.nextCursor }),
    );
    expect(page2.items.map((i) => i.id)).toEqual([first]);
    expect(page2.nextCursor).toBeNull();

    expect(await listedDeletedEvents(scope)).toEqual([[second], [first]]);

    // A search that matches nothing returns an empty page and writes no event.
    const empty = await inScope(scope, (tx) =>
      listDeletedPersons(tx, { actorUserId: newId(), search: "Nobody" }),
    );
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBeNull();
    expect(await listedDeletedEvents(scope)).toEqual([[second], [first]]);
    expect(await listedDeletedEvents(scope)).not.toContainEqual([visible]);
  });

  it("the deleted list searches names only and stays inside its community", async () => {
    const scope = await setupTenant("hr44b");
    const other = await setupTenant("hr44c");
    const wanted = await addAdultPerson(scope, "Zara", "Findable");
    const unwanted = await addAdultPerson(scope, "Yan", "Elsewhere");
    const foreign = await addAdultPerson(other, "Zara", "Findable");
    await hide(scope, wanted);
    await hide(scope, unwanted);
    await hide(other, foreign);

    await inScope(scope, async (tx) => {
      const byName = await listDeletedPersons(tx, { actorUserId: newId(), search: "zar" });
      expect(byName.items.map((i) => i.id)).toEqual([wanted]);

      const byFamily = await listDeletedPersons(tx, { actorUserId: newId(), search: "Findable" });
      expect(byFamily.items.map((i) => i.id)).toEqual([wanted]);

      const byEmail = await listDeletedPersons(tx, {
        actorUserId: newId(),
        search: "hidden-reads.1@example.test",
      });
      expect(byEmail.items).toEqual([]);

      const all = await listDeletedPersons(tx, { actorUserId: newId() });
      expect(all.items.map((i) => i.id).sort()).toEqual([wanted, unwanted].sort());
    });
  });

  it("the deleted list never returns a minor", async () => {
    const scope = await setupTenant("hr44d");
    const householdId = await createHouseholdRow(scope, "Minor Family");
    const guardian = await addAdultPerson(scope, "Gail", "Minorfam", householdId);
    const hiddenAdult = await addAdultPerson(scope, "Hugo", "Minorfam");
    await hide(scope, hiddenAdult);
    const minorId = await inScope(scope, async (tx) => {
      const child = await addMinor(tx, kms, KEY_ARN, {
        now: NOW,
        householdId,
        givenName: "Kid",
        familyName: "Minorfam",
        dateOfBirth: "2018-03-04",
        guardianId: guardian,
        actorUserId: null,
      });
      return child.personId;
    });
    // A minor can never be hidden through the app role; seed one as the migrator to prove the
    // query's own is_minor predicate.
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
      await tx`
        update app.persons
        set deleted_at = now() - interval '1 hour', deleted_by = ${newId()}
        where id = ${minorId}::uuid
      `;
      await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
    });

    await inScope(scope, async (tx) => {
      const listed = await listDeletedPersons(tx, { actorUserId: newId() });
      expect(listed.items.map((i) => i.id)).toEqual([hiddenAdult]);
    });
  });

  it("visiblePersonIds returns the ids that are not hidden, in the current scope", async () => {
    const scope = await setupTenant("hr45");
    const other = await setupTenant("hr45o");
    const householdId = await createHouseholdRow(scope, "Visible Family");
    const visible = await addAdultPerson(scope, "Vera", "Visible", householdId);
    const hidden = await addAdultPerson(scope, "Hugo", "Visible");
    const foreign = await addAdultPerson(other, "Fay", "Visible");
    await hide(scope, hidden);
    const minorId = await inScope(scope, async (tx) => {
      const child = await addMinor(tx, kms, KEY_ARN, {
        now: NOW,
        householdId,
        givenName: "Kid",
        familyName: "Visible",
        dateOfBirth: "2018-03-04",
        guardianId: visible,
        actorUserId: null,
      });
      return child.personId;
    });
    const unknown = newId();

    await inScope(scope, async (tx) => {
      await expect(
        visiblePersonIds(tx, [minorId, hidden, unknown, foreign, visible, visible]),
      ).resolves.toEqual([minorId, visible]);
      await expect(visiblePersonIds(tx, [])).resolves.toEqual([]);
      await expect(visiblePersonIds(tx, ["not-a-uuid"])).rejects.toMatchObject({
        code: "invalid_input",
      });
    });
  });
});
