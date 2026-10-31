import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import {
  createHousehold,
  createPerson,
  listPersons,
  PeopleError,
  readPerson,
  updatePerson,
} from "../public/index.js";

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
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-31T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
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

async function createScope(platform: ReturnType<typeof createPlaintextPlatformSql>): Promise<{
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

async function cleanScope(
  directSql: ReturnType<typeof createPlaintextDirectSql>,
  scope: { orgId: string },
): Promise<void> {
  await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from app.person_activity where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.persons where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from app.household_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.households where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from app.community_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.organisation_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from platform.communities where organisation_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from platform.organisations where id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
}

describe("updatePerson", () => {
  it("updates adult contact fields, recomputes blind indexes, and increments version by exactly 1", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let personId = "";

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const created = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Original",
              familyName: "Contact",
              email: "original@example.com",
              phone: "+61411111111",
              actorUserId,
            });
            personId = created.personId;
          });
        },
      );

      // Verify initial read
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const initial = await readPerson(tx, kms, KEY_ARN, { personId, actorUserId });
            expect(initial?.givenName).toBe("Original");
            expect(initial?.familyName).toBe("Contact");
            expect(initial?.email).toBe("original@example.com");
            expect(initial?.phone).toBe("61411111111");
            expect(initial?.version).toBe(1);

            // Update person
            const res = await updatePerson(tx, kms, KEY_ARN, {
              personId,
              version: 1,
              changes: {
                givenName: "Updated",
                familyName: "Person",
                email: "updated@example.com",
                phone: "+61422222222",
              },
              actorUserId,
              now: NOW,
            });
            expect(res.version).toBe(2);

            // Verify updated values via readPerson
            const updated = await readPerson(tx, kms, KEY_ARN, { personId, actorUserId });
            expect(updated?.givenName).toBe("Updated");
            expect(updated?.familyName).toBe("Person");
            expect(updated?.email).toBe("updated@example.com");
            expect(updated?.phone).toBe("61422222222");
            expect(updated?.version).toBe(2);

            // Verify blind index recomputation: old search returns nothing, new search finds row
            const oldEmailSearch = await listPersons(tx, kms, KEY_ARN, {
              search: "original@example.com",
              actorUserId,
            });
            expect(oldEmailSearch.items).toHaveLength(0);

            const newEmailSearch = await listPersons(tx, kms, KEY_ARN, {
              search: "updated@example.com",
              actorUserId,
            });
            expect(newEmailSearch.items).toHaveLength(1);
            expect(newEmailSearch.items[0]!.id).toBe(personId);

            const newPhoneSearch = await listPersons(tx, kms, KEY_ARN, {
              search: "+61 422 222 222",
              actorUserId,
            });
            expect(newPhoneSearch.items).toHaveLength(1);
            expect(newPhoneSearch.items[0]!.id).toBe(personId);
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("produces typed conflict on duplicate email or duplicate phone with no field named", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let personBId = "";

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Person",
              familyName: "Alpha",
              email: "alpha@example.com",
              phone: "+61400000001",
              actorUserId,
            });

            const b = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Person",
              familyName: "Beta",
              email: "beta@example.com",
              phone: "+61400000002",
              actorUserId,
            });
            personBId = b.personId;
          });
        },
      );

      // Try updating Person B's email to Person A's email -> conflict
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            let thrown: PeopleError | null = null;
            try {
              await updatePerson(tx, kms, KEY_ARN, {
                personId: personBId,
                version: 1,
                changes: { email: "alpha@example.com" },
                actorUserId,
              });
            } catch (err) {
              if (err instanceof PeopleError) {
                thrown = err;
              }
            }
            expect(thrown).not.toBeNull();
            expect(thrown?.code).toBe("conflict");
            expect(thrown?.message).toBe("conflict");
          });
        },
      );

      // Try updating Person B's phone to Person A's phone -> conflict
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            let thrown: PeopleError | null = null;
            try {
              await updatePerson(tx, kms, KEY_ARN, {
                personId: personBId,
                version: 1,
                changes: { phone: "+61400000001" },
                actorUserId,
              });
            } catch (err) {
              if (err instanceof PeopleError) {
                thrown = err;
              }
            }
            expect(thrown).not.toBeNull();
            expect(thrown?.code).toBe("conflict");
            expect(thrown?.message).toBe("conflict");
          });
        },
      );
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("enforces optimistic concurrency: stale version yields conflict, row and audit unchanged (pin 9)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let personId = "";

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const created = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Initial",
              familyName: "State",
              email: "initial@example.com",
              phone: "+61412345678",
              actorUserId,
            });
            personId = created.personId;
          });
        },
      );

      // Attempt update with stale version (e.g. version 99 instead of 1)
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            let thrown: PeopleError | null = null;
            try {
              await updatePerson(tx, kms, KEY_ARN, {
                personId,
                version: 99,
                changes: { givenName: "AttemptedChange" },
                actorUserId,
              });
            } catch (err) {
              if (err instanceof PeopleError) {
                thrown = err;
              }
            }
            expect(thrown).not.toBeNull();
            expect(thrown?.code).toBe("conflict");
          });
        },
      );

      // Verify row unchanged in DB
      const dbRow = (
        await directSql<{ version: number; given_name: string }[]>`
          select version, given_name from app.persons where id = ${personId}::uuid
        `
      )[0];
      expect(dbRow?.version).toBe(1);
      expect(dbRow?.given_name).toBe("Initial");

      // Verify NO audit event for people.person.updated was written
      const auditRows = await directSql<{ action: string }[]>`
        select action from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and action = 'people.person.updated'
      `;
      expect(auditRows).toHaveLength(0);
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("returns not-found for minor id, cross-community id, and cross-organisation id (pin 10)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scopeA = await createScope(platform);
    const commA2 = await createCommunityInOrg(platform, scopeA.orgId);
    const scopeB = await createScope(platform);
    const actorUserId = newId();

    try {
      let minorId = "";
      let commA2PersonId = "";
      let scopeBPersonId = "";

      // Scope A comm 1: Minor
      await withAppTransaction(
        app,
        { orgId: scopeA.orgId, communityId: scopeA.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const hh = await createHousehold(tx, kms, KEY_ARN, {
              now: NOW,
              label: "Minor Household",
              actorUserId,
            });
            const m = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: false,
              householdId: hh.householdId,
              dateOfBirth: "2016-01-01",
              givenName: "Minor",
              familyName: "Person",
              email: null,
              phone: null,
              actorUserId,
            });
            minorId = m.personId;
          });
        },
      );

      // Scope A comm 2: Adult
      await withAppTransaction(app, { orgId: scopeA.orgId, communityId: commA2 }, async (tx) => {
        await withRequest({ requestId: REQUEST_ID }, async () => {
          const a = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Adult",
            familyName: "CommA2",
            email: "comma2@example.com",
            phone: "+61433333331",
            actorUserId,
          });
          commA2PersonId = a.personId;
        });
      });

      // Scope B: Adult
      await withAppTransaction(
        app,
        { orgId: scopeB.orgId, communityId: scopeB.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const b = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Adult",
              familyName: "ScopeB",
              email: "scopeb@example.com",
              phone: "+61433333332",
              actorUserId,
            });
            scopeBPersonId = b.personId;
          });
        },
      );

      // From Scope A comm 1:
      await withAppTransaction(
        app,
        { orgId: scopeA.orgId, communityId: scopeA.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            // 1. Updating minor id -> not_found
            await expect(
              updatePerson(tx, kms, KEY_ARN, {
                personId: minorId,
                version: 1,
                changes: { givenName: "Hacked" },
                actorUserId,
              }),
            ).rejects.toThrow(new PeopleError("not_found"));

            // 2. Updating cross-community id -> not_found
            await expect(
              updatePerson(tx, kms, KEY_ARN, {
                personId: commA2PersonId,
                version: 1,
                changes: { givenName: "Hacked" },
                actorUserId,
              }),
            ).rejects.toThrow(new PeopleError("not_found"));

            // 3. Updating cross-org id -> not_found
            await expect(
              updatePerson(tx, kms, KEY_ARN, {
                personId: scopeBPersonId,
                version: 1,
                changes: { givenName: "Hacked" },
                actorUserId,
              }),
            ).rejects.toThrow(new PeopleError("not_found"));
          });
        },
      );
    } finally {
      await cleanScope(directSql, scopeA);
      await cleanScope(directSql, scopeB);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("appends audit event for people.person.updated holding ids only and no personal values", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let personId = "";

      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const created = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "InitialName",
              familyName: "InitialFamily",
              email: "initial.secret@example.com",
              phone: "+61499999999",
              actorUserId,
            });
            personId = created.personId;

            await updatePerson(tx, kms, KEY_ARN, {
              personId,
              version: 1,
              changes: {
                givenName: "NewName",
                email: "new.secret@example.com",
              },
              actorUserId,
            });
          });
        },
      );

      const auditRows = await directSql<
        {
          action: string;
          purpose: string;
          target_ids: string[];
        }[]
      >`
        select action, purpose, target_ids
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and action = 'people.person.updated'
      `;

      expect(auditRows).toHaveLength(1);
      const audit = auditRows[0]!;
      expect(audit.action).toBe("people.person.updated");
      expect(audit.purpose).toBe("people.person.updated");
      expect(audit.target_ids).toEqual([personId]);

      // Verify no personal values appear anywhere in the audit table for this org
      const allAuditRows = await directSql<{ [key: string]: unknown }[]>`
        select * from app.audit_events where org_id = ${scope.orgId}::uuid
      `;
      const auditDump = JSON.stringify(allAuditRows);
      expect(auditDump).not.toContain("NewName");
      expect(auditDump).not.toContain("new.secret@example.com");
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("throws invalid_input when changes object is empty, with no version bump and no audit row (Deviation 5)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let personId = "";
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const created = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Initial",
              familyName: "Contact",
              email: "initial@example.com",
              phone: "+61412345678",
              actorUserId,
            });
            personId = created.personId;
          });
        },
      );

      // Call updatePerson with empty changes: {}
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await expect(
              updatePerson(tx, kms, KEY_ARN, {
                personId,
                version: 1,
                changes: {},
                actorUserId,
              }),
            ).rejects.toMatchObject({ code: "invalid_input" });
          });
        },
      );

      // Call updatePerson with all fields undefined or unknown keys
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await expect(
              updatePerson(tx, kms, KEY_ARN, {
                personId,
                version: 1,
                changes: { givenName: undefined } as unknown as Parameters<
                  typeof updatePerson
                >[3]["changes"],
                actorUserId,
              }),
            ).rejects.toMatchObject({ code: "invalid_input" });

            await expect(
              updatePerson(tx, kms, KEY_ARN, {
                personId,
                version: 1,
                changes: { unknownField: "val" } as unknown as Parameters<
                  typeof updatePerson
                >[3]["changes"],
                actorUserId,
              }),
            ).rejects.toMatchObject({ code: "invalid_input" });
          });
        },
      );

      // Verify row version unchanged
      const dbRow = (
        await directSql<{ version: number }[]>`
          select version from app.persons where id = ${personId}::uuid
        `
      )[0];
      expect(dbRow?.version).toBe(1);

      // Verify no audit row for update
      const updateAudits = await directSql<{ action: string }[]>`
        select action from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and action = 'people.person.updated'
      `;
      expect(updateAudits).toHaveLength(0);
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("enforces optimistic concurrency under concurrent race: second transaction blocks on row lock and throws conflict (pin 9)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();

    const scope = await createScope(platform);
    const actorUserId = newId();

    try {
      let personId = "";
      await withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (tx) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const created = await createPerson(tx, kms, KEY_ARN, {
              now: NOW,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Race",
              familyName: "Person",
              email: "race@example.com",
              phone: "+61412345678",
              actorUserId,
            });
            personId = created.personId;
          });
        },
      );

      let releaseTxA: () => void;
      const txAHold = new Promise<void>((resolve) => {
        releaseTxA = resolve;
      });

      let txAReachedUpdate: () => void;
      const txAUpdated = new Promise<void>((resolve) => {
        txAReachedUpdate = resolve;
      });

      // Transaction A starts, updates person, and holds transaction open
      const txAPromise = withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (txA) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            const resA = await updatePerson(txA, kms, KEY_ARN, {
              personId,
              version: 1,
              changes: { givenName: "Alice" },
              actorUserId,
            });
            expect(resA.version).toBe(2);
            txAReachedUpdate();
            await txAHold;
          });
        },
      );

      // Wait until Tx A has completed its update and acquired the row lock
      await txAUpdated;

      // Transaction B starts concurrently with same initial version 1
      let bError: unknown = null;
      const txBPromise = withAppTransaction(
        app,
        { orgId: scope.orgId, communityId: scope.communityId },
        async (txB) => {
          await withRequest({ requestId: REQUEST_ID }, async () => {
            await updatePerson(txB, kms, KEY_ARN, {
              personId,
              version: 1,
              changes: { givenName: "Bob" },
              actorUserId,
            });
          });
        },
      ).catch((err) => {
        bError = err;
      });

      // Wait until Tx B is blocked on the row lock held by Tx A
      while (true) {
        const waiting = await directSql<{ waiting: boolean }[]>`
          select true as waiting
          from pg_locks l
          join pg_stat_activity a on a.pid = l.pid
          where not l.granted
            and a.query like '%update app.persons%'
        `;
        if (waiting.length > 0) {
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Now release Tx A to commit
      releaseTxA!();
      await txAPromise;

      // Now Tx B will unblock, evaluate its version predicate on the newly committed row, and fail
      await txBPromise;

      expect(bError).toMatchObject({ code: "conflict" });

      // Verify row state: Alice's update won, version is 2
      const finalRow = (
        await directSql<{ version: number; given_name: string }[]>`
          select version, given_name from app.persons where id = ${personId}::uuid
        `
      )[0];
      expect(finalRow?.version).toBe(2);
      expect(finalRow?.given_name).toBe("Alice");
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
