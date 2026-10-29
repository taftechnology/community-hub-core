import { beforeAll, describe, expect, it } from "vitest";

import type { KmsPort } from "@community-hub/crypto";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";
import { createHousehold, createPerson } from "@community-hub/people";

import {
  addMember,
  archiveGroup,
  createGroup,
  groupLeaderFact,
  GroupsError,
  listMembers,
  removeMember,
  setMemberRole,
} from "../public/index.js";
import { cleanScope, loadRuntime, roleUrl } from "../test/fixtures/real-scope.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-11T00:00:00+11:00");

function createTestKms(): KmsPort {
  const store = new Map<string, Uint8Array>();
  return {
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
      const key = Buffer.from(blob).toString("hex");
      const secret = store.get(key);
      if (!secret) {
        throw new Error("key not found in test kms");
      }
      return new Uint8Array(secret);
    },
  };
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

async function createTestScope(platform: ReturnType<typeof createPlaintextPlatformSql>): Promise<{
  orgId: string;
  communityId: string;
}> {
  const orgId = newId();
  const communityId = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.organisations (id, slug, region, kind)
      values (${orgId}, ${`scope-${orgId}`}, 'au', 'implicit')
    `;
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`comm-${communityId}`}, 'au')
    `;
  });
  return { orgId, communityId };
}

async function createCommunityInOrg(
  platform: ReturnType<typeof createPlaintextPlatformSql>,
  orgId: string,
): Promise<string> {
  const communityId = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`comm-${communityId}`}, 'au')
    `;
  });
  return communityId;
}

describe("group members and leader fact", () => {
  it("removes a member (pin 3)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();
    const scope = await createTestScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        let groupId = "";
        let personId = "";

        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Choir",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });
          groupId = group.id;

          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Alice",
            familyName: "Singer",
            email: null,
            phone: null,
            actorUserId,
          });
          personId = person.personId;

          await addMember(tx, kms, KEY_ARN, {
            groupId,
            personId,
            now: NOW,
            actorUserId,
          });
        });

        // Verify row exists in app.group_members
        const rowsBefore = await directSql<
          { person_id: string }[]
        >`select person_id::text from app.group_members where group_id = ${groupId}::uuid and person_id = ${personId}::uuid and org_id = ${scope.orgId}::uuid`;
        expect(rowsBefore).toHaveLength(1);

        // Delete the member using removeMember
        await withAppTransaction(app, scope, async (tx) => {
          const removed = await removeMember(tx, {
            groupId,
            personId,
            now: NOW,
            actorUserId,
          });
          expect(removed).toBe(true);

          // Verify row is deleted
          const rowsAfter = await tx<
            { person_id: string }[]
          >`select person_id::text from app.group_members where group_id = ${groupId}::uuid and person_id = ${personId}::uuid`;
          expect(rowsAfter).toHaveLength(0);

          // Verify groups.member.removed audit event
          const auditRows = await tx<{ action: string; target_ids: string[]; actor_id: string }[]>`
            select action, target_ids::text[] as target_ids, actor_id::text as actor_id
            from app.audit_events
            where action = 'groups.member.removed'
              and org_id = ${scope.orgId}::uuid
          `;
          expect(auditRows).toHaveLength(1);
          expect(auditRows[0]?.target_ids).toEqual([groupId, personId]);
          expect(auditRows[0]?.actor_id).toBe(actorUserId);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("two communities in one organisation see only their own members (pin 4)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();

    const scope1 = await createTestScope(platform);
    const comm2Id = await createCommunityInOrg(platform, scope1.orgId);
    const scope2 = { orgId: scope1.orgId, communityId: comm2Id };
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        let group1Id = "";
        let group2Id = "";
        let person1Id = "";
        let person2Id = "";

        await withAppTransaction(app, scope1, async (tx) => {
          const g1 = await createGroup(tx, {
            name: "Comm1 Group",
            kind: "group",
            now: NOW,
            actorUserId,
          });
          group1Id = g1.id;
          const p1 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Person",
            familyName: "One",
            email: null,
            phone: null,
            actorUserId,
          });
          person1Id = p1.personId;
          await addMember(tx, kms, KEY_ARN, {
            groupId: group1Id,
            personId: person1Id,
            now: NOW,
            actorUserId,
          });
        });

        await withAppTransaction(app, scope2, async (tx) => {
          const g2 = await createGroup(tx, {
            name: "Comm2 Group",
            kind: "group",
            now: NOW,
            actorUserId,
          });
          group2Id = g2.id;
          const p2 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Person",
            familyName: "Two",
            email: null,
            phone: null,
            actorUserId,
          });
          person2Id = p2.personId;
          await addMember(tx, kms, KEY_ARN, {
            groupId: group2Id,
            personId: person2Id,
            now: NOW,
            actorUserId,
          });
        });

        // Under scope1, listMembers for group1 sees person1
        await withAppTransaction(app, scope1, async (tx) => {
          const m1 = await listMembers(tx, kms, KEY_ARN, { groupId: group1Id, actorUserId });
          expect(m1).toHaveLength(1);
          expect(m1[0]?.personId).toBe(person1Id);

          // Under scope1, group2 is not found
          await expect(
            listMembers(tx, kms, KEY_ARN, { groupId: group2Id, actorUserId }),
          ).rejects.toBeInstanceOf(GroupsError);

          // Direct select under scope1 only sees group1's member
          const rlsRows = await tx<
            { group_id: string }[]
          >`select group_id::text from app.group_members`;
          expect(rlsRows.map((r) => r.group_id)).toEqual([group1Id]);
        });

        // Under scope2, listMembers for group2 sees person2
        await withAppTransaction(app, scope2, async (tx) => {
          const m2 = await listMembers(tx, kms, KEY_ARN, { groupId: group2Id, actorUserId });
          expect(m2).toHaveLength(1);
          expect(m2[0]?.personId).toBe(person2Id);

          const rlsRows = await tx<
            { group_id: string }[]
          >`select group_id::text from app.group_members`;
          expect(rlsRows.map((r) => r.group_id)).toEqual([group2Id]);
        });
      });
    } finally {
      await cleanScope(directSql, scope1);
      await cleanScope(directSql, scope2);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects a person from another community or organisation with person_not_found (pin 17)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();

    const scopeA = await createTestScope(platform);
    const commA2Id = await createCommunityInOrg(platform, scopeA.orgId);
    const scopeA2 = { orgId: scopeA.orgId, communityId: commA2Id };
    const scopeB = await createTestScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        let groupAId = "";
        let personA2Id = "";
        let personBId = "";

        await withAppTransaction(app, scopeA, async (tx) => {
          const g = await createGroup(tx, {
            name: "Parish Council",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });
          groupAId = g.id;
        });

        await withAppTransaction(app, scopeA2, async (tx) => {
          const p = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Other",
            familyName: "Comm",
            email: null,
            phone: null,
            actorUserId,
          });
          personA2Id = p.personId;
        });

        await withAppTransaction(app, scopeB, async (tx) => {
          const p = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Other",
            familyName: "Org",
            email: null,
            phone: null,
            actorUserId,
          });
          personBId = p.personId;
        });

        await withAppTransaction(app, scopeA, async (tx) => {
          // Person in another community of same org
          await expect(
            addMember(tx, kms, KEY_ARN, {
              groupId: groupAId,
              personId: personA2Id,
              now: NOW,
              actorUserId,
            }),
          ).rejects.toMatchObject({ message: "person_not_found" });

          // Person in another organisation
          await expect(
            addMember(tx, kms, KEY_ARN, {
              groupId: groupAId,
              personId: personBId,
              now: NOW,
              actorUserId,
            }),
          ).rejects.toMatchObject({ message: "person_not_found" });

          // Non-existent person UUID
          await expect(
            addMember(tx, kms, KEY_ARN, {
              groupId: groupAId,
              personId: newId(),
              now: NOW,
              actorUserId,
            }),
          ).rejects.toMatchObject({ message: "person_not_found" });
        });
      });
    } finally {
      await cleanScope(directSql, scopeA);
      await cleanScope(directSql, scopeA2);
      await cleanScope(directSql, scopeB);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects member changes on an archived group (pin 18)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();
    const scope = await createTestScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        let groupId = "";
        let person1Id = "";
        let person2Id = "";

        await withAppTransaction(app, scope, async (tx) => {
          const g = await createGroup(tx, {
            name: "Archived Group",
            kind: "group",
            now: NOW,
            actorUserId,
          });
          groupId = g.id;

          const p1 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Member",
            familyName: "One",
            email: null,
            phone: null,
            actorUserId,
          });
          person1Id = p1.personId;

          const p2 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Member",
            familyName: "Two",
            email: null,
            phone: null,
            actorUserId,
          });
          person2Id = p2.personId;

          // Add p1 before archiving
          await addMember(tx, kms, KEY_ARN, {
            groupId,
            personId: person1Id,
            now: NOW,
            actorUserId,
          });

          // Archive the group
          await archiveGroup(tx, groupId, { now: NOW, actorUserId });
        });

        await withAppTransaction(app, scope, async (tx) => {
          // Attempt addMember on archived group
          await expect(
            addMember(tx, kms, KEY_ARN, {
              groupId,
              personId: person2Id,
              now: NOW,
              actorUserId,
            }),
          ).rejects.toMatchObject({ message: "group_archived" });

          // Attempt removeMember on archived group
          await expect(
            removeMember(tx, {
              groupId,
              personId: person1Id,
              now: NOW,
              actorUserId,
            }),
          ).rejects.toMatchObject({ message: "group_archived" });

          // Attempt setMemberRole on archived group
          await expect(
            setMemberRole(tx, {
              groupId,
              personId: person1Id,
              role: "leader",
              now: NOW,
              actorUserId,
            }),
          ).rejects.toMatchObject({ message: "group_archived" });
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("groupLeaderFact is true only for a leader of that group (pin 19)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();
    const scope = await createTestScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        let group1Id = "";
        let group2Id = "";
        let leader1Id = "";
        let member1Id = "";
        let leader2Id = "";

        await withAppTransaction(app, scope, async (tx) => {
          const g1 = await createGroup(tx, {
            name: "Ministry Alpha",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });
          group1Id = g1.id;

          const g2 = await createGroup(tx, {
            name: "Ministry Beta",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });
          group2Id = g2.id;

          const pLeader1 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Lead",
            familyName: "Alpha",
            email: null,
            phone: null,
            actorUserId,
          });
          leader1Id = pLeader1.personId;

          const pMember1 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Member",
            familyName: "Alpha",
            email: null,
            phone: null,
            actorUserId,
          });
          member1Id = pMember1.personId;

          const pLeader2 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Lead",
            familyName: "Beta",
            email: null,
            phone: null,
            actorUserId,
          });
          leader2Id = pLeader2.personId;

          await addMember(tx, kms, KEY_ARN, {
            groupId: group1Id,
            personId: leader1Id,
            role: "leader",
            now: NOW,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group1Id,
            personId: member1Id,
            role: "member",
            now: NOW,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group2Id,
            personId: leader2Id,
            role: "leader",
            now: NOW,
            actorUserId,
          });

          // Leader of group 1 returns true
          expect(await groupLeaderFact(tx, group1Id, leader1Id)).toBe(true);

          // Member of group 1 returns false
          expect(await groupLeaderFact(tx, group1Id, member1Id)).toBe(false);

          // Leader of group 2 checked against group 1 returns false
          expect(await groupLeaderFact(tx, group1Id, leader2Id)).toBe(false);

          // Unknown person returns false
          expect(await groupLeaderFact(tx, group1Id, newId())).toBe(false);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects adding an existing member with already_member", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();
    const scope = await createTestScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Youth Group",
            kind: "group",
            now: NOW,
            actorUserId,
          });
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Sam",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: person.personId,
            now: NOW,
            actorUserId,
          });

          await expect(
            addMember(tx, kms, KEY_ARN, {
              groupId: group.id,
              personId: person.personId,
              now: NOW,
              actorUserId,
            }),
          ).rejects.toMatchObject({ message: "already_member" });
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("returns false when removing a non-member and writes no audit event", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createTestScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Altar Guild",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });

          const auditCountBefore = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events where action = 'groups.member.removed'
          `;

          const removed = await removeMember(tx, {
            groupId: group.id,
            personId: newId(),
            now: NOW,
            actorUserId,
          });
          expect(removed).toBe(false);

          const auditCountAfter = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events where action = 'groups.member.removed'
          `;
          expect(auditCountAfter[0]?.count).toBe(auditCountBefore[0]?.count);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("allows a minor to be added and listMembers returns isMinor: true with no name keys", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();
    const scope = await createTestScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Sunday School",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });

          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Smith Family",
            actorUserId,
          });

          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: hh.householdId,
            dateOfBirth: null,
            givenName: "Little",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId,
          });

          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: hh.householdId,
            dateOfBirth: null,
            givenName: "Big",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: minor.personId,
            role: "member",
            now: NOW,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: adult.personId,
            role: "leader",
            now: new Date(NOW.getTime() + 1000),
            actorUserId,
          });

          const members = await listMembers(tx, kms, KEY_ARN, {
            groupId: group.id,
            actorUserId,
          });

          expect(members).toHaveLength(2);

          // Assert strict shape of result objects: no name keys!
          for (const m of members) {
            const keys = Object.keys(m).sort();
            expect(keys).toEqual(["addedAt", "isMinor", "personId", "role"]);
            expect(m).not.toHaveProperty("givenName");
            expect(m).not.toHaveProperty("familyName");
          }

          const minorEntry = members.find((m) => m.personId === minor.personId);
          expect(minorEntry).toBeDefined();
          expect(minorEntry?.isMinor).toBe(true);
          expect(minorEntry?.role).toBe("member");

          const adultEntry = members.find((m) => m.personId === adult.personId);
          expect(adultEntry).toBeDefined();
          expect(adultEntry?.isMinor).toBe(false);
          expect(adultEntry?.role).toBe("leader");

          // No people.person.read audit event was created
          const peopleAuditRows = await tx<{ count: string }[]>`
            select count(*)::text as count
            from app.audit_events
            where action = 'people.person.read'
              and org_id = ${scope.orgId}::uuid
          `;
          expect(Number(peopleAuditRows[0]?.count ?? "0")).toBe(0);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("supports groups with zero leaders", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();
    const scope = await createTestScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Discussion Circle",
            kind: "group",
            now: NOW,
            actorUserId,
          });

          const p1 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Peer",
            familyName: "One",
            email: null,
            phone: null,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: p1.personId,
            role: "member",
            now: NOW,
            actorUserId,
          });

          const members = await listMembers(tx, kms, KEY_ARN, {
            groupId: group.id,
            actorUserId,
          });

          expect(members).toHaveLength(1);
          expect(members[0]?.role).toBe("member");
          expect(await groupLeaderFact(tx, group.id, p1.personId)).toBe(false);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("updates member role with setMemberRole and writes audit event", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();
    const scope = await createTestScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Tech Team",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });

          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Bob",
            familyName: "Builder",
            email: null,
            phone: null,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: person.personId,
            role: "member",
            now: NOW,
            actorUserId,
          });

          // Change role to leader
          await setMemberRole(tx, {
            groupId: group.id,
            personId: person.personId,
            role: "leader",
            now: NOW,
            actorUserId,
          });

          expect(await groupLeaderFact(tx, group.id, person.personId)).toBe(true);

          const auditRows = await tx<{ action: string; target_ids: string[]; actor_id: string }[]>`
            select action, target_ids::text[] as target_ids, actor_id::text as actor_id
            from app.audit_events
            where action = 'groups.member.role_changed'
              and org_id = ${scope.orgId}::uuid
          `;
          expect(auditRows).toHaveLength(1);
          expect(auditRows[0]?.target_ids).toEqual([group.id, person.personId]);

          // Same role is a no-op with no audit
          await setMemberRole(tx, {
            groupId: group.id,
            personId: person.personId,
            role: "leader",
            now: NOW,
            actorUserId,
          });

          const auditRowsAfter = await tx<{ count: string }[]>`
            select count(*)::text as count
            from app.audit_events
            where action = 'groups.member.role_changed'
              and org_id = ${scope.orgId}::uuid
          `;
          expect(auditRowsAfter[0]?.count).toBe("1");

          // Non-member throws person_not_found
          await expect(
            setMemberRole(tx, {
              groupId: group.id,
              personId: newId(),
              role: "member",
              now: NOW,
              actorUserId,
            }),
          ).rejects.toMatchObject({ message: "person_not_found" });
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("writes audit events with target IDs only and no fixture names", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();
    const scope = await createTestScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Audit Group",
            kind: "group",
            now: NOW,
            actorUserId,
          });

          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "SecretGiven",
            familyName: "SecretFamily",
            email: null,
            phone: null,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: person.personId,
            role: "member",
            now: NOW,
            actorUserId,
          });

          const addedAudit = await tx<{ target_ids: string[]; payload: unknown }[]>`
            select target_ids::text[] as target_ids, null as payload
            from app.audit_events
            where action = 'groups.member.added'
              and org_id = ${scope.orgId}::uuid
          `;
          expect(addedAudit).toHaveLength(1);
          expect(addedAudit[0]?.target_ids).toEqual([group.id, person.personId]);

          // No fixture names appear anywhere in audit rows
          const allAuditRows = await tx<{ text_repr: string }[]>`
            select (action || ' ' || target_ids::text || ' ' || actor_id::text) as text_repr
            from app.audit_events
            where org_id = ${scope.orgId}::uuid
          `;
          for (const row of allAuditRows) {
            expect(row.text_repr).not.toContain("SecretGiven");
            expect(row.text_repr).not.toContain("SecretFamily");
          }
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("validates input UUIDs and throws invalid_input", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();
    const scope = await createTestScope(platform);

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          // Non-UUID groupId
          await expect(
            addMember(tx, kms, KEY_ARN, {
              groupId: "bad-uuid",
              personId: newId(),
              now: NOW,
              actorUserId: newId(),
            }),
          ).rejects.toMatchObject({ message: "invalid_input" });

          // Non-UUID personId
          await expect(
            addMember(tx, kms, KEY_ARN, {
              groupId: newId(),
              personId: "bad-uuid",
              now: NOW,
              actorUserId: newId(),
            }),
          ).rejects.toMatchObject({ message: "invalid_input" });

          // Non-UUID actorUserId
          await expect(
            addMember(tx, kms, KEY_ARN, {
              groupId: newId(),
              personId: newId(),
              now: NOW,
              actorUserId: "bad-actor",
            }),
          ).rejects.toMatchObject({ message: "invalid_input" });

          // Invalid role
          await expect(
            addMember(tx, kms, KEY_ARN, {
              groupId: newId(),
              personId: newId(),
              role: "invalid-role" as never,
              now: NOW,
              actorUserId: newId(),
            }),
          ).rejects.toMatchObject({ message: "invalid_input" });

          // removeMember bad UUIDs
          await expect(
            removeMember(tx, {
              groupId: "bad",
              personId: newId(),
              now: NOW,
              actorUserId: newId(),
            }),
          ).rejects.toMatchObject({ message: "invalid_input" });

          // setMemberRole bad UUIDs
          await expect(
            setMemberRole(tx, {
              groupId: "bad",
              personId: newId(),
              role: "leader",
              now: NOW,
              actorUserId: newId(),
            }),
          ).rejects.toMatchObject({ message: "invalid_input" });

          // listMembers bad UUID
          await expect(
            listMembers(tx, kms, KEY_ARN, {
              groupId: "bad",
              actorUserId: newId(),
            }),
          ).rejects.toMatchObject({ message: "invalid_input" });

          // groupLeaderFact bad UUID returns false
          expect(await groupLeaderFact(tx, "bad", newId())).toBe(false);
          expect(await groupLeaderFact(tx, newId(), "bad")).toBe(false);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
