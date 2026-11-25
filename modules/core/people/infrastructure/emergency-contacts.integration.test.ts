import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encrypt } from "@community-hub/crypto";
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
  hideHousehold,
  listHouseholds,
  purgeDeletedHouseholds,
  readEmergencyContacts,
  readHouseholdDetail,
  saveEmergencyContacts,
} from "../public/index.js";
import { householdFieldKeys, openField } from "./household.js";

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
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-11-01T00:00:00+11:00");
const ACTOR = "00000000-0000-4000-8000-000000000002";

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

describe("emergency contacts infrastructure", () => {
  let runtime: Runtime;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let migrator: ReturnType<typeof createPlaintextDirectSql>;
  const kms = createLocalKmsPort();

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

  async function setupSecondCommunity(orgId: string, slugPrefix: string): Promise<string> {
    const communityId = newId();
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${orgId}, ${`${slugPrefix}-${communityId}`}, 'au')
      `;
    });
    return communityId;
  }

  function inScope<T>(scope: Scope, fn: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, fn));
  }

  async function createHouseholdRow(
    scope: Scope,
    label: string | null = "Family",
  ): Promise<{ householdId: string; version: number }> {
    return inScope(scope, async (tx) => {
      return createHousehold(tx, kms, KEY_ARN, {
        now: NOW,
        label,
        actorUserId: ACTOR,
      });
    });
  }

  async function ageHousehold(scope: Scope, householdId: string, hours = 721): Promise<void> {
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx.unsafe("ALTER TABLE app.households DISABLE TRIGGER USER");
      await tx`
        update app.households
        set deleted_at = now() - (${hours} * interval '1 hour'),
            deleted_by = ${newId()}
        where id = ${householdId}::uuid
      `;
      await tx.unsafe("ALTER TABLE app.households ENABLE TRIGGER USER");
    });
  }

  // Pin 54: emergency contacts are sealed under the household key and bound to the household row
  it("emergency contacts are sealed under the household key and bound to the household row", async () => {
    const scope = await setupTenant("pin54");
    const hh1 = await createHouseholdRow(scope, "Fam 1");
    const hh2 = await createHouseholdRow(scope, "Fam 2");

    const contacts = [
      { name: "John Contact", relationship: "friend" as const, phone: "+61 412 555 101" },
    ];

    await inScope(scope, async (tx) => {
      await saveEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh1.householdId,
        version: hh1.version,
        contacts,
        actorUserId: ACTOR,
      });
    });

    // Read back in scope
    await expect(
      inScope(scope, async (tx) => {
        return await readEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh1.householdId,
          actorUserId: ACTOR,
        });
      }),
    ).resolves.toEqual({
      householdId: hh1.householdId,
      version: hh1.version + 1,
      contacts: [{ name: "John Contact", relationship: "friend", phone: "61412555101" }],
    });

    // Read raw ciphertext bytes from app.households
    const [row1] = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ emergency_contacts: Uint8Array | null }[]>`
        select emergency_contacts
        from app.households
        where id = ${hh1.householdId}::uuid
      `;
    });
    expect(row1?.emergency_contacts).not.toBeNull();

    // Bound to household row: copying bytes to hh2's row fails to open
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        update app.households
        set emergency_contacts = ${row1!.emergency_contacts}
        where id = ${hh2.householdId}::uuid
      `;
    });

    await inScope(scope, async (tx) => {
      await expect(
        readEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh2.householdId,
          actorUserId: ACTOR,
        }),
      ).rejects.toThrow("malformed stored emergency contacts");
    });
  });

  // Test 4: emergency contacts are bound to the household row
  it("emergency contacts are bound to the household row", async () => {
    const scope = await setupTenant("bound-row");
    const hh1 = await createHouseholdRow(scope, "Fam 1");
    const hh2 = await createHouseholdRow(scope, "Fam 2");

    const contacts = [
      { name: "John Contact", relationship: "friend" as const, phone: "+61 412 555 101" },
    ];

    await inScope(scope, async (tx) => {
      await saveEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh1.householdId,
        version: hh1.version,
        contacts,
        actorUserId: ACTOR,
      });
    });

    const [row1] = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ emergency_contacts: Uint8Array | null }[]>`
        select emergency_contacts
        from app.households
        where id = ${hh1.householdId}::uuid
      `;
    });
    expect(row1?.emergency_contacts).not.toBeNull();

    // Positive control: opens with its own householdId as rowId
    await inScope(scope, async (tx) => {
      const { enc } = await householdFieldKeys(tx, kms, KEY_ARN, hh1.householdId);
      const opened = await openField(
        row1!.emergency_contacts,
        enc,
        hh1.householdId,
        scope.communityId,
        "people.household_emergency_contacts",
      );
      expect(opened).not.toBeNull();
      expect(JSON.parse(opened!)).toEqual([
        { name: "John Contact", relationship: "friend", phone: "61412555101" },
      ]);
    });

    // Negative control: refused ("decryption failed") with another household id as rowId
    await inScope(scope, async (tx) => {
      const { enc } = await householdFieldKeys(tx, kms, KEY_ARN, hh1.householdId);
      await expect(
        openField(
          row1!.emergency_contacts,
          enc,
          hh2.householdId,
          scope.communityId,
          "people.household_emergency_contacts",
        ),
      ).rejects.toThrow("decryption failed");
    });
  });

  // Pin 55: emergency contacts cannot be opened as a family label
  it("emergency contacts cannot be opened as a family label", async () => {
    const scope = await setupTenant("pin55");
    const hh = await createHouseholdRow(scope, "Fam Pin 55");

    const contacts = [
      { name: "Sarah Responder", relationship: "carer" as const, phone: "+61 412 555 201" },
    ];

    await inScope(scope, async (tx) => {
      await saveEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        version: hh.version,
        contacts,
        actorUserId: ACTOR,
      });
    });

    const [row] = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ emergency_contacts: Uint8Array | null }[]>`
        select emergency_contacts
        from app.households
        where id = ${hh.householdId}::uuid
      `;
    });
    expect(row?.emergency_contacts).not.toBeNull();

    await inScope(scope, async (tx) => {
      const { enc } = await householdFieldKeys(tx, kms, KEY_ARN, hh.householdId);

      // Positive control: the same bytes open with the label people.household_emergency_contacts
      const opened = await openField(
        row!.emergency_contacts,
        enc,
        hh.householdId,
        scope.communityId,
        "people.household_emergency_contacts",
      );
      expect(opened).not.toBeNull();
      expect(JSON.parse(opened!)).toEqual([
        { name: "Sarah Responder", relationship: "carer", phone: "61412555201" },
      ]);

      // Negative control: trying to open the emergency_contacts ciphertext using the label AAD label must fail
      await expect(
        openField(
          row!.emergency_contacts,
          enc,
          hh.householdId,
          scope.communityId,
          "people.household_label",
        ),
      ).rejects.toThrow("decryption failed");
    });
  });

  // Pin 56: refuses a sixth emergency contact
  it("refuses a sixth emergency contact", async () => {
    const scope = await setupTenant("pin56");
    const hh = await createHouseholdRow(scope, "Fam Pin 56");

    const sixContacts = [
      { name: "Contact 1", relationship: "spouse" as const, phone: "+61 412 555 301" },
      { name: "Contact 2", relationship: "relative" as const, phone: "+61 412 555 302" },
      { name: "Contact 3", relationship: "friend" as const, phone: "+61 412 555 303" },
      { name: "Contact 4", relationship: "neighbour" as const, phone: "+61 412 555 304" },
      { name: "Contact 5", relationship: "grandparent" as const, phone: "+61 412 555 305" },
      { name: "Contact 6", relationship: "other" as const, phone: "+61 412 555 306" },
    ];

    await inScope(scope, async (tx) => {
      await expect(
        saveEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          version: hh.version,
          contacts: sixContacts,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  // Pin 57: refuses a relationship outside the list, a child included
  it("refuses a relationship outside the list, a child included", async () => {
    const scope = await setupTenant("pin57");
    const hh = await createHouseholdRow(scope, "Fam Pin 57");

    await inScope(scope, async (tx) => {
      await expect(
        saveEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          version: hh.version,
          contacts: [
            { name: "Little Timmy", relationship: "child" as never, phone: "+61 412 555 401" },
          ],
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  // Pin 58: a stale version on emergency contacts save answers conflict and changes nothing
  it("a stale version on emergency contacts save answers conflict and changes nothing", async () => {
    const scope = await setupTenant("pin58");
    const hh = await createHouseholdRow(scope, "Fam Pin 58");

    const contacts = [
      { name: "Valid Person", relationship: "friend" as const, phone: "+61 412 555 501" },
    ];

    await inScope(scope, async (tx) => {
      await expect(
        saveEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          version: hh.version + 99,
          contacts,
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    });

    const [row] = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ version: number; emergency_contacts: Uint8Array | null }[]>`
        select version, emergency_contacts
        from app.households
        where id = ${hh.householdId}::uuid
      `;
    });
    expect(row?.version).toBe(hh.version);
    expect(row?.emergency_contacts).toBeNull();
  });

  // Test 6: two emergency contacts saves from one version: the second waits and answers conflict
  it("two emergency contacts saves from one version: the second waits and answers conflict", async () => {
    const scope = await setupTenant("save-conflict-lock");
    const hh = await createHouseholdRow(scope, "Fam Lock Concurrency");

    const contacts1 = [
      { name: "First Saver", relationship: "friend" as const, phone: "+61 412 555 111" },
    ];
    const contacts2 = [
      { name: "Second Saver", relationship: "spouse" as const, phone: "+61 412 555 222" },
    ];

    const app1 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const app2 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const inspector = createPlaintextDirectSql(runtime.productOnlyUrl);

    let releaseT1!: () => void;
    const releaseT1P = new Promise<void>((res) => {
      releaseT1 = res;
    });
    let t1Ready!: () => void;
    const t1ReadyP = new Promise<void>((res) => {
      t1Ready = res;
    });

    let t1Open = false;
    const t1Promise = withAppTransaction(app1, scope, async (tx) => {
      const res = await withRequest({ requestId: REQUEST_ID }, () =>
        saveEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          version: hh.version,
          contacts: contacts1,
          actorUserId: ACTOR,
        }),
      );
      t1Open = true;
      t1Ready();
      await releaseT1P;
      t1Open = false;
      return res;
    }).catch((err) => {
      t1Open = false;
      t1Ready();
      throw err;
    });

    await t1ReadyP;

    let t2Pid: number | null = null;
    let t2Settled = false;
    const t2Promise = withAppTransaction(app2, scope, async (tx) => {
      const [pidRow] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      t2Pid = pidRow?.pid ?? null;
      return await withRequest({ requestId: REQUEST_ID }, () =>
        saveEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          version: hh.version,
          contacts: contacts2,
          actorUserId: ACTOR,
        }),
      );
    }).finally(() => {
      t2Settled = true;
    });
    t2Promise.catch(() => {});

    let blocked = false;
    const started = Date.now();
    while (Date.now() - started < 10_000 && !t2Settled) {
      if (t2Pid !== null) {
        const rows = await inspector<{ count: number }[]>`
          select count(*)::int as count
          from pg_locks l
          join pg_stat_activity a on a.pid = l.pid
          where l.pid = ${t2Pid}
            and l.granted = false
        `;
        if ((rows[0]?.count ?? 0) > 0) {
          blocked = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    try {
      expect(blocked).toBe(true);
      expect(t1Open).toBe(true);
      releaseT1();
      const t1Result = await t1Promise;
      expect(t1Result).toEqual({
        householdId: hh.householdId,
        version: hh.version + 1,
      });

      await expect(t2Promise).rejects.toMatchObject({ code: "conflict" });

      const stored = await inScope(scope, async (tx) => {
        return await readEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          actorUserId: ACTOR,
        });
      });
      expect(stored).toEqual({
        householdId: hh.householdId,
        version: hh.version + 1,
        contacts: [{ name: "First Saver", relationship: "friend", phone: "61412555111" }],
      });
    } finally {
      releaseT1();
      await Promise.allSettled([t1Promise, t2Promise]);
      await app1.end({ timeout: 1 });
      await app2.end({ timeout: 1 });
      await inspector.end({ timeout: 1 });
    }
  }, 30_000);

  // Pin 59: an emergency contacts read writes one event, an empty list too
  it("an emergency contacts read writes one event, an empty list too", async () => {
    const scope = await setupTenant("pin59");
    const hh = await createHouseholdRow(scope, "Fam Pin 59");

    const read = await inScope(scope, async (tx) => {
      return await readEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        actorUserId: ACTOR,
      });
    });

    expect(read).toEqual({
      householdId: hh.householdId,
      version: hh.version,
      contacts: [],
    });

    const events = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ action: string; target_ids: string[] }[]>`
        select action, target_ids::text[] as target_ids
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and action = 'people.household.emergency_contacts_read'
      `;
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.target_ids).toEqual([hh.householdId]);
  });

  // Pin 60: an emergency contacts read of a hidden family answers null and writes no event
  it("an emergency contacts read of a hidden family answers null and writes no event", async () => {
    const scope = await setupTenant("pin60");
    const hh = await createHouseholdRow(scope, "Fam Pin 60");

    await inScope(scope, async (tx) => {
      await saveEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        version: hh.version,
        contacts: [
          { name: "Hidden Contact", relationship: "friend" as const, phone: "+61 412 555 601" },
        ],
        actorUserId: ACTOR,
      });
    });

    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hh.householdId,
        version: hh.version + 1,
        actorUserId: ACTOR,
      });
    });

    const read = await inScope(scope, async (tx) => {
      return await readEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        actorUserId: ACTOR,
      });
    });
    expect(read).toBeNull();

    const readEvents = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ action: string }[]>`
        select action
        from app.audit_events
        where org_id = ${scope.orgId}::uuid
          and action = 'people.household.emergency_contacts_read'
      `;
    });
    expect(readEvents).toHaveLength(0);
  });

  // Pin 61: family list and detail carry no emergency contact field
  it("family list and detail carry no emergency contact field", async () => {
    const scope = await setupTenant("pin61");
    const hh = await createHouseholdRow(scope, "Fam Pin 61");

    await inScope(scope, async (tx) => {
      await saveEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        version: hh.version,
        contacts: [
          { name: "Private Responder", relationship: "carer" as const, phone: "+61 412 555 701" },
        ],
        actorUserId: ACTOR,
      });
    });

    const listResult = await inScope(scope, async (tx) => {
      return await listHouseholds(tx, kms, KEY_ARN, {
        limit: 10,
        includeRestricted: true,
        actorUserId: ACTOR,
      });
    });
    const listItem = listResult.items.find((item) => item.householdId === hh.householdId);
    expect(listItem).toEqual({
      householdId: hh.householdId,
      label: "Fam Pin 61",
      adultCount: 0,
      version: hh.version + 1,
      status: "active",
    });

    const detailResult = await inScope(scope, async (tx) => {
      return await readHouseholdDetail(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        includeRestricted: true,
        actorUserId: ACTOR,
      });
    });
    expect(detailResult).toEqual({
      householdId: hh.householdId,
      label: "Fam Pin 61",
      version: hh.version + 1,
      adults: [],
      minors: [],
      guardians: [],
      status: "active",
    });
  });

  it("handles multi-tenancy: another community or organisation answers null on read and not_found on save", async () => {
    const scope1 = await setupTenant("tenant1");
    const comm2Id = await setupSecondCommunity(scope1.orgId, "comm2");
    const scope2: Scope = { orgId: scope1.orgId, communityId: comm2Id };
    const scopeOther = await setupTenant("other-org");

    const hh = await createHouseholdRow(scope1, "Scoped Fam");

    // Read from second community -> null
    const readComm2 = await inScope(scope2, async (tx) => {
      return await readEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        actorUserId: ACTOR,
      });
    });
    expect(readComm2).toBeNull();

    // Read from other organisation -> null
    const readOther = await inScope(scopeOther, async (tx) => {
      return await readEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        actorUserId: ACTOR,
      });
    });
    expect(readOther).toBeNull();

    // Save from second community -> not_found
    await inScope(scope2, async (tx) => {
      await expect(
        saveEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          version: hh.version,
          contacts: [],
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    // Save from other organisation -> not_found
    await inScope(scopeOther, async (tx) => {
      await expect(
        saveEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          version: hh.version,
          contacts: [],
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  it("saving to a hidden family answers not_found", async () => {
    const scope = await setupTenant("hidden-save");
    const hh = await createHouseholdRow(scope, "Fam Hidden Save");

    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hh.householdId,
        version: hh.version,
        actorUserId: ACTOR,
      });
    });

    await inScope(scope, async (tx) => {
      await expect(
        saveEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          version: hh.version + 1,
          contacts: [],
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  it("saving or reading a purged family answers not_found / null", async () => {
    const scope = await setupTenant("purged-fam");
    const hh = await createHouseholdRow(scope, "Fam Purged");

    await inScope(scope, async (tx) => {
      await hideHousehold(tx, {
        householdId: hh.householdId,
        version: hh.version,
        actorUserId: ACTOR,
      });
    });
    await ageHousehold(scope, hh.householdId, 725);

    await inScope(scope, async (tx) => {
      await purgeDeletedHouseholds(tx, 50);
    });

    const read = await inScope(scope, async (tx) => {
      return await readEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        actorUserId: ACTOR,
      });
    });
    expect(read).toBeNull();

    await inScope(scope, async (tx) => {
      await expect(
        saveEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          version: hh.version + 1,
          contacts: [],
          actorUserId: ACTOR,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });

  it("contains no plaintext contact names or phone digits in households row bytes or audit rows", async () => {
    const scope = await setupTenant("no-leak");
    const hh = await createHouseholdRow(scope, "Fam Plaintext Check");

    const secretName = "Zaphod Beeblebrox";
    const secretPhoneRaw = "+61 498 555 999";
    const secretPhoneDigits = "498555999";

    await inScope(scope, async (tx) => {
      await saveEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        version: hh.version,
        contacts: [{ name: secretName, relationship: "other" as const, phone: secretPhoneRaw }],
        actorUserId: ACTOR,
      });
      await readEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        actorUserId: ACTOR,
      });
    });

    // Check app.households row bytes
    const [row] = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ row_bytes: string }[]>`
        select encode(emergency_contacts, 'escape') as row_bytes
        from app.households
        where id = ${hh.householdId}::uuid
      `;
    });
    expect(row?.row_bytes).not.toContain(secretName);
    expect(row?.row_bytes).not.toContain(secretPhoneDigits);

    // Check all audit event rows for this organisation
    const auditRows = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<
        {
          action: string;
          purpose: string;
          payload: unknown;
          target_ids: string[];
        }[]
      >`
        select action, purpose, to_jsonb(a) as payload, target_ids::text[] as target_ids
        from app.audit_events a
        where org_id = ${scope.orgId}::uuid
      `;
    });
    for (const audit of auditRows) {
      const serialized = JSON.stringify(audit.payload);
      expect(serialized).not.toContain(secretName);
      expect(serialized).not.toContain(secretPhoneDigits);
    }

    expect(auditRows.length).toBeGreaterThan(0);
    const updatedEvents = auditRows.filter(
      (a) => a.action === "people.household.emergency_contacts_updated",
    );
    const readEvents = auditRows.filter(
      (a) => a.action === "people.household.emergency_contacts_read",
    );
    expect(updatedEvents).toHaveLength(1);
    expect(readEvents).toHaveLength(1);
    expect(updatedEvents[0]?.target_ids).toEqual([hh.householdId]);
    expect(readEvents[0]?.target_ids).toEqual([hh.householdId]);
  });

  it("saving an empty list stores null and bumps version", async () => {
    const scope = await setupTenant("empty-save");
    const hh = await createHouseholdRow(scope, "Fam Empty Save");

    // Save with 1 contact
    await inScope(scope, async (tx) => {
      await saveEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        version: hh.version,
        contacts: [
          { name: "Temp Contact", relationship: "friend" as const, phone: "+61 412 555 801" },
        ],
        actorUserId: ACTOR,
      });
    });

    // Save with empty list
    const saveRes = await inScope(scope, async (tx) => {
      return await saveEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        version: hh.version + 1,
        contacts: [],
        actorUserId: ACTOR,
      });
    });
    expect(saveRes).toEqual({
      householdId: hh.householdId,
      version: hh.version + 2,
    });

    // Verify stored column is null
    const [row] = await withAppTransaction(migrator, scope, async (tx) => {
      return await tx<{ emergency_contacts: Uint8Array | null }[]>`
        select emergency_contacts
        from app.households
        where id = ${hh.householdId}::uuid
      `;
    });
    expect(row?.emergency_contacts).toBeNull();

    // Read returns empty array
    const read = await inScope(scope, async (tx) => {
      return await readEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        actorUserId: ACTOR,
      });
    });
    expect(read).toEqual({
      householdId: hh.householdId,
      version: hh.version + 2,
      contacts: [],
    });
  });

  it("throws a plain Error with fixed message and no content on malformed stored data", async () => {
    const scope = await setupTenant("malformed-data");
    const hh = await createHouseholdRow(scope, "Fam Malformed");

    // Store corrupted bytes
    await withAppTransaction(migrator, scope, async (tx) => {
      await tx`
        update app.households
        set emergency_contacts = '\xdeadbeef'::bytea
        where id = ${hh.householdId}::uuid
      `;
    });

    await inScope(scope, async (tx) => {
      await expect(
        readEmergencyContacts(tx, kms, KEY_ARN, {
          householdId: hh.householdId,
          actorUserId: ACTOR,
        }),
      ).rejects.toThrow("malformed stored emergency contacts");
    });
  });

  // Test 8: validly encrypted JSON with an unknown key in an entry gives malformed stored emergency contacts
  it("validly encrypted JSON with an unknown key in an entry gives malformed stored emergency contacts", async () => {
    const scope = await setupTenant("unknown-key-entry");
    const hh = await createHouseholdRow(scope, "Fam Unknown Key");

    const badPayload = JSON.stringify([
      {
        name: "Valid Name",
        relationship: "friend",
        phone: "+61 412 555 101",
        unexpected_extra_key: "forbidden",
      },
    ]);

    await inScope(scope, async (tx) => {
      const { enc, keyId } = await householdFieldKeys(tx, kms, KEY_ARN, hh.householdId);
      const ciphertext = await encrypt(
        enc,
        new TextEncoder().encode(badPayload),
        uuidToBytes(keyId),
        {
          tag: "chub/field/v1",
          label: "people.household_emergency_contacts",
          rowId: uuidToBytes(hh.householdId),
          communityId: uuidToBytes(scope.communityId),
        },
      );

      await tx`
        update app.households
        set emergency_contacts = ${ciphertext}
        where id = ${hh.householdId}::uuid
      `;
    });

    await inScope(scope, async (tx) => {
      const promise = readEmergencyContacts(tx, kms, KEY_ARN, {
        householdId: hh.householdId,
        actorUserId: ACTOR,
      });
      await expect(promise).rejects.toThrow();
      try {
        await promise;
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe("malformed stored emergency contacts");
      }
    });
  });
});
