import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { KmsPort } from "@community-hub/crypto";
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
import { createHousehold, createPerson } from "@community-hub/people";

import {
  activeGroupsForPersons,
  addMember,
  createGroup,
  exportRosterCsv,
  GroupsError,
  listMembers,
  personIdsInGroup,
  removeMember,
  setMemberRole,
} from "../public/index.js";
import { cleanScope, loadRuntime, roleUrl } from "../test/fixtures/real-scope.js";

// Children in groups (plan Task 5, pins 45 to 49). A child is counted, not listed, for anyone but a
// Community Admin: under "presence" a minor row and a minor id are never returned, and a minor
// membership is never written. Under "admin" a child is an id and a label, never a name. No
// function here decrypts a child's field in either view.

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-11-28T00:00:00+11:00");

// Unusual on purpose: a substring hit is never a coincidence.
const CHILD_ONE = { givenName: "Zephyrine", familyName: "Quillonwick", dateOfBirth: "2018-05-05" };
const CHILD_TWO = { givenName: "Quillon", familyName: "Zephyrwick", dateOfBirth: "2019-06-07" };
const CHILD_THREE = {
  givenName: "Thessaly",
  familyName: "Brannochmoor",
  dateOfBirth: "2016-02-02",
};
const CHILD_VALUES = [
  CHILD_ONE.givenName,
  CHILD_ONE.familyName,
  CHILD_ONE.dateOfBirth,
  CHILD_TWO.givenName,
  CHILD_TWO.familyName,
  CHILD_TWO.dateOfBirth,
  CHILD_THREE.givenName,
  CHILD_THREE.familyName,
  CHILD_THREE.dateOfBirth,
];

type Scope = { orgId: string; communityId: string };

let platform: ReturnType<typeof createPlaintextPlatformSql>;
let app: ReturnType<typeof createPlaintextAppSql>;
let directSql: ReturnType<typeof createPlaintextDirectSql>;

function createTestKms(): { kms: KmsPort; decrypts: () => number; reset: () => void } {
  const store = new Map<string, Uint8Array>();
  let decrypts = 0;
  return {
    kms: {
      async generateDataKey(keyId, context) {
        void keyId;
        void context;
        const secret = crypto.getRandomValues(new Uint8Array(32));
        const blob = crypto.getRandomValues(new Uint8Array(32));
        store.set(Buffer.from(blob).toString("hex"), new Uint8Array(secret));
        return { plaintext: new Uint8Array(secret), blob };
      },
      async decrypt(keyId, blob, context) {
        void keyId;
        void context;
        decrypts += 1;
        const secret = store.get(Buffer.from(blob).toString("hex"));
        if (!secret) {
          throw new Error("key not found in test kms");
        }
        return new Uint8Array(secret);
      },
    },
    decrypts: () => decrypts,
    reset: () => {
      decrypts = 0;
    },
  };
}

beforeAll(async () => {
  const runtime = loadRuntime();
  directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
  await applyProductMigrations(directSql);
  platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  app = createPlaintextAppSql(roleUrl(runtime, "app"));
});

const scopes: Scope[] = [];

afterAll(async () => {
  for (const scope of scopes) {
    await cleanScope(directSql, scope);
  }
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
      values (${orgId}, ${`minor-members-org-${orgId}`}, 'au', 'implicit')
    `;
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`minor-members-comm-${communityId}`}, 'au')
    `;
  });
  const scope = { orgId, communityId };
  scopes.push(scope);
  return scope;
}

async function newCommunityIn(orgId: string): Promise<Scope> {
  const communityId = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`minor-members-comm-${communityId}`}, 'au')
    `;
  });
  return { orgId, communityId };
}

function inScope<T>(scope: Scope, run: (tx: AppTransaction) => Promise<T>): Promise<T> {
  return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, run));
}

// Hides children the way a later chunk will: deleted_at and deleted_by are set. Today the user
// triggers refuse that, so it is done in a short committed transaction as the migrator with the
// user triggers off, as the other hidden-row tests do.
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

type Fixture = {
  scope: Scope;
  actorUserId: string;
  kms: ReturnType<typeof createTestKms>;
  groupId: string;
  otherGroupId: string;
  adultId: string;
  outsiderId: string;
  childOneId: string;
  childTwoId: string;
  childThreeId: string;
};

// One group with an adult leader and three children as members: Child 1 and Child 2 of one
// household (Child 2 created an hour later, so the labels do not depend on id order) and the only
// child of another household. A second group holds Child 1. An adult outside the group and a child
// who is no member are there for the writes.
async function seedFixture(
  existing?: Scope,
  sharedKms?: ReturnType<typeof createTestKms>,
): Promise<Fixture> {
  const target = existing ?? (await newScope());
  const actorUserId = newId();
  // Two communities of one organisation share the organisation key, so they share a KMS.
  const kms = sharedKms ?? createTestKms();
  const ids = await inScope(target, async (tx) => {
    const group = await createGroup(tx, {
      name: "Altar Servers",
      kind: "ministry",
      now: NOW,
      actorUserId,
    });
    const other = await createGroup(tx, {
      name: "Choir Juniors",
      kind: "ministry",
      now: NOW,
      actorUserId,
    });
    const household = await createHousehold(tx, kms.kms, KEY_ARN, {
      now: NOW,
      label: "Marchetti",
      actorUserId,
    });
    const household2 = await createHousehold(tx, kms.kms, KEY_ARN, {
      now: NOW,
      label: "Ashcombe",
      actorUserId,
    });
    const adult = await createPerson(tx, kms.kms, KEY_ARN, {
      now: NOW,
      declaredAdult: true,
      householdId: household.householdId,
      dateOfBirth: null,
      givenName: "Aurelia",
      familyName: "Marchetti",
      email: null,
      phone: null,
      actorUserId,
    });
    const outsider = await createPerson(tx, kms.kms, KEY_ARN, {
      now: NOW,
      declaredAdult: true,
      householdId: null,
      dateOfBirth: null,
      givenName: "Olivier",
      familyName: "Outsider",
      email: null,
      phone: null,
      actorUserId,
    });
    const childOne = await createPerson(tx, kms.kms, KEY_ARN, {
      now: NOW,
      declaredAdult: false,
      householdId: household.householdId,
      ...CHILD_ONE,
      email: null,
      phone: null,
      actorUserId,
    });
    const childTwo = await createPerson(tx, kms.kms, KEY_ARN, {
      now: new Date(NOW.getTime() + 3_600_000),
      declaredAdult: false,
      householdId: household.householdId,
      ...CHILD_TWO,
      email: null,
      phone: null,
      actorUserId,
    });
    const childThree = await createPerson(tx, kms.kms, KEY_ARN, {
      now: NOW,
      declaredAdult: false,
      householdId: household2.householdId,
      ...CHILD_THREE,
      email: null,
      phone: null,
      actorUserId,
    });
    await addMember(tx, kms.kms, KEY_ARN, {
      groupId: group.id,
      personId: adult.personId,
      role: "leader",
      now: NOW,
      actorUserId,
      childView: "presence",
    });
    for (const [offset, child] of [childOne, childTwo, childThree].entries()) {
      await addMember(tx, kms.kms, KEY_ARN, {
        groupId: group.id,
        personId: child.personId,
        now: new Date(NOW.getTime() + (offset + 1) * 1000),
        actorUserId,
        childView: "admin",
      });
    }
    await addMember(tx, kms.kms, KEY_ARN, {
      groupId: other.id,
      personId: childOne.personId,
      now: NOW,
      actorUserId,
      childView: "admin",
    });
    return {
      groupId: group.id,
      otherGroupId: other.id,
      adultId: adult.personId,
      outsiderId: outsider.personId,
      childOneId: childOne.personId,
      childTwoId: childTwo.personId,
      childThreeId: childThree.personId,
    };
  });
  return { scope: target, actorUserId, kms, ...ids };
}

function expectNoChildValue(value: unknown): void {
  const text = JSON.stringify(value);
  for (const forbidden of CHILD_VALUES) {
    expect(text).not.toContain(forbidden);
  }
}

function childIds(f: Fixture): string[] {
  return [f.childOneId, f.childTwoId, f.childThreeId];
}

async function memberRows(tx: AppTransaction, groupId: string): Promise<[string, string][]> {
  const rows = await tx<{ person_id: string; role: string }[]>`
    select person_id::text as person_id, role
    from app.group_members
    where group_id = ${groupId}::uuid
    order by person_id
  `;
  return rows.map((row) => [row.person_id, row.role]);
}

async function auditCount(tx: AppTransaction, action: string): Promise<number> {
  const rows = await tx<{ n: number }[]>`
    select count(*)::int as n from app.audit_events where action = ${action}
  `;
  return rows[0]?.n ?? 0;
}

// The error a call throws. A call that does not throw fails the test on an assertion, not on a
// thrown error of its own, so a weakened refusal is reported as a failed expectation.
async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable("the call was expected to throw");
}

describe("children in group members", () => {
  it("pin 45: listMembers under presence has no minor row or id, and reports minorCount", async () => {
    const f = await seedFixture();

    await inScope(f.scope, async (tx) => {
      f.kms.reset();
      const presence = await listMembers(tx, f.kms.kms, KEY_ARN, {
        groupId: f.groupId,
        actorUserId: f.actorUserId,
        childView: "presence",
      });
      expect(Object.keys(presence).sort()).toEqual(["members", "minorCount"]);
      // The adult is unchanged: the same four keys as before this chunk, and no name.
      expect(presence.members).toHaveLength(1);
      expect(presence.members[0]).toEqual({
        personId: f.adultId,
        role: "leader",
        isMinor: false,
        addedAt: NOW,
      });
      expect(Object.keys(presence.members[0] ?? {}).sort()).toEqual([
        "addedAt",
        "isMinor",
        "personId",
        "role",
      ]);
      // The three children are counted and nothing else: no row, no id, no label, no name.
      expect(presence.minorCount).toBe(3);
      const text = JSON.stringify(presence);
      for (const id of childIds(f)) {
        expect(text).not.toContain(id);
      }
      expect(text).not.toContain("Child");
      expectNoChildValue(presence);
      expect(f.kms.decrypts()).toBe(0);
    });

    // A hidden child is neither listed nor counted.
    await hideChildren(f.scope, [f.childTwoId]);
    await inScope(f.scope, async (tx) => {
      const after = await listMembers(tx, f.kms.kms, KEY_ARN, {
        groupId: f.groupId,
        actorUserId: f.actorUserId,
        childView: "presence",
      });
      expect(after.minorCount).toBe(2);
      expect(after.members.map((member) => member.personId)).toEqual([f.adultId]);
    });
  });

  it("pin 45 (continued): listMembers under admin lists each child as an id and a label, never a name", async () => {
    const f = await seedFixture();

    await inScope(f.scope, async (tx) => {
      f.kms.reset();
      const admin = await listMembers(tx, f.kms.kms, KEY_ARN, {
        groupId: f.groupId,
        actorUserId: f.actorUserId,
        childView: "admin",
      });
      expect(admin.minorCount).toBe(3);
      expect(admin.members.map((member) => member.personId)).toEqual([
        f.adultId,
        f.childOneId,
        f.childTwoId,
        f.childThreeId,
      ]);
      const adult = admin.members[0];
      expect(Object.keys(adult ?? {}).sort()).toEqual(["addedAt", "isMinor", "personId", "role"]);
      expect(adult?.isMinor).toBe(false);
      for (const child of admin.members.slice(1)) {
        expect(Object.keys(child).sort()).toEqual([
          "addedAt",
          "isMinor",
          "label",
          "personId",
          "role",
        ]);
        expect(child.isMinor).toBe(true);
        expect(child.role).toBe("member");
      }
      // Labels are numbered inside each child's own household, as on every other screen.
      expect(admin.members.slice(1).map((member) => member.label)).toEqual([
        "Child 1",
        "Child 2",
        "Child 1",
      ]);
      expectNoChildValue(admin);
      expect(f.kms.decrypts()).toBe(0);
      expect(await auditCount(tx, "people.person.read")).toBe(0);
    });

    await hideChildren(f.scope, [f.childOneId]);
    await inScope(f.scope, async (tx) => {
      const after = await listMembers(tx, f.kms.kms, KEY_ARN, {
        groupId: f.groupId,
        actorUserId: f.actorUserId,
        childView: "admin",
      });
      expect(after.minorCount).toBe(2);
      expect(after.members.map((member) => [member.personId, member.label])).toEqual([
        [f.adultId, undefined],
        [f.childTwoId, "Child 1"],
        [f.childThreeId, "Child 1"],
      ]);
    });
  });

  it("pin 46: personIdsInGroup under presence has no minor id", async () => {
    const f = await seedFixture();

    await inScope(f.scope, async (tx) => {
      const presence = await personIdsInGroup(tx, f.groupId, { childView: "presence" });
      expect(presence).toEqual([f.adultId]);
      for (const id of childIds(f)) {
        expect(JSON.stringify(presence)).not.toContain(id);
      }
      // A Community Admin's view keeps the ids, in the order the members joined.
      await expect(personIdsInGroup(tx, f.groupId, { childView: "admin" })).resolves.toEqual([
        f.adultId,
        f.childOneId,
        f.childTwoId,
        f.childThreeId,
      ]);
      // The other group holds one child and no adult: nothing under presence.
      await expect(
        personIdsInGroup(tx, f.otherGroupId, { childView: "presence" }),
      ).resolves.toEqual([]);
      await expect(personIdsInGroup(tx, f.otherGroupId, { childView: "admin" })).resolves.toEqual([
        f.childOneId,
      ]);
    });
  });

  it("pin 46b: activeGroupsForPersons under presence has no minor id and no minor group", async () => {
    const f = await seedFixture();

    await inScope(f.scope, async (tx) => {
      const asked = [f.adultId, f.childOneId, f.childTwoId, f.outsiderId];
      const presence = await activeGroupsForPersons(tx, asked, { childView: "presence" });
      expect([...presence.keys()].sort()).toEqual([f.adultId, f.outsiderId].sort());
      expect(presence.get(f.adultId)).toEqual([{ id: f.groupId, name: "Altar Servers" }]);
      expect(presence.get(f.outsiderId)).toEqual([]);
      for (const id of [f.childOneId, f.childTwoId]) {
        expect(JSON.stringify([...presence.entries()])).not.toContain(id);
      }

      // A Community Admin's view gives a child's groups, by id: still no name or label.
      const admin = await activeGroupsForPersons(tx, asked, { childView: "admin" });
      expect([...admin.keys()].sort()).toEqual(
        [f.adultId, f.childOneId, f.childTwoId, f.outsiderId].sort(),
      );
      expect(admin.get(f.childOneId)).toEqual([
        { id: f.groupId, name: "Altar Servers" },
        { id: f.otherGroupId, name: "Choir Juniors" },
      ]);
      expect(admin.get(f.childTwoId)).toEqual([{ id: f.groupId, name: "Altar Servers" }]);
      expectNoChildValue([...admin.entries()]);
    });
  });

  it("pin 47: exportRosterCsv under presence has no child row", async () => {
    const f = await seedFixture();

    await inScope(f.scope, async (tx) => {
      f.kms.reset();
      const csv = await exportRosterCsv(tx, f.kms.kms, KEY_ARN, {
        groupId: f.groupId,
        childView: "presence",
        actorUserId: f.actorUserId,
      });
      expect(csv.trim().split(/\r?\n/)).toEqual([
        '"given_name","family_name","role"',
        '"Aurelia","Marchetti","leader"',
      ]);
      expect(csv).not.toContain("Child");
      expectNoChildValue(csv);
      for (const id of childIds(f)) {
        expect(csv).not.toContain(id);
      }
      expect(f.kms.decrypts()).toBe(0);
      // One export is audited, with the group id and no person.
      const events = await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where action = 'groups.roster.exported'
      `;
      expect(events).toEqual([{ target_ids: [f.groupId] }]);
    });

    // A group of children alone exports the header and nothing else.
    await inScope(f.scope, async (tx) => {
      const csv = await exportRosterCsv(tx, f.kms.kms, KEY_ARN, {
        groupId: f.otherGroupId,
        childView: "presence",
        actorUserId: f.actorUserId,
      });
      expect(csv.trim().split(/\r?\n/)).toEqual(['"given_name","family_name","role"']);
    });
  });

  it("pin 48: exportRosterCsv under admin shows Child n and no name", async () => {
    const f = await seedFixture();

    await inScope(f.scope, async (tx) => {
      f.kms.reset();
      const csv = await exportRosterCsv(tx, f.kms.kms, KEY_ARN, {
        groupId: f.groupId,
        childView: "admin",
        actorUserId: f.actorUserId,
      });
      const lines = csv.trim().split(/\r?\n/);
      expect(lines[0]).toBe('"given_name","family_name","role"');
      // The adult is unchanged and sorted first. Each child is the label alone, in the first
      // column, with no family name: Child 1 and Child 2 of one household, and the only child of
      // the other, in label order.
      expect(lines.slice(1)).toEqual([
        '"Aurelia","Marchetti","leader"',
        '"Child 1","","member"',
        '"Child 1","","member"',
        '"Child 2","","member"',
      ]);
      expectNoChildValue(csv);
      // Nothing was decrypted, and no name read was audited.
      expect(f.kms.decrypts()).toBe(0);
      expect(await auditCount(tx, "people.person.read")).toBe(0);
      const events = await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where action = 'groups.roster.exported'
      `;
      expect(events).toEqual([{ target_ids: [f.groupId] }]);
    });
  });

  it("pin 49: addMember of a minor under presence is refused as a person that does not exist", async () => {
    const f = await seedFixture();

    await inScope(f.scope, async (tx) => {
      const before = await memberRows(tx, f.otherGroupId);
      const audited = await auditCount(tx, "groups.member.added");

      // childTwo is in no second group yet: the refusal must leave no membership behind.
      const refused = await caught(() =>
        addMember(tx, f.kms.kms, KEY_ARN, {
          groupId: f.otherGroupId,
          personId: f.childTwoId,
          now: NOW,
          actorUserId: f.actorUserId,
          childView: "presence",
        }),
      );
      const missing = await caught(() =>
        addMember(tx, f.kms.kms, KEY_ARN, {
          groupId: f.otherGroupId,
          personId: newId(),
          now: NOW,
          actorUserId: f.actorUserId,
          childView: "presence",
        }),
      );
      expect(refused).toBeInstanceOf(GroupsError);
      expect(refused).toMatchObject({ code: "person_not_found" });
      // The same answer, whole, as for an id that is no person at all: not an oracle.
      expect((refused as Error).message).toBe((missing as Error).message);
      expect((refused as Error).name).toBe((missing as Error).name);
      expect(JSON.stringify(refused)).not.toContain(f.childTwoId);

      expect(await memberRows(tx, f.otherGroupId)).toEqual(before);
      expect(await auditCount(tx, "groups.member.added")).toBe(audited);

      // A Community Admin's view adds the child, and the answer carries ids and the role only.
      const added = await addMember(tx, f.kms.kms, KEY_ARN, {
        groupId: f.otherGroupId,
        personId: f.childTwoId,
        now: NOW,
        actorUserId: f.actorUserId,
        childView: "admin",
      });
      expect(added).toEqual({
        personId: f.childTwoId,
        role: "member",
        isMinor: true,
        addedAt: NOW,
      });
      expect(await auditCount(tx, "groups.member.added")).toBe(audited + 1);

      // An adult is added under either view, as before.
      for (const [view, person] of [
        ["presence", f.outsiderId],
        ["admin", f.adultId],
      ] as const) {
        const adult = await addMember(tx, f.kms.kms, KEY_ARN, {
          groupId: f.otherGroupId,
          personId: person,
          now: NOW,
          actorUserId: f.actorUserId,
          childView: view,
        });
        expect(adult).toMatchObject({ personId: person, isMinor: false, role: "member" });
      }
    });
  });

  it("pin 49b: removeMember of a minor under presence is refused and removes nothing", async () => {
    const f = await seedFixture();

    await inScope(f.scope, async (tx) => {
      const before = await memberRows(tx, f.groupId);
      const audited = await auditCount(tx, "groups.member.removed");

      // A child who is a member: refused with the module's not-found error, as for a hidden contact.
      await expect(
        removeMember(tx, {
          groupId: f.groupId,
          personId: f.childOneId,
          now: NOW,
          actorUserId: f.actorUserId,
          childView: "presence",
        }),
      ).rejects.toMatchObject({ code: "person_not_found" });
      expect(await memberRows(tx, f.groupId)).toEqual(before);
      expect(await auditCount(tx, "groups.member.removed")).toBe(audited);

      // A child who is no member of this group answers as an id that is no member does: false.
      await expect(
        removeMember(tx, {
          groupId: f.otherGroupId,
          personId: f.childTwoId,
          now: NOW,
          actorUserId: f.actorUserId,
          childView: "presence",
        }),
      ).resolves.toBe(false);
      await expect(
        removeMember(tx, {
          groupId: f.otherGroupId,
          personId: newId(),
          now: NOW,
          actorUserId: f.actorUserId,
          childView: "presence",
        }),
      ).resolves.toBe(false);

      // An adult is removed under presence, as before.
      await expect(
        removeMember(tx, {
          groupId: f.groupId,
          personId: f.adultId,
          now: NOW,
          actorUserId: f.actorUserId,
          childView: "presence",
        }),
      ).resolves.toBe(true);

      // A Community Admin's view removes the child.
      await expect(
        removeMember(tx, {
          groupId: f.groupId,
          personId: f.childOneId,
          now: NOW,
          actorUserId: f.actorUserId,
          childView: "admin",
        }),
      ).resolves.toBe(true);
      expect((await memberRows(tx, f.groupId)).map(([id]) => id).sort()).toEqual(
        [f.childTwoId, f.childThreeId].sort(),
      );
    });
  });

  it("pin 49c: setMemberRole of a minor under presence is refused and changes nothing", async () => {
    const f = await seedFixture();

    await inScope(f.scope, async (tx) => {
      const before = await memberRows(tx, f.groupId);
      const audited = await auditCount(tx, "groups.member.role_changed");

      await expect(
        setMemberRole(tx, {
          groupId: f.groupId,
          personId: f.childOneId,
          role: "leader",
          now: NOW,
          actorUserId: f.actorUserId,
          childView: "presence",
        }),
      ).rejects.toMatchObject({ code: "person_not_found" });
      expect(await memberRows(tx, f.groupId)).toEqual(before);
      expect(await auditCount(tx, "groups.member.role_changed")).toBe(audited);

      // The adult's role changes under presence, as before.
      await setMemberRole(tx, {
        groupId: f.groupId,
        personId: f.adultId,
        role: "member",
        now: NOW,
        actorUserId: f.actorUserId,
        childView: "presence",
      });
      expect(await auditCount(tx, "groups.member.role_changed")).toBe(audited + 1);

      // A Community Admin's view changes the child's role.
      await setMemberRole(tx, {
        groupId: f.groupId,
        personId: f.childOneId,
        role: "leader",
        now: NOW,
        actorUserId: f.actorUserId,
        childView: "admin",
      });
      const rows = new Map(await memberRows(tx, f.groupId));
      expect(rows.get(f.childOneId)).toBe("leader");
      expect(await auditCount(tx, "groups.member.role_changed")).toBe(audited + 2);
    });
  });

  it("every changed function requires a valid childView, with no default", async () => {
    const f = await seedFixture();

    await inScope(f.scope, async (tx) => {
      for (const bad of [undefined, "", "Admin", null, true]) {
        const childView = bad as never;
        await expect(
          listMembers(tx, f.kms.kms, KEY_ARN, {
            groupId: f.groupId,
            actorUserId: f.actorUserId,
            childView,
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(personIdsInGroup(tx, f.groupId, { childView })).rejects.toMatchObject({
          code: "invalid_input",
        });
        await expect(personIdsInGroup(tx, f.groupId, undefined as never)).rejects.toMatchObject({
          code: "invalid_input",
        });
        await expect(
          activeGroupsForPersons(tx, [f.adultId], undefined as never),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(activeGroupsForPersons(tx, [f.adultId], { childView })).rejects.toMatchObject({
          code: "invalid_input",
        });
        await expect(
          exportRosterCsv(tx, f.kms.kms, KEY_ARN, {
            groupId: f.groupId,
            actorUserId: f.actorUserId,
            childView,
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(
          addMember(tx, f.kms.kms, KEY_ARN, {
            groupId: f.groupId,
            personId: f.outsiderId,
            now: NOW,
            actorUserId: f.actorUserId,
            childView,
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(
          removeMember(tx, {
            groupId: f.groupId,
            personId: f.adultId,
            now: NOW,
            actorUserId: f.actorUserId,
            childView,
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(
          setMemberRole(tx, {
            groupId: f.groupId,
            personId: f.adultId,
            role: "member",
            now: NOW,
            actorUserId: f.actorUserId,
            childView,
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });
      }
      // Nothing changed.
      expect((await memberRows(tx, f.groupId)).length).toBe(4);
    });
  });

  it("a child of another community or organisation is never listed, counted or added under either view", async () => {
    const own = await seedFixture();
    const sameOrg = await seedFixture(await newCommunityIn(own.scope.orgId), own.kms);
    const otherOrg = await seedFixture();
    expect(sameOrg.scope.orgId).toBe(own.scope.orgId);
    expect(sameOrg.scope.communityId).not.toBe(own.scope.communityId);
    expect(otherOrg.scope.orgId).not.toBe(own.scope.orgId);

    await inScope(own.scope, async (tx) => {
      const foreign = [...childIds(sameOrg), ...childIds(otherOrg)];
      for (const view of ["presence", "admin"] as const) {
        // Another scope's group is not found, so none of its children can be reached.
        for (const group of [sameOrg.groupId, otherOrg.groupId]) {
          await expect(
            listMembers(tx, own.kms.kms, KEY_ARN, {
              groupId: group,
              actorUserId: own.actorUserId,
              childView: view,
            }),
          ).rejects.toMatchObject({ code: "group_not_found" });
          await expect(
            exportRosterCsv(tx, own.kms.kms, KEY_ARN, {
              groupId: group,
              childView: view,
              actorUserId: own.actorUserId,
            }),
          ).rejects.toMatchObject({ code: "group_not_found" });
          await expect(personIdsInGroup(tx, group, { childView: view })).resolves.toEqual([]);
        }
        // Another scope's child is no person here: never added, never given a group.
        for (const child of foreign) {
          await expect(
            addMember(tx, own.kms.kms, KEY_ARN, {
              groupId: own.groupId,
              personId: child,
              now: NOW,
              actorUserId: own.actorUserId,
              childView: view,
            }),
          ).rejects.toMatchObject({ code: "person_not_found" });
        }
        const groups = await activeGroupsForPersons(tx, foreign, { childView: view });
        expect(groups.size).toBe(0);
      }
      // Our own count is ours alone.
      const mine = await listMembers(tx, own.kms.kms, KEY_ARN, {
        groupId: own.groupId,
        actorUserId: own.actorUserId,
        childView: "presence",
      });
      expect(mine.minorCount).toBe(3);
    });
  });
});
