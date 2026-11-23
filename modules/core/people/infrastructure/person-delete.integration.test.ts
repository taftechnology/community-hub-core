import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { hidePerson, lockPersonForDelete, personIsMinor, restorePerson } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const FAKE_ENCRYPTED = Buffer.from("0123456789abcdef0123456789abcdef");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

describe("person-delete", () => {
  let runtime: Runtime;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let migrator: ReturnType<typeof createPlaintextDirectSql>;

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

  async function setupTenant(slugPrefix = "del") {
    const organisationId = newId();
    const communityId = newId();
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${organisationId}, ${`${slugPrefix}-${organisationId}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${organisationId}, ${`${slugPrefix}-${communityId}`}, 'au')
      `;
    });
    return { orgId: organisationId, communityId };
  }

  async function insertAdult(
    scope: { orgId: string; communityId: string },
    givenName = "Adult",
    familyName = "Test",
  ): Promise<string> {
    const id = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.persons (id, org_id, community_id, version, is_minor, age_basis, given_name, family_name)
        values (${id}, ${scope.orgId}, ${scope.communityId}, 1, false, 'declared_adult', ${givenName}, ${familyName})
      `;
    });
    return id;
  }

  async function insertMinor(scope: {
    orgId: string;
    communityId: string;
  }): Promise<{ minorId: string; householdId: string }> {
    const minorId = newId();
    const householdId = newId();
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.households (id, org_id, community_id)
        values (${householdId}, ${scope.orgId}, ${scope.communityId})
      `;
      await tx`
        insert into app.persons (id, org_id, community_id, household_id, version, is_minor, age_basis, given_name_restricted, family_name_restricted)
        values (${minorId}, ${scope.orgId}, ${scope.communityId}, ${householdId}, 1, true, 'unknown', ${FAKE_ENCRYPTED}, ${FAKE_ENCRYPTED})
      `;
    });
    return { minorId, householdId };
  }

  async function getPerson(
    scope: { orgId: string; communityId: string },
    personId: string,
  ): Promise<
    | {
        id: string;
        version: number;
        is_minor: boolean;
        deleted_at: Date | null;
        deleted_by: string | null;
      }
    | undefined
  > {
    const rows = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<
        {
          id: string;
          version: number;
          is_minor: boolean;
          deleted_at: Date | null;
          deleted_by: string | null;
        }[]
      >`
        select id::text as id, version, is_minor, deleted_at, deleted_by::text as deleted_by
        from app.persons
        where id = ${personId}::uuid
      `;
    });
    return rows[0];
  }

  it("delete blocks a concurrent writer that holds the person for share", async () => {
    const scope = await setupTenant("pin25");
    const adult = await insertAdult(scope, "Lock", "Person");

    const app1 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const app2 = createPlaintextAppSql(roleUrl(runtime, "app"));

    try {
      let releaseTx1!: () => void;
      const tx1Hold = new Promise<void>((resolve) => {
        releaseTx1 = resolve;
      });
      let tx1Ready = false;
      let tx1Error: unknown = null;

      const p1 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app1, scope, async (tx1) => {
          await lockPersonForDelete(tx1, { personId: adult, version: 1 });
          tx1Ready = true;
          await tx1Hold;
        }),
      ).catch((err) => {
        tx1Error = err;
      });

      while (!tx1Ready && tx1Error === null) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (tx1Error !== null) {
        throw tx1Error;
      }

      let tx2Pid: number | null = null;
      let tx2Settled = false;
      let tx2Result: boolean | null = null;
      let tx2Error: unknown = null;

      const p2 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app2, scope, async (tx2) => {
          const pidRows = await tx2<{ pid: number }[]>`select pg_backend_pid() as pid`;
          tx2Pid = pidRows[0]!.pid;
          return await personIsMinor(tx2, adult, { lock: "share" });
        }),
      )
        .then((res) => {
          tx2Result = res;
          tx2Settled = true;
        })
        .catch((err) => {
          tx2Error = err;
          tx2Settled = true;
        });

      const start = Date.now();
      let blocked = false;
      while (Date.now() - start < 10000) {
        if (tx2Settled) {
          break;
        }
        if (tx2Pid !== null) {
          const lockRows = await migrator<{ count: number }[]>`
              select count(*)::int as count
              from pg_locks
              where pid = ${tx2Pid} and granted = false
            `;
          if ((lockRows[0]?.count ?? 0) > 0) {
            blocked = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(blocked).toBe(true);

      releaseTx1();
      await p1;
      await p2;

      expect(tx2Error).toBeNull();
      expect(tx2Result).toBe(false);
    } finally {
      await app1.end({ timeout: 1 });
      await app2.end({ timeout: 1 });
    }
  }, 15000);

  it("two concurrent deletes of a child's two guardians leave one guardian", async () => {
    const scope = await setupTenant("pin26");
    const { minorId, householdId } = await insertMinor(scope);
    const g1 = await insertAdult(scope, "Guardian", "One");
    const g2 = await insertAdult(scope, "Guardian", "Two");

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
          insert into app.guardian_links (
            id, org_id, community_id, household_id, guardian_person_id, child_person_id,
            consent, pickup, view, manage
          ) values
            (${newId()}, ${scope.orgId}, ${scope.communityId}, ${householdId}, ${g1}, ${minorId}, true, true, true, true),
            (${newId()}, ${scope.orgId}, ${scope.communityId}, ${householdId}, ${g2}, ${minorId}, true, true, true, true)
        `;
    });

    const app1 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const app2 = createPlaintextAppSql(roleUrl(runtime, "app"));

    try {
      let releaseTx1!: () => void;
      const tx1Hold = new Promise<void>((resolve) => {
        releaseTx1 = resolve;
      });
      let tx1Ready = false;
      let tx1Error: unknown = null;

      const p1 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app1, scope, async (tx1) => {
          await lockPersonForDelete(tx1, { personId: g1, version: 1 });
          await hidePerson(tx1, { personId: g1, actorUserId: newId() });
          tx1Ready = true;
          await tx1Hold;
        }),
      ).catch((err) => {
        tx1Error = err;
      });

      while (!tx1Ready && tx1Error === null) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (tx1Error !== null) {
        throw tx1Error;
      }

      let tx2Pid: number | null = null;
      let tx2Settled = false;
      let tx2Error: unknown = null;

      const p2 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app2, scope, async (tx2) => {
          const pidRows = await tx2<{ pid: number }[]>`select pg_backend_pid() as pid`;
          tx2Pid = pidRows[0]!.pid;
          await lockPersonForDelete(tx2, { personId: g2, version: 1 });
          await hidePerson(tx2, { personId: g2, actorUserId: newId() });
        }),
      )
        .then(() => {
          tx2Settled = true;
        })
        .catch((err) => {
          tx2Error = err;
          tx2Settled = true;
        });

      const start = Date.now();
      let blocked = false;
      while (Date.now() - start < 10000) {
        if (tx2Settled) {
          break;
        }
        if (tx2Pid !== null) {
          const lockRows = await migrator<{ count: number }[]>`
              select count(*)::int as count
              from pg_locks
              where pid = ${tx2Pid} and granted = false
            `;
          if ((lockRows[0]?.count ?? 0) > 0) {
            blocked = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(blocked).toBe(true);

      releaseTx1();
      await p1;
      await p2;

      expect(tx2Error).toMatchObject({ code: "sole_guardian" });

      const survivorG1 = await getPerson(scope, g1);
      expect(survivorG1?.deleted_at).not.toBeNull();

      const survivorG2 = await getPerson(scope, g2);
      expect(survivorG2?.deleted_at).toBeNull();
      expect(survivorG2?.version).toBe(1);
    } finally {
      await app1.end({ timeout: 1 });
      await app2.end({ timeout: 1 });
    }
  }, 15000);

  it("delete refuses the only unhidden guardian of a child", async () => {
    const scope = await setupTenant("pin27");
    const { minorId, householdId } = await insertMinor(scope);
    const g1 = await insertAdult(scope, "Guardian", "One");
    const g2 = await insertAdult(scope, "Guardian", "Two");

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.guardian_links (
          id, org_id, community_id, household_id, guardian_person_id, child_person_id,
          consent, pickup, view, manage
        ) values
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${householdId}, ${g1}, ${minorId}, true, true, true, true),
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${householdId}, ${g2}, ${minorId}, true, true, true, true)
      `;
    });

    // Hide g1 first
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await lockPersonForDelete(tx, { personId: g1, version: 1 });
        await hidePerson(tx, { personId: g1, actorUserId: newId() });
      }),
    );

    // Deleting g2 must be refused with sole_guardian
    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await lockPersonForDelete(tx, { personId: g2, version: 1 });
          await hidePerson(tx, { personId: g2, actorUserId: newId() });
        }),
      ).rejects.toMatchObject({ code: "sole_guardian" }),
    );

    const survivorG2 = await getPerson(scope, g2);
    expect(survivorG2?.deleted_at).toBeNull();
    expect(survivorG2?.version).toBe(1);
  });

  it("delete does not refuse the only guardian of an adult child", async () => {
    const scope = await setupTenant("pin27b");
    const { minorId, householdId } = await insertMinor(scope);
    const guardian = await insertAdult(scope, "Only", "Guardian");

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.guardian_links (
          id, org_id, community_id, household_id, guardian_person_id, child_person_id,
          consent, pickup, view, manage
        ) values
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${householdId}, ${guardian}, ${minorId}, true, true, true, true)
      `;
    });

    // The child turns 18: the row stays, the guardian link stays, is_minor is false.
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        update app.persons
        set is_minor = false,
            age_basis = 'declared_adult',
            given_name = 'Grown',
            family_name = 'Child',
            given_name_restricted = null,
            family_name_restricted = null
        where id = ${minorId}::uuid
      `;
    });
    const grownChild = await getPerson(scope, minorId);
    expect(grownChild?.is_minor).toBe(false);

    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await lockPersonForDelete(tx, { personId: guardian, version: 1 });
          await hidePerson(tx, { personId: guardian, actorUserId: newId() });
        }),
      ).resolves.toBeUndefined(),
    );

    const hidden = await getPerson(scope, guardian);
    expect(hidden?.deleted_at).not.toBeNull();
    expect(hidden?.version).toBe(2);
  });

  it("delete answers not found for a minor and for another organisation's contact", async () => {
    const scope = await setupTenant("pin28-org1");
    const { minorId } = await insertMinor(scope);

    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await lockPersonForDelete(tx, { personId: minorId, version: 1 });
        }),
      ).rejects.toMatchObject({ code: "not_found" }),
    );

    const minor = await getPerson(scope, minorId);
    expect(minor?.deleted_at).toBeNull();

    const scope2 = await setupTenant("pin28-org2");
    const adultOrg2 = await insertAdult(scope2, "Org2", "Adult");

    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await lockPersonForDelete(tx, { personId: adultOrg2, version: 1 });
        }),
      ).rejects.toMatchObject({ code: "not_found" }),
    );

    const survivorOrg2 = await getPerson(scope2, adultOrg2);
    expect(survivorOrg2?.deleted_at).toBeNull();
  });

  it("delete answers not found for a contact that is already hidden", async () => {
    const scope = await setupTenant("pin28b");
    const adult = await insertAdult(scope, "Already", "Hidden");

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await lockPersonForDelete(tx, { personId: adult, version: 1 });
        await hidePerson(tx, { personId: adult, actorUserId: newId() });
      }),
    );
    const hidden = await getPerson(scope, adult);
    expect(hidden?.deleted_at).not.toBeNull();
    expect(hidden?.version).toBe(2);

    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await lockPersonForDelete(tx, { personId: adult, version: 2 });
        }),
      ).rejects.toMatchObject({ code: "not_found" }),
    );

    const after = await getPerson(scope, adult);
    expect(after?.version).toBe(2);
    expect(after?.deleted_at).toEqual(hidden?.deleted_at);
    expect(after?.deleted_by).toBe(hidden?.deleted_by);
  });

  async function countAuditEvents(
    scope: { orgId: string; communityId: string },
    personId: string,
  ): Promise<number> {
    const rows = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ count: number }[]>`
        select count(*)::int as count
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and ${personId}::uuid = any(target_ids)
      `;
    });
    return rows[0]?.count ?? 0;
  }

  it("hidePerson alone answers not found for a hidden contact", async () => {
    const scope = await setupTenant("pin28d");
    const adult = await insertAdult(scope, "Twice", "Hidden");

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await lockPersonForDelete(tx, { personId: adult, version: 1 });
        await hidePerson(tx, { personId: adult, actorUserId: newId() });
      }),
    );
    const hidden = await getPerson(scope, adult);
    expect(hidden?.deleted_at).not.toBeNull();
    expect(hidden?.version).toBe(2);
    const eventsBefore = await countAuditEvents(scope, adult);

    // No lockPersonForDelete: the update itself must refuse a contact that is already hidden.
    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await hidePerson(tx, { personId: adult, actorUserId: newId() });
        }),
      ).rejects.toMatchObject({ code: "not_found" }),
    );

    const after = await getPerson(scope, adult);
    expect(after?.version).toBe(2);
    expect(after?.deleted_at).toEqual(hidden?.deleted_at);
    expect(after?.deleted_by).toBe(hidden?.deleted_by);
    expect(await countAuditEvents(scope, adult)).toBe(eventsBefore);
  });

  it("hidePerson alone answers not found for a minor", async () => {
    const scope = await setupTenant("pin28e");
    const { minorId } = await insertMinor(scope);
    const eventsBefore = await countAuditEvents(scope, minorId);

    // No lockPersonForDelete: the update itself must refuse a minor.
    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await hidePerson(tx, { personId: minorId, actorUserId: newId() });
        }),
      ).rejects.toMatchObject({ code: "not_found" }),
    );

    const after = await getPerson(scope, minorId);
    expect(after?.version).toBe(1);
    expect(after?.deleted_at).toBeNull();
    expect(after?.deleted_by).toBeNull();
    expect(await countAuditEvents(scope, minorId)).toBe(eventsBefore);
  });

  it("restore answers not found for a hidden minor", async () => {
    const scope = await setupTenant("pin28c");
    const { minorId } = await insertMinor(scope);
    const deletedBy = newId();

    // Seeded as migrator with the user triggers off: the 0022 rule refuses a minor otherwise.
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
      await tx`
        update app.persons
        set deleted_at = now() - interval '1 hour',
            deleted_by = ${deletedBy}
        where id = ${minorId}::uuid
      `;
      await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
    });
    const seeded = await getPerson(scope, minorId);
    expect(seeded?.deleted_at).not.toBeNull();

    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await restorePerson(tx, { personId: minorId, version: 1, actorUserId: newId() });
        }),
      ).rejects.toMatchObject({ code: "not_found" }),
    );

    const after = await getPerson(scope, minorId);
    expect(after?.is_minor).toBe(true);
    expect(after?.version).toBe(1);
    expect(after?.deleted_at).toEqual(seeded?.deleted_at);
    expect(after?.deleted_by).toBe(deletedBy);
  });

  it("a stale version on delete or restore answers conflict and changes nothing", async () => {
    const scope = await setupTenant("pin29");
    const adult = await insertAdult(scope, "Version", "Check");

    // Stale version on delete
    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await lockPersonForDelete(tx, { personId: adult, version: 99 });
        }),
      ).rejects.toMatchObject({ code: "conflict" }),
    );

    const untouched = await getPerson(scope, adult);
    expect(untouched?.version).toBe(1);
    expect(untouched?.deleted_at).toBeNull();

    // Hide person properly
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await lockPersonForDelete(tx, { personId: adult, version: 1 });
        await hidePerson(tx, { personId: adult, actorUserId: newId() });
      }),
    );

    const hidden = await getPerson(scope, adult);
    expect(hidden?.version).toBe(2);
    expect(hidden?.deleted_at).not.toBeNull();

    // Stale version on restore
    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await restorePerson(tx, { personId: adult, version: 1, actorUserId: newId() });
        }),
      ).rejects.toMatchObject({ code: "conflict" }),
    );

    const stillHidden = await getPerson(scope, adult);
    expect(stillHidden?.version).toBe(2);
    expect(stillHidden?.deleted_at).not.toBeNull();
  });

  it("delete and restore each write one event with the person id only", async () => {
    const scope = await setupTenant("pin30");
    const adult = await insertAdult(scope, "Audit", "Person");
    const actorId = newId();

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await lockPersonForDelete(tx, { personId: adult, version: 1 });
        await hidePerson(tx, { personId: adult, actorUserId: actorId });
      }),
    );

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await restorePerson(tx, { personId: adult, version: 2, actorUserId: actorId });
      }),
    );

    const events = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<
        {
          action: string;
          purpose: string;
          target_ids: string[];
        }[]
      >`
        select action, purpose, target_ids
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and ${adult}::uuid = any(target_ids)
        order by id asc
      `;
    });

    const deletedEvent = events.find((e) => e.action === "people.person.deleted");
    expect(deletedEvent).toBeDefined();
    expect(deletedEvent?.purpose).toBe("people.person.deleted");
    expect(deletedEvent?.target_ids).toEqual([adult]);

    const restoredEvent = events.find((e) => e.action === "people.person.restored");
    expect(restoredEvent).toBeDefined();
    expect(restoredEvent?.purpose).toBe("people.person.restored");
    expect(restoredEvent?.target_ids).toEqual([adult]);
  });

  it("hides an adult contact and computes purgeAfter 720 hours ahead", async () => {
    const scope = await setupTenant("happy-hide");
    const adult = await insertAdult(scope, "Happy", "Adult");
    const actorId = newId();

    const before = Date.now();
    let result!: { personId: string; version: number; purgeAfter: Date };

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await lockPersonForDelete(tx, { personId: adult, version: 1 });
        result = await hidePerson(tx, { personId: adult, actorUserId: actorId });
      }),
    );

    const after = Date.now();
    expect(result.personId).toBe(adult);
    expect(result.version).toBe(2);

    const expectedMin = before + 720 * 60 * 60 * 1000 - 5000;
    const expectedMax = after + 720 * 60 * 60 * 1000 + 5000;
    expect(result.purgeAfter.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(result.purgeAfter.getTime()).toBeLessThanOrEqual(expectedMax);

    const person = await getPerson(scope, adult);
    expect(person?.deleted_at).not.toBeNull();
    expect(person?.deleted_by).toBe(actorId);
    expect(person?.version).toBe(2);
  });

  it("restores a hidden adult contact", async () => {
    const scope = await setupTenant("happy-restore");
    const adult = await insertAdult(scope, "Restore", "Adult");
    const actorId = newId();

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await lockPersonForDelete(tx, { personId: adult, version: 1 });
        await hidePerson(tx, { personId: adult, actorUserId: actorId });
      }),
    );

    let result!: { personId: string; version: number };
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        result = await restorePerson(tx, { personId: adult, version: 2, actorUserId: actorId });
      }),
    );

    expect(result.personId).toBe(adult);
    expect(result.version).toBe(3);

    const person = await getPerson(scope, adult);
    expect(person?.deleted_at).toBeNull();
    expect(person?.deleted_by).toBeNull();
    expect(person?.version).toBe(3);
  });

  it("lockPersonForDelete answers not found for nonexistent person", async () => {
    const scope = await setupTenant("not-found");
    const nonExistent = newId();

    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await lockPersonForDelete(tx, { personId: nonExistent, version: 1 });
        }),
      ).rejects.toMatchObject({ code: "not_found" }),
    );
  });

  it("restorePerson answers not found for nonexistent or visible person", async () => {
    const scope = await setupTenant("restore-not-found");
    const nonExistent = newId();
    const visible = await insertAdult(scope, "Visible", "Contact");

    // Nonexistent
    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await restorePerson(tx, { personId: nonExistent, version: 1, actorUserId: newId() });
        }),
      ).rejects.toMatchObject({ code: "not_found" }),
    );

    // Visible contact (not hidden)
    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await restorePerson(tx, { personId: visible, version: 1, actorUserId: newId() });
        }),
      ).rejects.toMatchObject({ code: "not_found" }),
    );
  });

  it("hidePerson refuses sole guardian when child has only one guardian", async () => {
    const scope = await setupTenant("sole-one");
    const { minorId, householdId } = await insertMinor(scope);
    const soleG = await insertAdult(scope, "Sole", "Guardian");

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.guardian_links (
          id, org_id, community_id, household_id, guardian_person_id, child_person_id,
          consent, pickup, view, manage
        ) values
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${householdId}, ${soleG}, ${minorId}, true, true, true, true)
      `;
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      expect(
        withAppTransaction(app, scope, async (tx) => {
          await lockPersonForDelete(tx, { personId: soleG, version: 1 });
          await hidePerson(tx, { personId: soleG, actorUserId: newId() });
        }),
      ).rejects.toMatchObject({ code: "sole_guardian" }),
    );

    const survivor = await getPerson(scope, soleG);
    expect(survivor?.deleted_at).toBeNull();
    expect(survivor?.version).toBe(1);
  });

  it("deletes a contact who is one of multiple unhidden guardians for multiple children", async () => {
    const scope = await setupTenant("multi-children");
    const child1 = await insertMinor(scope);
    const child2 = await insertMinor(scope);
    const sharedGuardian = await insertAdult(scope, "Shared", "Guardian");
    const otherGuardian1 = await insertAdult(scope, "Other", "One");
    const otherGuardian2 = await insertAdult(scope, "Other", "Two");

    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        insert into app.guardian_links (
          id, org_id, community_id, household_id, guardian_person_id, child_person_id,
          consent, pickup, view, manage
        ) values
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${child1.householdId}, ${sharedGuardian}, ${child1.minorId}, true, true, true, true),
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${child1.householdId}, ${otherGuardian1}, ${child1.minorId}, true, true, true, true),
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${child2.householdId}, ${sharedGuardian}, ${child2.minorId}, true, true, true, true),
          (${newId()}, ${scope.orgId}, ${scope.communityId}, ${child2.householdId}, ${otherGuardian2}, ${child2.minorId}, true, true, true, true)
      `;
    });

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scope, async (tx) => {
        await lockPersonForDelete(tx, { personId: sharedGuardian, version: 1 });
        await hidePerson(tx, { personId: sharedGuardian, actorUserId: newId() });
      }),
    );

    const hidden = await getPerson(scope, sharedGuardian);
    expect(hidden?.deleted_at).not.toBeNull();
  });
});
