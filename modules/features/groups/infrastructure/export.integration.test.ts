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

import { addMember, archiveGroup, createGroup, exportRosterCsv } from "../public/index.js";
import { cleanScope, loadRuntime, roleUrl } from "../test/fixtures/real-scope.js";
import { createSyntheticScopes } from "../test/fixtures/scopes.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-11T00:00:00+11:00");

function createCountingKms(): { kms: KmsPort; unwrapCount: () => number } {
  const store = new Map<string, Uint8Array>();
  let unwraps = 0;
  return {
    unwrapCount: () => unwraps,
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
        unwraps++;
        const key = Buffer.from(blob).toString("hex");
        const secret = store.get(key);
        if (!secret) {
          throw new Error("key not found in test kms");
        }
        return new Uint8Array(secret);
      },
    },
  };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentCell += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i += 1;
          continue;
        }
      } else {
        currentCell += char;
        i += 1;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i += 1;
      } else if (char === ",") {
        currentRow.push(currentCell);
        currentCell = "";
        i += 1;
      } else if (char === "\n") {
        currentRow.push(currentCell);
        rows.push(currentRow);
        currentRow = [];
        currentCell = "";
        i += 1;
      } else if (char === "\r") {
        if (i + 1 < text.length && text[i + 1] === "\n") {
          i += 1;
        }
        currentRow.push(currentCell);
        rows.push(currentRow);
        currentRow = [];
        currentCell = "";
        i += 1;
      } else {
        currentCell += char;
        i += 1;
      }
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
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

describe("exportRosterCsv", () => {
  it("omits minors unless includeRestricted (pin 20)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createTestScope(platform);
    const { kms } = createCountingKms();
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Pin 20 Group",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });

          const adult = await createPerson(tx, kms, KEY_ARN, {
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

          const household = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Smith Family",
            actorUserId,
          });

          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: "2015-06-01",
            givenName: "Charlie",
            familyName: "Smith",
            email: null,
            phone: null,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: adult.personId,
            role: "member",
            now: NOW,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: minor.personId,
            role: "leader",
            now: NOW,
            actorUserId,
          });

          // Without includeRestricted: minor is omitted (pin 20)
          const csvWithout = await exportRosterCsv(tx, kms, KEY_ARN, {
            groupId: group.id,
            includeRestricted: false,
            actorUserId,
          });

          const parsedWithout = parseCsv(csvWithout);
          expect(parsedWithout).toEqual([
            ["given_name", "family_name", "role"],
            ["Alice", "Singer", "member"],
          ]);

          // No people.person.read audit event was written
          const peopleAuditWithout = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events
            where action = 'people.person.read'
          `;
          expect(Number(peopleAuditWithout[0]?.count ?? "0")).toBe(0);

          // With includeRestricted: minor is present
          const csvWith = await exportRosterCsv(tx, kms, KEY_ARN, {
            groupId: group.id,
            includeRestricted: true,
            actorUserId,
          });

          const parsedWith = parseCsv(csvWith);
          expect(parsedWith).toEqual([
            ["given_name", "family_name", "role"],
            ["Alice", "Singer", "member"],
            ["Charlie", "Smith", "leader"],
          ]);

          // people.person.read audit event exists with minor's id as target
          const peopleAuditWith = await tx<{ target_ids: string[] }[]>`
            select target_ids from app.audit_events
            where action = 'people.person.read'
          `;
          expect(peopleAuditWith).toHaveLength(1);
          expect(peopleAuditWith[0]?.target_ids).toEqual([minor.personId]);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("writes one groups.roster.exported event with the group id and no name (pin 21)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createTestScope(platform);
    const { kms } = createCountingKms();
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Pin 21 Group",
            kind: "group",
            now: NOW,
            actorUserId,
          });

          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "SecretAdultGiven",
            familyName: "SecretAdultFamily",
            email: null,
            phone: null,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: adult.personId,
            role: "member",
            now: NOW,
            actorUserId,
          });

          const auditBefore = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events
            where action = 'groups.roster.exported'
          `;
          expect(Number(auditBefore[0]?.count ?? "0")).toBe(0);

          await exportRosterCsv(tx, kms, KEY_ARN, {
            groupId: group.id,
            includeRestricted: false,
            actorUserId,
          });

          const auditAfter = await tx<
            {
              action: string;
              purpose: string;
              actor_id: string;
              target_ids: string[];
              raw_row: string;
            }[]
          >`
            select
              action,
              purpose,
              actor_id::text as actor_id,
              target_ids::text[] as target_ids,
              row_to_json(e)::text as raw_row
            from app.audit_events e
            where action = 'groups.roster.exported'
          `;

          expect(auditAfter).toHaveLength(1);
          expect(auditAfter[0]?.action).toBe("groups.roster.exported");
          expect(auditAfter[0]?.purpose).toBe("groups.roster.exported");
          expect(auditAfter[0]?.actor_id).toBe(actorUserId);
          expect(auditAfter[0]?.target_ids).toEqual([group.id]);

          // The serialised audit row must contain no fixture name
          const raw = auditAfter[0]?.raw_row ?? "";
          expect(raw).not.toContain("SecretAdultGiven");
          expect(raw).not.toContain("SecretAdultFamily");
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("orders by family name, given name, person id, minors included (pin 23)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createTestScope(platform);
    const { kms } = createCountingKms();
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Order Group",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });

          // Create two adults with identical names so only personId separates them
          const p1 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Identical",
            familyName: "Name",
            email: null,
            phone: null,
            actorUserId,
          });

          const p2 = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Identical",
            familyName: "Name",
            email: null,
            phone: null,
            actorUserId,
          });

          // Create a minor with earlier alphabet name
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Alpha Household",
            actorUserId,
          });
          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: hh.householdId,
            dateOfBirth: "2016-01-01",
            givenName: "Alex",
            familyName: "Alpha",
            email: null,
            phone: null,
            actorUserId,
          });

          const [pLow, pHigh] = [p1.personId, p2.personId].sort() as [string, string];

          // Insert members in wrong person-id order: pHigh first with "member", then minor with "leader", then pLow with "leader"
          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: pHigh,
            role: "member",
            now: NOW,
            actorUserId,
          });
          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: minor.personId,
            role: "leader",
            now: NOW,
            actorUserId,
          });
          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: pLow,
            role: "leader",
            now: NOW,
            actorUserId,
          });

          const csv = await exportRosterCsv(tx, kms, KEY_ARN, {
            groupId: group.id,
            includeRestricted: true,
            actorUserId,
          });

          const parsed = parseCsv(csv);
          expect(parsed).toEqual([
            ["given_name", "family_name", "role"],
            ["Alex", "Alpha", "leader"],
            ["Identical", "Name", "leader"],
            ["Identical", "Name", "member"],
          ]);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects a null or non-UUID actor before any SQL, decryption or audit (pin 24)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createTestScope(platform);
    const counting = createCountingKms();
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Actor Pin 24 Group",
            kind: "group",
            now: NOW,
            actorUserId,
          });

          const household = await createHousehold(tx, counting.kms, KEY_ARN, {
            now: NOW,
            label: "Pin 24 Household",
            actorUserId,
          });

          const minor = await createPerson(tx, counting.kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: "2015-01-01",
            givenName: "RealMinor",
            familyName: "Pin24",
            email: null,
            phone: null,
            actorUserId,
          });

          await addMember(tx, counting.kms, KEY_ARN, {
            groupId: group.id,
            personId: minor.personId,
            role: "member",
            now: NOW,
            actorUserId,
          });

          const unwrapsBefore = counting.unwrapCount();
          const auditCountBefore = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events
          `;

          const nonexistentGroupId = newId();

          // Bad (null / non-UUID) actor with a nonexistent group id rejects with invalid_input, not group_not_found
          await expect(
            exportRosterCsv(tx, counting.kms, KEY_ARN, {
              groupId: nonexistentGroupId,
              includeRestricted: true,
              actorUserId: null as unknown as string,
            }),
          ).rejects.toMatchObject({ code: "invalid_input" });

          await expect(
            exportRosterCsv(tx, counting.kms, KEY_ARN, {
              groupId: nonexistentGroupId,
              includeRestricted: true,
              actorUserId: "not-a-uuid",
            }),
          ).rejects.toMatchObject({ code: "invalid_input" });

          // Null actor on existing group
          await expect(
            exportRosterCsv(tx, counting.kms, KEY_ARN, {
              groupId: group.id,
              includeRestricted: true,
              actorUserId: null as unknown as string,
            }),
          ).rejects.toMatchObject({ code: "invalid_input" });

          // Non-UUID actor on existing group
          await expect(
            exportRosterCsv(tx, counting.kms, KEY_ARN, {
              groupId: group.id,
              includeRestricted: true,
              actorUserId: "not-a-uuid",
            }),
          ).rejects.toMatchObject({ code: "invalid_input" });

          // Zero unwraps and zero audit rows
          expect(counting.unwrapCount()).toBe(unwrapsBefore);
          const auditCountAfter = await tx<{ count: string }[]>`
            select count(*)::text as count from app.audit_events
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

  it("returns header only for empty group", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createTestScope(platform);
    const { kms } = createCountingKms();
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Empty Group",
            kind: "group",
            now: NOW,
            actorUserId,
          });

          const csv = await exportRosterCsv(tx, kms, KEY_ARN, {
            groupId: group.id,
            includeRestricted: false,
            actorUserId,
          });

          expect(csv).toBe('"given_name","family_name","role"\n');

          const audit = await tx<{ action: string; target_ids: string[] }[]>`
            select action, target_ids::text[] as target_ids from app.audit_events
            where action = 'groups.roster.exported'
          `;
          expect(audit).toHaveLength(1);
          expect(audit[0]?.target_ids).toEqual([group.id]);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("returns header only for all-minor group without includeRestricted", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createTestScope(platform);
    const { kms } = createCountingKms();
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Minor Only Group",
            kind: "group",
            now: NOW,
            actorUserId,
          });

          const household = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Minor Family",
            actorUserId,
          });

          const minor = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: "2015-02-02",
            givenName: "OnlyMinor",
            familyName: "Child",
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

          const csv = await exportRosterCsv(tx, kms, KEY_ARN, {
            groupId: group.id,
            includeRestricted: false,
            actorUserId,
          });

          expect(csv).toBe('"given_name","family_name","role"\n');
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("neutralises formula prefix end to end and round-trips special characters", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createTestScope(platform);
    const { kms } = createCountingKms();
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Formula Neutralisation Group",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });

          // Formula prefix name: =SUM(1,2)
          const formulaPerson = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "=Formula",
            familyName: "Safe",
            email: null,
            phone: null,
            actorUserId,
          });

          // Special characters: comma, quotes, newline
          const specialGiven = 'Comma, "Quote" and \n Newline';
          const specialFamily = 'Family, "Quote"';
          const specialPersonId = newId();
          await tx`
            insert into app.persons (
              id,
              org_id,
              community_id,
              is_minor,
              age_basis,
              given_name,
              family_name
            ) values (
              ${specialPersonId}::uuid,
              current_setting('app.org_id')::uuid,
              current_setting('app.community_id')::uuid,
              false,
              'declared_adult',
              ${specialGiven},
              ${specialFamily}
            )
          `;

          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: formulaPerson.personId,
            role: "member",
            now: NOW,
            actorUserId,
          });

          await addMember(tx, kms, KEY_ARN, {
            groupId: group.id,
            personId: specialPersonId,
            role: "leader",
            now: NOW,
            actorUserId,
          });

          const csv = await exportRosterCsv(tx, kms, KEY_ARN, {
            groupId: group.id,
            includeRestricted: false,
            actorUserId,
          });

          // Verify raw text has single quote formula neutralisation
          expect(csv).toContain('"\'=Formula"');

          // Verify round-trip through parseCsv
          const parsed = parseCsv(csv);
          const formulaRow = parsed.find((r) => r[1] === "Safe");
          expect(formulaRow).toBeDefined();
          expect(formulaRow![0]).toBe("'=Formula");

          const specialRow = parsed.find((r) => r[2] === "leader");
          expect(specialRow).toBeDefined();
          expect(specialRow![0]).toBe(specialGiven);
          expect(specialRow![1]).toBe(specialFamily);
        });
      });
    } finally {
      await cleanScope(directSql, scope);
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("rejects group of another tenant with group_not_found across two organisations and two communities", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scopes = createSyntheticScopes();
    const counting = createCountingKms();
    const actorUserId = newId();

    try {
      let groupAId = "";

      // Create group under Org A / Comm 1
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scopes.orgA.community1, async (tx) => {
          const g = await createGroup(tx, {
            name: "OrgA Comm1 Group",
            kind: "ministry",
            now: NOW,
            actorUserId,
          });
          groupAId = g.id;
        }),
      );

      // Attempt export under Org A / Comm 2 -> group_not_found
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scopes.orgA.community2, async (tx) => {
          await expect(
            exportRosterCsv(tx, counting.kms, KEY_ARN, {
              groupId: groupAId,
              includeRestricted: false,
              actorUserId,
            }),
          ).rejects.toMatchObject({ code: "group_not_found" });
        }),
      );

      // Scope B: other community and other organisation
      const scopeB = {
        orgId: scopes.orgB.id,
        communityId: newId(),
      };
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scopeB, async (tx) => {
          await expect(
            exportRosterCsv(tx, counting.kms, KEY_ARN, {
              groupId: groupAId,
              includeRestricted: false,
              actorUserId,
            }),
          ).rejects.toMatchObject({ code: "group_not_found" });
        }),
      );

      // Attempt export under Org B / Comm 1 (same community UUID string) -> group_not_found
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scopes.orgB.community1, async (tx) => {
          await expect(
            exportRosterCsv(tx, counting.kms, KEY_ARN, {
              groupId: groupAId,
              includeRestricted: false,
              actorUserId,
            }),
          ).rejects.toMatchObject({ code: "group_not_found" });
        }),
      );

      // No groups.roster.exported audit row is written
      const auditRows = await directSql<{ count: string }[]>`
        select count(*)::text as count
        from app.audit_events
        where action = 'groups.roster.exported'
      `;
      expect(Number(auditRows[0]?.count ?? "0")).toBe(0);

      // Counting KMS sees 0 unwraps
      expect(counting.unwrapCount()).toBe(0);
    } finally {
      await directSql`delete from app.groups where org_id in (${scopes.orgA.id}::uuid, ${scopes.orgB.id}::uuid)`.catch(
        () => {},
      );
      await directSql.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("exports an archived group", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createTestScope(platform);
    const { kms } = createCountingKms();
    const actorUserId = newId();

    try {
      await withRequest({ requestId: REQUEST_ID }, async () => {
        await withAppTransaction(app, scope, async (tx) => {
          const group = await createGroup(tx, {
            name: "Archived Export Group",
            kind: "group",
            now: NOW,
            actorUserId,
          });

          const person = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Bob",
            familyName: "Archived",
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

          // Archive the group
          await archiveGroup(tx, group.id, { now: NOW, actorUserId });

          // Export succeeds on archived group
          const csv = await exportRosterCsv(tx, kms, KEY_ARN, {
            groupId: group.id,
            includeRestricted: false,
            actorUserId,
          });

          const parsed = parseCsv(csv);
          expect(parsed).toEqual([
            ["given_name", "family_name", "role"],
            ["Bob", "Archived", "member"],
          ]);
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
