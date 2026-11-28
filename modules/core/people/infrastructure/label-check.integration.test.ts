import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { KmsPort } from "@community-hub/crypto";
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
  addAdult,
  addMinor,
  createHousehold,
  createPerson,
  hidePerson,
  openMinorField,
  PeopleError,
  renameHousehold,
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
const NOW = new Date("2026-11-28T09:00:00+11:00");
const ACTOR = "00000000-0000-4000-8000-0000000000a1";
const CHILD_DOB = "2018-05-05";
const REFUSED = "label_contains_child_name";

let platform: ReturnType<typeof createPlaintextPlatformSql>;
let app: ReturnType<typeof createPlaintextAppSql>;
let directSql: ReturnType<typeof createPlaintextDirectSql>;
const kms: KmsPort = createLocalKmsPort();

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

beforeAll(async () => {
  const runtime = loadRuntime();
  directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
  await applyProductMigrations(directSql);
  platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  app = createPlaintextAppSql(roleUrl(runtime, "app"));
});

afterAll(async () => {
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
      values (${orgId}, ${`label-check-org-${orgId}`}, 'au', 'implicit')
    `;
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`label-check-comm-${communityId}`}, 'au')
    `;
  });
  return { orgId, communityId };
}

function inScope<T>(scope: Scope, run: (tx: AppTransaction) => Promise<T>): Promise<T> {
  return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, run));
}

// How a write ended: "resolved", or the code it was refused with.
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PeopleError) {
      return error.code;
    }
    throw error;
  }
  return "resolved";
}

function addPerson(
  tx: AppTransaction,
  householdId: string,
  input: {
    givenName: string;
    familyName?: string;
    declaredAdult: boolean;
    dateOfBirth: string | null;
  },
) {
  return createPerson(tx, kms, KEY_ARN, {
    now: NOW,
    declaredAdult: input.declaredAdult,
    householdId,
    dateOfBirth: input.dateOfBirth,
    givenName: input.givenName,
    familyName: input.familyName ?? "Nguyen",
    email: null,
    phone: null,
    actorUserId: null,
  });
}

function addChild(tx: AppTransaction, householdId: string, givenName: string, familyName?: string) {
  return addPerson(tx, householdId, {
    givenName,
    ...(familyName !== undefined ? { familyName } : {}),
    declaredAdult: false,
    dateOfBirth: CHILD_DOB,
  });
}

function addGrownUp(tx: AppTransaction, householdId: string, givenName: string) {
  return addPerson(tx, householdId, { givenName, declaredAdult: true, dateOfBirth: null });
}

type Family = { householdId: string; adultIds: string[]; childIds: string[] };

// A family with the label, then its adults, then its children (each by given name). A label is
// only ever refused when a child is added or the family is renamed, so a test that needs children
// and a label naming one of them cannot seed it this way: that is the point.
async function seedFamily(
  scope: Scope,
  input: { label: string | null; adults?: string[]; children?: string[] },
): Promise<Family> {
  return inScope(scope, async (tx) => {
    const { householdId } = await createHousehold(tx, kms, KEY_ARN, {
      now: NOW,
      label: input.label,
      actorUserId: null,
    });
    const adultIds: string[] = [];
    for (const givenName of input.adults ?? []) {
      adultIds.push((await addGrownUp(tx, householdId, givenName)).personId);
    }
    const childIds: string[] = [];
    for (const givenName of input.children ?? []) {
      childIds.push((await addChild(tx, householdId, givenName)).personId);
    }
    return { householdId, adultIds, childIds };
  });
}

async function householdRow(
  tx: AppTransaction,
  householdId: string,
): Promise<{ version: number; label: Uint8Array | null }> {
  const rows = await tx<{ version: number; label: Uint8Array | null }[]>`
    select version, label from app.households where id = ${householdId}::uuid
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no household");
  }
  return { version: row.version, label: row.label };
}

async function rename(
  tx: AppTransaction,
  householdId: string,
  label: string | null,
): Promise<{ version: number }> {
  const { version } = await householdRow(tx, householdId);
  return renameHousehold(tx, kms, KEY_ARN, { householdId, version, label, actorUserId: null });
}

// One rename in its own transaction, and how it ended.
function tryRename(scope: Scope, householdId: string, label: string | null): Promise<string> {
  return codeOf(() => inScope(scope, (tx) => rename(tx, householdId, label)));
}

// One new child in its own transaction, and how it ended.
function tryAddChild(
  scope: Scope,
  householdId: string,
  givenName: string,
  familyName?: string,
): Promise<string> {
  return codeOf(() => inScope(scope, (tx) => addChild(tx, householdId, givenName, familyName)));
}

async function childCount(tx: AppTransaction, householdId: string): Promise<number> {
  const rows = await tx<{ n: number }[]>`
    select count(*)::int as n
    from app.persons
    where household_id = ${householdId}::uuid and is_minor = true
  `;
  return rows[0]?.n ?? -1;
}

async function linkCount(tx: AppTransaction, householdId: string): Promise<number> {
  const rows = await tx<{ n: number }[]>`
    select count(*)::int as n
    from app.guardian_links
    where household_id = ${householdId}::uuid
  `;
  return rows[0]?.n ?? -1;
}

async function auditCount(scope: Scope, action?: string): Promise<number> {
  const rows = await directSql<{ n: number }[]>`
    select count(*)::int as n
    from app.audit_events
    where org_id = ${scope.orgId}::uuid
      and (${action ?? null}::text is null or action = ${action ?? null}::text)
  `;
  return rows[0]?.n ?? -1;
}

// Hides a child the way a later chunk will: deleted_at and deleted_by are set. Today the user
// triggers refuse that, so it is done as the migrator with them off (see the other hidden-row tests).
async function hideChild(scope: Scope, personId: string): Promise<void> {
  const deletedBy = newId();
  await withAppTransaction(directSql, scope, async (tx) => {
    await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
    await tx`
      update app.persons
      set deleted_at = now() - interval '1 hour', deleted_by = ${deletedBy}::uuid
      where id = ${personId}::uuid
    `;
    await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
  });
}

// Replaces a child's family name with bytes that cannot be decrypted.
async function breakFamilyName(scope: Scope, personId: string): Promise<void> {
  await withAppTransaction(directSql, scope, async (tx) => {
    await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
    await tx`
      update app.persons
      set family_name_restricted = ${Buffer.alloc(64, 7)}
      where id = ${personId}::uuid
    `;
    await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
  });
}

// Runs `first` in a transaction that stays open, then `second` on another connection. It reports
// whether the second one had to wait on a lock, lets the first commit, and returns how the second
// ended.
async function race(
  scope: Scope,
  first: (tx: AppTransaction) => Promise<unknown>,
  second: (tx: AppTransaction) => Promise<unknown>,
): Promise<{ blocked: boolean; outcome: string }> {
  const firstSql = createPlaintextAppSql(roleUrl(loadRuntime(), "app"));
  const secondSql = createPlaintextAppSql(roleUrl(loadRuntime(), "app"));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const isReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const firstDone = withRequest({ requestId: REQUEST_ID }, () =>
    withAppTransaction(firstSql, scope, async (tx) => {
      await first(tx);
      ready();
      await held;
    }),
  );
  firstDone.catch(() => ready());
  try {
    await isReady;
    let pid: number | undefined;
    let settled = false;
    const secondDone = codeOf(() =>
      withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(secondSql, scope, async (tx) => {
          const rows = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          pid = rows[0]?.pid;
          await second(tx);
        }),
      ),
    ).finally(() => {
      settled = true;
    });
    secondDone.catch(() => {});
    let blocked = false;
    const deadline = Date.now() + 10_000;
    while (!blocked && !settled && Date.now() < deadline) {
      if (pid !== undefined) {
        const rows = await directSql<{ waiting: boolean | null }[]>`
          select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = ${pid}
        `;
        blocked = rows[0]?.waiting === true;
      }
      if (!blocked) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    release();
    await firstDone;
    return { blocked, outcome: await secondDone };
  } finally {
    release();
    await Promise.allSettled([firstDone]);
    await Promise.all([firstSql.end({ timeout: 1 }), secondSql.end({ timeout: 1 })]);
  }
}

describe("the family label check (O3)", () => {
  it("pin 50: renaming to a label holding a child's given name is refused", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, {
      label: "Nguyen",
      adults: ["Linh"],
      children: ["Tom"],
    });

    await inScope(scope, async (tx) => {
      const before = await householdRow(tx, family.householdId);
      expect(await codeOf(() => rename(tx, family.householdId, "Nguyen (Tom)"))).toBe(REFUSED);
      // Refused before the write: the same transaction still sees the old row.
      expect(await householdRow(tx, family.householdId)).toEqual(before);
    });
    expect(await auditCount(scope, "people.household.updated")).toBe(0);
  });

  it("pin 51: adding Tom to a family labelled with Tom in brackets is refused", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, { label: "Nguyen (Tom)", adults: ["Linh"] });
    const add = (tx: AppTransaction, givenName: string) =>
      addMinor(tx, kms, KEY_ARN, {
        now: NOW,
        householdId: family.householdId,
        givenName,
        familyName: "Nguyen",
        dateOfBirth: CHILD_DOB,
        guardianId: family.adultIds[0] ?? "",
        actorUserId: null,
      });

    await inScope(scope, async (tx) => {
      expect(await codeOf(() => add(tx, "Tom"))).toBe(REFUSED);
      // Refused before the insert: no child and no link, even inside the same transaction.
      expect(await childCount(tx, family.householdId)).toBe(0);
      expect(await linkCount(tx, family.householdId)).toBe(0);
    });
    // The label is read as it stands: a child it does not name joins the family.
    expect(await codeOf(() => inScope(scope, (tx) => add(tx, "Bo")))).toBe("resolved");
  });

  it("pin 52: a direct minor createPerson into a family labelled with the child's name is refused", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, { label: "Nguyen (Tom)", adults: ["Linh"] });

    // A dated child, and a person of unknown age, who is a minor until shown otherwise.
    for (const dateOfBirth of [CHILD_DOB, null]) {
      await inScope(scope, async (tx) => {
        const outcome = await codeOf(() =>
          addPerson(tx, family.householdId, {
            givenName: "Tom",
            declaredAdult: false,
            dateOfBirth,
          }),
        );
        expect(outcome, String(dateOfBirth)).toBe(REFUSED);
        expect(await childCount(tx, family.householdId)).toBe(0);
      });
    }
  });

  it("pin 53: Nguyen family is allowed when the child is Tom Nguyen", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, { label: null, adults: ["Linh"], children: ["Tom"] });

    expect(await tryRename(scope, family.householdId, "Nguyen family")).toBe("resolved");
    // A second child, also a Nguyen, joins the family under that label.
    expect(await tryAddChild(scope, family.householdId, "Ava", "Nguyen")).toBe("resolved");
    // The given name is still checked.
    expect(await tryRename(scope, family.householdId, "Tom Nguyen")).toBe(REFUSED);
  });

  it("pin 54: Tomlinson is allowed when the child is Tom", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, { label: null, adults: ["Linh"], children: ["Tom"] });

    // A name part counts only as a whole word: a letter on either side makes it another word.
    for (const label of ["Tomlinson", "Atom Nguyen", "Tomas", "Stom", "Tomé"]) {
      expect(await tryRename(scope, family.householdId, label), label).toBe("resolved");
    }
    // Anything that is not a letter bounds it, as does the edge of the label.
    for (const label of [
      "Tom",
      "Tom's family",
      "(Tom)",
      "Nguyen-Tom",
      "Tom2",
      "The Nguyens: Tom.",
    ]) {
      expect(await tryRename(scope, family.householdId, label), label).toBe(REFUSED);
    }
  });

  it("pin 55: an upper-case TOM and a full-width Tom are refused", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, { label: null, adults: ["Linh"], children: ["Tom"] });

    // U+FF34 is the full-width capital T.
    for (const label of ["TOM", "Ｔom", "tom Nguyen"]) {
      expect(await tryRename(scope, family.householdId, label), label).toBe(REFUSED);
    }

    // The child's name is normalised the same way: full-width capitals, and a composed letter
    // matched by the label that spells it with a combining mark.
    const other = await seedFamily(scope, {
      label: null,
      adults: ["Linh"],
      children: ["ＭＩＡ", "Zoë"],
    });
    for (const label of ["Mia and co", "Zoë house"]) {
      expect(await tryRename(scope, other.householdId, label), label).toBe(REFUSED);
    }
  });

  it("pin 135: accents do not matter: a child Zoë refuses Zoe and ZOE, a child Zoe refuses Zoë (checkpoint 2, L8)", async () => {
    const scope = await newScope();
    // ë as one letter (U+00EB), and as e with a combining diaeresis (U+0308).
    const composed = "Zoë";
    const decomposed = "Zoë";

    // A child with the accent refuses the spelling without it, in any case, and both accented forms.
    const accented = await seedFamily(scope, {
      label: null,
      adults: ["Linh"],
      children: [composed],
    });
    for (const label of ["Zoe", "ZOE", "zoe Nguyen", "Nguyen (Zoe)", composed, "ZOË", decomposed]) {
      expect(await tryRename(scope, accented.householdId, label), label).toBe(REFUSED);
    }
    // A child written without the accent refuses the accented spellings.
    const plain = await seedFamily(scope, { label: null, adults: ["Linh"], children: ["Zoe"] });
    for (const label of [composed, "ZOË", decomposed, `${composed} house`]) {
      expect(await tryRename(scope, plain.householdId, label), label).toBe(REFUSED);
    }
    // A whole word is still a whole word once the marks are gone: Zoey, Zoella and Zoëy are other
    // words than Zoe.
    for (const label of ["Zoey", "Zoella Nguyen", "Zoëy"]) {
      expect(await tryRename(scope, plain.householdId, label), label).toBe("resolved");
    }

    // The same check runs when a child is added to a family whose label holds the other spelling.
    const labelled = await seedFamily(scope, { label: "Nguyen (Zoe)", adults: ["Linh"] });
    expect(await tryAddChild(scope, labelled.householdId, composed)).toBe(REFUSED);
    expect(await tryAddChild(scope, labelled.householdId, "Bo")).toBe("resolved");

    // A name an adult of the family holds is still skipped, whichever way it is spelled.
    const shared = await seedFamily(scope, {
      label: null,
      adults: ["José", "Mary"],
      children: ["Jose"],
    });
    expect(await tryRename(scope, shared.householdId, "Jose and Mary Nguyen")).toBe("resolved");
    // And a name only the child holds is refused beside it.
    expect(await tryAddChild(scope, shared.householdId, "Zoë")).toBe("resolved");
    expect(await tryRename(scope, shared.householdId, "Jose, Mary and Zoe")).toBe(REFUSED);
  });

  it("pin 56: a child called Mary Jane refuses a label holding Jane", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, {
      label: null,
      adults: ["Linh"],
      // A space, a hyphen, a no-break space and a Unicode hyphen each separate the parts.
      children: ["Mary Jane", "Anne-Marie", "Ana Sofia", "Kim‐Lee"],
    });

    for (const label of [
      "Jane Nguyen",
      "Mary's house",
      "Mary Jane",
      "Anne",
      "Marie Nguyen",
      "Sofia",
      "Kim",
      "Lee Nguyen",
    ]) {
      expect(await tryRename(scope, family.householdId, label), label).toBe(REFUSED);
    }
  });

  it("pin 57: Tom and Mary Nguyen is allowed when the father is Tom too", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, {
      label: null,
      adults: ["Tom", "Mary"],
      children: ["Tom"],
    });
    expect(await tryRename(scope, family.householdId, "Tom and Mary Nguyen")).toBe("resolved");
    // A child's name that no adult holds is still refused beside the shared one.
    expect(await tryAddChild(scope, family.householdId, "Bo")).toBe("resolved");
    expect(await tryRename(scope, family.householdId, "Tom, Mary and Bo")).toBe(REFUSED);

    // A family that carries that label already takes the son named after the father.
    const second = await seedFamily(scope, {
      label: "Tom and Mary Nguyen",
      adults: ["Tom", "Mary"],
    });
    expect(await tryAddChild(scope, second.householdId, "Tom")).toBe("resolved");

    // Each part of an adult's given name counts.
    const third = await seedFamily(scope, {
      label: null,
      adults: ["Sam James"],
      children: ["James"],
    });
    expect(await tryRename(scope, third.householdId, "James Nguyen")).toBe("resolved");
  });

  it("pin 58: Mia is refused when only the child is Mia", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, { label: null, adults: ["Linh"], children: ["Mia"] });

    expect(await tryRename(scope, family.householdId, "Mia")).toBe(REFUSED);
    expect(await tryRename(scope, family.householdId, "Linh and Mia")).toBe(REFUSED);
    expect(await tryRename(scope, family.householdId, "Linh Nguyen")).toBe("resolved");

    const second = await seedFamily(scope, { label: "Mia's house", adults: ["Linh"] });
    expect(await tryAddChild(scope, second.householdId, "Mia")).toBe(REFUSED);
  });

  it("pin 59: a child named J does not refuse J and K Nguyen", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, { label: null, adults: ["Linh"], children: ["J"] });

    expect(await tryRename(scope, family.householdId, "J and K Nguyen")).toBe("resolved");
    // One letter is not a name part, with or without a full stop.
    expect(await tryAddChild(scope, family.householdId, "K")).toBe("resolved");
    expect(await tryAddChild(scope, family.householdId, "J.")).toBe("resolved");
    // Two letters are.
    expect(await tryAddChild(scope, family.householdId, "Bo")).toBe("resolved");
    expect(await tryRename(scope, family.householdId, "Bo and K")).toBe(REFUSED);
  });

  it("pin 60: the refusal carries the code and nothing else", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, { label: null, adults: ["Linh"] });
    await inScope(scope, (tx) => addChild(tx, family.householdId, "Zephyrine", "Quillonwick"));
    const labelled = await seedFamily(scope, { label: "Quillon house", adults: ["Linh"] });

    const refusals = [
      await inScope(scope, async (tx) => {
        try {
          await rename(tx, family.householdId, "Zephyrine's family");
        } catch (error) {
          return error;
        }
        return undefined;
      }),
      await inScope(scope, async (tx) => {
        try {
          await addChild(tx, labelled.householdId, "Quillon", "Zephyrwick");
        } catch (error) {
          return error;
        }
        return undefined;
      }),
    ];

    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(PeopleError);
      const error = refusal as PeopleError;
      expect(error.message).toBe(REFUSED);
      expect(error.code).toBe(REFUSED);
      // No cause, no matched part, no label: only what every PeopleError carries.
      expect(Object.getOwnPropertyNames(error).sort()).toEqual([
        "code",
        "message",
        "name",
        "stack",
      ]);
      const text = Object.getOwnPropertyNames(error)
        .map((key) => String((error as unknown as Record<string, unknown>)[key]))
        .join("\n")
        .toLowerCase();
      for (const secret of ["zephyrine", "quillon", "zephyrwick"]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("returns nothing, writes no audit row and logs nothing", async () => {
    const { assertLabelFreeOfChildNames } = await import("./label-check.js");
    const scope = await newScope();
    const family = await seedFamily(scope, {
      label: null,
      adults: ["Linh"],
      children: ["Zephyrine"],
    });
    const before = await auditCount(scope);
    const spies = (["debug", "error", "info", "log", "trace", "warn"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      await inScope(scope, async (tx) => {
        const check = (label: string) =>
          assertLabelFreeOfChildNames(tx, kms, KEY_ARN, {
            householdId: family.householdId,
            label,
          });
        await expect(check("Nguyen")).resolves.toBeUndefined();
        expect(await codeOf(() => check("Zephyrine's house"))).toBe(REFUSED);
        // The child being added counts as a child of the family.
        expect(
          await codeOf(() =>
            assertLabelFreeOfChildNames(tx, kms, KEY_ARN, {
              householdId: family.householdId,
              label: "Quillon house",
              newChildGivenName: "Quillon",
            }),
          ),
        ).toBe(REFUSED);
      });
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
    expect(await auditCount(scope)).toBe(before);
  });

  it("counts the given name of a hidden child", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, {
      label: null,
      adults: ["Linh"],
      children: ["Zephyrine"],
    });
    await hideChild(scope, family.childIds[0] ?? "");

    expect(await tryRename(scope, family.householdId, "Zephyrine house")).toBe(REFUSED);
  });

  it("skips a name only for a current adult of the same family", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, { label: null, adults: ["Linh"], children: ["Tom"] });
    // Another family: its adult Tom excuses nothing here, and the child here refuses nothing there.
    const other = await seedFamily(scope, { label: null, adults: ["Tom"] });
    expect(await tryRename(scope, family.householdId, "Tom house")).toBe(REFUSED);
    expect(await tryRename(scope, other.householdId, "Tom house")).toBe("resolved");

    // A current adult of this family excuses the name.
    const tom = await inScope(scope, (tx) => addGrownUp(tx, family.householdId, "Tom"));
    expect(await tryRename(scope, family.householdId, "Tom house")).toBe("resolved");

    // A hidden adult does not: nobody can read that adult's name now.
    await inScope(scope, (tx) => hidePerson(tx, { personId: tom.personId, actorUserId: ACTOR }));
    expect(await tryRename(scope, family.householdId, "Tom lodge")).toBe(REFUSED);
  });

  it("opens a child's given name only, never the family name", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, {
      label: null,
      adults: ["Linh"],
      children: ["Zephyrine"],
    });
    const childId = family.childIds[0] ?? "";
    await breakFamilyName(scope, childId);
    // The family name really cannot be opened now.
    await expect(
      inScope(scope, (tx) =>
        openMinorField(tx, kms, KEY_ARN, { personId: childId, field: "name" }),
      ),
    ).rejects.toThrow();

    expect(await tryRename(scope, family.householdId, "Nguyen")).toBe("resolved");
    expect(await tryRename(scope, family.householdId, "Zephyrine")).toBe(REFUSED);
    expect(await tryAddChild(scope, family.householdId, "Quillon")).toBe("resolved");
  });

  it("never checks a new family, an adult or a family with no label, and lets a label be cleared", async () => {
    const scope = await newScope();
    // A new family has no children, so creating it checks nothing.
    const named = await seedFamily(scope, { label: "Tom's place" });
    expect(
      await codeOf(() => inScope(scope, (tx) => addGrownUp(tx, named.householdId, "Tom"))),
    ).toBe("resolved");
    expect(
      await codeOf(() =>
        inScope(scope, (tx) =>
          addAdult(tx, kms, KEY_ARN, {
            now: NOW,
            householdId: named.householdId,
            givenName: "Quinn",
            familyName: "Nguyen",
            email: null,
            phone: null,
            dateOfBirth: null,
            actorUserId: null,
          }),
        ),
      ),
    ).toBe("resolved");

    const unlabelled = await seedFamily(scope, {
      label: null,
      adults: ["Linh"],
      children: ["Zephyrine"],
    });
    expect(await tryAddChild(scope, unlabelled.householdId, "Quillon")).toBe("resolved");
    expect(await tryRename(scope, unlabelled.householdId, null)).toBe("resolved");
  });

  it("a rename waits for a child who is being added, and then refuses that child's name", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, { label: "Nguyen", adults: ["Linh"] });

    const ended = await race(
      scope,
      (tx) =>
        addMinor(tx, kms, KEY_ARN, {
          now: NOW,
          householdId: family.householdId,
          givenName: "Zephyrine",
          familyName: "Nguyen",
          dateOfBirth: CHILD_DOB,
          guardianId: family.adultIds[0] ?? "",
          actorUserId: null,
        }),
      (tx) =>
        renameHousehold(tx, kms, KEY_ARN, {
          householdId: family.householdId,
          version: 1,
          label: "Zephyrine's family",
          actorUserId: null,
        }),
    );

    expect(ended).toEqual({ blocked: true, outcome: REFUSED });
  }, 30_000);

  it("adding a child waits for a rename in progress, and is checked against the new label", async () => {
    const scope = await newScope();
    const family = await seedFamily(scope, { label: "Nguyen", adults: ["Linh"] });

    const ended = await race(
      scope,
      (tx) => rename(tx, family.householdId, "Quillon's house"),
      (tx) => addChild(tx, family.householdId, "Quillon"),
    );

    expect(ended).toEqual({ blocked: true, outcome: REFUSED });
  }, 30_000);
});
