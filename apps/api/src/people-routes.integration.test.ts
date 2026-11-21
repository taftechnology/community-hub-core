import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, createCustomRole, grantRole } from "@community-hub/access";
import { addMember } from "@community-hub/access/testing";
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
import { createRequestHandler, type RequestLogFields, withRequest } from "@community-hub/kernel";
import { createHousehold, createPerson, setPersonStatus } from "@community-hub/people";
import { addMember as addGroupMember, createGroup } from "@community-hub/groups";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { peopleRoutes, type PeopleLog } from "./people-routes.js";
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
const PORT = 18475;
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";

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

describe("people routes real-database integration (finding 3)", () => {
  let identity: ReturnType<typeof createPlaintextIdentitySql>;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let kms: ReturnType<typeof createLocalKmsPort>;
  let mail: MemoryMail;
  let server: Server;
  const userIds: string[] = [];
  const capturedLogs: Array<{ message: string; fields?: Record<string, unknown> | undefined }> = [];

  const now = new Date("2026-10-11T00:00:00.000Z");

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
      throw new Error(`Failed to sign in for ${email}`);
    }
    userIds.push(session.userId);
    return session;
  }

  const log: PeopleLog = (message, fields) => {
    capturedLogs.push({ message, ...(fields !== undefined ? { fields } : {}) });
  };
  const guardLog = (message: string, fields: Record<string, unknown>) => {
    capturedLogs.push({ message, fields });
  };

  beforeAll(async () => {
    const runtime = loadRuntime();
    identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    app = createPlaintextAppSql(roleUrl(runtime, "app"));
    kms = createLocalKmsPort();
    mail = new MemoryMail();
    await identity`delete from identity.identity_keys`;

    server = startServer({
      env: envFor(PORT),
      routes: peopleRoutes({
        checkout,
        kms,
        keyArn: KEY_ARN,
        now: () => now,
        apiHostname: API_HOSTNAME,
        log,
        guardLog,
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
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    }
    for (const uid of userIds) {
      await identity`delete from identity.sessions where user_id = ${uid}::uuid`;
      await identity`delete from identity.users where id = ${uid}::uuid`;
    }
    await identity`delete from identity.identity_keys`;
    await identity.end({ timeout: 1 });
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
  });

  it("exercises people list and read routes across organisations and roles", async () => {
    // 1. Organisations: Org A and Org B with people.directory entitlement, Org C without
    const orgIdA = newId();
    const communityIdA = newId();
    const slugA = `synth-a-${orgIdA.slice(0, 8)}`;

    const orgIdB = newId();
    const communityIdB = newId();
    const slugB = `synth-b-${orgIdB.slice(0, 8)}`;

    const orgIdC = newId();
    const communityIdC = newId();
    const slugC = `synth-c-${orgIdC.slice(0, 8)}`;

    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values
          (${orgIdA}::uuid, ${slugA}, 'au', 'implicit'),
          (${orgIdB}::uuid, ${slugB}, 'au', 'implicit'),
          (${orgIdC}::uuid, ${slugC}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values
          (${communityIdA}::uuid, ${orgIdA}::uuid, ${slugA}, 'au'),
          (${communityIdB}::uuid, ${orgIdB}::uuid, ${slugB}, 'au'),
          (${communityIdC}::uuid, ${orgIdC}::uuid, ${slugC}, 'au')
      `;
    });

    const planKey = `synth_plan_${orgIdA.slice(0, 8)}`;
    await upsertPlan(platform, {
      key: planKey,
      entitlements: [{ key: "people.directory", limit: null }],
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

    // 2. Users
    const ownerASession = await signIn(`owner-a-${orgIdA.slice(0, 8)}@example.test`);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA }, (tx) =>
        bootstrapOwner(tx, {
          now,
          userId: ownerASession.userId,
          actorUserId: ownerASession.userId,
        }),
      ),
    );

    const customRoleSession = await signIn(`custom-role-${orgIdA.slice(0, 8)}@example.test`);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA }, async (tx) => {
        const role = await createCustomRole(tx, {
          now,
          key: "people_viewer",
          permissions: ["people.view"],
          actorUserId: ownerASession.userId,
        });
        await addMember(tx, customRoleSession.userId);
        await grantRole(tx, {
          now,
          userId: customRoleSession.userId,
          roleKey: null,
          customRoleId: role.customRoleId,
          actorUserId: ownerASession.userId,
        });
      }),
    );

    const manageRoleSession = await signIn(`manage-role-${orgIdA.slice(0, 8)}@example.test`);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA }, async (tx) => {
        const role = await createCustomRole(tx, {
          now,
          key: "people_manager",
          permissions: ["people.manage"],
          actorUserId: ownerASession.userId,
        });
        await addMember(tx, manageRoleSession.userId);
        await grantRole(tx, {
          now,
          userId: manageRoleSession.userId,
          roleKey: null,
          customRoleId: role.customRoleId,
          actorUserId: ownerASession.userId,
        });
      }),
    );

    const restrictedRoleSession = await signIn(
      `restricted-role-${orgIdA.slice(0, 8)}@example.test`,
    );
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA }, async (tx) => {
        const role = await createCustomRole(tx, {
          now,
          key: "people_safeguarder",
          permissions: ["people.restricted.read"],
          actorUserId: ownerASession.userId,
        });
        await addMember(tx, restrictedRoleSession.userId);
        await grantRole(tx, {
          now,
          userId: restrictedRoleSession.userId,
          roleKey: null,
          customRoleId: role.customRoleId,
          actorUserId: ownerASession.userId,
        });
      }),
    );

    const memberSession = await signIn(`member-${orgIdA.slice(0, 8)}@example.test`);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA }, async (tx) => {
        await addMember(tx, memberSession.userId);
        await grantRole(tx, {
          now,
          userId: memberSession.userId,
          roleKey: "member",
          customRoleId: null,
          actorUserId: ownerASession.userId,
        });
      }),
    );

    const strangerSession = await signIn(`stranger-${orgIdA.slice(0, 8)}@example.test`);

    const ownerBSession = await signIn(`owner-b-${orgIdB.slice(0, 8)}@example.test`);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdB, communityId: communityIdB }, (tx) =>
        bootstrapOwner(tx, {
          now,
          userId: ownerBSession.userId,
          actorUserId: ownerBSession.userId,
        }),
      ),
    );

    const ownerCSession = await signIn(`owner-c-${orgIdC.slice(0, 8)}@example.test`);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdC, communityId: communityIdC }, (tx) =>
        bootstrapOwner(tx, {
          now,
          userId: ownerCSession.userId,
          actorUserId: ownerCSession.userId,
        }),
      ),
    );

    // 3. Persons
    let adultAId = "";
    let minorAId = "";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA }, async (tx) => {
        const adult = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: "1990-01-01",
          givenName: "AdultA",
          familyName: "SmithA",
          email: "adult.a@example.com",
          phone: "+61400000001",
          actorUserId: ownerASession.userId,
        });
        adultAId = adult.personId;

        const household = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: "HouseholdA",
          actorUserId: ownerASession.userId,
        });

        const minor = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: false,
          householdId: household.householdId,
          dateOfBirth: "2015-05-05",
          givenName: "MinorA",
          familyName: "SmithA",
          email: null,
          phone: null,
          actorUserId: ownerASession.userId,
        });
        minorAId = minor.personId;
      }),
    );

    let adultBId = "";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdB, communityId: communityIdB }, async (tx) => {
        const adultB = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: "1992-02-02",
          givenName: "AdultB",
          familyName: "JonesB",
          email: "adult.b@example.com",
          phone: "+61400000002",
          actorUserId: ownerBSession.userId,
        });
        adultBId = adultB.personId;
      }),
    );

    // 4. Assert: people.view custom role reads an adult (200)
    const resAdult = await post(
      "/v1/people/read",
      { communitySlug: slugA, personId: adultAId },
      customRoleSession.accessToken,
    );
    expect(resAdult.status).toBe(200);
    const adultData = (await resAdult.json()) as {
      personId: string;
      givenName: string;
      familyName: string;
      email: string;
      phone: string;
      isMinor: boolean;
    };
    expect(adultData.personId).toBe(adultAId);
    expect(adultData.givenName).toBe("AdultA");
    expect(adultData.familyName).toBe("SmithA");
    expect(adultData.email).toBe("adult.a@example.com");
    expect(adultData.phone).toBe("61400000001");
    expect(adultData.isMinor).toBe(false);

    // 5. Assert: gets byte-identical status, body and headers for a minor, an absent id and org B's id
    const absentId = newId();

    const resMinor = await post(
      "/v1/people/read",
      { communitySlug: slugA, personId: minorAId },
      customRoleSession.accessToken,
    );
    const resAbsent = await post(
      "/v1/people/read",
      { communitySlug: slugA, personId: absentId },
      customRoleSession.accessToken,
    );
    const resForeign = await post(
      "/v1/people/read",
      { communitySlug: slugA, personId: adultBId },
      customRoleSession.accessToken,
    );

    expect(resMinor.status).toBe(404);
    expect(resAbsent.status).toBe(404);
    expect(resForeign.status).toBe(404);

    const bodyMinor = await resMinor.text();
    const bodyAbsent = await resAbsent.text();
    const bodyForeign = await resForeign.text();

    expect(bodyMinor).toBe("");
    expect(bodyAbsent).toBe("");
    expect(bodyForeign).toBe("");

    expect(resMinor.headers.get("content-length")).toBe(resAbsent.headers.get("content-length"));
    expect(resMinor.headers.get("content-length")).toBe(resForeign.headers.get("content-length"));
    expect(resMinor.headers.get("content-type")).toBe(resAbsent.headers.get("content-type"));
    expect(resMinor.headers.get("content-type")).toBe(resForeign.headers.get("content-type"));

    // Check same audit-row shape for those 3 reads
    const readAuditRows = await withAppTransaction(
      app,
      { orgId: orgIdA, communityId: communityIdA },
      (tx) => tx<{ action: string; purpose: string; target_ids: string[]; actor_id: string }[]>`
        select action, purpose, target_ids, actor_id::text as actor_id
        from app.audit_events
        where actor_id = ${customRoleSession.userId}::uuid
          and action = 'access.permission.denied'
        order by occurred_at desc
        limit 3
      `,
    );
    expect(readAuditRows.length).toBe(3);
    for (const row of readAuditRows) {
      expect(row.action).toBe("access.permission.denied");
      expect(row.purpose).toBe("people.restricted.read");
      expect(row.actor_id).toBe(customRoleSession.userId);
      expect(Array.isArray(row.target_ids)).toBe(true);
      expect(row.target_ids.length).toBe(1);
    }
    const auditTargetIds = readAuditRows.map((r: { target_ids: string[] }) => r.target_ids[0]);
    expect(auditTargetIds).toContain(minorAId);
    expect(auditTargetIds).toContain(absentId);
    expect(auditTargetIds).toContain(adultBId);

    // 6. Assert: adult list omits the minor and org B's person
    const resAdultList = await post(
      "/v1/people/list",
      { communitySlug: slugA, kind: "adults" },
      customRoleSession.accessToken,
    );
    expect(resAdultList.status).toBe(200);
    const adultListData = (await resAdultList.json()) as {
      items: Array<{ personId: string; givenName: string }>;
    };
    const listedIds = adultListData.items.map((i) => i.personId);
    expect(listedIds).toContain(adultAId);
    expect(listedIds).not.toContain(minorAId);
    expect(listedIds).not.toContain(adultBId);

    // 7. Assert: minors mode is 403 with an empty body for that role, a member and a stranger
    for (const token of [
      customRoleSession.accessToken,
      memberSession.accessToken,
      strangerSession.accessToken,
    ]) {
      const res = await post("/v1/people/list", { communitySlug: slugA, kind: "minors" }, token);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    }

    // 8. Assert: stranger and member get 403 on all four routes
    for (const token of [strangerSession.accessToken, memberSession.accessToken]) {
      const rList = await post("/v1/people/list", { communitySlug: slugA }, token);
      expect(rList.status).toBe(403);
      expect(await rList.text()).toBe("");

      const rRead = await post(
        "/v1/people/read",
        { communitySlug: slugA, personId: adultAId },
        token,
      );
      expect(rRead.status).toBe(403);
      expect(await rRead.text()).toBe("");

      const rCreate = await post(
        "/v1/people/create",
        { communitySlug: slugA, givenName: "Denied", familyName: "User" },
        token,
      );
      expect(rCreate.status).toBe(403);
      expect(await rCreate.text()).toBe("");

      const rUpdate = await post(
        "/v1/people/update",
        {
          communitySlug: slugA,
          personId: adultAId,
          version: 1,
          givenName: "Denied",
        },
        token,
      );
      expect(rUpdate.status).toBe(403);
      expect(await rUpdate.text()).toBe("");
    }

    // 9. Assert: org B's owner cannot read or update org A's person through either slug
    // Through slug B (person does not exist in org B -> 404)
    const rReadB = await post(
      "/v1/people/read",
      { communitySlug: slugB, personId: adultAId },
      ownerBSession.accessToken,
    );
    expect(rReadB.status).toBe(404);
    expect(await rReadB.text()).toBe("");

    const rUpdateB = await post(
      "/v1/people/update",
      {
        communitySlug: slugB,
        personId: adultAId,
        version: 1,
        givenName: "Intruder",
      },
      ownerBSession.accessToken,
    );
    expect(rUpdateB.status).toBe(404);
    expect(await rUpdateB.text()).toBe("");

    // Through slug A (owner B has no grant in org A -> 403)
    const rReadA = await post(
      "/v1/people/read",
      { communitySlug: slugA, personId: adultAId },
      ownerBSession.accessToken,
    );
    expect(rReadA.status).toBe(403);
    expect(await rReadA.text()).toBe("");

    const rUpdateA = await post(
      "/v1/people/update",
      {
        communitySlug: slugA,
        personId: adultAId,
        version: 1,
        givenName: "Intruder",
      },
      ownerBSession.accessToken,
    );
    expect(rUpdateA.status).toBe(403);
    expect(await rUpdateA.text()).toBe("");

    // 10. Assert: denial audit rows insert (purposes pass the DB CHECK)
    const denialAudit = await withAppTransaction(
      app,
      { orgId: orgIdA, communityId: communityIdA },
      (tx) => tx<{ action: string; purpose: string }[]>`
        select action, purpose
        from app.audit_events
        where action in ('people.permission.denied', 'access.permission.denied')
      `,
    );
    expect(denialAudit.length).toBeGreaterThan(0);
    const registeredPurposes = new Set(denialAudit.map((r: { purpose: string }) => r.purpose));
    for (const p of registeredPurposes) {
      expect([
        "people.permission.denied",
        "people.person.view",
        "people.restricted.read",
        "access.permission.denied",
      ]).toContain(p);
    }

    // 11. Assert: no seeded name/email/phone appears in captured log lines or audit rows
    // Run list with search term, read, create and update
    const SEARCH_TERM = "SearchZetaQuery";
    await post(
      "/v1/people/list",
      { communitySlug: slugA, search: SEARCH_TERM },
      customRoleSession.accessToken,
    );

    await post(
      "/v1/people/read",
      { communitySlug: slugA, personId: adultAId },
      customRoleSession.accessToken,
    );

    const rCreated = await post(
      "/v1/people/create",
      {
        communitySlug: slugA,
        givenName: "CreatedAlpha",
        familyName: "CreatedBeta",
        email: "created.alpha@example.test",
        phone: "+61499999001",
      },
      ownerASession.accessToken,
    );
    expect(rCreated.status).toBe(201);
    const createdBody = (await rCreated.json()) as { personId: string };

    const rUpdated = await post(
      "/v1/people/update",
      {
        communitySlug: slugA,
        personId: createdBody.personId,
        version: 1,
        givenName: "UpdatedAlpha",
      },
      ownerASession.accessToken,
    );
    expect(rUpdated.status).toBe(200);

    const termsToScan = [
      SEARCH_TERM,
      "AdultA",
      "SmithA",
      "adult.a@example.com",
      "+61400000001",
      "61400000001",
      "MinorA",
      "AdultB",
      "JonesB",
      "adult.b@example.com",
      "+61400000002",
      "61400000002",
      "CreatedAlpha",
      "CreatedBeta",
      "created.alpha@example.test",
      "+61499999001",
      "61499999001",
      "UpdatedAlpha",
    ];

    const stringifiedLogs = capturedLogs.map((l) => JSON.stringify(l));
    for (const term of termsToScan) {
      for (const logStr of stringifiedLogs) {
        expect(logStr).not.toContain(term);
      }
    }

    const allAuditRowsA = await withAppTransaction(
      app,
      { orgId: orgIdA, communityId: communityIdA },
      (tx) => tx`
        select *
        from app.audit_events
      `,
    );
    const allAuditRowsB = await withAppTransaction(
      app,
      { orgId: orgIdB, communityId: communityIdB },
      (tx) => tx`
        select *
        from app.audit_events
      `,
    );
    const allAuditRows = [...allAuditRowsA, ...allAuditRowsB];
    const stringifiedAudit = allAuditRows.map((r: unknown) => JSON.stringify(r));
    for (const term of termsToScan) {
      for (const auditStr of stringifiedAudit) {
        expect(auditStr).not.toContain(term);
      }
    }
  }, 60_000);

  async function createOrgAndCommunity(
    slugPrefix: string,
    entitlements: string[] = ["people.directory", "groups.basic"],
  ) {
    const orgId = newId();
    const communityId = newId();
    const slug = `synth-${slugPrefix}-${orgId.slice(0, 8)}`;

    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${orgId}::uuid, ${slug}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}::uuid, ${orgId}::uuid, ${slug}, 'au')
      `;
    });

    const planKey = `plan_${orgId.slice(0, 8)}`;
    await upsertPlan(platform, {
      key: planKey,
      entitlements: entitlements.map((k) => ({ key: k, limit: null })),
    });
    await assignPlan(platform, { organisationId: orgId, planKey, now });

    const cus = `cus_${newId().replaceAll("-", "")}`;
    const sub = `sub_${newId().replaceAll("-", "")}`;
    await platform`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status)
      values (${orgId}::uuid, 'self_serve', ${cus}, ${sub}, 'active')
    `;

    const ownerSession = await signIn(`owner-${slugPrefix}-${orgId.slice(0, 8)}@example.test`);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId, communityId }, (tx) =>
        bootstrapOwner(tx, {
          now,
          userId: ownerSession.userId,
          actorUserId: ownerSession.userId,
        }),
      ),
    );

    return { orgId, communityId, slug, ownerSession };
  }

  async function addCommunityToOrg(orgId: string, slugPrefix: string) {
    const communityId = newId();
    const slug = `synth-${slugPrefix}-${communityId.slice(0, 8)}`;
    await platform`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}::uuid, ${orgId}::uuid, ${slug}, 'au')
    `;
    return { communityId, slug };
  }

  it("people list: a groupId from another community of the same organisation gives an empty page", async () => {
    const org = await createOrgAndCommunity("pin32");
    const comm2 = await addCommunityToOrg(org.orgId, "pin32-c2");

    // In comm1: create an adult
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "AdultCommOne",
          familyName: "Person",
          email: "adult1@example.test",
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
      }),
    );

    // In comm2: create a group and add a person
    let groupComm2Id = "";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: comm2.communityId }, async (tx) => {
        const a2 = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "AdultCommTwo",
          familyName: "Person",
          email: "adult2@example.test",
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
        const g2 = await createGroup(tx, {
          name: "Comm2 Group",
          kind: "group",
          now,
          actorUserId: org.ownerSession.userId,
        });
        groupComm2Id = g2.id;
        await addGroupMember(tx, kms, KEY_ARN, {
          groupId: g2.id,
          personId: a2.personId,
          now,
          actorUserId: org.ownerSession.userId,
        });
      }),
    );

    const res = await post(
      "/v1/people/list",
      { communitySlug: org.slug, groupId: groupComm2Id },
      org.ownerSession.accessToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<unknown> };
    expect(body.items).toHaveLength(0);
  });

  it("people list: a tampered ciphertext gives 500 with an empty body and no value in the log", async () => {
    const org = await createOrgAndCommunity("pin43");
    const SECRET_EMAIL = "tamper-route@example.test";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "TamperAdult",
          familyName: "Person",
          email: SECRET_EMAIL,
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
      }),
    );

    const plantedError = new Error(`decryption failed with secret ${SECRET_EMAIL}`);
    plantedError.name = "TamperDecryptError";

    const throwingKms: typeof kms = {
      ...kms,
      decrypt: async () => {
        throw plantedError;
      },
    };

    const kernelLogs: RequestLogFields[] = [];
    const routes = peopleRoutes({
      checkout,
      kms: throwingKms,
      keyArn: KEY_ARN,
      now: () => now,
      apiHostname: API_HOSTNAME,
      log,
      guardLog,
    });
    const match = (request: Request) =>
      routes.find(
        (route) =>
          route.method === request.method && route.pattern === new URL(request.url).pathname,
      );

    const handler = createRequestHandler(
      {
        info: (fields: RequestLogFields) => {
          kernelLogs.push(fields);
        },
        pathFor: (request) => match(request)?.pattern ?? "unmatched",
        acceptInboundRequestId: false,
      },
      (request) => {
        const route = match(request);
        if (route === undefined) {
          return new Response(null, { status: 404 });
        }
        return route.handle(request, { billing: route.billing, pattern: route.pattern });
      },
    );

    capturedLogs.length = 0;
    const req = new Request(`http://${API_HOSTNAME}/v1/people/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-community-hub-hostname": API_HOSTNAME,
        authorization: `Bearer ${org.ownerSession.accessToken}`,
      },
      body: JSON.stringify({ communitySlug: org.slug }),
    });

    const res = await handler(req);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");

    const errorLog = kernelLogs.find((l) => l.errorClass !== undefined);
    expect(errorLog).toBeDefined();
    expect(errorLog?.errorClass).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
    expect(errorLog?.errorClass).toBe("TamperDecryptError");
    const allLogText = JSON.stringify({ kernelLogs, capturedLogs });
    expect(allLogText).not.toContain(SECRET_EMAIL);
    expect(allLogText).not.toContain("TamperAdult");
  });

  it("people list: a groupId from another organisation gives an empty page", async () => {
    const org1 = await createOrgAndCommunity("cross-org-l1");
    const org2 = await createOrgAndCommunity("cross-org-l2");

    let group2Id = "";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org2.orgId, communityId: org2.communityId }, async (tx) => {
        const g = await createGroup(tx, {
          name: "Org2 Group",
          kind: "group",
          now,
          actorUserId: org2.ownerSession.userId,
        });
        group2Id = g.id;
      }),
    );

    const res = await post(
      "/v1/people/list",
      { communitySlug: org1.slug, groupId: group2Id },
      org1.ownerSession.accessToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<unknown> };
    expect(body.items).toHaveLength(0);
  });

  it("people status: a minor's id gives 404", async () => {
    const org = await createOrgAndCommunity("minor-status");
    let minorId = "";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        const h = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: null,
          actorUserId: org.ownerSession.userId,
        });
        const m = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: false,
          householdId: h.householdId,
          dateOfBirth: "2015-01-01",
          givenName: "MinorPerson",
          familyName: "Child",
          email: null,
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
        minorId = m.personId;
      }),
    );

    const res = await post(
      "/v1/people/status",
      {
        communitySlug: org.slug,
        personId: minorId,
        version: 1,
        status: "inactive",
      },
      org.ownerSession.accessToken,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("people status: two organisations", async () => {
    const org1 = await createOrgAndCommunity("stat-org1");
    const org2 = await createOrgAndCommunity("stat-org2");

    let adult1Id = "";
    let adult2Id = "";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org1.orgId, communityId: org1.communityId }, async (tx) => {
        const a1 = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "AdultOne",
          familyName: "OrgOne",
          email: null,
          phone: null,
          actorUserId: org1.ownerSession.userId,
        });
        adult1Id = a1.personId;
      }),
    );
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org2.orgId, communityId: org2.communityId }, async (tx) => {
        const a2 = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "AdultTwo",
          familyName: "OrgTwo",
          email: null,
          phone: null,
          actorUserId: org2.ownerSession.userId,
        });
        adult2Id = a2.personId;
      }),
    );

    const resCross = await post(
      "/v1/people/status",
      {
        communitySlug: org1.slug,
        personId: adult2Id,
        version: 1,
        status: "inactive",
      },
      org1.ownerSession.accessToken,
    );
    expect(resCross.status).toBe(404);
    expect(await resCross.text()).toBe("");

    const rows = await withAppTransaction(
      app,
      { orgId: org2.orgId, communityId: org2.communityId },
      (tx) => tx<{ status: string; version: number }[]>`
        select status, version from app.persons where id = ${adult2Id}::uuid
      `,
    );
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.version).toBe(1);

    const resOk = await post(
      "/v1/people/status",
      {
        communitySlug: org1.slug,
        personId: adult1Id,
        version: 1,
        status: "inactive",
      },
      org1.ownerSession.accessToken,
    );
    expect(resOk.status).toBe(200);
    expect(await resOk.json()).toEqual({ version: 2, status: "inactive" });
  });

  it("people summary: counts only the caller's community", async () => {
    const org = await createOrgAndCommunity("sum-comm");
    const comm2 = await addCommunityToOrg(org.orgId, "sum-comm2");

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "SumA1",
          familyName: "Person",
          email: null,
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
        await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "SumA2",
          familyName: "Person",
          email: null,
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
        const inact = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "SumA3",
          familyName: "Person",
          email: null,
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
        await setPersonStatus(tx, {
          personId: inact.personId,
          version: 1,
          status: "inactive",
          actorUserId: org.ownerSession.userId,
          now,
        });
        const h = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: null,
          actorUserId: org.ownerSession.userId,
        });
        await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: false,
          householdId: h.householdId,
          dateOfBirth: "2016-01-01",
          givenName: "SumMinor",
          familyName: "Child",
          email: null,
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
      }),
    );

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: comm2.communityId }, async (tx) => {
        await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "Comm2A1",
          familyName: "Person",
          email: null,
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
        await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "Comm2A2",
          familyName: "Person",
          email: null,
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
      }),
    );

    const res = await post(
      "/v1/people/summary",
      {
        communitySlug: org.slug,
        addedSince: "2026-10-01T00:00:00+00:00",
      },
      org.ownerSession.accessToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      active: number;
      inactive: number;
      addedSince: number;
    };
    expect(body.total).toBe(3);
    expect(body.active).toBe(2);
    expect(body.inactive).toBe(1);
    expect(body.addedSince).toBe(3);
  });

  it("people list: a minor in a group never appears and adults carry their groups", async () => {
    const org = await createOrgAndCommunity("group-minors");
    let adultId = "";
    let minorId = "";
    let groupId = "";

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        const a = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "GroupAdult",
          familyName: "Person",
          email: null,
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
        adultId = a.personId;

        const h = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: null,
          actorUserId: org.ownerSession.userId,
        });
        const m = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: false,
          householdId: h.householdId,
          dateOfBirth: "2016-01-01",
          givenName: "GroupMinor",
          familyName: "Person",
          email: null,
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
        minorId = m.personId;

        const g = await createGroup(tx, {
          name: "Youth Fellowship",
          kind: "group",
          now,
          actorUserId: org.ownerSession.userId,
        });
        groupId = g.id;

        await addGroupMember(tx, kms, KEY_ARN, {
          groupId,
          personId: adultId,
          now,
          actorUserId: org.ownerSession.userId,
        });
        await addGroupMember(tx, kms, KEY_ARN, {
          groupId,
          personId: minorId,
          now,
          actorUserId: org.ownerSession.userId,
        });
      }),
    );

    const res = await post(
      "/v1/people/list",
      {
        communitySlug: org.slug,
        groupId,
      },
      org.ownerSession.accessToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        personId: string;
        isMinor: boolean;
        groups?: Array<{ id: string; name: string }>;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.personId).toBe(adultId);
    expect(body.items[0]!.isMinor).toBe(false);
    expect(body.items[0]!.groups).toEqual([{ id: groupId, name: "Youth Fellowship" }]);
    expect(body.items.some((i) => i.personId === minorId)).toBe(false);
  });

  it("people list: a decrypt failure leaves no listed audit row", async () => {
    const org = await createOrgAndCommunity("pin43b");
    let adultId = "";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        const a = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "AuditRollbackAdult",
          familyName: "Person",
          email: "tamper-rollback@example.test",
          phone: null,
          actorUserId: org.ownerSession.userId,
        });
        adultId = a.personId;

        const rows = await tx<{ email: Uint8Array | null }[]>`
          select email from app.persons where id = ${adultId}::uuid
        `;
        const tampered = new Uint8Array(rows[0]!.email!);
        tampered[0] = tampered[0]! ^ 0xff;
        await tx`
          update app.persons set email = ${tampered} where id = ${adultId}::uuid
        `;
      }),
    );

    const res = await post(
      "/v1/people/list",
      { communitySlug: org.slug },
      org.ownerSession.accessToken,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");

    const auditRows = await withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      (tx) => tx<{ count: string }[]>`
        select count(*)::text as count
        from app.audit_events
        where org_id = ${org.orgId}::uuid
          and action = 'people.person.listed'
      `,
    );
    expect(Number(auditRows[0]?.count ?? "0")).toBe(0);
  });
});
