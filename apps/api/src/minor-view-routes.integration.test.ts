import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, grantRole } from "@community-hub/access";
import { addMember } from "@community-hub/access/testing";
import {
  minorViewErrorBody,
  minorViewNameResponse,
  minorViewValueResponse,
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
import { withRequest } from "@community-hub/kernel";
import { createHousehold, createLifeEvent, createPerson } from "@community-hub/people";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { minorViewRoutes } from "./minor-view-routes.js";
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
const PORT = 18493;
const REQUEST_ID = "88888888-8888-4888-8888-888888888888";

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

// Seeded child values are unusual on purpose: a substring hit is never a coincidence.
const CHILD_ONE = {
  givenName: "Zephyrine",
  familyName: "Quillonwick",
  email: "zephyrine.quillonwick@zephyr.example.test",
  phone: "+61400555301",
  dateOfBirth: "2018-05-05",
};
const CHILD_TWO = {
  givenName: "Quillon",
  familyName: "Zephyrwick",
  dateOfBirth: "2019-06-07",
};
const EVENT_ONE = {
  type: "baptism",
  date: "2019-03-03",
  place: "Zephyr Chapel",
  notes: "Quillonwick godparents",
};

const SEEDED_VALUES = [
  CHILD_ONE.givenName,
  CHILD_ONE.familyName,
  CHILD_ONE.email,
  CHILD_ONE.phone,
  CHILD_ONE.phone.slice(1),
  CHILD_ONE.dateOfBirth,
  CHILD_TWO.givenName,
  CHILD_TWO.familyName,
  CHILD_TWO.dateOfBirth,
  EVENT_ONE.place,
  EVENT_ONE.notes,
];

type Scope = { orgId: string; communityId: string };
type AuditRow = {
  action: string;
  purpose: string;
  actor_id: string | null;
  target_ids: string[];
};

describe("the Community Admin's View routes (pins 64, 67b, 68, 69, 70, 71)", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  let identity: ReturnType<typeof createPlaintextIdentitySql>;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let directSql: ReturnType<typeof createPlaintextDirectSql>;
  let kms: ReturnType<typeof createLocalKmsPort>;
  let server: Server;
  const logged: string[] = [];

  const orgA = newId();
  const orgC = newId();
  const communityA1 = newId();
  const communityA2 = newId();
  const communityC = newId();
  const slugA1 = `mv-a1-${newId().slice(-8)}`;
  const slugA2 = `mv-a2-${newId().slice(-8)}`;
  const slugC = `mv-c-${newId().slice(-8)}`;
  const scopeA1: Scope = { orgId: orgA, communityId: communityA1 };
  const scopeA2: Scope = { orgId: orgA, communityId: communityA2 };
  const scopeC: Scope = { orgId: orgC, communityId: communityC };

  let ownerA1: string;
  let family: {
    adultId: string;
    childOneId: string;
    childTwoId: string;
    eventOneId: string;
    eventTwoId: string;
    adultEventId: string;
  };
  let childInC: string;
  let adminA2: { userId: string; accessToken: string };
  let adminC: { userId: string; accessToken: string };
  let staff: { userId: string; accessToken: string };

  const checkout = async <T>(role: Role, run: (sql: never) => Promise<T>): Promise<T> => {
    if (role === "identity") {
      return run(identity as never);
    }
    if (role === "platform") {
      return run(platform as never);
    }
    return run(app as never);
  };

  // A new user with one live session and a fresh check at `now`, which is what a second-step
  // sign-in leaves (ADR 0022 point 4; the sign-in flow is the identity package's tests). The helper
  // signs in through TOTP setup, which leaves no check, so the check is set here.
  async function signIn(label: string): Promise<{ userId: string; accessToken: string }> {
    const session = await signInWithTotpInProcess(
      identity,
      kms,
      KEY_ARN,
      `${label}-${newId().slice(-8)}@users.example.test`,
      now,
    );
    await setFresh(session.userId, now);
    return { userId: session.userId, accessToken: session.accessToken };
  }

  // A new Community Admin of community A1, with a fresh check.
  async function newAdmin(): Promise<{ userId: string; accessToken: string }> {
    const session = await signIn("admin-a1");
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeA1, async (tx) => {
        await addMember(tx, session.userId);
        await grantRole(tx, {
          now,
          userId: session.userId,
          roleKey: "community_admin",
          customRoleId: null,
          actorUserId: ownerA1,
        });
      }),
    );
    return session;
  }

  async function postRoute(
    pathName: string,
    body: unknown,
    token?: string,
    hostname: string = API_HOSTNAME,
  ): Promise<Response> {
    const headers = new Headers({
      "content-type": "application/json",
      "x-community-hub-hostname": hostname,
    });
    if (token !== undefined) {
      headers.set("authorization", `Bearer ${token}`);
    }
    return fetch(`http://127.0.0.1:${PORT}${pathName}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  function viewPerson(
    token: string | undefined,
    personId: string,
    field: string,
    slug: string = slugA1,
  ): Promise<Response> {
    return postRoute("/v1/people/minors/view", { communitySlug: slug, personId, field }, token);
  }

  function viewEvent(
    token: string | undefined,
    personId: string,
    lifeEventId: string,
    field: string,
    slug: string = slugA1,
  ): Promise<Response> {
    return postRoute(
      "/v1/people/minors/life-events/view",
      { communitySlug: slug, personId, lifeEventId, field },
      token,
    );
  }

  // What a successful fresh check leaves on the session (the check itself is the identity
  // package's tests). The user has one live session in these tests.
  async function setFresh(userId: string, at: Date | null): Promise<void> {
    await directSql`
      update identity.sessions
      set fresh_factor_at = ${at === null ? null : at.toISOString()}::timestamptz
      where user_id = ${userId} and revoked_at is null
    `;
  }

  async function setRecovery(userId: string): Promise<void> {
    await directSql`
      update identity.sessions
      set recovery_until = ${new Date(now.getTime() + 3_600_000).toISOString()}::timestamptz
      where user_id = ${userId} and revoked_at is null
    `;
  }

  async function freshAt(userId: string): Promise<Date | null> {
    const rows = await directSql<{ fresh_factor_at: Date | null }[]>`
      select fresh_factor_at from identity.sessions
      where user_id = ${userId} and revoked_at is null
    `;
    expect(rows).toHaveLength(1);
    return rows[0]?.fresh_factor_at ?? null;
  }

  async function auditRows(scope: Scope, action: string): Promise<AuditRow[]> {
    return withAppTransaction(
      app,
      scope,
      (tx) =>
        tx<AuditRow[]>`
        select action, purpose, actor_id::text as actor_id, target_ids::text[] as target_ids
        from app.audit_events
        where action = ${action}
        order by seq
      `,
    );
  }

  const VIEWED = "people.minor.field_viewed";
  const DENIED = "access.permission.denied";

  beforeAll(async () => {
    const migration = createPlaintextDirectSql(loadRuntime().productOnlyUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }
  });

  beforeAll(async () => {
    const runtime = loadRuntime();
    identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    app = createPlaintextAppSql(roleUrl(runtime, "app"));
    directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    kms = createLocalKmsPort();
    await identity`delete from identity.identity_keys`;

    server = startServer({
      env: envFor(PORT),
      routes: minorViewRoutes({
        checkout,
        kms,
        keyArn: KEY_ARN,
        now: () => now,
        apiHostname: API_HOSTNAME,
        log: (message, fields) => {
          logged.push(JSON.stringify({ message, fields }));
        },
        guardLog: (message, fields) => {
          logged.push(JSON.stringify({ message, fields }));
        },
      }),
    });
    await new Promise<void>((resolve, reject) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once("listening", () => resolve());
      server.once("error", reject);
    });

    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values
          (${orgA}::uuid, ${`mv-org-a-${newId().slice(-8)}`}, 'au', 'implicit'),
          (${orgC}::uuid, ${`mv-org-c-${newId().slice(-8)}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values
          (${communityA1}::uuid, ${orgA}::uuid, ${slugA1}, 'au'),
          (${communityA2}::uuid, ${orgA}::uuid, ${slugA2}, 'au'),
          (${communityC}::uuid, ${orgC}::uuid, ${slugC}, 'au')
      `;
    });

    const planWithHouseholds = `mv_plan_hh_${orgA.slice(-8)}`;
    await upsertPlan(platform, {
      key: planWithHouseholds,
      entitlements: [
        { key: "people.directory", limit: null },
        { key: "people.households", limit: null },
      ],
    });
    await assignPlan(platform, { organisationId: orgA, planKey: planWithHouseholds, now });
    const planWithoutHouseholds = `mv_plan_no_hh_${orgC.slice(-8)}`;
    await upsertPlan(platform, {
      key: planWithoutHouseholds,
      entitlements: [{ key: "people.directory", limit: null }],
    });
    await assignPlan(platform, { organisationId: orgC, planKey: planWithoutHouseholds, now });

    // Community A1: the owner (who is a Community Admin there), a staff member, and a family.
    const owner = await signIn("owner-a1");
    ownerA1 = owner.userId;
    staff = await signIn("staff-a1");
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeA1, async (tx) => {
        await bootstrapOwner(tx, { now, userId: ownerA1, actorUserId: ownerA1 });
        await addMember(tx, staff.userId);
        await grantRole(tx, {
          now,
          userId: staff.userId,
          roleKey: "staff",
          customRoleId: null,
          actorUserId: ownerA1,
        });
      }),
    );

    // The admin of community A2 only: a Community Admin elsewhere in the same organisation.
    adminA2 = await signIn("admin-a2");
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeA2, async (tx) => {
        await addMember(tx, adminA2.userId);
        await grantRole(tx, {
          now,
          userId: adminA2.userId,
          roleKey: "community_admin",
          customRoleId: null,
          actorUserId: ownerA1,
        });
      }),
    );

    // Community C has no households entitlement. Its owner is a Community Admin there.
    adminC = await signIn("admin-c");
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeC, (tx) =>
        bootstrapOwner(tx, { now, userId: adminC.userId, actorUserId: adminC.userId }),
      ),
    );

    family = await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeA1, async (tx) => {
        const household = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: "Marchetti",
          actorUserId: null,
        });
        const householdId = household.householdId;
        const adult = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId,
          dateOfBirth: "1984-02-02",
          givenName: "Aurelia",
          familyName: "Marchetti",
          email: "aurelia.marchetti@parish.example.test",
          phone: "+61400555300",
          actorUserId: null,
        });
        const childOne = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: false,
          householdId,
          ...CHILD_ONE,
          actorUserId: null,
        });
        const childTwo = await createPerson(tx, kms, KEY_ARN, {
          now: new Date(now.getTime() + 3_600_000),
          declaredAdult: false,
          householdId,
          ...CHILD_TWO,
          email: null,
          phone: null,
          actorUserId: null,
        });
        const eventOne = await createLifeEvent(tx, kms, KEY_ARN, {
          personId: childOne.personId,
          ...EVENT_ONE,
          actorUserId: null,
          now,
        });
        const eventTwo = await createLifeEvent(tx, kms, KEY_ARN, {
          personId: childTwo.personId,
          type: "first_communion",
          date: "2026-05-10",
          actorUserId: null,
          now,
        });
        const adultEvent = await createLifeEvent(tx, kms, KEY_ARN, {
          personId: adult.personId,
          type: "baptism",
          date: "1984-04-04",
          place: "Marchetti Cathedral",
          actorUserId: null,
          now,
        });
        return {
          adultId: adult.personId,
          childOneId: childOne.personId,
          childTwoId: childTwo.personId,
          eventOneId: eventOne.eventId,
          eventTwoId: eventTwo.eventId,
          adultEventId: adultEvent.eventId,
        };
      }),
    );

    // A child in community C, whose organisation has no households entitlement.
    childInC = await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeC, async (tx) => {
        const household = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: "Hollowell",
          actorUserId: null,
        });
        const child = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: false,
          householdId: household.householdId,
          givenName: "Marigold",
          familyName: "Hollowell",
          email: null,
          phone: null,
          dateOfBirth: "2017-01-02",
          actorUserId: null,
        });
        return child.personId;
      }),
    );
  });

  afterAll(async () => {
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

  it("a Community Admin with a fresh check views a name, a date of birth and a life-event place", async () => {
    const admin = await newAdmin();

    // The admin holds a fresh check, so the first View needs no panel.
    const name = await viewPerson(admin.accessToken, family.childOneId, "name");
    expect(name.status).toBe(200);
    expect(name.headers.get("cache-control")).toBe("no-store");
    expect(minorViewNameResponse.parse(await name.json())).toEqual({
      value: { given: CHILD_ONE.givenName, family: CHILD_ONE.familyName },
    });
    // The View used the check up.
    expect(await freshAt(admin.userId)).toBeNull();

    await setFresh(admin.userId, now);
    const dateOfBirth = await viewPerson(admin.accessToken, family.childOneId, "dateOfBirth");
    expect(dateOfBirth.status).toBe(200);
    expect(minorViewValueResponse.parse(await dateOfBirth.json())).toEqual({
      value: CHILD_ONE.dateOfBirth,
    });

    await setFresh(admin.userId, now);
    const place = await viewEvent(admin.accessToken, family.childOneId, family.eventOneId, "place");
    expect(place.status).toBe(200);
    expect(place.headers.get("cache-control")).toBe("no-store");
    expect(minorViewValueResponse.parse(await place.json())).toEqual({ value: EVENT_ONE.place });

    // One audit row per View, with ids only.
    const rows = (await auditRows(scopeA1, VIEWED)).filter((row) => row.actor_id === admin.userId);
    expect(rows.map((row) => [row.purpose, row.target_ids])).toEqual([
      ["people.minor_view.name", [family.childOneId]],
      ["people.minor_view.date_of_birth", [family.childOneId]],
      ["people.minor_view.life_event_place", [family.childOneId, family.eventOneId]],
    ]);
  });

  it("the second View without a new check gets fresh_required, and shows nothing", async () => {
    const admin = await newAdmin();
    expect((await viewPerson(admin.accessToken, family.childOneId, "email")).status).toBe(200);

    const second = await viewPerson(admin.accessToken, family.childOneId, "phone");
    expect(second.status).toBe(403);
    expect(second.headers.get("cache-control")).toBe("no-store");
    const text = await second.text();
    expect(minorViewErrorBody.parse(JSON.parse(text))).toEqual({ code: "fresh_required" });
    for (const value of SEEDED_VALUES) {
      expect(text).not.toContain(value);
    }

    // One View, so one audit row.
    const rows = (await auditRows(scopeA1, VIEWED)).filter((row) => row.actor_id === admin.userId);
    expect(rows.map((row) => row.purpose)).toEqual(["people.minor_view.email"]);
  });

  it("two Views on one check give one 200 and one fresh_required", async () => {
    const admin = await newAdmin();
    const [first, second] = await Promise.all([
      viewPerson(admin.accessToken, family.childOneId, "dateOfBirth"),
      viewPerson(admin.accessToken, family.childOneId, "dateOfBirth"),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 403]);
    const refused = first.status === 403 ? first : second;
    expect(minorViewErrorBody.parse(await refused.json())).toEqual({ code: "fresh_required" });
    const rows = (await auditRows(scopeA1, VIEWED)).filter((row) => row.actor_id === admin.userId);
    expect(rows).toHaveLength(1);
  });

  it("a missing field value is null", async () => {
    const admin = await newAdmin();
    const email = await viewPerson(admin.accessToken, family.childTwoId, "email");
    expect(email.status).toBe(200);
    expect(minorViewValueResponse.parse(await email.json())).toEqual({ value: null });

    await setFresh(admin.userId, now);
    const notes = await viewEvent(admin.accessToken, family.childTwoId, family.eventTwoId, "notes");
    expect(notes.status).toBe(200);
    expect(minorViewValueResponse.parse(await notes.json())).toEqual({ value: null });
  });

  it("pin 64: a refused View leaves the fresh check in place", async () => {
    // A caller who is not a Community Admin, with a fresh check: 403, and the check is still held.
    const before = await freshAt(staff.userId);
    expect(before).not.toBeNull();
    const refused = await viewPerson(staff.accessToken, family.childOneId, "name");
    expect(refused.status).toBe(403);
    expect(await freshAt(staff.userId)).not.toBeNull();

    // A Community Admin whose View finds no such child: 404, and the check is still held.
    const admin = await newAdmin();
    const missing = await viewPerson(admin.accessToken, newId(), "name");
    expect(missing.status).toBe(404);
    expect(await freshAt(admin.userId)).not.toBeNull();

    // An adult, a life event of the other child, and a child of another organisation (its id sent
    // with this community's slug): the same 404, and the check is still held.
    expect((await viewPerson(admin.accessToken, family.adultId, "name")).status).toBe(404);
    expect(
      (await viewEvent(admin.accessToken, family.childOneId, family.eventTwoId, "place")).status,
    ).toBe(404);
    expect((await viewPerson(admin.accessToken, childInC, "name")).status).toBe(404);
    expect(await freshAt(admin.userId)).not.toBeNull();

    // The same View, now allowed, still has the check to use.
    const allowed = await viewPerson(admin.accessToken, family.childOneId, "name");
    expect(allowed.status).toBe(200);
    expect(await freshAt(admin.userId)).toBeNull();
  });

  it("a Community Admin of another community is refused, and the check stays", async () => {
    const before = await freshAt(adminA2.userId);
    expect(before).not.toBeNull();
    const refused = await viewPerson(adminA2.accessToken, family.childOneId, "name", slugA1);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe("");
    expect(await freshAt(adminA2.userId)).not.toBeNull();
  });

  it("pin 67b: a non-admin's refused View writes one denial row with the person id and no value", async () => {
    const outsider = await signIn("staff-denied");
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeA1, async (tx) => {
        await addMember(tx, outsider.userId);
        await grantRole(tx, {
          now,
          userId: outsider.userId,
          roleKey: "staff",
          customRoleId: null,
          actorUserId: ownerA1,
        });
      }),
    );

    const refused = await viewPerson(outsider.accessToken, family.childOneId, "dateOfBirth");
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe("");

    const denied = (await auditRows(scopeA1, DENIED)).filter(
      (row) => row.actor_id === outsider.userId,
    );
    expect(denied).toEqual([
      {
        action: DENIED,
        purpose: "people.minor_view.date_of_birth",
        actor_id: outsider.userId,
        target_ids: [family.childOneId],
      },
    ]);
    expect(JSON.stringify(denied)).not.toContain(CHILD_ONE.dateOfBirth);
    // No View was written for them.
    expect(
      (await auditRows(scopeA1, VIEWED)).filter((row) => row.actor_id === outsider.userId),
    ).toEqual([]);
  });

  it("pin 68: every View answer, 200, 400, 401, 403 and 404, carries no-store", async () => {
    const admin = await newAdmin();
    const noStore = (response: Response): string | null => response.headers.get("cache-control");

    const ok = await viewPerson(admin.accessToken, family.childOneId, "name");
    expect(ok.status).toBe(200);
    expect(noStore(ok)).toBe("no-store");

    // Fresh check used up: 403 with a code.
    const fresh = await viewPerson(admin.accessToken, family.childOneId, "name");
    expect(fresh.status).toBe(403);
    expect(noStore(fresh)).toBe("no-store");

    // Not a Community Admin: 403, empty.
    const notAdmin = await viewPerson(staff.accessToken, family.childOneId, "name");
    expect(notAdmin.status).toBe(403);
    expect(noStore(notAdmin)).toBe("no-store");

    // A community without the households entitlement.
    const entitlement = await viewPerson(adminC.accessToken, childInC, "name", slugC);
    expect(entitlement.status).toBe(403);
    expect(noStore(entitlement)).toBe("no-store");

    // A community that does not exist.
    const unknown = await viewPerson(admin.accessToken, family.childOneId, "name", "no-such-slug");
    expect(unknown.status).toBe(403);
    expect(noStore(unknown)).toBe("no-store");

    // No such child.
    await setFresh(admin.userId, now);
    const missing = await viewPerson(admin.accessToken, newId(), "name");
    expect(missing.status).toBe(404);
    expect(noStore(missing)).toBe("no-store");

    // No session.
    const noSession = await viewPerson(undefined, family.childOneId, "name");
    expect(noSession.status).toBe(401);
    expect(noStore(noSession)).toBe("no-store");

    // A body outside the contract.
    const badField = await postRoute(
      "/v1/people/minors/view",
      { communitySlug: slugA1, personId: family.childOneId, field: "notes" },
      admin.accessToken,
    );
    expect(badField.status).toBe(400);
    expect(noStore(badField)).toBe("no-store");

    // The life-event route answers the same way.
    const eventRefused = await viewEvent(
      staff.accessToken,
      family.childOneId,
      family.eventOneId,
      "place",
    );
    expect(eventRefused.status).toBe(403);
    expect(noStore(eventRefused)).toBe("no-store");
    const eventOk = await viewEvent(
      admin.accessToken,
      family.childOneId,
      family.eventOneId,
      "type",
    );
    expect(eventOk.status).toBe(200);
    expect(noStore(eventOk)).toBe("no-store");
  });

  it("pin 69: a backup-code session's first View answers recovery_session", async () => {
    const admin = await newAdmin();
    await setRecovery(admin.userId);
    const response = await viewPerson(admin.accessToken, family.childOneId, "name");
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(minorViewErrorBody.parse(JSON.parse(text))).toEqual({ code: "recovery_session" });
    for (const value of SEEDED_VALUES) {
      expect(text).not.toContain(value);
    }
    // The recovery window never allows a View, and uses nothing up.
    expect(await freshAt(admin.userId)).not.toBeNull();
    expect(
      (await auditRows(scopeA1, VIEWED)).filter((row) => row.actor_id === admin.userId),
    ).toEqual([]);
  });

  it("pin 70: a session with no fresh check answers fresh_required", async () => {
    const none = await newAdmin();
    await setFresh(none.userId, null);
    const noCheck = await viewPerson(none.accessToken, family.childOneId, "name");
    expect(noCheck.status).toBe(403);
    expect(minorViewErrorBody.parse(await noCheck.json())).toEqual({ code: "fresh_required" });

    // A check older than five minutes is no check.
    const stale = await newAdmin();
    await setFresh(stale.userId, new Date(now.getTime() - 5 * 60_000 - 1_000));
    const staleCheck = await viewPerson(stale.accessToken, family.childOneId, "name");
    expect(staleCheck.status).toBe(403);
    expect(minorViewErrorBody.parse(await staleCheck.json())).toEqual({ code: "fresh_required" });

    // Neither View read anything.
    for (const admin of [none, stale]) {
      expect(
        (await auditRows(scopeA1, VIEWED)).filter((row) => row.actor_id === admin.userId),
      ).toEqual([]);
    }
  });

  it("a revoked session answers 401, and never a value", async () => {
    const admin = await newAdmin();
    await directSql`
      update identity.sessions set revoked_at = ${now.toISOString()}::timestamptz
      where user_id = ${admin.userId}
    `;
    const response = await viewPerson(admin.accessToken, family.childOneId, "name");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("pin 71: a community without households answers the entitlement refusal", async () => {
    // Community C holds a child and a Community Admin with a fresh check, but its organisation has
    // no people.households entitlement: the same empty 403 as every household route, and the check
    // stays unused.
    expect(await freshAt(adminC.userId)).not.toBeNull();
    const response = await viewPerson(adminC.accessToken, childInC, "name", slugC);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(await freshAt(adminC.userId)).not.toBeNull();
    expect(
      (await auditRows(scopeC, VIEWED)).filter((row) => row.actor_id === adminC.userId),
    ).toEqual([]);
  });

  it("answers 404, with an empty body, for an adult, another child's event and a missing event", async () => {
    const admin = await newAdmin();
    const attempts = [
      () => viewPerson(admin.accessToken, family.adultId, "name"),
      () => viewEvent(admin.accessToken, family.adultId, family.adultEventId, "place"),
      () => viewEvent(admin.accessToken, family.childOneId, family.eventTwoId, "place"),
      () => viewEvent(admin.accessToken, family.childOneId, newId(), "place"),
    ];
    for (const attempt of attempts) {
      const response = await attempt();
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
    // Four refusals, and the one check is still there.
    expect(await freshAt(admin.userId)).not.toBeNull();
  });

  it("logs no value, name or id for any View", async () => {
    const before = logged.length;
    const admin = await newAdmin();
    expect((await viewPerson(admin.accessToken, family.childOneId, "name")).status).toBe(200);
    expect((await viewPerson(admin.accessToken, family.childOneId, "name")).status).toBe(403);
    expect((await viewPerson(staff.accessToken, family.childOneId, "name")).status).toBe(403);
    await setFresh(admin.userId, now);
    expect((await viewPerson(admin.accessToken, newId(), "name")).status).toBe(404);
    expect(
      (await viewEvent(admin.accessToken, family.childOneId, family.eventOneId, "place")).status,
    ).toBe(200);

    expect(logged.length).toBeGreaterThan(before);
    const text = logged.join("\n");
    for (const value of [
      ...SEEDED_VALUES,
      family.childOneId,
      family.childTwoId,
      family.eventOneId,
      family.eventTwoId,
    ]) {
      expect(text).not.toContain(value);
    }
  });
});
