import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, createCustomRole, grantRole, linkUser } from "@community-hub/access";
import { addMember } from "@community-hub/access/testing";
import {
  capabilitiesBody,
  createCustomRoleBody,
  deleteCustomRoleBody,
  grantBody,
  linkUserBody,
  listGrantsBody,
  listUsersBody,
  revokeGrantBody,
  unlinkUserBody,
} from "@community-hub/contracts/access";
import {
  addAdultBody,
  addMinorBody,
  createHouseholdBody,
  householdDeleteBody,
  householdRestoreBody,
  householdStatusBody,
  linkGuardianBody,
  listHouseholdsBody,
  moveAdultBody,
  readEmergencyContactsBody,
  readHouseholdBody,
  renameHouseholdBody,
  saveEmergencyContactsBody,
  unlinkGuardianBody,
} from "@community-hub/contracts/households";
import {
  createLifeEventBody,
  listLifeEventsBody,
  updateLifeEventBody,
} from "@community-hub/contracts/life-events";
import {
  createPersonBody,
  listPeopleBody,
  minorLifeEventViewBody,
  minorViewBody,
  peopleSummaryBody,
  personDeleteBody,
  personRestoreBody,
  personStatusBody,
  readPersonBody,
  updatePersonBody,
} from "@community-hub/contracts/people";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { assignPlan, upsertPlan } from "@community-hub/entitlements";
import { addMember as addGroupMember, createGroup } from "@community-hub/groups";
import { withRequest } from "@community-hub/kernel";
import {
  createHousehold,
  createLifeEvent,
  createPerson,
  linkGuardian,
} from "@community-hub/people";
import { catalogue } from "@community-hub/policy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accessRoutes } from "./access-routes.js";
import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import type { GateRoute } from "./gate.js";
import { householdRoutes } from "./household-routes.js";
import { lifeEventRoutes } from "./life-event-routes.js";
import { minorViewRoutes } from "./minor-view-routes.js";
import { peopleRoutes } from "./people-routes.js";
import { startServer } from "./server.js";
import { signInWithTotpInProcess } from "./test-support/second-factor.js";

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");

const API_HOSTNAME = "au.api.example.test";
const PORT = 18494;
const REQUEST_ID = "99999999-9999-4999-8999-999999999998";

const pem = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../certs/rds-ap-southeast-2-bundle.pem"),
  "utf8",
);

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/test/.runtime.json",
);

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "identity" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

function envFor(port: number): ServiceEnv {
  const arn = (service: string, name: string): string =>
    [
      "arn",
      "aws",
      service,
      "ap-southeast-2",
      ["12", "34", "56", "78", "90", "12"].join(""),
      name,
    ].join(":");
  const read = readServiceEnv(
    {
      PORT: String(port),
      PGPORT: "5432",
      AWS_REGION: "ap-southeast-2",
      NODE_ENV: "test",
      COMMUNITY_HUB_ENVIRONMENT: "staging",
      API_HOSTNAME,
      AUTH_HOSTNAME: "auth.au.example.test",
      WEBHOOKS_HOSTNAME: "webhooks.au.example.test",
      OPS_HOSTNAME: "ops.au.example.test",
      PGHOST: "127.0.0.1",
      PGDATABASE: "hub_product_only",
      PGUSER_APP: "app",
      PGUSER_IDENTITY: "identity",
      PGUSER_PLATFORM: "platform",
      PGPASSWORD_APP: "pw-app",
      PGPASSWORD_IDENTITY: "pw-identity",
      PGPASSWORD_PLATFORM: "pw-platform",
      ENVELOPE_KEY_ARN: KEY_ARN,
      APP_SECRET_ARN: arn("secretsmanager", "secret:app"),
      IDENTITY_SECRET_ARN: arn("secretsmanager", "secret:identity"),
      PLATFORM_SECRET_ARN: arn("secretsmanager", "secret:platform"),
    },
    pem,
  );
  if (!read.ok) {
    throw new Error("Failed to read test env");
  }
  return read.env;
}

// ---------------------------------------------------------------------------------------------
// The seeded families. Every child value is unusual on purpose, so a substring hit is never a
// coincidence, and no child's month and day (birthdayMd) is any adult's.
// ---------------------------------------------------------------------------------------------

type ChildSeed = {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  place: string;
  notes: string;
};

type AdultSeed = {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
};

type TenantKey = "a1" | "a2" | "b1";

const SEEDS: Record<
  TenantKey,
  { label: string; adult: AdultSeed; children: [ChildSeed, ChildSeed] }
> = {
  a1: {
    label: "Marchetti",
    adult: {
      givenName: "Aurelia",
      familyName: "Marchetti",
      email: "aurelia.marchetti@sweep.example.test",
      phone: "+61400555300",
      dateOfBirth: "1984-02-02",
    },
    children: [
      {
        givenName: "Zephyrine",
        familyName: "Quillonwick",
        email: "zephyrine.quillonwick@sweep.example.test",
        phone: "+61400555311",
        dateOfBirth: "2018-03-14",
        place: "Zephyr Chapel",
        notes: "Quillonwick godparents",
      },
      {
        givenName: "Quillon",
        familyName: "Zephyrwick",
        email: "quillon.zephyrwick@sweep.example.test",
        phone: "+61400555312",
        dateOfBirth: "2019-11-26",
        place: "Larkspur Font",
        notes: "Zephyrwick sponsors",
      },
    ],
  },
  a2: {
    label: "Castellane",
    adult: {
      givenName: "Benedetta",
      familyName: "Castellane",
      email: "benedetta.castellane@sweep.example.test",
      phone: "+61400555301",
      dateOfBirth: "1979-04-10",
    },
    children: [
      {
        givenName: "Marigoldine",
        familyName: "Thistlewhite",
        email: "marigoldine.thistlewhite@sweep.example.test",
        phone: "+61400555321",
        dateOfBirth: "2017-07-27",
        place: "Thistle Abbey",
        notes: "Thistlewhite cousins",
      },
      {
        givenName: "Ottoline",
        familyName: "Brambleby",
        email: "ottoline.brambleby@sweep.example.test",
        phone: "+61400555322",
        dateOfBirth: "2020-09-21",
        place: "Bramble Hall",
        notes: "Brambleby aunt",
      },
    ],
  },
  b1: {
    label: "Dunmore",
    adult: {
      givenName: "Cornelius",
      familyName: "Dunmore",
      email: "cornelius.dunmore@sweep.example.test",
      phone: "+61400555302",
      dateOfBirth: "1975-08-08",
    },
    children: [
      {
        givenName: "Peregrina",
        familyName: "Wolfsbane",
        email: "peregrina.wolfsbane@sweep.example.test",
        phone: "+61400555331",
        dateOfBirth: "2016-01-30",
        place: "Wolfsbane Priory",
        notes: "Wolfsbane elders",
      },
      {
        givenName: "Fenwick",
        familyName: "Larkspurre",
        email: "fenwick.larkspurre@sweep.example.test",
        phone: "+61400555332",
        dateOfBirth: "2021-06-18",
        place: "Larkspurre Chapel",
        notes: "Larkspurre minders",
      },
    ],
  },
};

function birthdayMd(dateOfBirth: string): number {
  const [, month, day] = dateOfBirth.split("-");
  return Number(month) * 100 + Number(day);
}

type Target = {
  key: TenantKey;
  slug: string;
  householdId: string;
  adultId: string;
  childIds: [string, string];
  eventIds: [string, string];
  adultEventId: string;
  linkIds: [string, string];
};

// What the sweep looks for. A field value of a child is checked in every answer. A child's person
// id and life-event id are checked in every answer a caller who is not a Community Admin gets.
type SeededChild = {
  label: string;
  fields: Array<[string, string]>;
  birthdayMd: number;
  ids: Array<[string, string]>;
};

function seededChildren(targets: readonly Target[]): SeededChild[] {
  const out: SeededChild[] = [];
  for (const target of targets) {
    SEEDS[target.key].children.forEach((child, index) => {
      out.push({
        label: `${target.key} child ${index}`,
        fields: [
          ["given name", child.givenName],
          ["family name", child.familyName],
          ["email", child.email],
          ["phone", child.phone],
          ["phone digits", child.phone.slice(1)],
          ["date of birth", child.dateOfBirth],
          ["life-event place", child.place],
          ["life-event notes", child.notes],
        ],
        birthdayMd: birthdayMd(child.dateOfBirth),
        ids: [
          ["person id", target.childIds[index as 0 | 1]],
          ["life-event id", target.eventIds[index as 0 | 1]],
        ],
      });
    });
  }
  return out;
}

// Names the leaks without printing a value.
function fieldLeaks(text: string, children: readonly SeededChild[]): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const child of children) {
    for (const [kind, value] of child.fields) {
      if (lower.includes(value.toLowerCase())) {
        found.push(`${child.label} ${kind}`);
      }
    }
    if (new RegExp(`"birthdayMd":\\s*${child.birthdayMd}(?![0-9])`).test(text)) {
      found.push(`${child.label} birthdayMd`);
    }
  }
  return found;
}

function idLeaks(text: string, children: readonly SeededChild[]): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const child of children) {
    for (const [kind, value] of child.ids) {
      if (lower.includes(value.toLowerCase())) {
        found.push(`${child.label} ${kind}`);
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// The route table (pin 79). One row per route in the five route files: the contract that checks
// every body before it is sent, what each caller who is not a Community Admin sends, and, for a
// list or read route, what the Community Admin sends. A write route is called with a version that
// does not exist, so a path that gets past its guards still changes nothing.
// ---------------------------------------------------------------------------------------------

type Call = { label: string; body: Record<string, unknown> };
type Context = { target: Target; groupId: string; memberUserId: string };
type RouteSpec = {
  file: string;
  schema: { parse(data: unknown): unknown };
  nonAdmin: (ctx: Context) => Call[];
  admin?: (ctx: Context) => Call[];
};

const NO_VERSION = 9999;
const call = (label: string, body: Record<string, unknown> = {}): Call => ({ label, body });

const PEOPLE_FILE = "people-routes.ts";
const HOUSEHOLD_FILE = "household-routes.ts";
const LIFE_EVENT_FILE = "life-event-routes.ts";
const ACCESS_FILE = "access-routes.ts";
const MINOR_VIEW_FILE = "minor-view-routes.ts";

const ROUTES: Record<string, RouteSpec> = {
  // --- people-routes.ts
  "POST /v1/people/list": {
    file: PEOPLE_FILE,
    schema: listPeopleBody,
    nonAdmin: ({ target, groupId }) => [
      call("default"),
      call("adults", { kind: "adults" }),
      call("minors", { kind: "minors" }),
      call("search by a child's given name", {
        search: SEEDS[target.key].children[0].givenName,
      }),
      call("deleted", { status: "deleted" }),
      call("a group with a child in it", { groupId }),
    ],
    admin: ({ groupId }) => [
      call("default"),
      call("adults", { kind: "adults" }),
      call("minors", { kind: "minors" }),
      call("a group with a child in it", { groupId }),
    ],
  },
  "POST /v1/people/read": {
    file: PEOPLE_FILE,
    schema: readPersonBody,
    nonAdmin: ({ target }) => [
      call("a child", { personId: target.childIds[0] }),
      call("the other child", { personId: target.childIds[1] }),
      call("an adult", { personId: target.adultId }),
    ],
    admin: ({ target }) => [
      call("a child", { personId: target.childIds[0] }),
      call("an adult", { personId: target.adultId }),
    ],
  },
  "POST /v1/people/summary": {
    file: PEOPLE_FILE,
    schema: peopleSummaryBody,
    nonAdmin: () => [call("since 2026", { addedSince: "2026-01-01T00:00:00Z" })],
    admin: () => [call("since 2026", { addedSince: "2026-01-01T00:00:00Z" })],
  },
  "POST /v1/people/create": {
    file: PEOPLE_FILE,
    schema: createPersonBody,
    nonAdmin: () => [
      call("an adult", { givenName: "SweepAdult", familyName: "Created" }),
      call("a date of birth that makes a child", {
        givenName: "SweepKid",
        familyName: "Created",
        dateOfBirth: "2021-01-01",
      }),
    ],
  },
  "POST /v1/people/update": {
    file: PEOPLE_FILE,
    schema: updatePersonBody,
    nonAdmin: ({ target }) => [
      call("a child's name", {
        personId: target.childIds[0],
        version: NO_VERSION,
        givenName: "SweepRename",
      }),
      call("a child's email", { personId: target.childIds[1], version: NO_VERSION, email: null }),
    ],
  },
  "POST /v1/people/status": {
    file: PEOPLE_FILE,
    schema: personStatusBody,
    nonAdmin: ({ target }) => [
      call("a child", { personId: target.childIds[0], version: NO_VERSION, status: "inactive" }),
    ],
  },
  "POST /v1/people/delete": {
    file: PEOPLE_FILE,
    schema: personDeleteBody,
    nonAdmin: ({ target }) => [
      call("a child", { personId: target.childIds[0], version: NO_VERSION }),
    ],
  },
  "POST /v1/people/restore": {
    file: PEOPLE_FILE,
    schema: personRestoreBody,
    nonAdmin: ({ target }) => [
      call("a child", { personId: target.childIds[0], version: NO_VERSION }),
    ],
  },

  // --- household-routes.ts
  "POST /v1/households/list": {
    file: HOUSEHOLD_FILE,
    schema: listHouseholdsBody,
    nonAdmin: () => [call("default"), call("deleted", { status: "deleted" })],
    admin: () => [call("default"), call("deleted", { status: "deleted" })],
  },
  "POST /v1/households/read": {
    file: HOUSEHOLD_FILE,
    schema: readHouseholdBody,
    nonAdmin: ({ target }) => [call("the family", { householdId: target.householdId })],
    admin: ({ target }) => [call("the family", { householdId: target.householdId })],
  },
  "POST /v1/households/create": {
    file: HOUSEHOLD_FILE,
    schema: createHouseholdBody,
    nonAdmin: () => [call("a family", { label: "SweepFamily" })],
  },
  "POST /v1/households/rename": {
    file: HOUSEHOLD_FILE,
    schema: renameHouseholdBody,
    nonAdmin: ({ target }) => [
      call("a plain label", {
        householdId: target.householdId,
        version: NO_VERSION,
        label: "SweepRenamed",
      }),
      call("a label with a child's given name", {
        householdId: target.householdId,
        version: NO_VERSION,
        label: `SweepRenamed ${SEEDS[target.key].children[0].givenName}`,
      }),
    ],
  },
  "POST /v1/households/members/move-adult": {
    file: HOUSEHOLD_FILE,
    schema: moveAdultBody,
    nonAdmin: ({ target }) => [
      call("a child", {
        householdId: target.householdId,
        personId: target.childIds[0],
        version: NO_VERSION,
      }),
      call("an adult to no family", {
        householdId: null,
        personId: target.adultId,
        version: NO_VERSION,
      }),
    ],
  },
  "POST /v1/households/members/add-minor": {
    file: HOUSEHOLD_FILE,
    schema: addMinorBody,
    nonAdmin: ({ target }) => [
      call("a child", {
        householdId: target.householdId,
        givenName: "SweepKid",
        familyName: "Added",
        dateOfBirth: "2020-02-02",
        guardianId: target.adultId,
      }),
    ],
  },
  "POST /v1/households/members/add-adult": {
    file: HOUSEHOLD_FILE,
    schema: addAdultBody,
    nonAdmin: ({ target }) => [
      call("an adult", {
        householdId: target.householdId,
        givenName: "SweepAdult",
        familyName: "Added",
      }),
    ],
  },
  "POST /v1/households/guardians/link": {
    file: HOUSEHOLD_FILE,
    schema: linkGuardianBody,
    nonAdmin: ({ target }) => [
      call("a child", {
        householdId: target.householdId,
        guardianId: target.adultId,
        childId: target.childIds[0],
      }),
    ],
  },
  "POST /v1/households/guardians/unlink": {
    file: HOUSEHOLD_FILE,
    schema: unlinkGuardianBody,
    nonAdmin: ({ target }) => [
      call("a child's link", { householdId: target.householdId, linkId: target.linkIds[0] }),
    ],
  },
  "POST /v1/households/status": {
    file: HOUSEHOLD_FILE,
    schema: householdStatusBody,
    nonAdmin: ({ target }) => [
      call("the family", {
        householdId: target.householdId,
        version: NO_VERSION,
        status: "inactive",
      }),
    ],
  },
  "POST /v1/households/delete": {
    file: HOUSEHOLD_FILE,
    schema: householdDeleteBody,
    nonAdmin: ({ target }) => [
      call("the family", { householdId: target.householdId, version: NO_VERSION }),
    ],
  },
  "POST /v1/households/restore": {
    file: HOUSEHOLD_FILE,
    schema: householdRestoreBody,
    nonAdmin: ({ target }) => [
      call("the family", { householdId: target.householdId, version: NO_VERSION }),
    ],
  },
  "POST /v1/households/emergency-contacts/read": {
    file: HOUSEHOLD_FILE,
    schema: readEmergencyContactsBody,
    nonAdmin: ({ target }) => [call("the family", { householdId: target.householdId })],
    admin: ({ target }) => [call("the family", { householdId: target.householdId })],
  },
  "POST /v1/households/emergency-contacts/save": {
    file: HOUSEHOLD_FILE,
    schema: saveEmergencyContactsBody,
    nonAdmin: ({ target }) => [
      call("no contacts", { householdId: target.householdId, version: NO_VERSION, contacts: [] }),
    ],
  },

  // --- life-event-routes.ts
  "POST /v1/people/life-events/list": {
    file: LIFE_EVENT_FILE,
    schema: listLifeEventsBody,
    nonAdmin: ({ target }) => [
      call("a child", { personId: target.childIds[0] }),
      call("the other child", { personId: target.childIds[1] }),
      call("an adult", { personId: target.adultId }),
    ],
    admin: ({ target }) => [
      call("a child", { personId: target.childIds[0] }),
      call("an adult", { personId: target.adultId }),
    ],
  },
  "POST /v1/people/life-events/create": {
    file: LIFE_EVENT_FILE,
    schema: createLifeEventBody,
    nonAdmin: ({ target }) => [
      call("a child's event", {
        personId: target.childIds[0],
        type: "baptism",
        date: "2020-01-01",
        place: "SweepPlace",
      }),
    ],
  },
  "POST /v1/people/life-events/update": {
    file: LIFE_EVENT_FILE,
    schema: updateLifeEventBody,
    nonAdmin: ({ target }) => [
      call("a child's event", {
        eventId: target.eventIds[0],
        version: NO_VERSION,
        type: "baptism",
        date: "2020-01-01",
      }),
    ],
  },

  // --- access-routes.ts
  "POST /v1/access/grants/list": {
    file: ACCESS_FILE,
    schema: listGrantsBody,
    nonAdmin: () => [call("the grants")],
    admin: () => [call("the grants")],
  },
  "POST /v1/access/users/list": {
    file: ACCESS_FILE,
    schema: listUsersBody,
    nonAdmin: () => [call("the users")],
    admin: () => [call("the users")],
  },
  "POST /v1/access/capabilities": {
    file: ACCESS_FILE,
    schema: capabilitiesBody,
    nonAdmin: () => [call("the caller's capabilities")],
    admin: () => [call("the caller's capabilities")],
  },
  "POST /v1/access/grants": {
    file: ACCESS_FILE,
    schema: grantBody,
    nonAdmin: ({ memberUserId }) => [
      call("a role that does not exist", { userId: memberUserId, roleKey: "no_such_role" }),
    ],
  },
  "POST /v1/access/grants/revoke": {
    file: ACCESS_FILE,
    schema: revokeGrantBody,
    nonAdmin: () => [call("a grant that does not exist", { grantId: newId(), scope: "community" })],
  },
  "POST /v1/access/custom-roles": {
    file: ACCESS_FILE,
    schema: createCustomRoleBody,
    nonAdmin: () => [
      call("a permission that does not exist", {
        key: "sweep_role",
        permissions: ["no.such.permission"],
      }),
    ],
  },
  "POST /v1/access/custom-roles/delete": {
    file: ACCESS_FILE,
    schema: deleteCustomRoleBody,
    nonAdmin: () => [call("a role that does not exist", { customRoleId: newId() })],
  },
  "POST /v1/access/user-links": {
    file: ACCESS_FILE,
    schema: linkUserBody,
    nonAdmin: ({ target, memberUserId }) => [
      call("a user to a child", { userId: memberUserId, personId: target.childIds[0] }),
    ],
  },
  "POST /v1/access/user-links/delete": {
    file: ACCESS_FILE,
    schema: unlinkUserBody,
    nonAdmin: () => [call("a user with no link", { userId: newId() })],
  },

  // --- minor-view-routes.ts
  "POST /v1/people/minors/view": {
    file: MINOR_VIEW_FILE,
    schema: minorViewBody,
    nonAdmin: ({ target }) => [
      call("a name", { personId: target.childIds[0], field: "name" }),
      call("a date of birth", { personId: target.childIds[0], field: "dateOfBirth" }),
      call("an email", { personId: target.childIds[1], field: "email" }),
      call("a phone", { personId: target.childIds[1], field: "phone" }),
    ],
  },
  "POST /v1/people/minors/life-events/view": {
    file: MINOR_VIEW_FILE,
    schema: minorLifeEventViewBody,
    nonAdmin: ({ target }) => [
      call("a place", {
        personId: target.childIds[0],
        lifeEventId: target.eventIds[0],
        field: "place",
      }),
      call("notes", {
        personId: target.childIds[1],
        lifeEventId: target.eventIds[1],
        field: "notes",
      }),
      call("a type", {
        personId: target.childIds[0],
        lifeEventId: target.eventIds[0],
        field: "type",
      }),
      call("a date", {
        personId: target.childIds[0],
        lifeEventId: target.eventIds[0],
        field: "date",
      }),
    ],
  },
};

// ---------------------------------------------------------------------------------------------

type CallerName =
  "staff" | "safeguarding_officer" | "custom_restricted" | "custom_all" | "org_admin" | "member";
const NON_ADMIN: readonly CallerName[] = [
  "staff",
  "safeguarding_officer",
  "custom_restricted",
  "custom_all",
  "org_admin",
  "member",
];

type Result = {
  route: string;
  caller: CallerName | "community_admin";
  aim: string;
  label: string;
  status: number;
  text: string;
};

describe("the route sweep (pins 79, 80)", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  let identity: ReturnType<typeof createPlaintextIdentitySql>;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let directSql: ReturnType<typeof createPlaintextDirectSql>;
  let kms: ReturnType<typeof createLocalKmsPort>;
  let server: Server;

  const captured: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  const orgA = newId();
  const orgB = newId();
  const communityA1 = newId();
  const communityA2 = newId();
  const communityB1 = newId();
  const slugs: Record<TenantKey, string> = {
    a1: `sw-a1-${newId().slice(-8)}`,
    a2: `sw-a2-${newId().slice(-8)}`,
    b1: `sw-b1-${newId().slice(-8)}`,
  };
  const scopes: Record<TenantKey, { orgId: string; communityId: string }> = {
    a1: { orgId: orgA, communityId: communityA1 },
    a2: { orgId: orgA, communityId: communityA2 },
    b1: { orgId: orgB, communityId: communityB1 },
  };

  const targets = {} as Record<TenantKey, Target>;
  const tokens = {} as Record<CallerName | "community_admin", string>;
  let memberUserId = "";
  let groupId = "";
  let registry: Array<{ file: string; key: string }> = [];
  const results: Result[] = [];

  const checkout = async <T>(role: Role, run: (sql: never) => Promise<T>): Promise<T> => {
    if (role === "identity") {
      return run(identity as never);
    }
    if (role === "platform") {
      return run(platform as never);
    }
    return run(app as never);
  };

  async function signIn(label: string): Promise<{ userId: string; accessToken: string }> {
    const session = await signInWithTotpInProcess(
      identity,
      kms,
      KEY_ARN,
      `${label}-${newId().slice(-8)}@users.example.test`,
      now,
    );
    return { userId: session.userId, accessToken: session.accessToken };
  }

  async function postRoute(pathName: string, body: unknown, token: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${PORT}${pathName}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-community-hub-hostname": API_HOSTNAME,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function seedTenant(key: TenantKey, actorUserId: string): Promise<Target> {
    const seed = SEEDS[key];
    return withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopes[key], async (tx) => {
        const household = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: seed.label,
          actorUserId,
        });
        const householdId = household.householdId;
        const adult = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId,
          ...seed.adult,
          actorUserId,
        });
        const childIds: string[] = [];
        const eventIds: string[] = [];
        const linkIds: string[] = [];
        for (const [index, child] of seed.children.entries()) {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now: new Date(now.getTime() + index * 3_600_000),
            declaredAdult: false,
            householdId,
            givenName: child.givenName,
            familyName: child.familyName,
            email: child.email,
            phone: child.phone,
            dateOfBirth: child.dateOfBirth,
            actorUserId,
          });
          childIds.push(person.personId);
          const event = await createLifeEvent(tx, kms, KEY_ARN, {
            personId: person.personId,
            type: index === 0 ? "baptism" : "first_communion",
            date: index === 0 ? "2019-03-03" : "2026-05-10",
            place: child.place,
            notes: child.notes,
            actorUserId,
            now,
          });
          eventIds.push(event.eventId);
          const link = await linkGuardian(tx, {
            now,
            householdId,
            guardianPersonId: adult.personId,
            childPersonId: person.personId,
            consent: true,
            pickup: true,
            view: true,
            manage: false,
            actorUserId,
          });
          linkIds.push(link.linkId);
        }
        const adultEvent = await createLifeEvent(tx, kms, KEY_ARN, {
          personId: adult.personId,
          type: "baptism",
          date: "1984-04-04",
          place: "Marchetti Cathedral",
          actorUserId,
          now,
        });
        const [childOne, childTwo] = childIds;
        const [eventOne, eventTwo] = eventIds;
        const [linkOne, linkTwo] = linkIds;
        if (
          childOne === undefined ||
          childTwo === undefined ||
          eventOne === undefined ||
          eventTwo === undefined ||
          linkOne === undefined ||
          linkTwo === undefined
        ) {
          throw new Error("seed incomplete");
        }
        return {
          key,
          slug: slugs[key],
          householdId,
          adultId: adult.personId,
          childIds: [childOne, childTwo] as [string, string],
          eventIds: [eventOne, eventTwo] as [string, string],
          adultEventId: adultEvent.eventId,
          linkIds: [linkOne, linkTwo] as [string, string],
        };
      }),
    );
  }

  const send = async (
    caller: CallerName | "community_admin",
    aim: string,
    route: string,
    spec: RouteSpec,
    slug: string,
    one: Call,
  ): Promise<void> => {
    const body = { communitySlug: slug, ...one.body };
    // A body outside the contract would be refused before the route did anything, and the sweep
    // would pass without testing it. Every body is checked against the route's own contract.
    try {
      spec.schema.parse(body);
    } catch {
      throw new Error(`the sweep's body for ${route} (${one.label}) is outside its contract`);
    }
    const response = await postRoute(route.slice("POST ".length), body, tokens[caller]);
    results.push({
      route,
      caller,
      aim,
      label: one.label,
      status: response.status,
      text: await response.text(),
    });
  };

  beforeAll(async () => {
    const migration = createPlaintextDirectSql(loadRuntime().productOnlyUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }
  }, 120_000);

  beforeAll(async () => {
    // The whole run's logs: the gate's request lines go through console.log, and each route's own
    // log goes to the function below. Both are kept and neither is printed.
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          captured.push(args.map((arg) => String(arg)).join(" "));
        }),
      );
    }
    const logFn = (message: string, fields?: unknown): void => {
      captured.push(JSON.stringify({ message, fields }));
    };

    const runtime = loadRuntime();
    identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    app = createPlaintextAppSql(roleUrl(runtime, "app"));
    directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    kms = createLocalKmsPort();
    await identity`delete from identity.identity_keys`;

    const deps = {
      checkout,
      kms,
      keyArn: KEY_ARN,
      now: () => now,
      apiHostname: API_HOSTNAME,
      log: logFn,
      guardLog: logFn,
    };
    const byFile: Array<[string, GateRoute[]]> = [
      [PEOPLE_FILE, peopleRoutes(deps)],
      [HOUSEHOLD_FILE, householdRoutes(deps)],
      [LIFE_EVENT_FILE, lifeEventRoutes(deps)],
      [ACCESS_FILE, accessRoutes(deps)],
      [MINOR_VIEW_FILE, minorViewRoutes(deps)],
    ];
    registry = byFile.flatMap(([file, routes]) =>
      routes.map((route) => ({ file, key: `${route.method} ${route.pattern}` })),
    );
    server = startServer({ env: envFor(PORT), routes: byFile.flatMap(([, routes]) => routes) });
    await new Promise<void>((resolve, reject) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once("listening", () => resolve());
      server.once("error", reject);
    });

    // Two organisations, and three communities: A1 and A2 in the first, B1 in the second.
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values
          (${orgA}::uuid, ${`sw-org-a-${newId().slice(-8)}`}, 'au', 'implicit'),
          (${orgB}::uuid, ${`sw-org-b-${newId().slice(-8)}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values
          (${communityA1}::uuid, ${orgA}::uuid, ${slugs.a1}, 'au'),
          (${communityA2}::uuid, ${orgA}::uuid, ${slugs.a2}, 'au'),
          (${communityB1}::uuid, ${orgB}::uuid, ${slugs.b1}, 'au')
      `;
    });
    for (const [orgId, suffix] of [
      [orgA, "a"],
      [orgB, "b"],
    ] as const) {
      const planKey = `sw_plan_${suffix}_${orgId.slice(-8)}`;
      await upsertPlan(platform, {
        key: planKey,
        entitlements: [
          { key: "people.directory", limit: null },
          { key: "people.households", limit: null },
          { key: "groups.basic", limit: null },
        ],
      });
      await assignPlan(platform, { organisationId: orgId, planKey, now });
      await platform`
        insert into platform.billing_accounts (
          organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status
        ) values (
          ${orgId}::uuid,
          'self_serve',
          ${`cus_${newId().replaceAll("-", "")}`},
          ${`sub_${newId().replaceAll("-", "")}`},
          'active'
        )
      `;
    }

    // The callers: one per role the spec names, and a Community Admin.
    const admin = await signIn("sw-admin");
    tokens.community_admin = admin.accessToken;
    const sessions = {
      staff: await signIn("sw-staff"),
      safeguarding_officer: await signIn("sw-safeguarding"),
      custom_restricted: await signIn("sw-restricted"),
      custom_all: await signIn("sw-all"),
      org_admin: await signIn("sw-orgadmin"),
      member: await signIn("sw-member"),
    };
    for (const name of NON_ADMIN) {
      tokens[name] = sessions[name].accessToken;
    }
    memberUserId = sessions.member.userId;
    const childLinked = await signIn("sw-childlinked");
    const adultLinked = await signIn("sw-adultlinked");

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopes.a1, async (tx) => {
        await bootstrapOwner(tx, { now, userId: admin.userId, actorUserId: admin.userId });
        const grant = async (
          userId: string,
          roleKey: string | null,
          customRoleId: string | null,
        ): Promise<void> => {
          await addMember(tx, userId);
          await grantRole(tx, { now, userId, roleKey, customRoleId, actorUserId: admin.userId });
        };
        // `staff` holds people.view through a custom role, as a parish staff member would.
        const viewRole = await createCustomRole(tx, {
          now,
          key: "sweep_view_only",
          permissions: ["people.view"],
          actorUserId: admin.userId,
        });
        await grant(sessions.staff.userId, "staff", null);
        await grantRole(tx, {
          now,
          userId: sessions.staff.userId,
          roleKey: null,
          customRoleId: viewRole.customRoleId,
          actorUserId: admin.userId,
        });
        await grant(sessions.safeguarding_officer.userId, "safeguarding_officer", null);
        const restrictedRole = await createCustomRole(tx, {
          now,
          key: "sweep_restricted",
          permissions: ["people.restricted.read"],
          actorUserId: admin.userId,
        });
        await grant(sessions.custom_restricted.userId, null, restrictedRole.customRoleId);
        const allRole = await createCustomRole(tx, {
          now,
          key: "sweep_all_perms",
          permissions: [...catalogue()],
          actorUserId: admin.userId,
        });
        await grant(sessions.custom_all.userId, null, allRole.customRoleId);
        await grant(sessions.org_admin.userId, "org_admin", null);
        await grant(sessions.member.userId, "member", null);
        await grant(childLinked.userId, "member", null);
      }),
    );

    targets.a1 = await seedTenant("a1", admin.userId);
    targets.a2 = await seedTenant("a2", admin.userId);
    targets.b1 = await seedTenant("b1", admin.userId);

    // A group with an adult and a child in it, a user linked to an adult, and a user linked to a
    // child. Linking a user to a child is refused by the product, so that row is inserted as the
    // migrator, as the users-list tests do for existing data.
    groupId = await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopes.a1, async (tx) => {
        await addMember(tx, adultLinked.userId);
        await grantRole(tx, {
          now,
          userId: adultLinked.userId,
          roleKey: "member",
          customRoleId: null,
          actorUserId: admin.userId,
        });
        await linkUser(tx, {
          now,
          userId: adultLinked.userId,
          personId: targets.a1.adultId,
          actorUserId: admin.userId,
        });
        const group = await createGroup(tx, {
          name: "Sweep Choir",
          kind: "group",
          now,
          actorUserId: admin.userId,
        });
        await addGroupMember(tx, kms, KEY_ARN, {
          groupId: group.id,
          personId: targets.a1.adultId,
          role: "leader",
          now,
          actorUserId: admin.userId,
          childView: "admin",
        });
        await addGroupMember(tx, kms, KEY_ARN, {
          groupId: group.id,
          personId: targets.a1.childIds[0],
          now,
          actorUserId: admin.userId,
          childView: "admin",
        });
        return group.id;
      }),
    );
    await directSql`
      insert into app.user_links (id, org_id, community_id, user_id, person_id)
      values (
        ${newId()}::uuid, ${orgA}::uuid, ${communityA1}::uuid,
        ${childLinked.userId}::uuid, ${targets.a1.childIds[0]}::uuid
      )
    `;

    // ---- The sweep. Every caller who is not a Community Admin calls every route, on its own
    // community with its own ids and with the ids of the other two communities. The organisation
    // administrator also calls the other community of its organisation, which it can reach.
    for (const name of NON_ADMIN) {
      const aims: Array<{ aim: string; target: Target; slug: string }> = [
        { aim: "own", target: targets.a1, slug: slugs.a1 },
        { aim: "other community", target: targets.a2, slug: slugs.a1 },
        { aim: "other organisation", target: targets.b1, slug: slugs.a1 },
      ];
      if (name === "org_admin") {
        aims.push({ aim: "own, second community", target: targets.a2, slug: slugs.a2 });
      }
      for (const [route, spec] of Object.entries(ROUTES)) {
        const sent = new Set<string>();
        for (const { aim, target, slug } of aims) {
          for (const one of spec.nonAdmin({ target, groupId, memberUserId })) {
            const key = JSON.stringify([slug, one.body]);
            if (sent.has(key)) {
              continue;
            }
            sent.add(key);
            await send(name, aim, route, spec, slug, one);
          }
        }
      }
    }
    // The Community Admin calls the list and read routes only, on its own community.
    for (const [route, spec] of Object.entries(ROUTES)) {
      if (spec.admin === undefined) {
        continue;
      }
      for (const one of spec.admin({ target: targets.a1, groupId, memberUserId })) {
        await send("community_admin", "own", route, spec, slugs.a1, one);
      }
    }
  }, 600_000);

  afterAll(async () => {
    for (const spy of spies) {
      spy.mockRestore();
    }
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
      server?.closeAllConnections();
    });
    await Promise.all([
      identity?.end({ timeout: 1 }),
      platform?.end({ timeout: 1 }),
      app?.end({ timeout: 1 }),
      directSql?.end({ timeout: 1 }),
    ]);
  });

  const everyTarget = (): Target[] => [targets.a1, targets.a2, targets.b1];

  it("pin 79: every route in the people, household, life-event, access and minor-view route files is in the sweep", () => {
    const registered = registry.map((entry) => `${entry.file} ${entry.key}`).sort();
    const unlisted = registry
      .filter((entry) => ROUTES[entry.key] === undefined || ROUTES[entry.key]?.file !== entry.file)
      .map((entry) => `${entry.file} ${entry.key}`);
    expect(unlisted).toEqual([]);

    // And no row stands for a route that is not registered.
    const keys = new Set(registry.map((entry) => entry.key));
    expect(Object.keys(ROUTES).filter((key) => !keys.has(key))).toEqual([]);
    // Five files, and every route is registered once.
    expect(new Set(registered).size).toBe(registered.length);
    expect(new Set(registry.map((entry) => entry.file))).toEqual(
      new Set([PEOPLE_FILE, HOUSEHOLD_FILE, LIFE_EVENT_FILE, ACCESS_FILE, MINOR_VIEW_FILE]),
    );
  });

  it("every caller who is not a Community Admin called every route, and the Community Admin every list and read route", () => {
    const missing: string[] = [];
    for (const [route, spec] of Object.entries(ROUTES)) {
      for (const name of NON_ADMIN) {
        const own = results.filter(
          (r) => r.route === route && r.caller === name && r.aim === "own",
        );
        if (own.length < spec.nonAdmin({ target: targets.a1, groupId, memberUserId }).length) {
          missing.push(`${name} ${route}`);
        }
      }
      if (spec.admin !== undefined) {
        const own = results.filter((r) => r.route === route && r.caller === "community_admin");
        if (own.length < spec.admin({ target: targets.a1, groupId, memberUserId }).length) {
          missing.push(`community_admin ${route}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("pin 80: no non-admin response carries a seeded minor's name, id, life-event id, email, phone or DOB", () => {
    const children = seededChildren(everyTarget());
    expect(children).toHaveLength(6);
    const nonAdmin = results.filter((r) => r.caller !== "community_admin");
    expect(nonAdmin.length).toBeGreaterThan(500);

    const leaks: string[] = [];
    for (const result of nonAdmin) {
      const found = [...fieldLeaks(result.text, children), ...idLeaks(result.text, children)];
      for (const kind of found) {
        leaks.push(`${result.caller} ${result.route} (${result.aim}, ${result.label}): ${kind}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("pin 80b: the grants list leaves out a user's link to a child for a non-admin, and shows it to a Community Admin", () => {
    type Links = { userLinks: Array<{ userId: string; personId: string }> };
    const child = targets.a1.childIds[0];
    const adult = targets.a1.adultId;
    const linksFor = (caller: CallerName | "community_admin", aim: string): Links["userLinks"] => {
      const found = results.find(
        (r) =>
          r.caller === caller &&
          r.aim === aim &&
          r.route === "POST /v1/access/grants/list" &&
          r.label === "the grants",
      );
      expect(found?.status, caller).toBe(200);
      return (JSON.parse(found?.text ?? "{}") as Links).userLinks;
    };

    // Three callers may view roles. None of them is told which user is linked to a child, and an
    // adult's link is listed as it was.
    for (const name of ["staff", "custom_all", "org_admin"] as const) {
      const links = linksFor(name, "own");
      expect(
        links.some((link) => link.personId === child),
        name,
      ).toBe(false);
      expect(
        links.some((link) => link.personId === adult),
        name,
      ).toBe(true);
    }
    const adminLinks = linksFor("community_admin", "own");
    expect(adminLinks.some((link) => link.personId === child)).toBe(true);
    expect(adminLinks.some((link) => link.personId === adult)).toBe(true);
  });

  it("a Community Admin's list and read answers carry no child field value", () => {
    const children = seededChildren(everyTarget());
    const admin = results.filter((r) => r.caller === "community_admin");
    expect(admin.length).toBeGreaterThan(15);

    const leaks: string[] = [];
    for (const result of admin) {
      for (const kind of fieldLeaks(result.text, children)) {
        leaks.push(`${result.route} (${result.label}): ${kind}`);
      }
    }
    expect(leaks).toEqual([]);

    // The admin's answers do show children, as ids and labels, so the scan above is not vacuous.
    const read = admin.find((r) => r.route === "POST /v1/households/read");
    expect(read?.status).toBe(200);
    expect(read?.text).toContain("Child 1");
    expect(read?.text).toContain(targets.a1.childIds[0]);
    const minors = admin.find((r) => r.route === "POST /v1/people/list" && r.label === "minors");
    expect(minors?.status).toBe(200);
    expect(minors?.text).toContain(targets.a1.childIds[0]);
    const users = admin.find((r) => r.route === "POST /v1/access/users/list");
    expect(users?.status).toBe(200);
    expect(users?.text).toContain('"minor":true');
  });

  it("the sweep reached the routes: a caller with the permission got an answer, not a refusal of the body", () => {
    const pick = (
      caller: CallerName,
      route: string,
      label: string,
      aim: string = "own",
    ): Result => {
      const found = results.find(
        (r) => r.caller === caller && r.route === route && r.label === label && r.aim === aim,
      );
      if (found === undefined) {
        throw new Error(`no result for ${caller} ${route} ${label}`);
      }
      return found;
    };

    // A staff member with people.view reads the family and sees a count of children only.
    const family = pick("staff", "POST /v1/households/read", "the family");
    expect(family.status).toBe(200);
    expect(JSON.parse(family.text)).toMatchObject({ minors: { childCount: 2 } });
    expect(pick("org_admin", "POST /v1/households/read", "the family").status).toBe(200);
    expect(pick("custom_all", "POST /v1/households/read", "the family").status).toBe(200);

    // The adult list answers, the children's list and a child's record do not.
    expect(pick("org_admin", "POST /v1/people/list", "adults").status).toBe(200);
    expect(pick("custom_all", "POST /v1/people/list", "minors").status).toBe(403);
    expect(pick("org_admin", "POST /v1/people/read", "a child").status).toBe(404);
    expect(pick("org_admin", "POST /v1/people/read", "an adult").status).toBe(200);
    expect(pick("org_admin", "POST /v1/people/life-events/list", "a child").status).toBe(404);

    // A View is refused to every one of them.
    for (const name of NON_ADMIN) {
      const view = pick(name, "POST /v1/people/minors/view", "a name");
      expect([401, 403]).toContain(view.status);
      expect(view.text).toBe("");
    }
    // The adult list in a group with a child in it answers, and shows no child.
    expect(pick("org_admin", "POST /v1/people/list", "a group with a child in it").status).toBe(
      200,
    );
    // A user linked to a child is listed for a caller who may see users, with no contact.
    expect(pick("staff", "POST /v1/access/users/list", "the users").status).toBe(200);
    // The organisation administrator also reached the other community of its organisation.
    expect(
      pick("org_admin", "POST /v1/households/read", "the family", "own, second community").status,
    ).toBe(200);
  });

  it("a rename probe with a child's given name answers as one without", () => {
    // Anything a server checks against a child's name is a name oracle for whoever can trigger it
    // (spec D5, O3). A caller who may not rename the family gets one answer whatever the label.
    for (const name of NON_ADMIN) {
      const plain = results.find(
        (r) =>
          r.caller === name &&
          r.aim === "own" &&
          r.route === "POST /v1/households/rename" &&
          r.label === "a plain label",
      );
      const probe = results.find(
        (r) =>
          r.caller === name &&
          r.aim === "own" &&
          r.route === "POST /v1/households/rename" &&
          r.label === "a label with a child's given name",
      );
      expect(plain, `${name} plain`).toBeDefined();
      expect(probe, `${name} probe`).toBeDefined();
      expect([probe?.status, probe?.text], name).toEqual([plain?.status, plain?.text]);
    }
  });

  it("the whole run's logs hold no seeded child value", () => {
    const children = seededChildren(everyTarget());
    // The gate logged a line for every call, and the routes logged theirs.
    expect(captured.length).toBeGreaterThan(results.length);
    const text = captured.join("\n");
    expect([...fieldLeaks(text, children), ...idLeaks(text, children)]).toEqual([]);
  });

  it("the scanner finds each kind of seeded value it is looking for", () => {
    const children = seededChildren(everyTarget());
    const first = SEEDS.a1.children[0];
    const target = targets.a1;
    const kinds: Array<[string, string]> = [
      ["given name", `{"x":"${first.givenName}"}`],
      ["family name", `{"x":"${first.familyName}"}`],
      ["email", `{"x":"${first.email}"}`],
      ["phone", `{"x":"${first.phone}"}`],
      ["phone digits", `{"x":"${first.phone.slice(1)}"}`],
      ["date of birth", `{"x":"${first.dateOfBirth}"}`],
      ["life-event place", `{"x":"${first.place}"}`],
      ["life-event notes", `{"x":"${first.notes}"}`],
      ["birthdayMd", `{"birthdayMd":${birthdayMd(first.dateOfBirth)}}`],
    ];
    for (const [kind, text] of kinds) {
      expect(
        fieldLeaks(text, children).some((hit) => hit.endsWith(kind)),
        kind,
      ).toBe(true);
    }
    // A name in another case, and an id, are found too.
    expect(fieldLeaks(`"${first.givenName.toUpperCase()}"`, children)).not.toEqual([]);
    expect(idLeaks(`{"personId":"${target.childIds[0]}"}`, children)).toEqual([
      "a1 child 0 person id",
    ]);
    expect(idLeaks(`{"eventId":"${target.eventIds[1]}"}`, children)).toEqual([
      "a1 child 1 life-event id",
    ]);
    // An adult's values and a different birthday are not child values.
    expect(fieldLeaks(JSON.stringify(SEEDS.a1.adult), children)).toEqual([]);
    expect(fieldLeaks('{"birthdayMd":202}', children)).toEqual([]);
    expect(
      idLeaks(JSON.stringify({ id: target.adultId, householdId: target.householdId }), children),
    ).toEqual([]);
  });
});
