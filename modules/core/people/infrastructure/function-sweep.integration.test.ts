import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

import * as people from "../public/index.js";

// The function sweep (spec Risks, plan Task 4). Two checks:
//
//  1. Every runtime export of the people and groups `public/` indexes is classified in a table
//     below, and the table fails when a new export is not in it (pin 43).
//  2. Every function that returns person data, or takes a child view, an actor or a person id, is
//     called against seeded children, as a Community Admin's view and as everyone else's, and the
//     answer is searched for any seeded child value (pin 44).
//
// Each call runs in its own transaction that is rolled back, so the sweep never changes what it
// seeded and the order of the calls does not matter.

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

type Scope = { orgId: string; communityId: string };

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PEOPLE_INDEX = path.resolve(HERE, "../public/index.ts");
const GROUPS_INDEX = path.resolve(HERE, "../../../features/groups/public/index.ts");

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-15T00:00:00+11:00");

// ---------------------------------------------------------------------------------------------
// The export table (pin 43)
// ---------------------------------------------------------------------------------------------

// checked           a reader, called under each child view it takes; no minor value may come back.
// minor-refused     takes a person id and refuses a minor; called with each seeded child.
// adult-only        works on adults or the household as a whole; called, and no minor value may come back.
// writer            writes; its answer carries ids and versions only; called, and its answer is searched.
// field-opener      opens one minor field; the only one, tested in minor-field.integration.test.ts.
// type-or-constant  not a function that touches a person.
// covered-by-GS    a groups export. The groups package depends on this one, so this file cannot
//                   call it: modules/features/groups/infrastructure/function-sweep.integration.test.ts
//                   (GS) classifies the same index and calls every export with a child view.
type ExportClass =
  | "checked"
  | "minor-refused"
  | "adult-only"
  | "writer"
  | "field-opener"
  | "type-or-constant"
  | "covered-by-GS";

type Entry = readonly [ExportClass, string];

const PEOPLE_EXPORTS: Record<string, Entry> = {
  PeopleError: ["type-or-constant", "the error class; it carries a code and nothing else"],
  ensureCommunityKey: ["writer", "key setup; returns a key id, no person data"],
  ensureOrganisationKey: ["writer", "key setup; returns a key id, no person data"],
  createHousehold: ["writer", "creates a household; returns an id and a version"],
  readHousehold: ["checked", "a child count, or labelled ids for a Community Admin"],
  readHouseholdDetail: ["checked", "a child count, or labelled ids for a Community Admin"],
  renameHousehold: ["writer", "returns a version only"],
  listDeletedHouseholds: ["checked", "label and adult count only; no child field"],
  listHouseholds: ["checked", "label and adult count only; no child field"],
  createPerson: ["writer", "returns an id and whether it is a minor"],
  readPerson: ["minor-refused", "a minor reads as null"],
  setPersonStatus: ["minor-refused", "a minor is not found"],
  summarisePersons: ["checked", "counts adults only"],
  updatePerson: ["minor-refused", "a minor is refused"],
  listDeletedPersons: ["checked", "never lists a minor"],
  listPersons: ["checked", "adults, or the Community Admin's list of children as labels"],
  hasGuardianView: ["checked", "a fact about a link; no field"],
  personIsMinor: ["checked", "a fact about a person; no field"],
  householdHasMinor: ["checked", "a fact about a family; no field"],
  guardianLinkChildIsMinor: ["checked", "a fact about a guardian link; no field"],
  lifeEventPersonIsMinor: ["checked", "a fact about a life event; no field"],
  moveAdult: ["minor-refused", "a minor cannot be moved"],
  addMinor: ["writer", "returns ids only"],
  addAdult: ["adult-only", "adds an adult; returns an id"],
  linkGuardian: ["writer", "returns a link id only"],
  unlinkGuardian: ["writer", "returns nothing"],
  listPersonActivity: ["minor-refused", "a minor answers as a person that does not exist"],
  attachTag: ["minor-refused", "a minor is not found"],
  createTag: ["writer", "returns a tag id only"],
  detachTag: ["minor-refused", "a minor is not found"],
  listPersonTags: ["minor-refused", "a minor answers as a person that does not exist"],
  openPersonFieldKeys: ["minor-refused", "a minor's keys are never handed out"],
  readRosterNames: ["checked", "adults by name; a minor is only counted, or an id and a label"],
  visiblePersonIds: ["checked", "ids only; a minor's id only for a Community Admin"],
  readLinkedContacts: ["checked", "a minor is absent, or { minor: true } for a Community Admin"],
  createLifeEvent: ["writer", "returns an id and a version"],
  listLifeEvents: ["checked", "a minor's events are ids only, for a Community Admin only"],
  updateLifeEvent: ["writer", "returns a version only"],
  openMinorField: [
    "field-opener",
    "the one reader of a child's field; see minor-field.integration",
  ],
  purgeDeletedPersons: ["writer", "returns ids of purged persons"],
  purgeDeletedHouseholds: ["writer", "returns ids of purged households"],
  hidePerson: ["minor-refused", "a minor is not found"],
  lockPersonForDelete: ["minor-refused", "a minor is not found"],
  restorePerson: ["minor-refused", "a minor is not found"],
  hideHousehold: ["writer", "a household with children is refused; returns a version"],
  restoreHousehold: ["writer", "returns a version only"],
  setHouseholdStatus: ["writer", "returns a status and a version"],
  EMERGENCY_CONTACT_RELATIONSHIPS: ["type-or-constant", "a constant list"],
  MAX_EMERGENCY_CONTACTS: ["type-or-constant", "a constant number"],
  readEmergencyContacts: ["adult-only", "emergency contacts are adults'"],
  saveEmergencyContacts: ["adult-only", "emergency contacts are adults'; returns a version"],
};

const GROUPS_EXPORTS: Record<string, Entry> = {
  GroupsError: ["type-or-constant", "the error class; it carries a code and nothing else"],
  createGroup: ["covered-by-GS", "no person field; classified and called in the groups sweep"],
  updateGroup: ["covered-by-GS", "no person field; classified and called in the groups sweep"],
  archiveGroup: ["covered-by-GS", "no person field; classified and called in the groups sweep"],
  restoreGroup: ["covered-by-GS", "no person field; classified and called in the groups sweep"],
  listGroups: ["covered-by-GS", "no person field; classified and called in the groups sweep"],
  readGroup: ["covered-by-GS", "no person field; classified and called in the groups sweep"],
  activeGroupsForPersons: ["covered-by-GS", "takes childView; called under both views in GS"],
  addMember: ["covered-by-GS", "takes childView; a minor is a Community Admin's, called in GS"],
  removeMember: ["covered-by-GS", "takes childView; a minor is a Community Admin's, called in GS"],
  setMemberRole: ["covered-by-GS", "takes childView; a minor is a Community Admin's, called in GS"],
  listMembers: ["covered-by-GS", "takes childView; called under both views in GS"],
  groupLeaderFact: ["covered-by-GS", "a fact about a group; no person field; called in GS"],
  personIdsInGroup: ["covered-by-GS", "takes childView; called under both views in GS"],
  exportRosterCsv: ["covered-by-GS", "takes childView; called under both views in GS"],
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

describe("function sweep: the export table", () => {
  it("pin 43: every export of the people and groups public indexes is classified", () => {
    const peopleNames = runtimeExportNames(PEOPLE_INDEX, readFileSync(PEOPLE_INDEX, "utf8"));
    const groupsNames = runtimeExportNames(GROUPS_INDEX, readFileSync(GROUPS_INDEX, "utf8"));
    expect(peopleNames.length).toBeGreaterThan(40);
    expect(groupsNames.length).toBeGreaterThan(10);

    // A new export fails here until it is classified, with a reason.
    expect(unclassified(peopleNames, PEOPLE_EXPORTS)).toEqual([]);
    expect(unclassified(groupsNames, GROUPS_EXPORTS)).toEqual([]);
    // A removed export leaves a stale row: remove it.
    expect(stale(peopleNames, PEOPLE_EXPORTS)).toEqual([]);
    expect(stale(groupsNames, GROUPS_EXPORTS)).toEqual([]);

    for (const [name, [exportClass, reason]] of [
      ...Object.entries(PEOPLE_EXPORTS),
      ...Object.entries(GROUPS_EXPORTS),
    ]) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(5);
      expect(exportClass).toMatch(
        /^(checked|minor-refused|adult-only|writer|field-opener|type-or-constant|covered-by-GS)$/,
      );
    }
    // openMinorField is the one field opener.
    const openers = Object.entries({ ...PEOPLE_EXPORTS, ...GROUPS_EXPORTS })
      .filter(([, [exportClass]]) => exportClass === "field-opener")
      .map(([name]) => name);
    expect(openers).toEqual(["openMinorField"]);
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
    const runtimeKeys = new Set(Object.keys(people));
    for (const name of Object.keys(PEOPLE_EXPORTS)) {
      expect(runtimeKeys.has(name), `${name} is not exported by @community-hub/people`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The sweep (pin 44)
// ---------------------------------------------------------------------------------------------

type ChildSeed = {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  birthdayMd: number;
  place: string;
  notes: string;
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
const PLACES = [
  "Stannary Chapel",
  "Pellucid Abbey",
  "Wexcombe Priory",
  "Ludgvan Oratory",
  "Marazion Minster",
  "Pentreath Kirk",
  "Trevanion Chantry",
  "Carbis Hermitage",
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
    email: `${(GIVEN[n] ?? "g").toLowerCase()}.${(FAMILY[n] ?? "f").toLowerCase()}@sweep.example.test`,
    phone: `+6140055${6100 + n}`,
    dateOfBirth,
    birthdayMd: (month ?? 0) * 100 + (day ?? 0),
    place: PLACES[n] ?? `Place${n}`,
    notes: `${FAMILY[n] ?? "f"} godparents`,
  };
}

type Seeded = {
  index: number;
  scope: Scope;
  householdId: string;
  adultId: string;
  childIds: [string, string];
  eventIds: [string, string];
  adultEventId: string;
  linkIds: [string, string];
  children: [ChildSeed, ChildSeed];
};

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

function inScope<T>(scope: Scope, run: (tx: AppTransaction) => Promise<T>): Promise<T> {
  return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, run));
}

async function newOrganisation(): Promise<[Scope, Scope]> {
  const orgId = newId();
  const first = newId();
  const second = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.organisations (id, slug, region, kind)
      values (${orgId}, ${`sweep-org-${orgId}`}, 'au', 'implicit')
    `;
    for (const communityId of [first, second]) {
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${orgId}, ${`sweep-comm-${communityId}`}, 'au')
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
    const household = await people.createHousehold(tx, kms, KEY_ARN, {
      now: NOW,
      label: `Sweep household ${index}`,
      actorUserId: null,
    });
    const householdId = household.householdId;
    const adult = await people.createPerson(tx, kms, KEY_ARN, {
      now: NOW,
      declaredAdult: true,
      householdId,
      dateOfBirth: "1980-07-15",
      givenName: "Aurelia",
      familyName: `Marchetti${index}`,
      email: `aurelia${index}.marchetti@sweep.example.test`,
      phone: `+6140055500${index}`,
      actorUserId: null,
    });
    const created: { personId: string; eventId: string; linkId: string }[] = [];
    for (const [offset, seed] of [first, second].entries()) {
      const child = await people.createPerson(tx, kms, KEY_ARN, {
        now: new Date(NOW.getTime() + offset * 3_600_000),
        declaredAdult: false,
        householdId,
        dateOfBirth: seed.dateOfBirth,
        givenName: seed.givenName,
        familyName: seed.familyName,
        email: seed.email,
        phone: seed.phone,
        actorUserId: null,
      });
      const event = await people.createLifeEvent(tx, kms, KEY_ARN, {
        personId: child.personId,
        type: "baptism",
        date: "2019-03-03",
        place: seed.place,
        notes: seed.notes,
        actorUserId: null,
        now: NOW,
      });
      const link = await people.linkGuardian(tx, {
        now: NOW,
        householdId,
        guardianPersonId: adult.personId,
        childPersonId: child.personId,
        consent: true,
        pickup: true,
        view: true,
        manage: false,
        actorUserId: null,
      });
      created.push({ personId: child.personId, eventId: event.eventId, linkId: link.linkId });
    }
    const adultEvent = await people.createLifeEvent(tx, kms, KEY_ARN, {
      personId: adult.personId,
      type: "baptism",
      date: "1980-09-09",
      place: "Marchetti Cathedral",
      actorUserId: null,
      now: NOW,
    });
    const [one, two] = created;
    if (one === undefined || two === undefined) {
      throw new Error("two children were not seeded");
    }
    return {
      index,
      scope,
      householdId,
      adultId: adult.personId,
      childIds: [one.personId, two.personId],
      eventIds: [one.eventId, two.eventId],
      adultEventId: adultEvent.eventId,
      linkIds: [one.linkId, two.linkId],
      children: [first, second],
    };
  });
}

type View = "admin" | "presence";

type Ctx = {
  tx: AppTransaction;
  kms: KmsPort;
  // The household, adult and children whose ids the call is given. It is the scope the call runs
  // in, or another one: then the call asks for rows the scope must not show.
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
  name: keyof typeof people,
  takesView: boolean,
  label: string,
  run: (ctx: Ctx) => Promise<unknown>,
): void {
  CALLS.push({ name, takesView, label, run });
}

function addForEachChild(
  name: keyof typeof people,
  takesView: boolean,
  run: (ctx: Ctx, child: { id: string; eventId: string }) => Promise<unknown>,
): void {
  for (const slot of [0, 1] as const) {
    add(name, takesView, `child ${slot + 1}`, (ctx) =>
      run(ctx, {
        id: ctx.t.childIds[slot] as string,
        eventId: ctx.t.eventIds[slot] as string,
      }),
    );
  }
}

// readers
add("readHousehold", true, "", ({ tx, kms: k, t, view, actor }) =>
  people.readHousehold(tx, k, KEY_ARN, {
    householdId: t.householdId,
    childView: view,
    actorUserId: actor,
  }),
);
for (const includeRestricted of [true, false]) {
  add("readHouseholdDetail", true, `includeRestricted ${includeRestricted}`, (x) =>
    people.readHouseholdDetail(x.tx, x.kms, KEY_ARN, {
      householdId: x.t.householdId,
      includeRestricted,
      childView: x.view,
      actorUserId: x.actor,
    }),
  );
  add("listHouseholds", false, `includeRestricted ${includeRestricted}`, (x) =>
    people.listHouseholds(x.tx, x.kms, KEY_ARN, { includeRestricted, actorUserId: x.actor }),
  );
}
add("listDeletedHouseholds", false, "", (x) =>
  people.listDeletedHouseholds(x.tx, x.kms, KEY_ARN, { actorUserId: x.actor }),
);
addForEachChild("readPerson", false, (x, child) =>
  people.readPerson(x.tx, x.kms, KEY_ARN, { personId: child.id, actorUserId: x.actor }),
);
add("readPerson", false, "adult", (x) =>
  people.readPerson(x.tx, x.kms, KEY_ARN, { personId: x.t.adultId, actorUserId: x.actor }),
);
add("summarisePersons", false, "", (x) =>
  people.summarisePersons(x.tx, { addedSince: new Date(0) }),
);
add("listPersons", false, "adults", (x) =>
  people.listPersons(x.tx, x.kms, KEY_ARN, {
    kind: "adults",
    includeRestricted: true,
    actorUserId: x.actor,
  }),
);
add("listPersons", true, "minors", (x) =>
  people.listPersons(x.tx, x.kms, KEY_ARN, {
    kind: "minors",
    childView: x.view,
    actorUserId: x.actor,
  }),
);
add("listDeletedPersons", false, "", (x) =>
  people.listDeletedPersons(x.tx, { actorUserId: x.actor }),
);
addForEachChild("personIsMinor", false, (x, child) => people.personIsMinor(x.tx, child.id));
addForEachChild("hasGuardianView", false, (x, child) =>
  people.hasGuardianView(x.tx, x.t.adultId, child.id),
);
add("householdHasMinor", false, "", (x) => people.householdHasMinor(x.tx, x.t.householdId));
for (const slot of [0, 1] as const) {
  add("guardianLinkChildIsMinor", false, `link ${slot + 1}`, (x) =>
    people.guardianLinkChildIsMinor(x.tx, {
      householdId: x.t.householdId,
      linkId: x.t.linkIds[slot] as string,
    }),
  );
}
addForEachChild("lifeEventPersonIsMinor", false, (x, child) =>
  people.lifeEventPersonIsMinor(x.tx, child.eventId),
);
addForEachChild("listPersonActivity", false, (x, child) =>
  people.listPersonActivity(x.tx, child.id),
);
addForEachChild("listPersonTags", false, (x, child) => people.listPersonTags(x.tx, child.id));
addForEachChild("openPersonFieldKeys", false, (x, child) =>
  people.openPersonFieldKeys(x.tx, x.kms, KEY_ARN, { personId: child.id, actorUserId: x.actor }),
);
add("readLinkedContacts", true, "", async (x) => {
  const contacts = await people.readLinkedContacts(x.tx, x.kms, KEY_ARN, {
    personIds: [x.t.adultId, ...x.t.childIds],
    includePhone: true,
    actorUserId: x.actor,
    childView: x.view,
  });
  return [...contacts.entries()];
});
addForEachChild("listLifeEvents", true, (x, child) =>
  people.listLifeEvents(x.tx, x.kms, KEY_ARN, {
    personId: child.id,
    actorUserId: x.actor,
    childView: x.view,
  }),
);
add("readRosterNames", true, "", (x) =>
  people.readRosterNames(x.tx, x.kms, KEY_ARN, {
    personIds: [x.t.adultId, ...x.t.childIds],
    childView: x.view,
    actorUserId: x.actor,
  }),
);
add("visiblePersonIds", true, "", (x) =>
  people.visiblePersonIds(x.tx, [x.t.adultId, ...x.t.childIds], { childView: x.view }),
);
add("readEmergencyContacts", false, "", (x) =>
  people.readEmergencyContacts(x.tx, x.kms, KEY_ARN, {
    householdId: x.t.householdId,
    actorUserId: x.actor,
  }),
);

// minor-refused writers and readers, called with each child
addForEachChild("setPersonStatus", false, (x, child) =>
  people.setPersonStatus(x.tx, {
    now: NOW,
    personId: child.id,
    version: 1,
    status: "inactive",
    actorUserId: x.actor,
  }),
);
addForEachChild("updatePerson", false, (x, child) =>
  people.updatePerson(x.tx, x.kms, KEY_ARN, {
    personId: child.id,
    version: 1,
    changes: { givenName: "Changed" },
    actorUserId: x.actor,
    now: NOW,
  }),
);
addForEachChild("moveAdult", false, (x, child) =>
  people.moveAdult(x.tx, {
    personId: child.id,
    version: 1,
    householdId: null,
    actorUserId: x.actor,
  }),
);
addForEachChild("hidePerson", false, (x, child) =>
  people.hidePerson(x.tx, { personId: child.id, actorUserId: x.actor }),
);
addForEachChild("lockPersonForDelete", false, (x, child) =>
  people.lockPersonForDelete(x.tx, { personId: child.id, version: 1 }),
);
addForEachChild("restorePerson", false, (x, child) =>
  people.restorePerson(x.tx, { personId: child.id, version: 1, actorUserId: x.actor }),
);
addForEachChild("attachTag", false, async (x, child) => {
  const tag = await people.createTag(x.tx, { label: "sweep-attach" });
  return people.attachTag(x.tx, {
    now: NOW,
    personId: child.id,
    tagId: tag.tagId,
    actorUserId: x.actor,
  });
});
addForEachChild("detachTag", false, async (x, child) => {
  const tag = await people.createTag(x.tx, { label: "sweep-detach" });
  return people.detachTag(x.tx, {
    now: NOW,
    personId: child.id,
    tagId: tag.tagId,
    actorUserId: x.actor,
  });
});

// writers: their answers carry ids and versions only
add("ensureCommunityKey", false, "", (x) => people.ensureCommunityKey(x.tx, x.kms, KEY_ARN));
add("ensureOrganisationKey", false, "", (x) => people.ensureOrganisationKey(x.tx, x.kms, KEY_ARN));
add("createHousehold", false, "", (x) =>
  people.createHousehold(x.tx, x.kms, KEY_ARN, {
    now: NOW,
    label: "Sweep new household",
    actorUserId: x.actor,
  }),
);
add("renameHousehold", false, "", (x) =>
  people.renameHousehold(x.tx, x.kms, KEY_ARN, {
    householdId: x.t.householdId,
    version: 1,
    label: "Sweep renamed",
    actorUserId: x.actor,
  }),
);
add("createPerson", false, "adult", (x) =>
  people.createPerson(x.tx, x.kms, KEY_ARN, {
    now: NOW,
    declaredAdult: true,
    householdId: x.t.householdId,
    dateOfBirth: null,
    givenName: "Sweepadult",
    familyName: "Tester",
    email: null,
    phone: null,
    actorUserId: x.actor,
  }),
);
add("createPerson", false, "minor", (x) =>
  people.createPerson(x.tx, x.kms, KEY_ARN, {
    now: NOW,
    declaredAdult: false,
    householdId: x.t.householdId,
    dateOfBirth: "2019-02-02",
    givenName: "Sweepkid",
    familyName: "Tester",
    email: null,
    phone: null,
    actorUserId: x.actor,
  }),
);
add("addAdult", false, "", (x) =>
  people.addAdult(x.tx, x.kms, KEY_ARN, {
    now: NOW,
    householdId: x.t.householdId,
    givenName: "Sweepadult",
    familyName: "Tester",
    email: null,
    phone: null,
    dateOfBirth: null,
    actorUserId: x.actor,
  }),
);
add("addMinor", false, "", (x) =>
  people.addMinor(x.tx, x.kms, KEY_ARN, {
    now: NOW,
    householdId: x.t.householdId,
    givenName: "Sweepkid",
    familyName: "Tester",
    dateOfBirth: "2019-02-02",
    guardianId: x.t.adultId,
    actorUserId: x.actor,
  }),
);
addForEachChild("linkGuardian", false, (x, child) =>
  people.linkGuardian(x.tx, {
    now: NOW,
    householdId: x.t.householdId,
    guardianPersonId: x.t.adultId,
    childPersonId: child.id,
    consent: true,
    pickup: true,
    view: true,
    manage: false,
    actorUserId: x.actor,
  }),
);
for (const slot of [0, 1] as const) {
  add("unlinkGuardian", false, `link ${slot + 1}`, (x) =>
    people.unlinkGuardian(x.tx, {
      now: NOW,
      householdId: x.t.householdId,
      linkId: x.t.linkIds[slot] as string,
      actorUserId: x.actor,
    }),
  );
}
add("createTag", false, "", (x) => people.createTag(x.tx, { label: "sweep-tag" }));
addForEachChild("createLifeEvent", false, (x, child) =>
  people.createLifeEvent(x.tx, x.kms, KEY_ARN, {
    personId: child.id,
    type: "baptism",
    date: "2020-01-01",
    actorUserId: x.actor,
    now: NOW,
  }),
);
addForEachChild("updateLifeEvent", false, (x, child) =>
  people.updateLifeEvent(x.tx, x.kms, KEY_ARN, {
    eventId: child.eventId,
    version: 1,
    type: "baptism",
    date: "2020-01-01",
    actorUserId: x.actor,
    now: NOW,
  }),
);
add("saveEmergencyContacts", false, "", (x) =>
  people.saveEmergencyContacts(x.tx, x.kms, KEY_ARN, {
    householdId: x.t.householdId,
    version: 1,
    contacts: [],
    actorUserId: x.actor,
  }),
);
add("setHouseholdStatus", false, "", (x) =>
  people.setHouseholdStatus(x.tx, {
    householdId: x.t.householdId,
    version: 1,
    status: "inactive",
    actorUserId: x.actor,
  }),
);
add("hideHousehold", false, "", (x) =>
  people.hideHousehold(x.tx, { householdId: x.t.householdId, version: 1, actorUserId: x.actor }),
);
add("restoreHousehold", false, "", (x) =>
  people.restoreHousehold(x.tx, { householdId: x.t.householdId, version: 1, actorUserId: x.actor }),
);
add("purgeDeletedPersons", false, "", (x) => people.purgeDeletedPersons(x.tx, 10));
add("purgeDeletedHouseholds", false, "", (x) => people.purgeDeletedHouseholds(x.tx, 10));

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

function leaks(text: string, everyChild: ChildSeed[]): string[] {
  const found: string[] = [];
  everyChild.forEach((child, index) => {
    const checks: [string, string][] = [
      ["given name", child.givenName],
      ["family name", child.familyName],
      ["email", child.email],
      ["phone", child.phone],
      ["phone digits", child.phone.slice(1)],
      ["date of birth", child.dateOfBirth],
      ["place", child.place],
      ["notes", child.notes],
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
  return found;
}

describe("function sweep: no export returns a seeded child's value", () => {
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
    await Promise.all([
      platform?.end({ timeout: 1 }),
      app?.end({ timeout: 1 }),
      directSql?.end({ timeout: 1 }),
    ]);
  });

  it("seeds two organisations with two communities, each with an adult and two children", () => {
    expect(seeded).toHaveLength(4);
    expect(new Set(seeded.map((s) => s.scope.orgId)).size).toBe(2);
    expect(new Set(seeded.map((s) => s.scope.communityId)).size).toBe(4);
    for (const family of seeded) {
      expect(family.childIds).toHaveLength(2);
    }
  });

  it("pin 44: no export returns a seeded minor's name, email, phone, date of birth, birthdayMd or place", async () => {
    const everyChild = seeded.flatMap((family) => family.children);
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
            for (const found of leaks(answer, everyChild)) {
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
    expect(observed).toBeGreaterThan(400);
    expect(nonEmpty).toBeGreaterThan(observed / 2);

    // The table does not claim a call that never happened.
    const claimed = Object.entries(PEOPLE_EXPORTS)
      .filter(([, [exportClass]]) =>
        ["checked", "minor-refused", "adult-only", "writer"].includes(exportClass),
      )
      .map(([name]) => name);
    expect(claimed.filter((name) => !called.has(name)).sort()).toEqual([]);
  }, 600_000);

  it("the sweep can find a leak: the search sees a seeded value in a serialised answer", () => {
    const everyChild = seeded.flatMap((family) => family.children);
    const first = everyChild[0] as ChildSeed;
    expect(leaks(serialise({ name: first.givenName }), everyChild)).toEqual(["child 0 given name"]);
    expect(leaks(serialise({ md: first.birthdayMd }), everyChild)).toEqual([]);
    expect(leaks(`{"birthdayMd":${first.birthdayMd}}`, everyChild)).toEqual(["child 0 birthdayMd"]);
    expect(leaks(serialise(new Map([["x", { email: first.email }]])), everyChild)).toContain(
      "child 0 email",
    );
    expect(leaks(describeError(new Error(first.familyName)), everyChild)).toEqual([
      "child 0 family name",
    ]);
  });
});
