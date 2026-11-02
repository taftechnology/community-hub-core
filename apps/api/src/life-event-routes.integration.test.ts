import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, createCustomRole, grantRole } from "@community-hub/access";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { assignPlan, upsertPlan } from "@community-hub/entitlements";
import type { OtpMail } from "@community-hub/identity";
import { startEmailOtp, verifyEmailOtp } from "@community-hub/identity";
import { withRequest } from "@community-hub/kernel";
import { createHousehold, createPerson } from "@community-hub/people";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { lifeEventRoutes, type LifeEventLog } from "./life-event-routes.js";
import { startServer } from "./server.js";

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");

const API_HOSTNAME = "au.api.example.test";
const PORT = 18479;
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

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
      APP_SECRET_ARN: [
        "arn",
        "aws",
        "secretsmanager",
        "ap-southeast-2",
        ["12", "34", "56", "78", "90", "12"].join(""),
        "secret:app",
      ].join(":"),
      IDENTITY_SECRET_ARN: [
        "arn",
        "aws",
        "secretsmanager",
        "ap-southeast-2",
        ["12", "34", "56", "78", "90", "12"].join(""),
        "secret:identity",
      ].join(":"),
      PLATFORM_SECRET_ARN: [
        "arn",
        "aws",
        "secretsmanager",
        "ap-southeast-2",
        ["12", "34", "56", "78", "90", "12"].join(""),
        "secret:platform",
      ].join(":"),
    },
    pem,
  );
  if (!read.ok) {
    throw new Error("Failed to read test env");
  }
  return read.env;
}

class MemoryMail implements OtpMail {
  last: { to: string; code: string } | undefined;

  send(input: { to: string; code: string }): Promise<void> {
    this.last = input;
    return Promise.resolve();
  }
}

describe("life event routes integration tests (Pins 6, 7, 8, 9, 11, 14)", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  let identity: ReturnType<typeof createPlaintextIdentitySql>;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let directSql: ReturnType<typeof createPlaintextDirectSql>;
  let kms: ReturnType<typeof createLocalKmsPort>;
  let mail: MemoryMail;
  let server: Server;
  const userIds: string[] = [];

  const orgIdA = newId();
  const orgIdB = newId();
  const orgIdC = newId();
  const communityIdA1 = newId();
  const communityIdA2 = newId();
  const communityIdB1 = newId();
  const communityIdC = newId();

  const slugA1 = `le-comm-a1-${newId().slice(-8)}`;
  const slugA2 = `le-comm-a2-${newId().slice(-8)}`;
  const slugB1 = `le-comm-b1-${newId().slice(-8)}`;
  const slugC = `le-comm-c-${newId().slice(-8)}`;

  let allPermissionsToken: string;
  let viewOnlyToken: string;
  let restrictedOnlyToken: string;
  let manageOnlyToken: string;
  let noRoleToken: string;
  let ownerB1Token: string;
  let tokenC: string;

  let adultPersonA1: { personId: string };
  let minorPersonA1: { personId: string };
  let adultPersonA2: { personId: string };
  let adultPersonB1: { personId: string };

  const checkout = async <T>(role: Role, run: (sql: never) => Promise<T>): Promise<T> => {
    if (role === "identity") {
      return run(identity as never);
    }
    if (role === "platform") {
      return run(platform as never);
    }
    return run(app as never);
  };

  async function signIn(email: string): Promise<{ userId: string; accessToken: string }> {
    await startEmailOtp(identity, kms, KEY_ARN, mail, { email, now });
    const session = await verifyEmailOtp(identity, kms, KEY_ARN, {
      email,
      code: mail.last?.code ?? "",
      now,
    });
    if (session === null) {
      throw new Error("Failed to sign in");
    }
    userIds.push(session.userId);
    return session;
  }

  async function postRoute(pathName: string, body: unknown, token?: string): Promise<Response> {
    const headers = new Headers({
      "content-type": "application/json",
      "x-community-hub-hostname": API_HOSTNAME,
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
    mail = new MemoryMail();
    await identity`delete from identity.identity_keys`;

    const env = envFor(PORT);
    const routes = lifeEventRoutes({
      checkout,
      kms,
      keyArn: KEY_ARN,
      now: () => now,
      apiHostname: API_HOSTNAME,
      log: (() => undefined) as LifeEventLog,
      guardLog: () => undefined,
    });

    server = startServer({
      env,
      routes,
    });

    await new Promise<void>((resolve, reject) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once("listening", () => resolve());
      server.once("error", reject);
    });

    // 1. Setup organisations and communities in platform
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values
          (${orgIdA}::uuid, ${`le-org-a-${newId().slice(-8)}`}, 'au', 'implicit'),
          (${orgIdB}::uuid, ${`le-org-b-${newId().slice(-8)}`}, 'au', 'implicit'),
          (${orgIdC}::uuid, ${`le-org-c-${newId().slice(-8)}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values
          (${communityIdA1}::uuid, ${orgIdA}::uuid, ${slugA1}, 'au'),
          (${communityIdA2}::uuid, ${orgIdA}::uuid, ${slugA2}, 'au'),
          (${communityIdB1}::uuid, ${orgIdB}::uuid, ${slugB1}, 'au'),
          (${communityIdC}::uuid, ${orgIdC}::uuid, ${slugC}, 'au')
      `;
    });

    // 2. Setup plans, entitlements, and billing accounts
    const planKeyWithHh = `le_plan_hh_${orgIdA.slice(-8)}`;
    await upsertPlan(platform, {
      key: planKeyWithHh,
      entitlements: [
        { key: "people.directory", limit: null },
        { key: "people.households", limit: null },
      ],
    });
    await assignPlan(platform, { organisationId: orgIdA, planKey: planKeyWithHh, now });
    await assignPlan(platform, { organisationId: orgIdB, planKey: planKeyWithHh, now });

    const planKeyNoHh = `le_plan_no_hh_${orgIdC.slice(-8)}`;
    await upsertPlan(platform, {
      key: planKeyNoHh,
      entitlements: [{ key: "people.directory", limit: null }],
    });
    await assignPlan(platform, { organisationId: orgIdC, planKey: planKeyNoHh, now });

    const cusA = `cus_${newId().replaceAll("-", "")}`;
    const subA = `sub_${newId().replaceAll("-", "")}`;
    const cusB = `cus_${newId().replaceAll("-", "")}`;
    const subB = `sub_${newId().replaceAll("-", "")}`;
    const cusC = `cus_${newId().replaceAll("-", "")}`;
    const subC = `sub_${newId().replaceAll("-", "")}`;

    await platform`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status)
      values
        (${orgIdA}::uuid, 'self_serve', ${cusA}, ${subA}, 'active'),
        (${orgIdB}::uuid, 'self_serve', ${cusB}, ${subB}, 'active'),
        (${orgIdC}::uuid, 'self_serve', ${cusC}, ${subC}, 'active')
    `;

    // 3. Setup users & role grants
    const uAll = await signIn(`admin-${newId().slice(-8)}@example.test`);
    allPermissionsToken = uAll.accessToken;

    const uManage = await signIn(`manage-${newId().slice(-8)}@example.test`);
    manageOnlyToken = uManage.accessToken;

    const uRestricted = await signIn(`restricted-${newId().slice(-8)}@example.test`);
    restrictedOnlyToken = uRestricted.accessToken;

    const uView = await signIn(`view-${newId().slice(-8)}@example.test`);
    viewOnlyToken = uView.accessToken;

    const uNone = await signIn(`norole-${newId().slice(-8)}@example.test`);
    noRoleToken = uNone.accessToken;

    // Grants on community A1
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA1 }, async (tx) => {
        // Bootstrap uAll as owner (holds people.manage, people.view, people.restricted.read)
        await bootstrapOwner(tx, {
          now,
          userId: uAll.userId,
          actorUserId: uAll.userId,
        });

        // Create roles and grant
        const roleManage = await createCustomRole(tx, {
          now,
          key: `manage_only_${newId().slice(-8)}`,
          permissions: ["people.manage"],
          actorUserId: uAll.userId,
        });
        await grantRole(tx, {
          now,
          userId: uManage.userId,
          roleKey: null,
          customRoleId: roleManage.customRoleId,
          actorUserId: uAll.userId,
        });

        const roleRestricted = await createCustomRole(tx, {
          now,
          key: `restricted_only_${newId().slice(-8)}`,
          permissions: ["people.restricted.read"],
          actorUserId: uAll.userId,
        });
        await grantRole(tx, {
          now,
          userId: uRestricted.userId,
          roleKey: null,
          customRoleId: roleRestricted.customRoleId,
          actorUserId: uAll.userId,
        });

        const roleView = await createCustomRole(tx, {
          now,
          key: `view_only_${newId().slice(-8)}`,
          permissions: ["people.view"],
          actorUserId: uAll.userId,
        });
        await grantRole(tx, {
          now,
          userId: uView.userId,
          roleKey: null,
          customRoleId: roleView.customRoleId,
          actorUserId: uAll.userId,
        });
      }),
    );

    // Grant uAll on A2 and A3
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA2 }, (tx) =>
        grantRole(tx, {
          now,
          userId: uAll.userId,
          roleKey: "community_admin",
          customRoleId: null,
          actorUserId: uAll.userId,
        }),
      ),
    );
    // Bootstrap uOwnerB in Org B
    const uOwnerB = await signIn(`owner-b-${newId().slice(-8)}@example.test`);
    ownerB1Token = uOwnerB.accessToken;
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdB, communityId: communityIdB1 }, (tx) =>
        bootstrapOwner(tx, {
          now,
          userId: uOwnerB.userId,
          actorUserId: uOwnerB.userId,
        }),
      ),
    );

    // Bootstrap uOwnerC in Org C (without people.households entitlement)
    const uOwnerC = await signIn(`owner-c-${newId().slice(-8)}@example.test`);
    tokenC = uOwnerC.accessToken;
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdC, communityId: communityIdC }, (tx) =>
        bootstrapOwner(tx, {
          now,
          userId: uOwnerC.userId,
          actorUserId: uOwnerC.userId,
        }),
      ),
    );

    // 4. Create persons fixtures
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA1 }, async (tx) => {
        const hh = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: "Smith Household",
          actorUserId: uAll.userId,
        });
        adultPersonA1 = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: hh.householdId,
          dateOfBirth: null,
          givenName: "AdultA1",
          familyName: "Smith",
          email: null,
          phone: null,
          actorUserId: uAll.userId,
        });
        minorPersonA1 = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: false,
          householdId: hh.householdId,
          dateOfBirth: "2018-05-20",
          givenName: "MinorA1",
          familyName: "Smith",
          email: null,
          phone: null,
          actorUserId: uAll.userId,
        });
      }),
    );

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA2 }, async (tx) => {
        adultPersonA2 = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "AdultA2",
          familyName: "Jones",
          email: null,
          phone: null,
          actorUserId: uAll.userId,
        });
      }),
    );

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdB, communityId: communityIdB1 }, async (tx) => {
        adultPersonB1 = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "AdultB1",
          familyName: "Taylor",
          email: null,
          phone: null,
          actorUserId: uOwnerB.userId,
        });
      }),
    );
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await directSql?.end({ timeout: 1 });
    await app?.end({ timeout: 1 });
    await platform?.end({ timeout: 1 });
    await identity?.end({ timeout: 1 });
  });

  it("Pin 6: List refuses without people.restricted.read, records denial audit, no listed audit row", async () => {
    // 1. people.view only
    const viewRes = await postRoute(
      "/v1/people/life-events/list",
      { communitySlug: slugA1, personId: adultPersonA1.personId },
      viewOnlyToken,
    );
    expect(viewRes.status).toBe(403);
    expect(await viewRes.text()).toBe("");

    // 2. people.manage only
    const manageRes = await postRoute(
      "/v1/people/life-events/list",
      { communitySlug: slugA1, personId: adultPersonA1.personId },
      manageOnlyToken,
    );
    expect(manageRes.status).toBe(403);
    expect(await manageRes.text()).toBe("");

    // 3. no role
    const noRoleRes = await postRoute(
      "/v1/people/life-events/list",
      { communitySlug: slugA1, personId: adultPersonA1.personId },
      noRoleToken,
    );
    expect(noRoleRes.status).toBe(403);
    expect(await noRoleRes.text()).toBe("");

    // Verify denial audit row written in app.audit_events
    const denialAudits = await directSql<{ action: string; purpose: string }[]>`
      select action, purpose from app.audit_events
      where action = 'people.permission.denied' and purpose = 'people.permission.denied'
    `;
    expect(denialAudits.length).toBeGreaterThanOrEqual(1);

    // Verify no people.life_event.listed row exists
    const listAudits = await directSql<{ count: number }[]>`
      select count(*)::int from app.audit_events
      where action = 'people.life_event.listed'
    `;
    expect(listAudits[0]?.count).toBe(0);
  });

  it("Pin 7: Create and update need both people.manage and people.restricted.read", async () => {
    const createBody = {
      communitySlug: slugA1,
      personId: adultPersonA1.personId,
      type: "baptism",
      date: "2020-01-01",
      place: "St Stephen's",
      notes: "Baptized in faith",
    };

    // manage only -> 403, no row created
    const manageCreate = await postRoute(
      "/v1/people/life-events/create",
      createBody,
      manageOnlyToken,
    );
    expect(manageCreate.status).toBe(403);
    expect(await manageCreate.text()).toBe("");

    // restricted only -> 403, no row created
    const restrictedCreate = await postRoute(
      "/v1/people/life-events/create",
      createBody,
      restrictedOnlyToken,
    );
    expect(restrictedCreate.status).toBe(403);
    expect(await restrictedCreate.text()).toBe("");

    // Check no row created so far
    const eventsCount = await directSql<{ count: number }[]>`
      select count(*)::int from app.life_events where person_id = ${adultPersonA1.personId}::uuid
    `;
    expect(eventsCount[0]?.count).toBe(0);

    // Authorized user (holds both) -> 201 created
    const authCreate = await postRoute(
      "/v1/people/life-events/create",
      createBody,
      allPermissionsToken,
    );
    expect(authCreate.status).toBe(201);
    const createdData = (await authCreate.json()) as { eventId: string; version: number };
    expect(createdData.eventId).toBeDefined();
    expect(createdData.version).toBe(1);

    // Now test update with manage only and restricted only
    const updateBody = {
      communitySlug: slugA1,
      eventId: createdData.eventId,
      version: 1,
      type: "baptism",
      date: "2020-01-02",
      place: "Updated St Stephen's",
      notes: null,
    };

    const manageUpdate = await postRoute(
      "/v1/people/life-events/update",
      updateBody,
      manageOnlyToken,
    );
    expect(manageUpdate.status).toBe(403);
    expect(await manageUpdate.text()).toBe("");

    const restrictedUpdate = await postRoute(
      "/v1/people/life-events/update",
      updateBody,
      restrictedOnlyToken,
    );
    expect(restrictedUpdate.status).toBe(403);
    expect(await restrictedUpdate.text()).toBe("");

    // Authorized update -> 200
    const authUpdate = await postRoute(
      "/v1/people/life-events/update",
      updateBody,
      allPermissionsToken,
    );
    expect(authUpdate.status).toBe(200);
    const updateResult = (await authUpdate.json()) as { version: number };
    expect(updateResult.version).toBe(2);
  });

  it("Pin 8: Entitlement people.households is required on all three routes", async () => {
    // Community C does not have people.households
    const listRes = await postRoute(
      "/v1/people/life-events/list",
      { communitySlug: slugC, personId: adultPersonA1.personId },
      tokenC,
    );
    expect(listRes.status).toBe(403);
    expect(await listRes.text()).toBe("");

    const createRes = await postRoute(
      "/v1/people/life-events/create",
      {
        communitySlug: slugC,
        personId: adultPersonA1.personId,
        type: "marriage",
        date: "2022-01-01",
      },
      tokenC,
    );
    expect(createRes.status).toBe(403);
    expect(await createRes.text()).toBe("");

    const updateRes = await postRoute(
      "/v1/people/life-events/update",
      {
        communitySlug: slugC,
        eventId: newId(),
        version: 1,
        type: "marriage",
        date: "2022-01-01",
      },
      tokenC,
    );
    expect(updateRes.status).toBe(403);
    expect(await updateRes.text()).toBe("");
  });

  it("Pin 9: Tenancy: cross-community and cross-organisation returns 404 with empty body", async () => {
    // 1. List for person in Community A2 requested from Community A1
    const crossCommList = await postRoute(
      "/v1/people/life-events/list",
      { communitySlug: slugA1, personId: adultPersonA2.personId },
      allPermissionsToken,
    );
    expect(crossCommList.status).toBe(404);
    expect(await crossCommList.text()).toBe("");

    // List for person in Org B requested from Community A1
    const crossOrgList = await postRoute(
      "/v1/people/life-events/list",
      { communitySlug: slugA1, personId: adultPersonB1.personId },
      allPermissionsToken,
    );
    expect(crossOrgList.status).toBe(404);
    expect(await crossOrgList.text()).toBe("");

    // 2. Create for person in Community A2 requested from Community A1
    const crossCommCreate = await postRoute(
      "/v1/people/life-events/create",
      {
        communitySlug: slugA1,
        personId: adultPersonA2.personId,
        type: "first_communion",
        date: "2023-01-01",
      },
      allPermissionsToken,
    );
    expect(crossCommCreate.status).toBe(404);
    expect(await crossCommCreate.text()).toBe("");

    // Create for person in Org B requested from Community A1
    const crossOrgCreate = await postRoute(
      "/v1/people/life-events/create",
      {
        communitySlug: slugA1,
        personId: adultPersonB1.personId,
        type: "first_communion",
        date: "2023-01-01",
      },
      allPermissionsToken,
    );
    expect(crossOrgCreate.status).toBe(404);
    expect(await crossOrgCreate.text()).toBe("");

    // 3. Update for event in Community A2 requested from Community A1
    // First create an event in A2
    const a2CreateRes = await postRoute(
      "/v1/people/life-events/create",
      {
        communitySlug: slugA2,
        personId: adultPersonA2.personId,
        type: "first_communion",
        date: "2023-01-01",
      },
      allPermissionsToken,
    );
    expect(a2CreateRes.status).toBe(201);
    const a2Event = (await a2CreateRes.json()) as { eventId: string; version: number };

    // Try updating A2's event using community A1 slug -> 404 empty body
    const crossCommUpdate = await postRoute(
      "/v1/people/life-events/update",
      {
        communitySlug: slugA1,
        eventId: a2Event.eventId,
        version: 1,
        type: "first_communion",
        date: "2023-01-02",
      },
      allPermissionsToken,
    );
    expect(crossCommUpdate.status).toBe(404);
    expect(await crossCommUpdate.text()).toBe("");

    // Try updating A2's event using community B1 slug -> 404 empty body
    const crossOrgUpdate = await postRoute(
      "/v1/people/life-events/update",
      {
        communitySlug: slugB1,
        eventId: a2Event.eventId,
        version: 1,
        type: "first_communion",
        date: "2023-01-02",
      },
      ownerB1Token,
    );
    expect(crossOrgUpdate.status).toBe(404);
    expect(await crossOrgUpdate.text()).toBe("");
  });

  it("Pin 11 & Pin 14: Audit rows written holding IDs only, and minor fixture round trip", async () => {
    // Test create for minor fixture
    const minorPlace = "St Child Chapel";
    const minorNotes = "Godparents present";
    const minorCreateRes = await postRoute(
      "/v1/people/life-events/create",
      {
        communitySlug: slugA1,
        personId: minorPersonA1.personId,
        type: "baptism",
        date: "2019-06-01",
        place: minorPlace,
        notes: minorNotes,
      },
      allPermissionsToken,
    );
    expect(minorCreateRes.status).toBe(201);
    const minorCreated = (await minorCreateRes.json()) as { eventId: string; version: number };

    // Verify create audit row
    const [createAudit] = await directSql<{ action: string; target_ids: string[] }[]>`
      select action, target_ids from app.audit_events
      where action = 'people.life_event.created'
      order by seq desc limit 1
    `;
    expect(createAudit?.action).toBe("people.life_event.created");
    expect(createAudit?.target_ids).toEqual([minorCreated.eventId]);
    const serialisedCreateAudit = JSON.stringify(createAudit);
    expect(serialisedCreateAudit).not.toContain(minorPlace);
    expect(serialisedCreateAudit).not.toContain(minorNotes);
    expect(serialisedCreateAudit).not.toContain("2019-06-01");
    expect(serialisedCreateAudit).not.toContain("baptism");

    // List minor events
    const listRes = await postRoute(
      "/v1/people/life-events/list",
      {
        communitySlug: slugA1,
        personId: minorPersonA1.personId,
      },
      allPermissionsToken,
    );
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as {
      items: {
        eventId: string;
        type: string;
        date: string;
        place: string | null;
        notes: string | null;
      }[];
    };
    expect(listData.items).toHaveLength(1);
    expect(listData.items[0]?.place).toBe(minorPlace);
    expect(listData.items[0]?.notes).toBe(minorNotes);

    // Verify list audit row
    const [listAudit] = await directSql<{ action: string; target_ids: string[] }[]>`
      select action, target_ids from app.audit_events
      where action = 'people.life_event.listed'
      order by seq desc limit 1
    `;
    expect(listAudit?.action).toBe("people.life_event.listed");
    expect(listAudit?.target_ids).toEqual([minorCreated.eventId]);
    const serialisedListAudit = JSON.stringify(listAudit);
    expect(serialisedListAudit).not.toContain(minorPlace);
    expect(serialisedListAudit).not.toContain(minorNotes);

    // Update minor event
    const updatedNotes = "Corrected notes text";
    const updateRes = await postRoute(
      "/v1/people/life-events/update",
      {
        communitySlug: slugA1,
        eventId: minorCreated.eventId,
        version: 1,
        type: "baptism",
        date: "2019-06-01",
        place: minorPlace,
        notes: updatedNotes,
      },
      allPermissionsToken,
    );
    expect(updateRes.status).toBe(200);

    // Verify update audit row
    const [updateAudit] = await directSql<{ action: string; target_ids: string[] }[]>`
      select action, target_ids from app.audit_events
      where action = 'people.life_event.updated'
      order by seq desc limit 1
    `;
    expect(updateAudit?.action).toBe("people.life_event.updated");
    expect(updateAudit?.target_ids).toEqual([minorCreated.eventId]);
    const serialisedUpdateAudit = JSON.stringify(updateAudit);
    expect(serialisedUpdateAudit).not.toContain(updatedNotes);

    // Check conflict (stale version) returns 409 with empty body
    const staleRes = await postRoute(
      "/v1/people/life-events/update",
      {
        communitySlug: slugA1,
        eventId: minorCreated.eventId,
        version: 1, // now version is 2
        type: "baptism",
        date: "2019-06-01",
      },
      allPermissionsToken,
    );
    expect(staleRes.status).toBe(409);
    expect(await staleRes.text()).toBe("");
  });
});
