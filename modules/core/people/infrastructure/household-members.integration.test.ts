import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

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
  createPerson,
  linkGuardian,
  moveAdult,
  PeopleError,
} from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-01T00:00:00+11:00");

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

async function withTenant(
  slug: string,
  run: (tx: AppTransaction, kms: ReturnType<typeof createLocalKmsPort>) => Promise<void>,
): Promise<void> {
  const runtime = loadRuntime();
  const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  const organisationId = newId();
  const communityId = newId();
  const kms = createLocalKmsPort();
  const tenantSlug = `${slug.slice(0, 20)}-${organisationId.slice(0, 8)}`;
  try {
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${organisationId}, ${tenantSlug}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${organisationId}, ${tenantSlug}, 'au')
      `;
    });
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: organisationId, communityId }, (tx) => run(tx, kms)),
    );
  } finally {
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
  }
}

describe("household members: move adult", () => {
  it("moves an adult between households and bumps person version", async () => {
    await withTenant("move-adult-success", async (tx, kms) => {
      const h1 = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: "Home 1",
        actorUserId: null,
      });
      const h2 = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: "Home 2",
        actorUserId: null,
      });

      const adult = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: h1.householdId,
        dateOfBirth: null,
        givenName: "Adult",
        familyName: "Person",
        email: null,
        phone: null,
        actorUserId: null,
      });

      const result = await moveAdult(tx, {
        personId: adult.personId,
        version: 1,
        householdId: h2.householdId,
        actorUserId: "11111111-1111-4111-8111-111111111111",
      });
      expect(result.version).toBe(2);

      const rows = await tx<{ household_id: string; version: number }[]>`
        select household_id::text as household_id, version
        from app.persons
        where id = ${adult.personId}::uuid
      `;
      expect(rows[0]!.household_id).toBe(h2.householdId);
      expect(rows[0]!.version).toBe(2);

      // Clearing household
      const cleared = await moveAdult(tx, {
        personId: adult.personId,
        version: 2,
        householdId: null,
        actorUserId: null,
      });
      expect(cleared.version).toBe(3);

      const clearedRows = await tx<{ household_id: string | null; version: number }[]>`
        select household_id::text as household_id, version
        from app.persons
        where id = ${adult.personId}::uuid
      `;
      expect(clearedRows[0]!.household_id).toBeNull();
      expect(clearedRows[0]!.version).toBe(3);
    });
  });

  it("pin 5: adult holding a guardian link cannot move", async () => {
    await withTenant("pin5-adult-guardian-link", async (tx, kms) => {
      const h1 = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const h2 = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });

      const adult = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: h1.householdId,
        dateOfBirth: null,
        givenName: "Guardian",
        familyName: "Person",
        email: null,
        phone: null,
        actorUserId: null,
      });

      const minor = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: false,
        householdId: h1.householdId,
        dateOfBirth: null,
        givenName: "Child",
        familyName: "Person",
        email: null,
        phone: null,
        actorUserId: null,
      });

      await linkGuardian(tx, {
        now: NOW,
        householdId: h1.householdId,
        guardianPersonId: adult.personId,
        childPersonId: minor.personId,
        consent: true,
        pickup: false,
        view: false,
        manage: false,
        actorUserId: null,
      });

      await expect(
        moveAdult(tx, {
          personId: adult.personId,
          version: 1,
          householdId: h2.householdId,
          actorUserId: null,
        }),
      ).rejects.toMatchObject({ code: "adult_cannot_move_with_links" });

      const stored = await tx<{ household_id: string; version: number }[]>`
        select household_id::text as household_id, version
        from app.persons
        where id = ${adult.personId}::uuid
      `;
      expect(stored[0]!.household_id).toBe(h1.householdId);
      expect(stored[0]!.version).toBe(1);
    });
  });

  it("pin 6: minors cannot move", async () => {
    await withTenant("pin6-minor-not-movable", async (tx, kms) => {
      const h1 = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const h2 = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });

      const minor = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: false,
        householdId: h1.householdId,
        dateOfBirth: null,
        givenName: "Child",
        familyName: "Person",
        email: null,
        phone: null,
        actorUserId: null,
      });

      await expect(
        moveAdult(tx, {
          personId: minor.personId,
          version: 1,
          householdId: h2.householdId,
          actorUserId: null,
        }),
      ).rejects.toMatchObject({ code: "minor_not_movable" });

      const stored = await tx<{ household_id: string; version: number }[]>`
        select household_id::text as household_id, version
        from app.persons
        where id = ${minor.personId}::uuid
      `;
      expect(stored[0]!.household_id).toBe(h1.householdId);
      expect(stored[0]!.version).toBe(1);
    });
  });

  it("pin 8: stale version cannot move adult", async () => {
    await withTenant("pin8-move-conflict", async (tx, kms) => {
      const h1 = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const h2 = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });

      const adult = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: h1.householdId,
        dateOfBirth: null,
        givenName: "Adult",
        familyName: "Person",
        email: null,
        phone: null,
        actorUserId: null,
      });

      await expect(
        moveAdult(tx, {
          personId: adult.personId,
          version: 99,
          householdId: h2.householdId,
          actorUserId: null,
        }),
      ).rejects.toMatchObject({ code: "conflict" });

      const stored = await tx<{ household_id: string; version: number }[]>`
        select household_id::text as household_id, version
        from app.persons
        where id = ${adult.personId}::uuid
      `;
      expect(stored[0]!.household_id).toBe(h1.householdId);
      expect(stored[0]!.version).toBe(1);
    });
  });

  it("pin 12: cross-organisation and cross-community target household returns not_found", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const kms = createLocalKmsPort();
    const orgA = newId();
    const commA = newId();
    const orgB = newId();
    const commB = newId();

    const commA2 = newId();

    try {
      await platform.begin(async (tx) => {
        await tx`insert into platform.organisations (id, slug, region, kind) values (${orgA}, ${`org-a-move-${orgA.slice(0, 8)}`}, 'au', 'implicit')`;
        await tx`insert into platform.communities (id, organisation_id, slug, region) values (${commA}, ${orgA}, ${`comm-a-move-${commA.slice(0, 8)}`}, 'au')`;
        await tx`insert into platform.communities (id, organisation_id, slug, region) values (${commA2}, ${orgA}, ${`comm-a2-move-${commA2.slice(0, 8)}`}, 'au')`;
        await tx`insert into platform.organisations (id, slug, region, kind) values (${orgB}, ${`org-b-move-${orgB.slice(0, 8)}`}, 'au', 'implicit')`;
        await tx`insert into platform.communities (id, organisation_id, slug, region) values (${commB}, ${orgB}, ${`comm-b-move-${commB.slice(0, 8)}`}, 'au')`;
      });

      let adultIdA!: string;
      let homeBId!: string;
      let homeA2Id!: string;

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgA, communityId: commA }, async (tx) => {
          const hA = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: hA.householdId,
            dateOfBirth: null,
            givenName: "A",
            familyName: "A",
            email: null,
            phone: null,
            actorUserId: null,
          });
          adultIdA = adult.personId;
        }),
      );

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgA, communityId: commA2 }, async (tx) => {
          const hA2 = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          homeA2Id = hA2.householdId;
        }),
      );

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgB, communityId: commB }, async (tx) => {
          const hB = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          homeBId = hB.householdId;
        }),
      );

      // Attempting to move Adult A into Household B from Org A scope -> not_found (household B does not exist in Org A)
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgA, communityId: commA }, async (tx) => {
          await expect(
            moveAdult(tx, {
              personId: adultIdA,
              version: 1,
              householdId: homeBId,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "not_found" });

          // Cross-community in same organisation: household A2 is in commA2 -> not_found in commA
          await expect(
            moveAdult(tx, {
              personId: adultIdA,
              version: 1,
              householdId: homeA2Id,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "not_found" });
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("pin 23: deterministic race: moveAdult cannot race linkGuardian", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const organisationId = newId();
    const communityId = newId();
    const scope = { orgId: organisationId, communityId };

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, ${`pin23-${organisationId.slice(0, 8)}`}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, ${`pin23-${organisationId.slice(0, 8)}`}, 'au')
        `;
      });

      let homeAId!: string;
      let homeBId!: string;
      let adultId!: string;
      let childId!: string;

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const homeA = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          homeAId = homeA.householdId;
          const homeB = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          homeBId = homeB.householdId;

          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: homeAId,
            dateOfBirth: null,
            givenName: "Adult",
            familyName: "Person",
            email: null,
            phone: null,
            actorUserId: null,
          });
          adultId = adult.personId;

          const child = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: false,
            householdId: homeAId,
            dateOfBirth: null,
            givenName: "Child",
            familyName: "Person",
            email: null,
            phone: null,
            actorUserId: null,
          });
          childId = child.personId;
        }),
      );

      // Deterministic race:
      // Tx1 calls moveAdult from homeA to homeB.
      // Tx1 acquires 'for update' on adult row and waits before committing.
      // Tx2 calls linkGuardian for adult to child in homeA.
      // Tx2 attempts 'for share' on adult row, blocking on Tx1's 'for update'.
      // We poll pg_stat_activity until Tx2 is waiting on 'Lock'.
      // Then Tx1 commits.
      // Tx2 unblocks, re-reads adult, sees adult is in homeB (not homeA), and fails with 'invalid_guardian'.
      let releaseTx1!: () => void;
      const tx1Hold = new Promise<void>((resolve) => {
        releaseTx1 = resolve;
      });
      let tx1Started = false;

      const p1 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx1) => {
          tx1Started = true;
          await moveAdult(tx1, {
            personId: adultId,
            version: 1,
            householdId: homeBId,
            actorUserId: null,
          });
          await tx1Hold;
        }),
      );

      while (!tx1Started) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      let tx2Pid: number | null = null;
      let tx2Error: unknown = null;

      const p2 = withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx2) => {
          const pidRows = await tx2<{ pid: number }[]>`select pg_backend_pid() as pid`;
          tx2Pid = pidRows[0]!.pid;
          await linkGuardian(tx2, {
            now: NOW,
            householdId: homeAId,
            guardianPersonId: adultId,
            childPersonId: childId,
            consent: true,
            pickup: false,
            view: false,
            manage: false,
            actorUserId: null,
          });
        }),
      ).catch((err) => {
        tx2Error = err;
      });

      const start = Date.now();
      let locked = false;
      while (Date.now() - start < 10000) {
        if (tx2Pid !== null) {
          const stat = await directSql<{ wait_event_type: string | null }[]>`
            select wait_event_type from pg_stat_activity where pid = ${tx2Pid}
          `;
          if (stat[0]?.wait_event_type === "Lock") {
            locked = true;
            break;
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(locked).toBe(true);

      releaseTx1();
      await p1;
      await p2;

      expect(tx2Error).toBeInstanceOf(PeopleError);
      expect((tx2Error as PeopleError).code).toBe("invalid_guardian");

      // After both finish, no link exists where guardian is outside household
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const links = await tx<{ count: number }[]>`
            select count(*)::int as count from app.guardian_links
          `;
          expect(links[0]!.count).toBe(0);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("pin 24: moveAdult appends audit event with ids only", async () => {
    await withTenant("pin24-move-audit", async (tx, kms) => {
      const home1 = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: "ConfidentialFamilyLabel",
        actorUserId: null,
      });
      const home2 = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: "ConfidentialFamilyLabel2",
        actorUserId: null,
      });
      const adult = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: home1.householdId,
        dateOfBirth: null,
        givenName: "SecretAdultName",
        familyName: "SecretFamilyName",
        email: null,
        phone: null,
        actorUserId: null,
      });

      await moveAdult(tx, {
        personId: adult.personId,
        version: 1,
        householdId: home2.householdId,
        actorUserId: "33333333-3333-4333-8333-333333333333",
      });

      const auditRows = await tx<{ action: string; target_ids: string[] }[]>`
        select action, target_ids from app.audit_events
        where action = 'people.person.household_moved'
      `;
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.target_ids).toContain(adult.personId);

      const allAudits = await tx<{ action: string }[]>`
        select action from app.audit_events
      `;
      const stringified = JSON.stringify(allAudits);
      expect(stringified).not.toContain("SecretAdultName");
      expect(stringified).not.toContain("SecretFamilyName");
      expect(stringified).not.toContain("ConfidentialFamilyLabel");
    });
  });
});

describe("household members: add minor", () => {
  it("adds minor with guardian link and default rights view and consent", async () => {
    await withTenant("add-minor-success", async (tx, kms) => {
      const home = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const adult = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: home.householdId,
        dateOfBirth: null,
        givenName: "Adult",
        familyName: "Guardian",
        email: null,
        phone: null,
        actorUserId: null,
      });

      const result = await addMinor(tx, kms, KEY_ARN, {
        now: NOW,
        householdId: home.householdId,
        givenName: "Minor",
        familyName: "Child",
        dateOfBirth: "2015-05-10",
        guardianId: adult.personId,
        actorUserId: "44444444-4444-4444-8444-444444444444",
      });

      expect(result.personId).toBeDefined();
      expect(result.linkId).toBeDefined();

      const storedLinks = await tx<
        { consent: boolean; pickup: boolean; view: boolean; manage: boolean }[]
      >`
        select consent, pickup, view, manage
        from app.guardian_links
        where id = ${result.linkId}::uuid
      `;
      expect(storedLinks).toEqual([
        {
          consent: true,
          pickup: false,
          view: true,
          manage: false,
        },
      ]);

      const storedPerson = await tx<{ is_minor: boolean; household_id: string }[]>`
        select is_minor, household_id::text as household_id
        from app.persons
        where id = ${result.personId}::uuid
      `;
      expect(storedPerson[0]!.is_minor).toBe(true);
      expect(storedPerson[0]!.household_id).toBe(home.householdId);
    });
  });

  it("pin 6: addMinor with null or adult date of birth throws invalid_date", async () => {
    await withTenant("pin6-dob-validation", async (tx, kms) => {
      const home = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: null,
        actorUserId: null,
      });
      const adult = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: home.householdId,
        dateOfBirth: null,
        givenName: "Adult",
        familyName: "Guardian",
        email: null,
        phone: null,
        actorUserId: null,
      });

      // Adult date of birth (e.g. 1990-01-01) -> invalid_date
      await expect(
        addMinor(tx, kms, KEY_ARN, {
          now: NOW,
          householdId: home.householdId,
          givenName: "Not",
          familyName: "Minor",
          dateOfBirth: "1990-01-01",
          guardianId: adult.personId,
          actorUserId: null,
        }),
      ).rejects.toMatchObject({ code: "invalid_date" });

      // Missing / null date of birth -> invalid_input or invalid_date
      await expect(
        addMinor(tx, kms, KEY_ARN, {
          now: NOW,
          householdId: home.householdId,
          givenName: "Not",
          familyName: "Minor",
          dateOfBirth: null as unknown as string,
          guardianId: adult.personId,
          actorUserId: null,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      // No persons added
      const personCount = await tx<{ count: number }[]>`
        select count(*)::int as count from app.persons where is_minor = true
      `;
      expect(personCount[0]!.count).toBe(0);
    });
  });

  it("pin 7: addMinor is atomic; failure to link guardian rolls back person and audit", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const kms = createLocalKmsPort();
    const organisationId = newId();
    const communityId = newId();
    const scope = { orgId: organisationId, communityId };

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, ${`pin7-${organisationId.slice(0, 8)}`}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, ${`pin7-${organisationId.slice(0, 8)}`}, 'au')
        `;
      });

      let homeId!: string;
      let nonMemberAdultId!: string;

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const home = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          homeId = home.householdId;
          const otherHome = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: otherHome.householdId,
            dateOfBirth: null,
            givenName: "Outside",
            familyName: "Adult",
            email: null,
            phone: null,
            actorUserId: null,
          });
          nonMemberAdultId = adult.personId;
        }),
      );

      // Calling addMinor with guardian from otherHome -> linkGuardian fails -> transaction rolls back
      let caught: unknown = null;
      try {
        await withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(app, scope, async (tx) => {
            await addMinor(tx, kms, KEY_ARN, {
              now: NOW,
              householdId: homeId,
              givenName: "Orphan",
              familyName: "Child",
              dateOfBirth: "2018-01-01",
              guardianId: nonMemberAdultId,
              actorUserId: null,
            });
          }),
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PeopleError);
      expect((caught as PeopleError).code).toBe("invalid_guardian");

      // Verify from a second connection: NO persons, guardian_links, or audit rows exist for this child
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const minors = await tx<{ count: number }[]>`
            select count(*)::int as count from app.persons where is_minor = true
          `;
          expect(minors[0]!.count).toBe(0);

          const links = await tx<{ count: number }[]>`
            select count(*)::int as count from app.guardian_links
          `;
          expect(links[0]!.count).toBe(0);

          const audits = await tx<{ count: number }[]>`
            select count(*)::int as count from app.audit_events where action = 'people.person.created'
          `;
          // Only the adult creation was audited, not the rolled-back minor
          expect(audits[0]!.count).toBe(1);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("pin 12: addMinor with target household in another scope throws not_found", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const kms = createLocalKmsPort();
    const orgA = newId();
    const commA = newId();
    const orgB = newId();
    const commB = newId();

    try {
      await platform.begin(async (tx) => {
        await tx`insert into platform.organisations (id, slug, region, kind) values (${orgA}, ${`org-a-minor-${orgA.slice(0, 8)}`}, 'au', 'implicit')`;
        await tx`insert into platform.communities (id, organisation_id, slug, region) values (${commA}, ${orgA}, ${`comm-a-minor-${commA.slice(0, 8)}`}, 'au')`;
        await tx`insert into platform.organisations (id, slug, region, kind) values (${orgB}, ${`org-b-minor-${orgB.slice(0, 8)}`}, 'au', 'implicit')`;
        await tx`insert into platform.communities (id, organisation_id, slug, region) values (${commB}, ${orgB}, ${`comm-b-minor-${commB.slice(0, 8)}`}, 'au')`;
      });

      let homeBId!: string;
      let adultAId!: string;

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgB, communityId: commB }, async (tx) => {
          const hB = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          homeBId = hB.householdId;
        }),
      );

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgA, communityId: commA }, async (tx) => {
          const hA = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: null,
            actorUserId: null,
          });
          const adult = await createPerson(tx, kms, KEY_ARN, {
            now: NOW,
            declaredAdult: true,
            householdId: hA.householdId,
            dateOfBirth: null,
            givenName: "A",
            familyName: "A",
            email: null,
            phone: null,
            actorUserId: null,
          });
          adultAId = adult.personId;
        }),
      );

      // Calling addMinor for household B from Org A scope -> not_found
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgA, communityId: commA }, async (tx) => {
          await expect(
            addMinor(tx, kms, KEY_ARN, {
              now: NOW,
              householdId: homeBId,
              givenName: "Minor",
              familyName: "Child",
              dateOfBirth: "2016-01-01",
              guardianId: adultAId,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "not_found" });
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });

  it("pin 24: addMinor appends person.created and guardian.linked audit events with ids only", async () => {
    await withTenant("pin24-add-minor-audit", async (tx, kms) => {
      const home = await createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label: "ConfidentialFamilyLabel",
        actorUserId: null,
      });
      const adult = await createPerson(tx, kms, KEY_ARN, {
        now: NOW,
        declaredAdult: true,
        householdId: home.householdId,
        dateOfBirth: null,
        givenName: "AdultGuardian",
        familyName: "Family",
        email: null,
        phone: null,
        actorUserId: null,
      });

      const minor = await addMinor(tx, kms, KEY_ARN, {
        now: NOW,
        householdId: home.householdId,
        givenName: "SecretMinorName",
        familyName: "SecretMinorFamily",
        dateOfBirth: "2017-07-07",
        guardianId: adult.personId,
        actorUserId: "55555555-5555-4555-8555-555555555555",
      });

      const personAudits = await tx<{ action: string; target_ids: string[] }[]>`
        select action, target_ids from app.audit_events
        where action = 'people.person.created'
      `;
      expect(personAudits.map((a) => a.target_ids)).toContainEqual([minor.personId]);

      const linkAudits = await tx<{ action: string; target_ids: string[] }[]>`
        select action, target_ids from app.audit_events
        where action = 'people.guardian.linked'
      `;
      expect(linkAudits).toHaveLength(1);
      expect(linkAudits[0]!.target_ids).toContain(minor.linkId);

      const allAudits = await tx<{ action: string }[]>`
        select action from app.audit_events
      `;
      const stringified = JSON.stringify(allAudits);
      expect(stringified).not.toContain("SecretMinorName");
      expect(stringified).not.toContain("SecretMinorFamily");
      expect(stringified).not.toContain("ConfidentialFamilyLabel");
    });
  });
});
