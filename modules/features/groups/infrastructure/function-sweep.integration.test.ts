import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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

import * as groups from "../public/index.js";
import { cleanScope, loadRuntime, roleUrl } from "../test/fixtures/real-scope.js";

// The groups half of the function sweep (plan amendment A2, Task 5). The people sweep cannot call
// a groups function: @community-hub/groups depends on @community-hub/people, so a people test
// cannot import it. This file is the same two checks, for this package:
//
//  1. Every runtime export of the groups `public/` index is classified in the table below, and the
//     table fails when a new export is not in it (pin 43b).
//  2. Every function is called against seeded children, under a Community Admin's view and
//     everyone else's, and no answer holds a seeded child's name, email, phone, date of birth or
//     birthday. Under "presence" no answer holds a child's person id either.
//
// Each call runs in its own transaction that is rolled back, so the sweep never changes what it
// seeded and the order of the calls does not matter.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GROUPS_INDEX = path.resolve(HERE, "../public/index.ts");

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-11-28T00:00:00+11:00");

// ---------------------------------------------------------------------------------------------
// The export table (pin 43b)
// ---------------------------------------------------------------------------------------------

// checked           a reader, called under each child view it takes; no child value may come back.
// writer            writes; called with each child; its answer carries ids, a role and a date only.
// fact              a boolean about a group and a person; called with each child.
// type-or-constant  not a function that touches a person.
type ExportClass = "checked" | "writer" | "fact" | "type-or-constant";

type Entry = readonly [ExportClass, string];

const GROUPS_EXPORTS: Record<string, Entry> = {
  GroupsError: ["type-or-constant", "the error class; it carries a code and nothing else"],
  createGroup: ["writer", "a group holds no person field; returns the group"],
  updateGroup: ["writer", "a group holds no person field; returns the group"],
  archiveGroup: ["writer", "a group holds no person field; returns the group"],
  restoreGroup: ["writer", "a group holds no person field; returns the group"],
  listGroups: ["checked", "groups only; no person field"],
  readGroup: ["checked", "a group only; no person field"],
  activeGroupsForPersons: ["checked", "group ids and names for people the view may show"],
  addMember: ["writer", "a minor member is a Community Admin's; the answer is ids and a role"],
  removeMember: ["writer", "a minor member is a Community Admin's; the answer is a boolean"],
  setMemberRole: ["writer", "a minor member is a Community Admin's; the answer is nothing"],
  listMembers: ["checked", "a minor is counted, or an id and a label for a Community Admin"],
  groupLeaderFact: ["fact", "a boolean about a group and a person; no field"],
  personIdsInGroup: ["checked", "ids only; a minor's id only for a Community Admin"],
  exportRosterCsv: ["checked", "children omitted, or the label alone for a Community Admin"],
};

// The runtime export names of a `public/index.ts`: named exports that are not type-only, and
// exported functions, classes and constants. `export *` is refused because it would hide names
// from this table.
function runtimeExportNames(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) {
        continue;
      }
      const clause = statement.exportClause;
      if (clause === undefined) {
        throw new Error(`${fileName}: export * hides names from the function sweep`);
      }
      if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (!element.isTypeOnly) {
            names.push(element.name.text);
          }
        }
      } else {
        names.push(clause.name.text);
      }
      continue;
    }
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) {
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}

function unclassified(names: string[], table: Record<string, Entry>): string[] {
  return names.filter((name) => !(name in table)).sort();
}

function stale(names: string[], table: Record<string, Entry>): string[] {
  const present = new Set(names);
  return Object.keys(table)
    .filter((name) => !present.has(name))
    .sort();
}

describe("groups function sweep: the export table", () => {
  it("pin 43b: every export of the groups public index is classified", () => {
    const names = runtimeExportNames(GROUPS_INDEX, readFileSync(GROUPS_INDEX, "utf8"));
    expect(names.length).toBeGreaterThan(10);

    // A new export fails here until it is classified, with a reason.
    expect(unclassified(names, GROUPS_EXPORTS)).toEqual([]);
    // A removed export leaves a stale row: remove it.
    expect(stale(names, GROUPS_EXPORTS)).toEqual([]);

    for (const [name, [exportClass, reason]] of Object.entries(GROUPS_EXPORTS)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(5);
      expect(exportClass).toMatch(/^(checked|writer|fact|type-or-constant)$/);
    }
  });

  describe("the check itself (must-fail fixtures)", () => {
    it("reads named, aliased and declared runtime exports and skips type-only ones", () => {
      const names = runtimeExportNames(
        "fixture.ts",
        `export { a, b as c, type D } from "./x.js";
         export type { E } from "./y.js";
         export const F = 1;
         export function g() {}
         export class H {}
         export type I = string;
         export interface J {}`,
      );
      expect(names.sort()).toEqual(["F", "H", "a", "c", "g"]);
    });

    it("refuses export *, which would hide names", () => {
      expect(() => runtimeExportNames("fixture.ts", `export * from "./x.js";`)).toThrow(
        /hides names/,
      );
    });

    it("reports an export that is not in the table, and a row that is no longer exported", () => {
      const table: Record<string, Entry> = { kept: ["writer", "a reason"], gone: ["writer", "x"] };
      expect(unclassified(["kept", "added"], table)).toEqual(["added"]);
      expect(stale(["kept", "added"], table)).toEqual(["gone"]);
    });
  });

  it("is in step with the module namespace: every runtime name the table lists exists", () => {
    const runtimeKeys = new Set(Object.keys(groups));
    for (const name of Object.keys(GROUPS_EXPORTS)) {
      expect(runtimeKeys.has(name), `${name} is not exported by @community-hub/groups`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------

type Scope = { orgId: string; communityId: string };

type ChildSeed = {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  birthdayMd: number;
};

// Unusual on purpose, and distinct for every child, so a substring hit is never a coincidence.
const GIVEN = [
  "Zephyrine",
  "Quillon",
  "Thessaly",
  "Brannoch",
  "Ottoline",
  "Perpetua",
  "Corvinus",
  "Maelisande",
];
const FAMILY = [
  "Vandermolen",
  "Ashgrovekell",
  "Fennimore",
  "Hollowaybrandt",
  "Tremaynel",
  "Oglethorpevoss",
  "Penhaligon",
  "Rosevearne",
];
const BIRTHDAYS = [
  "2014-03-07",
  "2016-11-22",
  "2012-08-19",
  "2017-01-30",
  "2013-04-04",
  "2015-09-09",
  "2011-12-25",
  "2018-06-13",
];

function childSeed(n: number): ChildSeed {
  const dateOfBirth = BIRTHDAYS[n] ?? "2015-05-05";
  const [, month, day] = dateOfBirth.split("-").map(Number);
  return {
    givenName: GIVEN[n] ?? `Given${n}`,
    familyName: FAMILY[n] ?? `Family${n}`,
    email: `${(GIVEN[n] ?? "g").toLowerCase()}.${(FAMILY[n] ?? "f").toLowerCase()}@gsweep.example.test`,
    phone: `+6140066${6100 + n}`,
    dateOfBirth,
    birthdayMd: (month ?? 0) * 100 + (day ?? 0),
  };
}

type Seeded = {
  index: number;
  scope: Scope;
  groupId: string;
  otherGroupId: string;
  adultId: string;
  outsiderId: string;
  childIds: [string, string];
  children: [ChildSeed, ChildSeed];
};

let platform: ReturnType<typeof createPlaintextPlatformSql>;
let app: ReturnType<typeof createPlaintextAppSql>;
let directSql: ReturnType<typeof createPlaintextDirectSql>;

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

const kms: KmsPort = createTestKms();
const orgIds: string[] = [];

function inScope<T>(scope: Scope, run: (tx: AppTransaction) => Promise<T>): Promise<T> {
  return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, run));
}

async function newOrganisation(): Promise<[Scope, Scope]> {
  const orgId = newId();
  const first = newId();
  const second = newId();
  orgIds.push(orgId);
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.organisations (id, slug, region, kind)
      values (${orgId}, ${`gsweep-org-${orgId}`}, 'au', 'implicit')
    `;
    for (const communityId of [first, second]) {
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${orgId}, ${`gsweep-comm-${communityId}`}, 'au')
      `;
    }
  });
  return [
    { orgId, communityId: first },
    { orgId, communityId: second },
  ];
}

async function seedScope(index: number, scope: Scope): Promise<Seeded> {
  const first = childSeed(index * 2);
  const second = childSeed(index * 2 + 1);
  return inScope(scope, async (tx) => {
    const actorUserId = newId();
    const group = await groups.createGroup(tx, {
      name: `Sweep servers ${index}`,
      kind: "ministry",
      now: NOW,
      actorUserId,
    });
    const other = await groups.createGroup(tx, {
      name: `Sweep juniors ${index}`,
      kind: "ministry",
      now: NOW,
      actorUserId,
    });
    const household = await createHousehold(tx, kms, KEY_ARN, {
      now: NOW,
      label: `Gsweep household ${index}`,
      actorUserId,
    });
    const adult = await createPerson(tx, kms, KEY_ARN, {
      now: NOW,
      declaredAdult: true,
      householdId: household.householdId,
      dateOfBirth: "1980-07-15",
      givenName: "Aurelia",
      familyName: `Marchetti${index}`,
      email: `aurelia${index}.marchetti@gsweep.example.test`,
      phone: `+6140066500${index}`,
      actorUserId,
    });
    const outsider = await createPerson(tx, kms, KEY_ARN, {
      now: NOW,
      declaredAdult: true,
      householdId: null,
      dateOfBirth: null,
      givenName: "Olivier",
      familyName: `Outsider${index}`,
      email: null,
      phone: null,
      actorUserId,
    });
    await groups.addMember(tx, kms, KEY_ARN, {
      groupId: group.id,
      personId: adult.personId,
      role: "leader",
      now: NOW,
      actorUserId,
      childView: "presence",
    });
    const childIds: string[] = [];
    for (const [offset, seed] of [first, second].entries()) {
      const child = await createPerson(tx, kms, KEY_ARN, {
        now: new Date(NOW.getTime() + offset * 3_600_000),
        declaredAdult: false,
        householdId: household.householdId,
        dateOfBirth: seed.dateOfBirth,
        givenName: seed.givenName,
        familyName: seed.familyName,
        email: seed.email,
        phone: seed.phone,
        actorUserId,
      });
      childIds.push(child.personId);
      await groups.addMember(tx, kms, KEY_ARN, {
        groupId: group.id,
        personId: child.personId,
        now: new Date(NOW.getTime() + (offset + 1) * 1000),
        actorUserId,
        childView: "admin",
      });
      await groups.addMember(tx, kms, KEY_ARN, {
        groupId: other.id,
        personId: child.personId,
        now: NOW,
        actorUserId,
        childView: "admin",
      });
    }
    const [one, two] = childIds;
    if (one === undefined || two === undefined) {
      throw new Error("two children were not seeded");
    }
    return {
      index,
      scope,
      groupId: group.id,
      otherGroupId: other.id,
      adultId: adult.personId,
      outsiderId: outsider.personId,
      childIds: [one, two],
      children: [first, second],
    };
  });
}

type View = "admin" | "presence";

type Ctx = {
  tx: AppTransaction;
  kms: KmsPort;
  // The group, adult and children whose ids the call is given. It is the scope the call runs in,
  // or another one: then the call asks for rows the scope must not show.
  t: Seeded;
  view: View;
  actor: string;
};

type Call = {
  name: string;
  takesView: boolean;
  label: string;
  run: (ctx: Ctx) => Promise<unknown>;
};

const CALLS: Call[] = [];

function add(
  name: keyof typeof groups,
  takesView: boolean,
  label: string,
  run: (ctx: Ctx) => Promise<unknown>,
): void {
  CALLS.push({ name, takesView, label, run });
}

function addForEachChild(
  name: keyof typeof groups,
  takesView: boolean,
  run: (ctx: Ctx, childId: string) => Promise<unknown>,
): void {
  for (const slot of [0, 1] as const) {
    add(name, takesView, `child ${slot + 1}`, (ctx) => run(ctx, ctx.t.childIds[slot] as string));
  }
}

// readers
add("listGroups", false, "", (x) => groups.listGroups(x.tx, { includeArchived: true }));
add("readGroup", false, "", (x) => groups.readGroup(x.tx, x.t.groupId));
add("activeGroupsForPersons", true, "", (x) =>
  groups.activeGroupsForPersons(x.tx, [x.t.adultId, x.t.outsiderId, ...x.t.childIds], {
    childView: x.view,
  }),
);
add("listMembers", true, "", (x) =>
  groups.listMembers(x.tx, x.kms, KEY_ARN, {
    groupId: x.t.groupId,
    actorUserId: x.actor,
    childView: x.view,
  }),
);
add("listMembers", true, "a group of children only", (x) =>
  groups.listMembers(x.tx, x.kms, KEY_ARN, {
    groupId: x.t.otherGroupId,
    actorUserId: x.actor,
    childView: x.view,
  }),
);
add("personIdsInGroup", true, "", (x) =>
  groups.personIdsInGroup(x.tx, x.t.groupId, { childView: x.view }),
);
add("personIdsInGroup", true, "a group of children only", (x) =>
  groups.personIdsInGroup(x.tx, x.t.otherGroupId, { childView: x.view }),
);
add("exportRosterCsv", true, "", (x) =>
  groups.exportRosterCsv(x.tx, x.kms, KEY_ARN, {
    groupId: x.t.groupId,
    childView: x.view,
    actorUserId: x.actor,
  }),
);
add("exportRosterCsv", true, "a group of children only", (x) =>
  groups.exportRosterCsv(x.tx, x.kms, KEY_ARN, {
    groupId: x.t.otherGroupId,
    childView: x.view,
    actorUserId: x.actor,
  }),
);
addForEachChild("groupLeaderFact", false, (x, childId) =>
  groups.groupLeaderFact(x.tx, x.t.groupId, childId),
);
add("groupLeaderFact", false, "adult", (x) =>
  groups.groupLeaderFact(x.tx, x.t.groupId, x.t.adultId),
);

// writers: their answers carry ids, a role and a date only, and a child's only to an admin
add("createGroup", false, "", (x) =>
  groups.createGroup(x.tx, {
    name: "Sweep new group",
    kind: "group",
    now: NOW,
    actorUserId: x.actor,
  }),
);
add("updateGroup", false, "", (x) =>
  groups.updateGroup(x.tx, x.t.groupId, { name: "Sweep renamed", now: NOW, actorUserId: x.actor }),
);
add("archiveGroup", false, "", (x) =>
  groups.archiveGroup(x.tx, x.t.groupId, { now: NOW, actorUserId: x.actor }),
);
add("restoreGroup", false, "", (x) =>
  groups.restoreGroup(x.tx, x.t.groupId, { now: NOW, actorUserId: x.actor }),
);
add("addMember", true, "adult", (x) =>
  groups.addMember(x.tx, x.kms, KEY_ARN, {
    groupId: x.t.otherGroupId,
    personId: x.t.adultId,
    now: NOW,
    actorUserId: x.actor,
    childView: x.view,
  }),
);
addForEachChild("addMember", true, (x, childId) =>
  groups.addMember(x.tx, x.kms, KEY_ARN, {
    groupId: x.t.groupId,
    personId: childId,
    now: NOW,
    actorUserId: x.actor,
    childView: x.view,
  }),
);
addForEachChild("removeMember", true, (x, childId) =>
  groups.removeMember(x.tx, {
    groupId: x.t.groupId,
    personId: childId,
    now: NOW,
    actorUserId: x.actor,
    childView: x.view,
  }),
);
addForEachChild("setMemberRole", true, (x, childId) =>
  groups.setMemberRole(x.tx, {
    groupId: x.t.groupId,
    personId: childId,
    role: "leader",
    now: NOW,
    actorUserId: x.actor,
    childView: x.view,
  }),
);
add("removeMember", true, "adult", (x) =>
  groups.removeMember(x.tx, {
    groupId: x.t.groupId,
    personId: x.t.adultId,
    now: NOW,
    actorUserId: x.actor,
    childView: x.view,
  }),
);
add("setMemberRole", true, "adult", (x) =>
  groups.setMemberRole(x.tx, {
    groupId: x.t.groupId,
    personId: x.t.adultId,
    role: "member",
    now: NOW,
    actorUserId: x.actor,
    childView: x.view,
  }),
);

// JSON for the leak search. A Map and a Set would otherwise serialise as {}.
function serialise(value: unknown): string {
  const text = JSON.stringify(value, (_key, inner: unknown) => {
    if (inner instanceof Map) {
      return { map: [...inner.entries()] };
    }
    if (inner instanceof Set) {
      return [...inner];
    }
    if (typeof inner === "bigint") {
      return String(inner);
    }
    return inner;
  });
  // JSON.stringify(undefined) is undefined, not a string.
  return text ?? "undefined";
}

function describeError(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as { name?: unknown; code?: unknown; message?: unknown };
    parts.push(`${String(record.name)}|${String(record.code)}|${String(record.message)}`);
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return parts.join(" <- ");
}

const ROLLBACK = new Error("sweep rollback");

// Runs one call in its own transaction and rolls it back. The answer, or the error it raised, is
// serialised: a refusal that carried a value would be a leak too.
async function observe(
  self: Seeded,
  run: (tx: AppTransaction) => Promise<unknown>,
): Promise<string> {
  let out = "";
  try {
    await inScope(self.scope, async (tx) => {
      try {
        out = serialise(await run(tx));
      } catch (error) {
        out = describeError(error);
      }
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) {
      throw error;
    }
  }
  return out;
}

// Every seeded child value found in the text. Under "presence" a child's person id counts too.
function leaks(
  text: string,
  everyChild: ChildSeed[],
  everyChildId: string[],
  ids: boolean,
): string[] {
  const found: string[] = [];
  everyChild.forEach((child, index) => {
    const checks: [string, string][] = [
      ["given name", child.givenName],
      ["family name", child.familyName],
      ["email", child.email],
      ["phone", child.phone],
      ["phone digits", child.phone.slice(1)],
      ["date of birth", child.dateOfBirth],
    ];
    for (const [what, value] of checks) {
      if (text.includes(value)) {
        found.push(`child ${index} ${what}`);
      }
    }
    if (new RegExp(`"birthdayMd":\\s*${child.birthdayMd}(?![0-9])`).test(text)) {
      found.push(`child ${index} birthdayMd`);
    }
  });
  if (ids) {
    everyChildId.forEach((id, index) => {
      if (text.includes(id)) {
        found.push(`child ${index} person id`);
      }
    });
  }
  return found;
}

describe("groups function sweep: no export returns a seeded child's value", () => {
  const seeded: Seeded[] = [];

  beforeAll(async () => {
    const runtime = loadRuntime();
    directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    await applyProductMigrations(directSql);
    platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const scopes: Scope[] = [...(await newOrganisation()), ...(await newOrganisation())];
    for (const [index, scope] of scopes.entries()) {
      seeded.push(await seedScope(index, scope));
    }
  }, 120_000);

  afterAll(async () => {
    for (const orgId of orgIds) {
      await cleanScope(directSql, { orgId, communityId: "" });
    }
    await Promise.all([
      platform?.end({ timeout: 1 }),
      app?.end({ timeout: 1 }),
      directSql?.end({ timeout: 1 }),
    ]);
  });

  it("seeds two organisations with two communities, each with groups holding an adult and two children", () => {
    expect(seeded).toHaveLength(4);
    expect(new Set(seeded.map((s) => s.scope.orgId)).size).toBe(2);
    expect(new Set(seeded.map((s) => s.scope.communityId)).size).toBe(4);
    for (const family of seeded) {
      expect(family.childIds).toHaveLength(2);
    }
  });

  it("pin 44c: no groups export returns a seeded child's value, or a child's id under presence", async () => {
    const everyChild = seeded.flatMap((family) => family.children);
    const everyChildId = seeded.flatMap((family) => family.childIds);
    const problems: string[] = [];
    const called = new Set<string>();
    let observed = 0;
    let nonEmpty = 0;

    for (const self of seeded) {
      // Its own ids, and the ids of the next scope in the ring: another community of the same
      // organisation (0 to 1, 2 to 3) or another organisation (1 to 2, 3 to 0).
      const targets = [self, seeded[(self.index + 1) % seeded.length] as Seeded];
      for (const t of targets) {
        for (const call of CALLS) {
          const views: View[] = call.takesView ? ["presence", "admin"] : ["presence"];
          for (const view of views) {
            const actor = newId();
            const answer = await observe(self, (tx) => call.run({ tx, kms, t, view, actor }));
            called.add(call.name);
            observed += 1;
            if (answer.length > 0 && answer !== "undefined") {
              nonEmpty += 1;
            }
            for (const found of leaks(answer, everyChild, everyChildId, view === "presence")) {
              problems.push(
                `${call.name}(${call.label}) as ${view}, scope ${self.index} with the ids of scope ${t.index}: ${found}`,
              );
            }
          }
        }
      }
    }

    expect(problems).toEqual([]);
    // The sweep did run: calls were made and most of them answered something.
    expect(observed).toBeGreaterThan(300);
    expect(nonEmpty).toBeGreaterThan(observed / 2);

    // The table does not claim a call that never happened.
    const claimed = Object.entries(GROUPS_EXPORTS)
      .filter(([, [exportClass]]) => ["checked", "writer", "fact"].includes(exportClass))
      .map(([name]) => name);
    expect(claimed.filter((name) => !called.has(name)).sort()).toEqual([]);
  }, 600_000);

  it("the sweep can find a leak: the search sees a seeded value, and under presence an id", () => {
    const everyChild = seeded.flatMap((family) => family.children);
    const everyChildId = seeded.flatMap((family) => family.childIds);
    const first = everyChild[0] as ChildSeed;
    const firstId = everyChildId[0] as string;
    expect(leaks(serialise({ name: first.givenName }), everyChild, everyChildId, true)).toEqual([
      "child 0 given name",
    ]);
    expect(leaks(serialise({ md: first.birthdayMd }), everyChild, everyChildId, true)).toEqual([]);
    expect(leaks(`{"birthdayMd":${first.birthdayMd}}`, everyChild, everyChildId, true)).toEqual([
      "child 0 birthdayMd",
    ]);
    expect(
      leaks(serialise(new Map([["x", { email: first.email }]])), everyChild, everyChildId, true),
    ).toContain("child 0 email");
    expect(
      leaks(describeError(new Error(first.familyName)), everyChild, everyChildId, true),
    ).toEqual(["child 0 family name"]);
    // A child's id is a leak under presence and not under admin.
    expect(leaks(serialise([firstId]), everyChild, everyChildId, true)).toEqual([
      "child 0 person id",
    ]);
    expect(leaks(serialise([firstId]), everyChild, everyChildId, false)).toEqual([]);
  });
});
