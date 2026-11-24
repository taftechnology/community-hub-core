import { beforeAll, describe, expect, it } from "vitest";

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
import { createPerson, hidePerson, lockPersonForDelete } from "@community-hub/people";

import {
  activeGroupsForPersons,
  addMember,
  createGroup,
  exportRosterCsv,
  listMembers,
  personIdsInGroup,
  removeMember,
  setMemberRole,
} from "../public/index.js";
import { cleanScope, createScope, loadRuntime, roleUrl } from "../test/fixtures/real-scope.js";

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-11-22T00:00:00+11:00");

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
      const secret = store.get(Buffer.from(blob).toString("hex"));
      if (!secret) {
        throw new Error("key not found in test kms");
      }
      return new Uint8Array(secret);
    },
  };
}

type Scope = { orgId: string; communityId: string };
type MemberRow = { person_id: string; role: string };

interface Fixture {
  scope: Scope;
  actorUserId: string;
  groupId: string;
  // A visible member of the group and a member who is hidden after joining.
  visibleId: string;
  hiddenMemberId: string;
  // Contacts outside the group: one visible, one hidden.
  visibleOutsiderId: string;
  hiddenOutsiderId: string;
  kms: KmsPort;
  app: ReturnType<typeof createPlaintextAppSql>;
}

async function memberRows(tx: AppTransaction, groupId: string): Promise<MemberRow[]> {
  return await tx<MemberRow[]>`
    select person_id::text as person_id, role
    from app.group_members
    where group_id = ${groupId}::uuid
    order by person_id
  `;
}

async function auditCount(tx: AppTransaction, action: string): Promise<number> {
  const rows = await tx<{ count: number }[]>`
    select count(*)::int as count from app.audit_events where action = ${action}
  `;
  return rows[0]?.count ?? 0;
}

describe("hidden contacts in group members", () => {
  beforeAll(async () => {
    const runtime = loadRuntime();
    const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }
  });

  // Every fixture holds a group with one visible and one hidden member, plus a visible and a
  // hidden contact outside the group, so each test can prove the visible side still works.
  async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        const ids = { groupId: "", visible: "", hiddenMember: "", visibleOutsider: "", hidden: "" };

        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Hidden Fixture Choir",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });
          ids.groupId = group.id;

          const create = async (givenName: string, familyName: string): Promise<string> => {
            const created = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName,
              familyName,
              email: null,
              phone: null,
              actorUserId,
            });
            return created.personId;
          };

          ids.visible = await create("Vera", "Visible");
          ids.hiddenMember = await create("Hugo", "Hidden");
          ids.visibleOutsider = await create("Olive", "Outsider");
          ids.hidden = await create("Hilda", "Hiddenoutsider");

          await addMember(tx, kms, KEY_ARN, {
            groupId: ids.groupId,
            personId: ids.visible,
            now: NOW,
            actorUserId,
          });
          await addMember(tx, kms, KEY_ARN, {
            groupId: ids.groupId,
            personId: ids.hiddenMember,
            now: NOW,
            actorUserId,
          });
        });

        for (const personId of [ids.hiddenMember, ids.hidden]) {
          await withAppTransaction(app, scope, async (tx) => {
            await lockPersonForDelete(tx, { personId, version: 1 });
            await hidePerson(tx, { personId, actorUserId });
          });
        }

        await fn({
          scope,
          actorUserId,
          groupId: ids.groupId,
          visibleId: ids.visible,
          hiddenMemberId: ids.hiddenMember,
          visibleOutsiderId: ids.visibleOutsider,
          hiddenOutsiderId: ids.hidden,
          kms,
          app,
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  }

  type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

  type RaceFixture = {
    scope: Scope;
    actorUserId: string;
    groupId: string;
    contactId: string;
    runtime: ReturnType<typeof loadRuntime>;
    app: ReturnType<typeof createPlaintextAppSql>;
    direct: ReturnType<typeof createPlaintextDirectSql>;
  };

  // A group with one visible contact who is a member, and nothing hidden yet: the race tests
  // hide that contact in a transaction they hold open.
  async function withRaceFixture(fn: (f: RaceFixture) => Promise<void>): Promise<void> {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createTestKms();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        const ids = { groupId: "", contactId: "" };
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Race Fixture Choir",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });
          ids.groupId = group.id;
          const created = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Hugo",
            familyName: "Racer",
            email: null,
            phone: null,
            actorUserId,
          });
          ids.contactId = created.personId;
          await addMember(tx, kms, KEY_ARN, {
            groupId: ids.groupId,
            personId: ids.contactId,
            now: NOW,
            actorUserId,
          });
        });
        await fn({ scope, actorUserId, runtime, app, direct, ...ids });
      });
    } finally {
      await cleanScope(direct, scope);
      await direct.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  }

  // One transaction deletes (lock and hide) and holds; a second runs `second`. The second is
  // proven blocked through pg_locks (granted = false for its backend pid, running a statement on
  // app.persons). Then the delete commits and the second's outcome is returned. The wait never
  // exceeds 10 s.
  async function raceAgainstDelete<T>(
    f: RaceFixture,
    second: (tx: AppTransaction) => Promise<T>,
  ): Promise<{ blocked: boolean; outcome: Outcome<T> }> {
    const personId = f.contactId;
    const app1 = createPlaintextAppSql(roleUrl(f.runtime, "app"));
    const app2 = createPlaintextAppSql(roleUrl(f.runtime, "app"));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const state: { pid: number | null; settled: boolean } = { pid: null, settled: false };
    try {
      const tx1 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app1, f.scope, async (tx) => {
          await lockPersonForDelete(tx, { personId, version: 1 });
          await hidePerson(tx, { personId, actorUserId: newId() });
          ready();
          await hold;
        }),
      );
      // Rejects if the delete transaction fails before it holds the contact.
      await Promise.race([readyPromise, tx1]);

      const tx2: Promise<Outcome<T>> = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app2, f.scope, async (tx) => {
          const rows = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          state.pid = rows[0]?.pid ?? null;
          return await second(tx);
        }),
      )
        .then((value): Outcome<T> => ({ ok: true, value }))
        .catch((error: unknown): Outcome<T> => ({ ok: false, error }))
        .finally(() => {
          state.settled = true;
        });

      let blocked = false;
      const started = Date.now();
      while (Date.now() - started < 10_000 && !state.settled) {
        if (state.pid !== null) {
          // Blocked on a lock while running a statement on app.persons: the contact's row lock,
          // not the audit chain or another wait.
          const rows = await f.direct<{ count: number }[]>`
            select count(*)::int as count
            from pg_locks l
            join pg_stat_activity a on a.pid = l.pid
            where l.pid = ${state.pid}
              and l.granted = false
              and a.query like '%app.persons%'
          `;
          if ((rows[0]?.count ?? 0) > 0) {
            blocked = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      release();
      await tx1;
      return { blocked, outcome: await tx2 };
    } finally {
      release();
      await app1.end({ timeout: 1 });
      await app2.end({ timeout: 1 });
    }
  }

  it("removeMember waits for a delete that holds the contact", async () => {
    await withRaceFixture(async (f) => {
      const before = await withAppTransaction(f.app, f.scope, (tx) => memberRows(tx, f.groupId));
      expect(before).toEqual([{ person_id: f.contactId, role: "member" }]);

      const { blocked, outcome } = await raceAgainstDelete(f, (tx) =>
        removeMember(tx, {
          groupId: f.groupId,
          personId: f.contactId,
          now: NOW,
          actorUserId: f.actorUserId,
        }),
      );

      expect(blocked).toBe(true);
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error).toMatchObject({ code: "person_not_found" });
      const after = await withAppTransaction(f.app, f.scope, async (tx) => ({
        rows: await memberRows(tx, f.groupId),
        removed: await auditCount(tx, "groups.member.removed"),
      }));
      expect(after.rows).toEqual(before);
      expect(after.removed).toBe(0);
    });
  }, 20_000);

  it("setMemberRole waits for a delete that holds the contact", async () => {
    await withRaceFixture(async (f) => {
      const before = await withAppTransaction(f.app, f.scope, (tx) => memberRows(tx, f.groupId));
      expect(before).toEqual([{ person_id: f.contactId, role: "member" }]);

      const { blocked, outcome } = await raceAgainstDelete(f, (tx) =>
        setMemberRole(tx, {
          groupId: f.groupId,
          personId: f.contactId,
          role: "leader",
          now: NOW,
          actorUserId: f.actorUserId,
        }),
      );

      expect(blocked).toBe(true);
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error).toMatchObject({ code: "person_not_found" });
      const after = await withAppTransaction(f.app, f.scope, async (tx) => ({
        rows: await memberRows(tx, f.groupId),
        changed: await auditCount(tx, "groups.member.role_changed"),
      }));
      expect(after.rows).toEqual(before);
      expect(after.changed).toBe(0);
    });
  }, 20_000);

  it("listMembers leaves out a hidden member", async () => {
    await withFixture(async (f) => {
      await withAppTransaction(f.app, f.scope, async (tx) => {
        const members = await listMembers(tx, f.kms, KEY_ARN, {
          groupId: f.groupId,
          actorUserId: f.actorUserId,
        });
        expect(members.map((m) => m.personId)).toEqual([f.visibleId]);
        expect(members[0]?.isMinor).toBe(false);
      });
    });
  });

  it("personIdsInGroup leaves out a hidden contact", async () => {
    await withFixture(async (f) => {
      await withAppTransaction(f.app, f.scope, async (tx) => {
        await expect(personIdsInGroup(tx, f.groupId)).resolves.toEqual([f.visibleId]);
      });
    });
  });

  it("activeGroupsForPersons leaves out a hidden contact", async () => {
    await withFixture(async (f) => {
      await withAppTransaction(f.app, f.scope, async (tx) => {
        const groups = await activeGroupsForPersons(tx, [
          f.visibleId,
          f.hiddenMemberId,
          f.hiddenOutsiderId,
        ]);
        expect([...groups.keys()]).toEqual([f.visibleId]);
        expect(groups.get(f.visibleId)).toEqual([{ id: f.groupId, name: "Hidden Fixture Choir" }]);
      });
    });
  });

  it("the roster export leaves out a hidden member", async () => {
    await withFixture(async (f) => {
      await withAppTransaction(f.app, f.scope, async (tx) => {
        const csv = await exportRosterCsv(tx, f.kms, KEY_ARN, {
          groupId: f.groupId,
          includeRestricted: false,
          actorUserId: f.actorUserId,
        });
        const lines = csv.trim().split(/\r?\n/);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe('"given_name","family_name","role"');
        expect(lines[1]).toBe('"Vera","Visible","member"');
        expect(csv).not.toContain("Hugo");
        expect(csv).not.toContain("Hidden");
      });
    });
  });

  it("addMember answers not found for a hidden contact", async () => {
    await withFixture(async (f) => {
      await withAppTransaction(f.app, f.scope, async (tx) => {
        const before = await memberRows(tx, f.groupId);
        const auditBefore = await auditCount(tx, "groups.member.added");

        await expect(
          addMember(tx, f.kms, KEY_ARN, {
            groupId: f.groupId,
            personId: f.hiddenOutsiderId,
            now: NOW,
            actorUserId: f.actorUserId,
          }),
        ).rejects.toMatchObject({ code: "person_not_found" });

        expect(await memberRows(tx, f.groupId)).toEqual(before);
        expect(await auditCount(tx, "groups.member.added")).toBe(auditBefore);

        const added = await addMember(tx, f.kms, KEY_ARN, {
          groupId: f.groupId,
          personId: f.visibleOutsiderId,
          now: NOW,
          actorUserId: f.actorUserId,
        });
        expect(added.personId).toBe(f.visibleOutsiderId);
        expect(added.isMinor).toBe(false);
      });
    });
  });

  it("removeMember answers not found for a hidden contact", async () => {
    await withFixture(async (f) => {
      await withAppTransaction(f.app, f.scope, async (tx) => {
        const before = await memberRows(tx, f.groupId);
        const auditBefore = await auditCount(tx, "groups.member.removed");

        await expect(
          removeMember(tx, {
            groupId: f.groupId,
            personId: f.hiddenMemberId,
            now: NOW,
            actorUserId: f.actorUserId,
          }),
        ).rejects.toMatchObject({ code: "person_not_found" });

        expect(await memberRows(tx, f.groupId)).toEqual(before);
        expect(await auditCount(tx, "groups.member.removed")).toBe(auditBefore);

        await expect(
          removeMember(tx, {
            groupId: f.groupId,
            personId: f.visibleId,
            now: NOW,
            actorUserId: f.actorUserId,
          }),
        ).resolves.toBe(true);
      });
    });
  });

  it("setMemberRole answers not found for a hidden contact", async () => {
    await withFixture(async (f) => {
      await withAppTransaction(f.app, f.scope, async (tx) => {
        const before = await memberRows(tx, f.groupId);
        const auditBefore = await auditCount(tx, "groups.member.role_changed");

        await expect(
          setMemberRole(tx, {
            groupId: f.groupId,
            personId: f.hiddenMemberId,
            role: "leader",
            now: NOW,
            actorUserId: f.actorUserId,
          }),
        ).rejects.toMatchObject({ code: "person_not_found" });

        expect(await memberRows(tx, f.groupId)).toEqual(before);
        expect(await auditCount(tx, "groups.member.role_changed")).toBe(auditBefore);

        await setMemberRole(tx, {
          groupId: f.groupId,
          personId: f.visibleId,
          role: "leader",
          now: NOW,
          actorUserId: f.actorUserId,
        });
        const after = await memberRows(tx, f.groupId);
        expect(after.find((m) => m.person_id === f.visibleId)?.role).toBe("leader");
        expect(after.find((m) => m.person_id === f.hiddenMemberId)?.role).toBe("member");
      });
    });
  });
});
