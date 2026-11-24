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
  createHousehold,
  createPerson,
  hidePerson,
  lockPersonForDelete,
} from "@community-hub/people";

import { AccessError, bootstrapOwner, grantRole, readPersonForActor } from "../public/index.js";
import { writeUserLink } from "./grants.js";
import { acceptInvitation, createInvitation } from "./invitations.js";
import { addMember, MemoryInvitationAddresses } from "./testing.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

type Scope = { orgId: string; communityId: string };

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-10-11T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

describe("hidden contact, access side", () => {
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

  async function setupParish(slugPrefix: string): Promise<{ scope: Scope; owner: string }> {
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
    const scope = { orgId, communityId };
    const owner = newId();
    await inScope(scope, (tx) =>
      bootstrapOwner(tx, { now: NOW, userId: owner, actorUserId: owner }),
    );
    return { scope, owner };
  }

  function inScope<T>(scope: Scope, fn: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, fn));
  }

  async function addAdultPerson(scope: Scope, givenName: string): Promise<string> {
    counter += 1;
    const n = counter;
    return inScope(scope, async (tx) => {
      const household = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const created = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: household.householdId,
        dateOfBirth: null,
        givenName,
        familyName: "Hiddencontact",
        email: `hidden-contact.${n}@example.test`,
        phone: null,
        actorUserId: null,
      });
      return created.personId;
    });
  }

  async function hide(scope: Scope, personId: string, version = 1): Promise<void> {
    await inScope(scope, async (tx) => {
      await lockPersonForDelete(tx, { personId, version });
      await hidePerson(tx, { personId, actorUserId: newId() });
    });
  }

  async function count(scope: Scope, table: "invitations" | "user_links", personId: string) {
    const rows = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ count: number }[]>`
        select count(*)::int as count
        from ${tx(`app.${table}`)}
        where person_id = ${personId}::uuid
      `;
    });
    return rows[0]?.count ?? 0;
  }

  // One transaction deletes (lock and hide) and holds; a second runs `second`. The second is
  // proven blocked through pg_locks (granted = false for its backend pid). Then the delete
  // commits and the second's outcome is returned. The wait never exceeds 10 s.
  async function raceAgainstDelete<T>(
    scope: Scope,
    personId: string,
    second: (tx: AppTransaction) => Promise<T>,
  ): Promise<{ blocked: boolean; outcome: Outcome<T> }> {
    const app1 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const app2 = createPlaintextAppSql(roleUrl(runtime, "app"));
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
        withAppTransaction(app1, scope, async (tx) => {
          await lockPersonForDelete(tx, { personId, version: 1 });
          await hidePerson(tx, { personId, actorUserId: newId() });
          ready();
          await hold;
        }),
      );
      // Rejects if the delete transaction fails before it holds the contact.
      await Promise.race([readyPromise, tx1]);

      const tx2: Promise<Outcome<T>> = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app2, scope, async (tx) => {
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
          const rows = await migrator<{ count: number }[]>`
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

  it("an invitation cannot be created for a hidden contact", async () => {
    const { scope, owner } = await setupParish("hc58");
    const visible = await addAdultPerson(scope, "Vera");
    const hidden = await addAdultPerson(scope, "Hugo");
    await hide(scope, hidden);
    const stub = new MemoryInvitationAddresses();

    await expect(
      inScope(scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: newId(),
          actorUserId: owner,
          address: "hidden-invite@example.test",
          personId: hidden,
          now: NOW,
        }),
      ),
    ).rejects.toMatchObject({ code: "person_not_found" });
    expect(await count(scope, "invitations", hidden)).toBe(0);

    await expect(
      inScope(scope, (tx) =>
        createInvitation(tx, stub, {
          invitationId: newId(),
          actorUserId: owner,
          address: "visible-invite@example.test",
          personId: visible,
          now: NOW,
        }),
      ),
    ).resolves.toMatchObject({ token: expect.stringMatching(/^v1\./) });
    expect(await count(scope, "invitations", visible)).toBe(1);
  });

  it("createInvitation waits for a delete that holds the contact", async () => {
    const { scope, owner } = await setupParish("hc59");
    const contact = await addAdultPerson(scope, "Hugo");
    const stub = new MemoryInvitationAddresses();

    const { blocked, outcome } = await raceAgainstDelete(scope, contact, (tx) =>
      createInvitation(tx, stub, {
        invitationId: newId(),
        actorUserId: owner,
        address: "race-invite@example.test",
        personId: contact,
        now: NOW,
      }),
    );

    expect(blocked).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatchObject({ code: "person_not_found" });
    expect(await count(scope, "invitations", contact)).toBe(0);
  }, 20_000);

  it("writeUserLink waits for a delete that holds the contact", async () => {
    const { scope, owner } = await setupParish("hc60");
    const contact = await addAdultPerson(scope, "Hugo");
    const memberUser = newId();
    await inScope(scope, (tx) => addMember(tx, memberUser));

    const { blocked, outcome } = await raceAgainstDelete(scope, contact, (tx) =>
      writeUserLink(tx, { userId: memberUser, personId: contact, actorUserId: owner }),
    );

    expect(blocked).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatchObject({ code: "not_found" });
    expect(await count(scope, "user_links", contact)).toBe(0);
  }, 20_000);

  it("writeUserLink answers not found for a hidden contact", async () => {
    const { scope, owner } = await setupParish("hc58b");
    const visible = await addAdultPerson(scope, "Vera");
    const hidden = await addAdultPerson(scope, "Hugo");
    await hide(scope, hidden);
    const memberUser = newId();
    await inScope(scope, (tx) => addMember(tx, memberUser));

    await expect(
      inScope(scope, (tx) =>
        writeUserLink(tx, { userId: memberUser, personId: hidden, actorUserId: owner }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await count(scope, "user_links", hidden)).toBe(0);

    await expect(
      inScope(scope, (tx) =>
        writeUserLink(tx, { userId: memberUser, personId: visible, actorUserId: owner }),
      ),
    ).resolves.toMatchObject({ skipped: false });
  });

  it("a role grant to a user linked to a hidden contact answers not found", async () => {
    const { scope, owner } = await setupParish("hc58c");
    const contact = await addAdultPerson(scope, "Hugo");
    const memberUser = newId();
    await inScope(scope, async (tx) => {
      await addMember(tx, memberUser);
      await writeUserLink(tx, { userId: memberUser, personId: contact, actorUserId: owner });
    });
    await hide(scope, contact);

    await expect(
      inScope(scope, (tx) =>
        grantRole(tx, {
          now: NOW,
          userId: memberUser,
          roleKey: "member",
          customRoleId: null,
          actorUserId: owner,
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("accepting an invitation for a contact hidden since it was sent gives invitation_void", async () => {
    const { scope, owner } = await setupParish("hc58d");
    const contact = await addAdultPerson(scope, "Hugo");
    const stub = new MemoryInvitationAddresses();
    const address = "accept-hidden@example.test";
    const sentAt = new Date();
    const created = await inScope(scope, (tx) =>
      createInvitation(tx, stub, {
        invitationId: newId(),
        actorUserId: owner,
        address,
        personId: contact,
        roleKey: "member",
        now: sentAt,
      }),
    );
    await hide(scope, contact);

    const acceptingUser = newId();
    stub.userAddresses.set(acceptingUser, address);
    let error: unknown = null;
    await inScope(scope, async (tx) => {
      try {
        await acceptInvitation(tx, stub, {
          token: created.token,
          userId: acceptingUser,
          now: sentAt,
        });
      } catch (caught) {
        error = caught;
      }
    });

    expect(error).toBeInstanceOf(AccessError);
    expect(error).toMatchObject({ code: "invitation_void" });
    expect(await count(scope, "user_links", contact)).toBe(0);
  });

  it("readPersonForActor throws forbidden and audits the denial for a hidden contact", async () => {
    const { scope, owner } = await setupParish("hc61");
    const visible = await addAdultPerson(scope, "Vera");
    const hidden = await addAdultPerson(scope, "Hugo");
    await hide(scope, hidden);
    const unknown = newId();

    await inScope(scope, async (tx) => {
      const seen = await readPersonForActor(tx, kms, KEY_ARN, {
        personId: visible,
        actorUserId: owner,
      });
      expect(seen).toMatchObject({ personId: visible });

      await expect(
        readPersonForActor(tx, kms, KEY_ARN, { personId: hidden, actorUserId: owner }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        readPersonForActor(tx, kms, KEY_ARN, { personId: unknown, actorUserId: owner }),
      ).rejects.toMatchObject({ code: "forbidden" });

      const denied = await tx<
        {
          action: string;
          purpose: string;
          actor_kind: string;
          actor_id: string | null;
          target_ids: string[];
        }[]
      >`
        select action, purpose, actor_kind, actor_id::text as actor_id,
               target_ids::text[] as target_ids
        from app.audit_events
        where action = 'access.permission.denied'
        order by id asc
      `;
      expect(denied).toEqual([
        {
          action: "access.permission.denied",
          purpose: "people.restricted.read",
          actor_kind: "user",
          actor_id: owner,
          target_ids: [hidden],
        },
        {
          action: "access.permission.denied",
          purpose: "people.restricted.read",
          actor_kind: "user",
          actor_id: owner,
          target_ids: [unknown],
        },
      ]);

      // The hidden contact was never read: the only people read is the visible one.
      const reads = await tx<{ target_ids: string[] }[]>`
        select target_ids::text[] as target_ids
        from app.audit_events
        where action = 'people.person.read'
      `;
      expect(reads).toEqual([{ target_ids: [visible] }]);
    });
  });
});
