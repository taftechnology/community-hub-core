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
import {
  addMinor,
  createHousehold,
  createPerson,
  linkGuardian,
  moveAdult,
} from "@community-hub/people";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { householdRoutes, type HouseholdLog } from "./household-routes.js";
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
const PORT = 18476;
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
    throw new Error("synthetic env");
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

function post(pathName: string, body: unknown, token?: string): Promise<Response> {
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

describe("household routes real-database integration (finding 4)", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  let identity: ReturnType<typeof createPlaintextIdentitySql>;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let secondApp: ReturnType<typeof createPlaintextAppSql>;
  let kms: ReturnType<typeof createLocalKmsPort>;
  let mail: MemoryMail;
  let server: Server;
  const userIds: string[] = [];

  const orgIdA = newId();
  const orgIdB = newId();
  const communityIdA1 = newId();
  const communityIdA2 = newId();
  const communityIdB1 = newId();

  const slugA1 = `comm-a1-${newId().slice(0, 8)}`;
  const slugA2 = `comm-a2-${newId().slice(0, 8)}`;
  const slugB1 = `comm-b1-${newId().slice(0, 8)}`;

  let ownerA1Token: string;
  let ownerA2Token: string;
  let ownerB1Token: string;
  let viewOnlyToken: string;
  let restrictedOnlyToken: string;
  let manageOnlyToken: string;

  let householdA1Id: string;
  let minorCharlieId: string;
  let minorDaisyId: string;
  let adultAliceId: string;
  let adultBobId: string;
  let guardianLinkId: string;

  let householdA1SecondId: string;
  let adultEvanId: string;
  let adultFionaId: string;
  let minorGeorgeId: string;
  let guardianLinkGeorgeId: string;

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

  beforeAll(async () => {
    const runtime = loadRuntime();
    identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    app = createPlaintextAppSql(roleUrl(runtime, "app"));
    secondApp = createPlaintextAppSql(roleUrl(runtime, "app"));
    kms = createLocalKmsPort();
    mail = new MemoryMail();
    await identity`delete from identity.identity_keys`;

    const env = envFor(PORT);
    const routes = householdRoutes({
      checkout,
      kms,
      keyArn: KEY_ARN,
      now: () => now,
      apiHostname: API_HOSTNAME,
      log: (() => undefined) as HouseholdLog,
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
          (${orgIdA}::uuid, ${`org-a-${newId().slice(0, 8)}`}, 'au', 'implicit'),
          (${orgIdB}::uuid, ${`org-b-${newId().slice(0, 8)}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values
          (${communityIdA1}::uuid, ${orgIdA}::uuid, ${slugA1}, 'au'),
          (${communityIdA2}::uuid, ${orgIdA}::uuid, ${slugA2}, 'au'),
          (${communityIdB1}::uuid, ${orgIdB}::uuid, ${slugB1}, 'au')
      `;
    });

    // 2. Setup plans and entitlements for both organisations
    const planKey = `synth_plan_${orgIdA.slice(0, 8)}`;
    await upsertPlan(platform, {
      key: planKey,
      entitlements: [
        { key: "people.directory", limit: null },
        { key: "people.households", limit: null },
      ],
    });
    await assignPlan(platform, { organisationId: orgIdA, planKey, now });
    await assignPlan(platform, { organisationId: orgIdB, planKey, now });

    const cusA = `cus_${newId().replaceAll("-", "")}`;
    const subA = `sub_${newId().replaceAll("-", "")}`;
    const cusB = `cus_${newId().replaceAll("-", "")}`;
    const subB = `sub_${newId().replaceAll("-", "")}`;

    await platform`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status)
      values
        (${orgIdA}::uuid, 'self_serve', ${cusA}, ${subA}, 'active'),
        (${orgIdB}::uuid, 'self_serve', ${cusB}, ${subB}, 'active')
    `;

    // 3. Setup Users and Grants
    // Owner A1
    const ownerA1Session = await signIn(`owner-a1-${orgIdA.slice(0, 8)}@example.test`);
    ownerA1Token = ownerA1Session.accessToken;
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA1 }, (tx) =>
        bootstrapOwner(tx, {
          now,
          userId: ownerA1Session.userId,
          actorUserId: ownerA1Session.userId,
        }),
      ),
    );

    // View-only user in Community A1
    const viewOnlySession = await signIn(`view-only-${orgIdA.slice(0, 8)}@example.test`);
    viewOnlyToken = viewOnlySession.accessToken;
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA1 }, async (tx) => {
        const role = await createCustomRole(tx, {
          now,
          key: "people_viewer",
          permissions: ["people.view"],
          actorUserId: ownerA1Session.userId,
        });
        await grantRole(tx, {
          now,
          userId: viewOnlySession.userId,
          roleKey: null,
          customRoleId: role.customRoleId,
          actorUserId: ownerA1Session.userId,
        });
      }),
    );

    // Restricted-only user in Community A1
    const restrictedOnlySession = await signIn(
      `restricted-only-${orgIdA.slice(0, 8)}@example.test`,
    );
    restrictedOnlyToken = restrictedOnlySession.accessToken;
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA1 }, async (tx) => {
        const role = await createCustomRole(tx, {
          now,
          key: "people_safeguarder",
          permissions: ["people.restricted.read"],
          actorUserId: ownerA1Session.userId,
        });
        await grantRole(tx, {
          now,
          userId: restrictedOnlySession.userId,
          roleKey: null,
          customRoleId: role.customRoleId,
          actorUserId: ownerA1Session.userId,
        });
      }),
    );

    // Manage-only user in Community A1 (lacks people.restricted.read)
    const manageOnlySession = await signIn(`manage-only-${orgIdA.slice(0, 8)}@example.test`);
    manageOnlyToken = manageOnlySession.accessToken;
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA1 }, async (tx) => {
        const role = await createCustomRole(tx, {
          now,
          key: "people_manager",
          permissions: ["people.view", "people.manage"],
          actorUserId: ownerA1Session.userId,
        });
        await grantRole(tx, {
          now,
          userId: manageOnlySession.userId,
          roleKey: null,
          customRoleId: role.customRoleId,
          actorUserId: ownerA1Session.userId,
        });
      }),
    );

    // Owner A2 (admin in Community A2)
    const ownerA2Session = await signIn(`owner-a2-${orgIdA.slice(0, 8)}@example.test`);
    ownerA2Token = ownerA2Session.accessToken;
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA2 }, (tx) =>
        grantRole(tx, {
          now,
          userId: ownerA2Session.userId,
          roleKey: "community_admin",
          customRoleId: null,
          actorUserId: ownerA1Session.userId,
        }),
      ),
    );

    // Owner B1
    const ownerB1Session = await signIn(`owner-b1-${orgIdB.slice(0, 8)}@example.test`);
    ownerB1Token = ownerB1Session.accessToken;
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdB, communityId: communityIdB1 }, (tx) =>
        bootstrapOwner(tx, {
          now,
          userId: ownerB1Session.userId,
          actorUserId: ownerB1Session.userId,
        }),
      ),
    );

    // 4. Populate household with 2 adults and 2 minors in Community A1
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA1 }, async (tx) => {
        const adult1 = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: "1990-01-01",
          givenName: "Alice",
          familyName: "Smith",
          email: "alice.smith@example.test",
          phone: "+61400000001",
          actorUserId: ownerA1Session.userId,
        });
        adultAliceId = adult1.personId;

        const adult2 = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: "1988-03-03",
          givenName: "Bob",
          familyName: "Smith",
          email: "bob.smith@example.test",
          phone: "+61400000002",
          actorUserId: ownerA1Session.userId,
        });
        adultBobId = adult2.personId;

        const hh = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: "The Smiths",
          actorUserId: ownerA1Session.userId,
        });
        householdA1Id = hh.householdId;

        await moveAdult(tx, {
          personId: adultAliceId,
          householdId: householdA1Id,
          version: 1,
          actorUserId: ownerA1Session.userId,
        });

        await moveAdult(tx, {
          personId: adultBobId,
          householdId: householdA1Id,
          version: 1,
          actorUserId: ownerA1Session.userId,
        });

        const minor1 = await addMinor(tx, kms, KEY_ARN, {
          now,
          householdId: householdA1Id,
          givenName: "Charlie",
          familyName: "Smith",
          dateOfBirth: "2015-03-12",
          guardianId: adultAliceId,
          actorUserId: ownerA1Session.userId,
        });
        minorCharlieId = minor1.personId;

        const minor2 = await addMinor(tx, kms, KEY_ARN, {
          now,
          householdId: householdA1Id,
          givenName: "Daisy",
          familyName: "Smith",
          dateOfBirth: "2017-08-25",
          guardianId: adultBobId,
          actorUserId: ownerA1Session.userId,
        });
        minorDaisyId = minor2.personId;

        const link = await linkGuardian(tx, {
          now,
          householdId: householdA1Id,
          guardianPersonId: adultBobId,
          childPersonId: minorCharlieId,
          consent: true,
          pickup: true,
          view: true,
          manage: false,
          actorUserId: ownerA1Session.userId,
        });
        guardianLinkId = link.linkId;

        // Second household in Community A1: The Johnsons
        const adult3 = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: "1992-05-15",
          givenName: "Evan",
          familyName: "Johnson",
          email: "evan.johnson@example.test",
          phone: "+61400000003",
          actorUserId: ownerA1Session.userId,
        });
        adultEvanId = adult3.personId;

        const adult4 = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: "1994-07-20",
          givenName: "Fiona",
          familyName: "Johnson",
          email: "fiona.johnson@example.test",
          phone: "+61400000004",
          actorUserId: ownerA1Session.userId,
        });
        adultFionaId = adult4.personId;

        const hh2 = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: "The Johnsons",
          actorUserId: ownerA1Session.userId,
        });
        householdA1SecondId = hh2.householdId;

        await moveAdult(tx, {
          personId: adultEvanId,
          householdId: householdA1SecondId,
          version: 1,
          actorUserId: ownerA1Session.userId,
        });

        await moveAdult(tx, {
          personId: adultFionaId,
          householdId: householdA1SecondId,
          version: 1,
          actorUserId: ownerA1Session.userId,
        });

        const minor3 = await addMinor(tx, kms, KEY_ARN, {
          now,
          householdId: householdA1SecondId,
          givenName: "George",
          familyName: "Johnson",
          dateOfBirth: "2018-11-30",
          guardianId: adultEvanId,
          actorUserId: ownerA1Session.userId,
        });
        minorGeorgeId = minor3.personId;

        const linkGeorge = await linkGuardian(tx, {
          now,
          householdId: householdA1SecondId,
          guardianPersonId: adultFionaId,
          childPersonId: minorGeorgeId,
          consent: true,
          pickup: false,
          view: true,
          manage: false,
          actorUserId: ownerA1Session.userId,
        });
        guardianLinkGeorgeId = linkGeorge.linkId;
      }),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    if (userIds.length > 0) {
      await identity`delete from identity.sessions where user_id in ${identity(userIds)}`;
      await identity`delete from identity.users where id in ${identity(userIds)}`;
    }
    await identity`delete from identity.identity_keys`;
    await identity.end({ timeout: 1 });
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
    await secondApp.end({ timeout: 1 });
  });

  it("redacts all minor identity data in raw response bytes for people.view-only caller (pin 9)", async () => {
    // 1. Read route: caller holding only people.view
    const resRead = await post(
      "/v1/households/read",
      { communitySlug: slugA1, householdId: householdA1Id },
      viewOnlyToken,
    );
    expect(resRead.status).toBe(200);

    const rawReadBytes = await resRead.text();
    // Prove NO minor name, date of birth, person ID, guardian link ID, or minor-derived household label exists
    expect(rawReadBytes).not.toContain("Charlie");
    expect(rawReadBytes).not.toContain("Daisy");
    expect(rawReadBytes).not.toContain("2015-03-12");
    expect(rawReadBytes).not.toContain("2017-08-25");
    expect(rawReadBytes).not.toContain(minorCharlieId);
    expect(rawReadBytes).not.toContain(minorDaisyId);
    expect(rawReadBytes).not.toContain(guardianLinkId);

    const parsedRead = JSON.parse(rawReadBytes) as {
      householdId: string;
      label: string | null;
      adults: Array<{ personId: string; givenName: string; familyName: string }>;
      guardians?: unknown[];
      minors?: unknown[];
    };
    expect(parsedRead.householdId).toBe(householdA1Id);
    expect(parsedRead.label).toBeNull();
    expect(parsedRead.adults).toHaveLength(2);
    expect(parsedRead.guardians).toEqual([]);
    expect(parsedRead.minors).toBeUndefined();

    // 2. List route: caller holding only people.view
    const resList = await post("/v1/households/list", { communitySlug: slugA1 }, viewOnlyToken);
    expect(resList.status).toBe(200);

    const rawListBytes = await resList.text();
    expect(rawListBytes).not.toContain("Charlie");
    expect(rawListBytes).not.toContain("Daisy");
    expect(rawListBytes).not.toContain(minorCharlieId);
    expect(rawListBytes).not.toContain(minorDaisyId);

    const parsedList = JSON.parse(rawListBytes) as {
      items: Array<{ householdId: string; label: string | null; adultCount: number }>;
    };
    const foundItem = parsedList.items.find((item) => item.householdId === householdA1Id);
    expect(foundItem).toBeDefined();
    expect(foundItem?.label).toBeNull();
    expect(foundItem?.adultCount).toBe(2);
  });

  it("exposes minor details to callers holding people.restricted.read (pin 9, 11)", async () => {
    // Read route: caller holding people.restricted.read
    const resRestricted = await post(
      "/v1/households/read",
      { communitySlug: slugA1, householdId: householdA1Id },
      restrictedOnlyToken,
    );
    expect(resRestricted.status).toBe(200);

    const rawRestrictedBytes = await resRestricted.text();
    expect(rawRestrictedBytes).toContain("Charlie");
    expect(rawRestrictedBytes).toContain("Daisy");
    expect(rawRestrictedBytes).toContain("2015-03-12");
    expect(rawRestrictedBytes).toContain("2017-08-25");
    expect(rawRestrictedBytes).toContain(minorCharlieId);
    expect(rawRestrictedBytes).toContain(minorDaisyId);
    expect(rawRestrictedBytes).toContain("The Smiths");

    // Also owner holding all permissions
    const resOwner = await post(
      "/v1/households/read",
      { communitySlug: slugA1, householdId: householdA1Id },
      ownerA1Token,
    );
    expect(resOwner.status).toBe(200);
    const rawOwnerBytes = await resOwner.text();
    expect(rawOwnerBytes).toContain("Charlie");
    expect(rawOwnerBytes).toContain("Daisy");
  });

  it("enforces tenant and community isolation: cross-org and cross-community ids give identical empty 404 to absent ids (pin 12)", async () => {
    const absentId = newId();

    // 1. Read route (/v1/households/read)
    // Same community, absent id -> 404 empty body
    const resAbsentRead = await post(
      "/v1/households/read",
      { communitySlug: slugA1, householdId: absentId },
      ownerA1Token,
    );
    expect(resAbsentRead.status).toBe(404);
    expect(await resAbsentRead.text()).toBe("");

    // Same org, different community (Community A2 caller reading Community A1 household) -> identical empty 404
    const resCrossCommRead = await post(
      "/v1/households/read",
      { communitySlug: slugA2, householdId: householdA1Id },
      ownerA2Token,
    );
    expect(resCrossCommRead.status).toBe(404);
    expect(await resCrossCommRead.text()).toBe("");

    // Different org (Org B caller reading Org A household) -> identical empty 404
    const resCrossOrgRead = await post(
      "/v1/households/read",
      { communitySlug: slugB1, householdId: householdA1Id },
      ownerB1Token,
    );
    expect(resCrossOrgRead.status).toBe(404);
    expect(await resCrossOrgRead.text()).toBe("");

    // 2. Rename route (/v1/households/rename)
    const resAbsentRename = await post(
      "/v1/households/rename",
      { communitySlug: slugA1, householdId: absentId, version: 1, label: "New" },
      ownerA1Token,
    );
    expect(resAbsentRename.status).toBe(404);
    expect(await resAbsentRename.text()).toBe("");

    const resCrossCommRename = await post(
      "/v1/households/rename",
      { communitySlug: slugA2, householdId: householdA1Id, version: 1, label: "New" },
      ownerA2Token,
    );
    expect(resCrossCommRename.status).toBe(404);
    expect(await resCrossCommRename.text()).toBe("");

    const resCrossOrgRename = await post(
      "/v1/households/rename",
      { communitySlug: slugB1, householdId: householdA1Id, version: 1, label: "New" },
      ownerB1Token,
    );
    expect(resCrossOrgRename.status).toBe(404);
    expect(await resCrossOrgRename.text()).toBe("");

    // 3. Move adult route (/v1/households/members/move-adult)
    const resAbsentMove = await post(
      "/v1/households/members/move-adult",
      { communitySlug: slugA1, householdId: absentId, personId: adultAliceId, version: 1 },
      ownerA1Token,
    );
    expect(resAbsentMove.status).toBe(404);
    expect(await resAbsentMove.text()).toBe("");

    const resCrossCommMove = await post(
      "/v1/households/members/move-adult",
      { communitySlug: slugA2, householdId: householdA1Id, personId: adultAliceId, version: 1 },
      ownerA2Token,
    );
    expect(resCrossCommMove.status).toBe(404);
    expect(await resCrossCommMove.text()).toBe("");

    const resCrossOrgMove = await post(
      "/v1/households/members/move-adult",
      { communitySlug: slugB1, householdId: householdA1Id, personId: adultAliceId, version: 1 },
      ownerB1Token,
    );
    expect(resCrossOrgMove.status).toBe(404);
    expect(await resCrossOrgMove.text()).toBe("");

    // 4. Add minor route (/v1/households/members/add-minor)
    const resAbsentAddMinor = await post(
      "/v1/households/members/add-minor",
      {
        communitySlug: slugA1,
        householdId: absentId,
        givenName: "Eva",
        familyName: "Smith",
        dateOfBirth: "2019-01-01",
        guardianId: adultAliceId,
      },
      ownerA1Token,
    );
    expect(resAbsentAddMinor.status).toBe(404);
    expect(await resAbsentAddMinor.text()).toBe("");

    const resCrossCommAddMinor = await post(
      "/v1/households/members/add-minor",
      {
        communitySlug: slugA2,
        householdId: householdA1Id,
        givenName: "Eva",
        familyName: "Smith",
        dateOfBirth: "2019-01-01",
        guardianId: adultAliceId,
      },
      ownerA2Token,
    );
    expect(resCrossCommAddMinor.status).toBe(404);
    expect(await resCrossCommAddMinor.text()).toBe("");

    const resCrossOrgAddMinor = await post(
      "/v1/households/members/add-minor",
      {
        communitySlug: slugB1,
        householdId: householdA1Id,
        givenName: "Eva",
        familyName: "Smith",
        dateOfBirth: "2019-01-01",
        guardianId: adultAliceId,
      },
      ownerB1Token,
    );
    expect(resCrossOrgAddMinor.status).toBe(404);
    expect(await resCrossOrgAddMinor.text()).toBe("");

    // 5. Link guardian route (/v1/households/guardians/link)
    const resAbsentLink = await post(
      "/v1/households/guardians/link",
      {
        communitySlug: slugA1,
        householdId: absentId,
        guardianId: adultAliceId,
        childId: minorCharlieId,
      },
      ownerA1Token,
    );
    expect(resAbsentLink.status).toBe(404);
    expect(await resAbsentLink.text()).toBe("");

    const resCrossCommLink = await post(
      "/v1/households/guardians/link",
      {
        communitySlug: slugA2,
        householdId: householdA1Id,
        guardianId: adultAliceId,
        childId: minorCharlieId,
      },
      ownerA2Token,
    );
    expect(resCrossCommLink.status).toBe(404);
    expect(await resCrossCommLink.text()).toBe("");

    const resCrossOrgLink = await post(
      "/v1/households/guardians/link",
      {
        communitySlug: slugB1,
        householdId: householdA1Id,
        guardianId: adultAliceId,
        childId: minorCharlieId,
      },
      ownerB1Token,
    );
    expect(resCrossOrgLink.status).toBe(404);
    expect(await resCrossOrgLink.text()).toBe("");

    // 6. Unlink guardian route (/v1/households/guardians/unlink)
    const resAbsentUnlink = await post(
      "/v1/households/guardians/unlink",
      { communitySlug: slugA1, householdId: absentId, linkId: guardianLinkId },
      ownerA1Token,
    );
    expect(resAbsentUnlink.status).toBe(404);
    expect(await resAbsentUnlink.text()).toBe("");

    const resCrossCommUnlink = await post(
      "/v1/households/guardians/unlink",
      { communitySlug: slugA2, householdId: householdA1Id, linkId: guardianLinkId },
      ownerA2Token,
    );
    expect(resCrossCommUnlink.status).toBe(404);
    expect(await resCrossCommUnlink.text()).toBe("");

    const resCrossOrgUnlink = await post(
      "/v1/households/guardians/unlink",
      { communitySlug: slugB1, householdId: householdA1Id, linkId: guardianLinkId },
      ownerB1Token,
    );
    expect(resCrossOrgUnlink.status).toBe(404);
    expect(await resCrossOrgUnlink.text()).toBe("");
  });

  it("rolls back atomic writes on error and commits permission denial audits (finding H1)", async () => {
    // Second connection counts before test
    const scopeA1 = { orgId: orgIdA, communityId: communityIdA1 };
    const getCounts = async () => {
      return withAppTransaction(secondApp, scopeA1, async (tx) => {
        const [persons] = await tx<
          { count: number }[]
        >`select count(*)::int as count from app.persons`;
        const [links] = await tx<
          { count: number }[]
        >`select count(*)::int as count from app.guardian_links`;
        const [activity] = await tx<
          { count: number }[]
        >`select count(*)::int as count from app.person_activity`;
        const [audit] = await tx<
          { count: number }[]
        >`select count(*)::int as count from app.audit_events`;
        const [hh] = await tx<
          { version: number }[]
        >`select version from app.households where id = ${householdA1Id}::uuid`;
        return {
          persons: persons!.count,
          links: links!.count,
          activity: activity!.count,
          audit: audit!.count,
          hhVersion: hh!.version,
        };
      });
    };

    const initial = await getCounts();
    expect(initial.persons).toBe(7);
    expect(initial.links).toBe(5);
    expect(initial.hhVersion).toBe(1);

    // 1. add-minor: guardian is a minor -> 400, no orphan minor row or link or audit
    const resMinorAsGuardian = await post(
      "/v1/households/members/add-minor",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        givenName: "OrphanMinor",
        familyName: "Smith",
        dateOfBirth: "2020-01-01",
        guardianId: minorCharlieId,
      },
      ownerA1Token,
    );
    expect(resMinorAsGuardian.status).toBe(400);
    expect(await resMinorAsGuardian.text()).toBe("");

    const afterMinorAsGuardian = await getCounts();
    expect(afterMinorAsGuardian.persons).toBe(initial.persons);
    expect(afterMinorAsGuardian.links).toBe(initial.links);
    expect(afterMinorAsGuardian.activity).toBe(initial.activity);
    expect(afterMinorAsGuardian.audit).toBe(initial.audit);

    // 2. add-minor: guardian not in household -> 404, no rows written
    const resGuardianNotFound = await post(
      "/v1/households/members/add-minor",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        givenName: "GhostMinor",
        familyName: "Smith",
        dateOfBirth: "2020-01-01",
        guardianId: newId(),
      },
      ownerA1Token,
    );
    expect(resGuardianNotFound.status).toBe(404);
    expect(await resGuardianNotFound.text()).toBe("");

    const afterGuardianNotFound = await getCounts();
    expect(afterGuardianNotFound.persons).toBe(initial.persons);
    expect(afterGuardianNotFound.links).toBe(initial.links);
    expect(afterGuardianNotFound.audit).toBe(initial.audit);

    // 3. add-minor: rights all false -> 400, no rows written
    const resNoRights = await post(
      "/v1/households/members/add-minor",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        givenName: "NoRightMinor",
        familyName: "Smith",
        dateOfBirth: "2020-01-01",
        guardianId: adultAliceId,
        rights: { consent: false, pickup: false, view: false, manage: false },
      },
      ownerA1Token,
    );
    expect(resNoRights.status).toBe(400);
    expect(await resNoRights.text()).toBe("");

    const afterNoRights = await getCounts();
    expect(afterNoRights.persons).toBe(initial.persons);
    expect(afterNoRights.links).toBe(initial.links);
    expect(afterNoRights.audit).toBe(initial.audit);

    // 4. link-guardian: duplicate link -> 409, no second link or extra audit
    const resDupLink = await post(
      "/v1/households/guardians/link",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        guardianId: adultBobId,
        childId: minorCharlieId,
      },
      ownerA1Token,
    );
    expect(resDupLink.status).toBe(409);
    expect(await resDupLink.text()).toBe("");

    const afterDupLink = await getCounts();
    expect(afterDupLink.links).toBe(initial.links);
    expect(afterDupLink.activity).toBe(initial.activity);
    expect(afterDupLink.audit).toBe(initial.audit);

    // 5. unlink-guardian: last guardian -> 409, no delete or audit
    // Find Daisy's only guardian link
    const daisyLink = await withAppTransaction(secondApp, scopeA1, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        select id::text as id from app.guardian_links where child_person_id = ${minorDaisyId}::uuid
      `;
      return rows[0]!.id;
    });

    const resLastGuardian = await post(
      "/v1/households/guardians/unlink",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        linkId: daisyLink,
      },
      ownerA1Token,
    );
    expect(resLastGuardian.status).toBe(409);
    expect(await resLastGuardian.text()).toBe("");

    const afterLastGuardian = await getCounts();
    expect(afterLastGuardian.links).toBe(initial.links);
    expect(afterLastGuardian.activity).toBe(initial.activity);
    expect(afterLastGuardian.audit).toBe(initial.audit);

    // 6. rename: stale version -> 409, version unchanged, no audit
    const resStaleRename = await post(
      "/v1/households/rename",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        version: 999,
        label: "Should Not Apply",
      },
      ownerA1Token,
    );
    expect(resStaleRename.status).toBe(409);
    expect(await resStaleRename.text()).toBe("");

    const afterStaleRename = await getCounts();
    expect(afterStaleRename.hhVersion).toBe(initial.hhVersion);
    expect(afterStaleRename.audit).toBe(initial.audit);

    // 7. move-adult: adult holding guardian links -> 409, version unchanged, no audit
    const resMoveWithLinks = await post(
      "/v1/households/members/move-adult",
      {
        communitySlug: slugA1,
        householdId: null,
        personId: adultAliceId,
        version: 2,
      },
      ownerA1Token,
    );
    expect(resMoveWithLinks.status).toBe(409);
    expect(await resMoveWithLinks.text()).toBe("");

    const afterMoveWithLinks = await getCounts();
    expect(afterMoveWithLinks.audit).toBe(initial.audit);

    // 8. permission denial: denied caller writes and commits the denial audit row
    const resDenied = await post(
      "/v1/households/members/add-minor",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        givenName: "DeniedMinor",
        familyName: "Smith",
        dateOfBirth: "2020-01-01",
        guardianId: adultAliceId,
      },
      manageOnlyToken,
    );
    expect(resDenied.status).toBe(403);
    expect(await resDenied.text()).toBe("");

    const afterDenied = await getCounts();
    expect(afterDenied.persons).toBe(initial.persons);
    // Audit row count increased by 1 for the denial audit event
    expect(afterDenied.audit).toBe(initial.audit + 1);

    const denialEvent = await withAppTransaction(secondApp, scopeA1, async (tx) => {
      const rows = await tx<{ action: string; purpose: string }[]>`
        select action, purpose from app.audit_events
        order by occurred_at desc limit 1
      `;
      return rows[0]!;
    });
    expect(denialEvent.action).toBe("people.permission.denied");
    expect(denialEvent.purpose).toBe("people.restricted.read");

    // 9. rename also needs people.restricted.read: manage-only is 403
    const beforeRenameDenied = await getCounts();
    const resRenameDenied = await post(
      "/v1/households/rename",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        version: 1,
        label: "Denied Rename",
      },
      manageOnlyToken,
    );
    expect(resRenameDenied.status).toBe(403);
    expect(await resRenameDenied.text()).toBe("");
    const afterRenameDenied = await getCounts();
    expect(afterRenameDenied.audit).toBe(beforeRenameDenied.audit + 1);
    const renameDenial = await withAppTransaction(secondApp, scopeA1, async (tx) => {
      const rows = await tx<{ action: string; purpose: string }[]>`
        select action, purpose from app.audit_events
        order by occurred_at desc limit 1
      `;
      return rows[0]!;
    });
    expect(renameDenial.action).toBe("people.permission.denied");
    expect(renameDenial.purpose).toBe("people.restricted.read");
  });

  it("pins the household predicate in readHouseholdDetail across co-located households (finding H2)", async () => {
    // 1. Restricted caller reads Household A1 ("The Smiths")
    const resA1Restricted = await post(
      "/v1/households/read",
      { communitySlug: slugA1, householdId: householdA1Id },
      restrictedOnlyToken,
    );
    expect(resA1Restricted.status).toBe(200);
    const bodyA1Restricted = (await resA1Restricted.json()) as {
      householdId: string;
      label: string | null;
      adults: Array<{ personId: string; givenName: string; familyName: string }>;
      minors?: Array<{ personId: string; givenName: string; familyName: string }>;
      guardians?: Array<{ linkId: string; guardianId: string; childId: string }>;
    };

    expect(bodyA1Restricted.householdId).toBe(householdA1Id);
    expect(bodyA1Restricted.label).toBe("The Smiths");

    // Adults: only Alice and Bob; Evan and Fiona from Household 2 must NOT appear
    const adultIdsA1 = bodyA1Restricted.adults.map((a) => a.personId);
    expect(adultIdsA1).toContain(adultAliceId);
    expect(adultIdsA1).toContain(adultBobId);
    expect(adultIdsA1).not.toContain(adultEvanId);
    expect(adultIdsA1).not.toContain(adultFionaId);
    expect(bodyA1Restricted.adults).toHaveLength(2);

    // Minors: only Charlie and Daisy; George must NOT appear
    const minorIdsA1 = bodyA1Restricted.minors!.map((m) => m.personId);
    expect(minorIdsA1).toContain(minorCharlieId);
    expect(minorIdsA1).toContain(minorDaisyId);
    expect(minorIdsA1).not.toContain(minorGeorgeId);
    expect(bodyA1Restricted.minors).toHaveLength(2);

    // Guardian links: only links for Charlie and Daisy; links involving George or Evan/Fiona must NOT appear
    const linkIdsA1 = bodyA1Restricted.guardians!.map((g) => g.linkId);
    const linkChildIdsA1 = bodyA1Restricted.guardians!.map((g) => g.childId);
    const linkGuardianIdsA1 = bodyA1Restricted.guardians!.map((g) => g.guardianId);
    expect(linkIdsA1).toContain(guardianLinkId);
    expect(linkIdsA1).not.toContain(guardianLinkGeorgeId);
    expect(linkChildIdsA1).toContain(minorCharlieId);
    expect(linkChildIdsA1).toContain(minorDaisyId);
    expect(linkChildIdsA1).not.toContain(minorGeorgeId);
    expect(linkGuardianIdsA1).not.toContain(adultEvanId);
    expect(linkGuardianIdsA1).not.toContain(adultFionaId);
    expect(bodyA1Restricted.guardians).toHaveLength(3);

    // 2. View-only caller reads Household A1
    const resA1View = await post(
      "/v1/households/read",
      { communitySlug: slugA1, householdId: householdA1Id },
      viewOnlyToken,
    );
    expect(resA1View.status).toBe(200);
    const bodyA1View = (await resA1View.json()) as {
      householdId: string;
      label: string | null;
      adults: Array<{ personId: string }>;
      minors?: unknown[];
      guardians?: unknown[];
    };
    const adultIdsA1View = bodyA1View.adults.map((a) => a.personId);
    expect(adultIdsA1View).toContain(adultAliceId);
    expect(adultIdsA1View).toContain(adultBobId);
    expect(adultIdsA1View).not.toContain(adultEvanId);
    expect(adultIdsA1View).not.toContain(adultFionaId);
    expect(bodyA1View.adults).toHaveLength(2);
    expect(bodyA1View.minors).toBeUndefined();
    expect(bodyA1View.guardians).toEqual([]);

    // 3. Restricted caller reads Household A2 ("The Johnsons")
    const resA2Restricted = await post(
      "/v1/households/read",
      { communitySlug: slugA1, householdId: householdA1SecondId },
      restrictedOnlyToken,
    );
    expect(resA2Restricted.status).toBe(200);
    const bodyA2Restricted = (await resA2Restricted.json()) as {
      householdId: string;
      label: string | null;
      adults: Array<{ personId: string }>;
      minors?: Array<{ personId: string }>;
      guardians?: Array<{ linkId: string; guardianId: string; childId: string }>;
    };

    expect(bodyA2Restricted.householdId).toBe(householdA1SecondId);
    expect(bodyA2Restricted.label).toBe("The Johnsons");

    // Adults: only Evan and Fiona; Alice and Bob must NOT appear
    const adultIdsA2 = bodyA2Restricted.adults.map((a) => a.personId);
    expect(adultIdsA2).toContain(adultEvanId);
    expect(adultIdsA2).toContain(adultFionaId);
    expect(adultIdsA2).not.toContain(adultAliceId);
    expect(adultIdsA2).not.toContain(adultBobId);
    expect(bodyA2Restricted.adults).toHaveLength(2);

    // Minors: only George; Charlie and Daisy must NOT appear
    const minorIdsA2 = bodyA2Restricted.minors!.map((m) => m.personId);
    expect(minorIdsA2).toContain(minorGeorgeId);
    expect(minorIdsA2).not.toContain(minorCharlieId);
    expect(minorIdsA2).not.toContain(minorDaisyId);
    expect(bodyA2Restricted.minors).toHaveLength(1);

    // Guardian links: only George's links; Charlie and Daisy's links must NOT appear
    const linkIdsA2 = bodyA2Restricted.guardians!.map((g) => g.linkId);
    const linkChildIdsA2 = bodyA2Restricted.guardians!.map((g) => g.childId);
    expect(linkIdsA2).toContain(guardianLinkGeorgeId);
    expect(linkIdsA2).not.toContain(guardianLinkId);
    expect(linkChildIdsA2).toContain(minorGeorgeId);
    expect(linkChildIdsA2).not.toContain(minorCharlieId);
    expect(linkChildIdsA2).not.toContain(minorDaisyId);
    expect(bodyA2Restricted.guardians).toHaveLength(2);

    // 4. View-only caller reads Household A2
    const resA2View = await post(
      "/v1/households/read",
      { communitySlug: slugA1, householdId: householdA1SecondId },
      viewOnlyToken,
    );
    expect(resA2View.status).toBe(200);
    const bodyA2View = (await resA2View.json()) as {
      householdId: string;
      adults: Array<{ personId: string }>;
      minors?: unknown[];
      guardians?: unknown[];
    };
    const adultIdsA2View = bodyA2View.adults.map((a) => a.personId);
    expect(adultIdsA2View).toContain(adultEvanId);
    expect(adultIdsA2View).toContain(adultFionaId);
    expect(adultIdsA2View).not.toContain(adultAliceId);
    expect(adultIdsA2View).not.toContain(adultBobId);
    expect(bodyA2View.adults).toHaveLength(2);
    expect(bodyA2View.minors).toBeUndefined();
    expect(bodyA2View.guardians).toEqual([]);
  });
  it("rejects a partial rights object on add-minor and link; omitted rights default to view and consent", async () => {
    const scopeA1 = { orgId: orgIdA, communityId: communityIdA1 };
    const rightsOf = async (childId: string, guardianId: string) =>
      withAppTransaction(secondApp, scopeA1, async (tx) => {
        const rows = await tx<
          { consent: boolean; pickup: boolean; view: boolean; manage: boolean }[]
        >`
          select consent, pickup, view, manage from app.guardian_links
          where child_person_id = ${childId}::uuid and guardian_person_id = ${guardianId}::uuid
        `;
        expect(rows).toHaveLength(1);
        return rows[0]!;
      });
    const countPersonsAndLinks = async () =>
      withAppTransaction(secondApp, scopeA1, async (tx) => {
        const persons = await tx<{ n: string }[]>`select count(*)::text as n from app.persons`;
        const links = await tx<{ n: string }[]>`select count(*)::text as n from app.guardian_links`;
        return { persons: Number(persons[0]!.n), links: Number(links[0]!.n) };
      });

    const beforePartialAdd = await countPersonsAndLinks();
    const resPartialAdd = await post(
      "/v1/households/members/add-minor",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        givenName: "RightsPartial",
        familyName: "Smith",
        dateOfBirth: "2019-05-05",
        guardianId: adultAliceId,
        rights: { pickup: true },
      },
      ownerA1Token,
    );
    expect(resPartialAdd.status).toBe(400);
    expect(await countPersonsAndLinks()).toEqual(beforePartialAdd);

    const resAddNone = await post(
      "/v1/households/members/add-minor",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        givenName: "RightsNone",
        familyName: "Smith",
        dateOfBirth: "2019-05-05",
        guardianId: adultAliceId,
      },
      ownerA1Token,
    );
    expect(resAddNone.status).toBe(201);
    const childNone = ((await resAddNone.json()) as { personId: string }).personId;
    expect(await rightsOf(childNone, adultAliceId)).toEqual({
      consent: true,
      pickup: false,
      view: true,
      manage: false,
    });

    const beforePartialLink = await countPersonsAndLinks();
    const resLinkPartial = await post(
      "/v1/households/guardians/link",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        guardianId: adultBobId,
        childId: childNone,
        rights: { pickup: true },
      },
      ownerA1Token,
    );
    expect(resLinkPartial.status).toBe(400);
    expect(await countPersonsAndLinks()).toEqual(beforePartialLink);

    const resLinkNone = await post(
      "/v1/households/guardians/link",
      {
        communitySlug: slugA1,
        householdId: householdA1Id,
        guardianId: adultBobId,
        childId: childNone,
      },
      ownerA1Token,
    );
    expect(resLinkNone.status).toBe(201);
    expect(await rightsOf(childNone, adultBobId)).toEqual({
      consent: true,
      pickup: false,
      view: true,
      manage: false,
    });
  });
});
