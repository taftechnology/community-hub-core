import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, createCustomRole, grantRole } from "@community-hub/access";
import { addMember } from "@community-hub/access/testing";
import {
  deletedHouseholdsListResponse,
  EMERGENCY_CONTACT_RELATIONSHIPS as CONTRACT_RELATIONSHIPS,
  householdDeleteResponse,
  householdRestoreResponse,
  householdStatusResponse,
  readEmergencyContactsResponse,
  saveEmergencyContactsResponse,
} from "@community-hub/contracts/households";
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
  EMERGENCY_CONTACT_RELATIONSHIPS as DOMAIN_RELATIONSHIPS,
  hideHousehold,
} from "@community-hub/people";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { householdRoutes, type HouseholdDeps, type HouseholdLog } from "./household-routes.js";
import { peopleRoutes } from "./people-routes.js";
import { startServer } from "./server.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");

const API_HOSTNAME = "au.api.example.test";
const PORT = 18492;
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

function post(
  pathName: string,
  body: unknown,
  token?: string,
  hostname = API_HOSTNAME,
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

beforeAll(async () => {
  const migration = createPlaintextDirectSql(loadRuntime().productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

type Session = { userId: string; accessToken: string };

type Org = {
  orgId: string;
  communityId: string;
  slug: string;
  owner: Session;
};

type HouseholdRow = {
  id: string;
  version: number;
  status: string;
  deleted_at: Date | null;
  deleted_by: string | null;
  emergency_contacts: Uint8Array | null;
};

describe("family parity routes against a real database", () => {
  let identity: ReturnType<typeof createPlaintextIdentitySql>;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let migrator: ReturnType<typeof createPlaintextDirectSql>;
  let kms: ReturnType<typeof createLocalKmsPort>;
  let mail: MemoryMail;
  let server: Server;
  let counter = 0;
  const userIds: string[] = [];
  const capturedLogs: Array<{ message: string; fields?: Record<string, unknown> | undefined }> = [];

  const now = new Date("2026-11-20T10:00:00.000Z");

  const checkout = async <T>(role: Role, run: (sql: never) => Promise<T>): Promise<T> => {
    if (role === "identity") {
      return run(identity as never);
    }
    if (role === "platform") {
      return run(platform as never);
    }
    return run(app as never);
  };

  async function signIn(email: string): Promise<Session> {
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

  const log: HouseholdLog = (message, fields) => {
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
    migrator = createPlaintextDirectSql(runtime.productOnlyUrl);
    kms = createLocalKmsPort();
    mail = new MemoryMail();
    await identity`delete from identity.identity_keys`;

    const deps: HouseholdDeps = {
      checkout,
      kms,
      keyArn: KEY_ARN,
      now: () => now,
      apiHostname: API_HOSTNAME,
      log,
      guardLog,
    };
    server = startServer({
      env: envFor(PORT),
      routes: [
        ...peopleRoutes(deps as unknown as Parameters<typeof peopleRoutes>[0]),
        ...householdRoutes(deps),
      ],
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
    await migrator.end({ timeout: 1 });
  });

  async function createOrg(
    prefix: string,
    options: { billing?: "ok" | "read_only"; entitlements?: string[] } = {},
  ): Promise<Org> {
    counter += 1;
    const orgId = newId();
    const communityId = newId();
    const slug = `fam-${prefix}-${counter}-${orgId.slice(0, 8)}`;
    const entitlements = options.entitlements ?? ["people.directory", "people.households"];

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

    const planKey = `plan_${counter}_${orgId.slice(0, 8)}`;
    await upsertPlan(platform, {
      key: planKey,
      entitlements: entitlements.map((key) => ({ key, limit: null })),
    });
    await assignPlan(platform, { organisationId: orgId, planKey, now });

    const cus = `cus_${newId().replaceAll("-", "")}`;
    const sub = `sub_${newId().replaceAll("-", "")}`;
    const stripeStatus = (options.billing ?? "ok") === "ok" ? "active" : "canceled";
    await platform`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status)
      values (${orgId}::uuid, 'self_serve', ${cus}, ${sub}, ${stripeStatus})
    `;

    const owner = await signIn(`owner-${counter}-${orgId.slice(0, 8)}@example.test`);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId, communityId }, (tx) =>
        bootstrapOwner(tx, { now, userId: owner.userId, actorUserId: owner.userId }),
      ),
    );
    return { orgId, communityId, slug, owner };
  }

  async function customCaller(org: Org, permissions: string[]): Promise<Session> {
    counter += 1;
    const session = await signIn(`caller-${counter}-${org.orgId.slice(0, 8)}@example.test`);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        const role = await createCustomRole(tx, {
          now,
          key: `r_${counter}_${newId().replaceAll("-", "").slice(0, 8)}`,
          permissions,
          actorUserId: org.owner.userId,
        });
        await addMember(tx, session.userId);
        await grantRole(tx, {
          now,
          userId: session.userId,
          roleKey: null,
          customRoleId: role.customRoleId,
          actorUserId: org.owner.userId,
        });
      }),
    );
    return session;
  }

  async function createFamily(
    org: Org,
    label = "Test Family",
  ): Promise<{ householdId: string; version: number }> {
    return withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, (tx) =>
        createHousehold(tx, kms, KEY_ARN, {
          now,
          label,
          actorUserId: org.owner.userId,
        }),
      ),
    );
  }

  async function createAdultMember(
    org: Org,
    householdId: string,
    givenName = "Parent",
  ): Promise<string> {
    return withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, (tx) =>
        createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId,
          dateOfBirth: null,
          givenName,
          familyName: "Member",
          email: null,
          phone: null,
          actorUserId: org.owner.userId,
        }),
      ).then((p) => p.personId),
    );
  }

  async function getHousehold(org: Org, householdId: string): Promise<HouseholdRow | null> {
    return withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        const rows = await tx<HouseholdRow[]>`
          select id::text as id, version, status, deleted_at, deleted_by::text as deleted_by, emergency_contacts
          from app.households
          where id = ${householdId}::uuid
        `;
        return rows[0] ?? null;
      },
    );
  }

  async function auditDenialRows(
    org: Org,
    purpose: string,
  ): Promise<
    Array<{
      action: string;
      purpose: string;
      target_ids: string[];
    }>
  > {
    return withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        const rows = await tx<
          Array<{
            action: string;
            purpose: string;
            target_ids: string[];
          }>
        >`
          select action, purpose, target_ids
          from app.audit_events
          where action = 'people.permission.denied'
            and purpose = ${purpose}
          order by id desc
        `;
        return rows;
      },
    );
  }

  it("the contract and domain relationship lists are equal", () => {
    expect(CONTRACT_RELATIONSHIPS).toEqual(DOMAIN_RELATIONSHIPS);
  });

  it("each family route refuses each missing permission with its status and denial row", async () => {
    const org = await createOrg("perm-check");

    const cases = [
      // /v1/households/delete: people.view (purpose people.person.view), people.delete (people.permission.denied), people.restricted.read (people.restricted.read)
      {
        route: "/v1/households/delete",
        makeBody: (hId: string, v: number) => ({
          communitySlug: org.slug,
          householdId: hId,
          version: v,
        }),
        missingKey: "people.view",
        allKeys: ["people.view", "people.delete", "people.restricted.read"],
        expectedPurpose: "people.person.view",
      },
      {
        route: "/v1/households/delete",
        makeBody: (hId: string, v: number) => ({
          communitySlug: org.slug,
          householdId: hId,
          version: v,
        }),
        missingKey: "people.delete",
        allKeys: ["people.view", "people.delete", "people.restricted.read"],
        expectedPurpose: "people.permission.denied",
      },
      {
        route: "/v1/households/delete",
        makeBody: (hId: string, v: number) => ({
          communitySlug: org.slug,
          householdId: hId,
          version: v,
        }),
        missingKey: "people.restricted.read",
        allKeys: ["people.view", "people.delete", "people.restricted.read"],
        expectedPurpose: "people.restricted.read",
      },
      // /v1/households/restore: same keys as delete
      {
        route: "/v1/households/restore",
        makeBody: (hId: string, v: number) => ({
          communitySlug: org.slug,
          householdId: hId,
          version: v,
        }),
        missingKey: "people.view",
        allKeys: ["people.view", "people.delete", "people.restricted.read"],
        expectedPurpose: "people.person.view",
      },
      {
        route: "/v1/households/restore",
        makeBody: (hId: string, v: number) => ({
          communitySlug: org.slug,
          householdId: hId,
          version: v,
        }),
        missingKey: "people.delete",
        allKeys: ["people.view", "people.delete", "people.restricted.read"],
        expectedPurpose: "people.permission.denied",
      },
      {
        route: "/v1/households/restore",
        makeBody: (hId: string, v: number) => ({
          communitySlug: org.slug,
          householdId: hId,
          version: v,
        }),
        missingKey: "people.restricted.read",
        allKeys: ["people.view", "people.delete", "people.restricted.read"],
        expectedPurpose: "people.restricted.read",
      },
      // /v1/households/status: people.view (people.person.view), people.manage (people.person.manage)
      {
        route: "/v1/households/status",
        makeBody: (hId: string, v: number) => ({
          communitySlug: org.slug,
          householdId: hId,
          version: v,
          status: "inactive",
        }),
        missingKey: "people.view",
        allKeys: ["people.view", "people.manage"],
        expectedPurpose: "people.person.view",
      },
      {
        route: "/v1/households/status",
        makeBody: (hId: string, v: number) => ({
          communitySlug: org.slug,
          householdId: hId,
          version: v,
          status: "inactive",
        }),
        missingKey: "people.manage",
        allKeys: ["people.view", "people.manage"],
        expectedPurpose: "people.person.manage",
      },
      // /v1/households/emergency-contacts/read: people.restricted.read (people.restricted.read)
      {
        route: "/v1/households/emergency-contacts/read",
        makeBody: (hId: string) => ({
          communitySlug: org.slug,
          householdId: hId,
        }),
        missingKey: "people.restricted.read",
        allKeys: ["people.restricted.read"],
        extraGranted: ["people.view"],
        expectedPurpose: "people.restricted.read",
      },
      // /v1/households/emergency-contacts/save: people.manage (people.person.manage), then people.restricted.read (people.restricted.read)
      {
        route: "/v1/households/emergency-contacts/save",
        makeBody: (hId: string, v: number) => ({
          communitySlug: org.slug,
          householdId: hId,
          version: v,
          contacts: [],
        }),
        missingKey: "people.manage",
        allKeys: ["people.manage", "people.restricted.read"],
        expectedPurpose: "people.person.manage",
      },
      {
        route: "/v1/households/emergency-contacts/save",
        makeBody: (hId: string, v: number) => ({
          communitySlug: org.slug,
          householdId: hId,
          version: v,
          contacts: [],
        }),
        missingKey: "people.restricted.read",
        allKeys: ["people.manage", "people.restricted.read"],
        expectedPurpose: "people.restricted.read",
      },
    ];

    for (const c of cases) {
      const permissions = [
        ...c.allKeys.filter((k) => k !== c.missingKey),
        ...(c.extraGranted ?? []),
      ];
      const caller = await customCaller(org, permissions);
      const family = await createFamily(org);

      const beforeRow = await getHousehold(org, family.householdId);
      const beforeDenials = await auditDenialRows(org, c.expectedPurpose);

      const res = await post(
        c.route,
        c.makeBody(family.householdId, family.version),
        caller.accessToken,
      );

      expect(res.status, `expected 403 on ${c.route} missing ${c.missingKey}`).toBe(403);
      expect(await res.text()).toBe("");
      expect(res.headers.get("cache-control"), `expected no-store on ${c.route}`).toContain(
        "no-store",
      );

      const afterDenials = await auditDenialRows(org, c.expectedPurpose);
      expect(
        afterDenials.length,
        `expected exactly one new denial for ${c.route} missing ${c.missingKey}`,
      ).toBe(beforeDenials.length + 1);
      const newDenial = afterDenials[0]!;
      expect(newDenial.action).toBe("people.permission.denied");
      expect(newDenial.purpose).toBe(c.expectedPurpose);
      expect(newDenial.target_ids).toEqual([org.orgId, org.communityId]);

      const afterRow = await getHousehold(org, family.householdId);
      expect(afterRow?.version).toBe(beforeRow?.version);
      expect(afterRow?.status).toBe(beforeRow?.status);
      expect(afterRow?.deleted_at).toEqual(beforeRow?.deleted_at);
    }
  });

  it("family list and read without people.view answer 403 with a denial row", async () => {
    const org = await createOrg("list-read-denial");
    const caller = await customCaller(org, ["people.manage"]); // has manage, no view
    const family = await createFamily(org);

    // List without people.view
    const listRes = await post(
      "/v1/households/list",
      { communitySlug: org.slug },
      caller.accessToken,
    );
    expect(listRes.status).toBe(403);
    expect(await listRes.text()).toBe("");

    const listDenials = await auditDenialRows(org, "people.person.view");
    expect(listDenials.length).toBeGreaterThanOrEqual(1);
    expect(listDenials[0]!.target_ids).toEqual([org.orgId, org.communityId]);

    // Read without people.view or people.restricted.read
    const readRes = await post(
      "/v1/households/read",
      { communitySlug: org.slug, householdId: family.householdId },
      caller.accessToken,
    );
    expect(readRes.status).toBe(403);
    expect(await readRes.text()).toBe("");

    const readDenials = await auditDenialRows(org, "people.person.view");
    expect(readDenials.length).toBeGreaterThanOrEqual(2);
    expect(readDenials[0]!.target_ids).toEqual([org.orgId, org.communityId]);
  });

  it("the deleted filter without all three keys answers 400 with a denial row", async () => {
    const org = await createOrg("deleted-filter-denial");

    // Case 1: has people.view, but missing people.delete (has view and restricted)
    const callerNoDelete = await customCaller(org, ["people.view", "people.restricted.read"]);
    const beforeDenials = await auditDenialRows(org, "people.permission.denied");

    const res1 = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "deleted" },
      callerNoDelete.accessToken,
    );
    expect(res1.status).toBe(400);
    expect(await res1.text()).toBe("");
    expect(res1.headers.get("cache-control")).toContain("no-store");

    const afterDenials1 = await auditDenialRows(org, "people.permission.denied");
    expect(afterDenials1.length).toBe(beforeDenials.length + 1);
    expect(afterDenials1[0]!.target_ids).toEqual([org.orgId, org.communityId]);

    // Case 2: has people.view, but missing people.restricted.read (has view and delete)
    const callerNoRestricted = await customCaller(org, ["people.view", "people.delete"]);
    const res2 = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "deleted" },
      callerNoRestricted.accessToken,
    );
    expect(res2.status).toBe(400);
    expect(await res2.text()).toBe("");
    expect(res2.headers.get("cache-control")).toContain("no-store");

    const afterDenials2 = await auditDenialRows(org, "people.permission.denied");
    expect(afterDenials2.length).toBe(afterDenials1.length + 1);
  });

  it("every family route answers 404 for another community's household id", async () => {
    const orgA = await createOrg("cross-comm-a");
    const orgB = await createOrg("cross-comm-b");
    const familyB = await createFamily(orgB);

    const routes = [
      {
        path: "/v1/households/status",
        body: {
          communitySlug: orgA.slug,
          householdId: familyB.householdId,
          version: familyB.version,
          status: "inactive",
        },
      },
      {
        path: "/v1/households/delete",
        body: {
          communitySlug: orgA.slug,
          householdId: familyB.householdId,
          version: familyB.version,
        },
      },
      {
        path: "/v1/households/restore",
        body: {
          communitySlug: orgA.slug,
          householdId: familyB.householdId,
          version: familyB.version,
        },
      },
      {
        path: "/v1/households/emergency-contacts/read",
        body: {
          communitySlug: orgA.slug,
          householdId: familyB.householdId,
        },
      },
      {
        path: "/v1/households/emergency-contacts/save",
        body: {
          communitySlug: orgA.slug,
          householdId: familyB.householdId,
          version: familyB.version,
          contacts: [],
        },
      },
    ];

    for (const r of routes) {
      const res = await post(r.path, r.body, orgA.owner.accessToken);
      expect(res.status, `expected 404 on ${r.path} for another community's household`).toBe(404);
      expect(await res.text()).toBe("");
    }

    const rowB = await getHousehold(orgB, familyB.householdId);
    expect(rowB?.version).toBe(familyB.version);
    expect(rowB?.deleted_at).toBeNull();
  });

  it("every family route and the deleted list answer no-store, refusals included", async () => {
    const org = await createOrg("no-store-suite");
    const family = await createFamily(org);

    // 1. The 5 new routes on 200 success
    const resStatus = await post(
      "/v1/households/status",
      { communitySlug: org.slug, householdId: family.householdId, version: 1, status: "inactive" },
      org.owner.accessToken,
    );
    expect(resStatus.status).toBe(200);
    expect(resStatus.headers.get("cache-control")).toContain("no-store");
    const statusBody = await resStatus.json();
    expect(householdStatusResponse.safeParse(statusBody).success).toBe(true);

    const resEcSave = await post(
      "/v1/households/emergency-contacts/save",
      {
        communitySlug: org.slug,
        householdId: family.householdId,
        version: 2,
        contacts: [{ name: "Bob", phone: "+61 400 000 001", relationship: "neighbour" }],
      },
      org.owner.accessToken,
    );
    expect(resEcSave.status).toBe(200);
    expect(resEcSave.headers.get("cache-control")).toContain("no-store");
    const ecSaveBody = await resEcSave.json();
    expect(saveEmergencyContactsResponse.safeParse(ecSaveBody).success).toBe(true);

    const resEcRead = await post(
      "/v1/households/emergency-contacts/read",
      { communitySlug: org.slug, householdId: family.householdId },
      org.owner.accessToken,
    );
    expect(resEcRead.status).toBe(200);
    expect(resEcRead.headers.get("cache-control")).toContain("no-store");
    const ecReadBody = await resEcRead.json();
    expect(readEmergencyContactsResponse.safeParse(ecReadBody).success).toBe(true);

    const resDelete = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: family.householdId, version: 3 },
      org.owner.accessToken,
    );
    expect(resDelete.status).toBe(200);
    expect(resDelete.headers.get("cache-control")).toContain("no-store");
    const deleteBody = await resDelete.json();
    expect(householdDeleteResponse.safeParse(deleteBody).success).toBe(true);

    const resRestore = await post(
      "/v1/households/restore",
      { communitySlug: org.slug, householdId: family.householdId, version: 4 },
      org.owner.accessToken,
    );
    expect(resRestore.status).toBe(200);
    expect(resRestore.headers.get("cache-control")).toContain("no-store");
    const restoreBody = await resRestore.json();
    expect(householdRestoreResponse.safeParse(restoreBody).success).toBe(true);

    // 2. Refusals on the 5 new routes
    // 400 bad body
    const badBodyRes = await post("/v1/households/delete", { bad: "body" }, org.owner.accessToken);
    expect(badBodyRes.status).toBe(400);
    expect(badBodyRes.headers.get("cache-control")).toContain("no-store");

    // 401 unauthenticated
    const unauthRes = await post("/v1/households/delete", {
      communitySlug: org.slug,
      householdId: family.householdId,
      version: 5,
    });
    expect(unauthRes.status).toBe(401);
    expect(unauthRes.headers.get("cache-control")).toContain("no-store");

    // 404 foreign host
    const foreignHostRes = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: family.householdId, version: 5 },
      org.owner.accessToken,
      "auth.au.example.test",
    );
    expect(foreignHostRes.status).toBe(404);
    expect(foreignHostRes.headers.get("cache-control")).toContain("no-store");

    // 409 conflict
    const conflictRes = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: family.householdId, version: 999 },
      org.owner.accessToken,
    );
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.headers.get("cache-control")).toContain("no-store");

    // 3. /v1/households/list with status "deleted"
    // Success (200)
    const listDelRes = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "deleted" },
      org.owner.accessToken,
    );
    expect(listDelRes.status).toBe(200);
    expect(listDelRes.headers.get("cache-control")).toContain("no-store");
    const listDelBody = await listDelRes.json();
    expect(deletedHouseholdsListResponse.safeParse(listDelBody).success).toBe(true);

    // 400 refusal on deleted filter
    const callerNoDel = await customCaller(org, ["people.view"]);
    const listRefused400 = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "deleted" },
      callerNoDel.accessToken,
    );
    expect(listRefused400.status).toBe(400);
    expect(listRefused400.headers.get("cache-control")).toContain("no-store");

    // 403 refusal on deleted filter without people.view
    const callerNoView = await customCaller(org, ["people.manage"]);
    const listRefused403 = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "deleted" },
      callerNoView.accessToken,
    );
    expect(listRefused403.status).toBe(403);
    expect(listRefused403.headers.get("cache-control")).toContain("no-store");

    // Normal list without status "deleted" does not carry no-store
    const normalListRes = await post(
      "/v1/households/list",
      { communitySlug: org.slug },
      org.owner.accessToken,
    );
    expect(normalListRes.status).toBe(200);
    expect(normalListRes.headers.get("cache-control")).toBeNull();
  });

  it("the family sweep does not run in a read-only community", async () => {
    const org = await createOrg("sweep-ro", { billing: "read_only" });
    const family = await createFamily(org);

    // Age the family 721 hours as migrator
    await migrator.begin(async (sql) => {
      await sql`set local search_path = pg_catalog, app`;
      await sql`alter table app.households disable trigger user`;
      await sql`
        update app.households
        set deleted_at = now() - interval '721 hours',
            deleted_by = ${org.owner.userId}::uuid
        where id = ${family.householdId}::uuid
      `;
      await sql`alter table app.households enable trigger user`;
    });

    // List is a read route and allowed in read_only
    const listRes = await post(
      "/v1/households/list",
      { communitySlug: org.slug },
      org.owner.accessToken,
    );
    expect(listRes.status).toBe(200);

    // The family must still be there (sweep did not run)
    const row = await getHousehold(org, family.householdId);
    expect(row).not.toBeNull();
    expect(row?.deleted_at).not.toBeNull();
  });

  it("a failing family sweep does not change the answer and logs the class only", async () => {
    const org = await createOrg("sweep-fail");
    const family = await createFamily(org);

    // Age family 721 hours
    await migrator.begin(async (sql) => {
      await sql`set local search_path = pg_catalog, app`;
      await sql`alter table app.households disable trigger user`;
      await sql`
        update app.households
        set deleted_at = now() - interval '721 hours',
            deleted_by = ${org.owner.userId}::uuid
        where id = ${family.householdId}::uuid
      `;
      await sql`alter table app.households enable trigger user`;
    });

    // Revoke EXECUTE on app.purge_deleted_households from app to force a failure
    await migrator`revoke execute on function app.purge_deleted_households(integer) from app`;
    try {
      capturedLogs.length = 0;
      const listRes = await post(
        "/v1/households/list",
        { communitySlug: org.slug },
        org.owner.accessToken,
      );
      expect(listRes.status).toBe(200);

      // Verify log message
      const sweepFailLog = capturedLogs.find((l) => l.message === "family_sweep_failed");
      expect(sweepFailLog).toBeDefined();
      expect(sweepFailLog?.fields).toEqual({
        errorClass: expect.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
        path: "/v1/households/list",
      });

      // The family is still there
      const row = await getHousehold(org, family.householdId);
      expect(row).not.toBeNull();
    } finally {
      await migrator`grant execute on function app.purge_deleted_households(integer) to app`;
    }
  });

  it("the family sweep does not run after a refusal", async () => {
    const org = await createOrg("sweep-refusal");
    const familyToPurge = await createFamily(org);

    // Age familyToPurge 721 hours
    await migrator.begin(async (sql) => {
      await sql`set local search_path = pg_catalog, app`;
      await sql`alter table app.households disable trigger user`;
      await sql`
        update app.households
        set deleted_at = now() - interval '721 hours',
            deleted_by = ${org.owner.userId}::uuid
        where id = ${familyToPurge.householdId}::uuid
      `;
      await sql`alter table app.households enable trigger user`;
    });

    const otherFamily = await createFamily(org);

    // Delete with a wrong version -> 409
    const refusedRes = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: otherFamily.householdId, version: 999 },
      org.owner.accessToken,
    );
    expect(refusedRes.status).toBe(409);

    // Sweep must NOT have run; familyToPurge is still in the database
    const row = await getHousehold(org, familyToPurge.householdId);
    expect(row).not.toBeNull();
  });

  it("a family past 720 hours is purged after a list, a delete and a restore", async () => {
    const org = await createOrg("sweep-triggers");

    // 1. Sweep after list
    const f1 = await createFamily(org);
    await migrator.begin(async (sql) => {
      await sql`set local search_path = pg_catalog, app`;
      await sql`alter table app.households disable trigger user`;
      await sql`
        update app.households
        set deleted_at = now() - interval '721 hours',
            deleted_by = ${org.owner.userId}::uuid
        where id = ${f1.householdId}::uuid
      `;
      await sql`alter table app.households enable trigger user`;
    });

    const resList = await post(
      "/v1/households/list",
      { communitySlug: org.slug },
      org.owner.accessToken,
    );
    expect(resList.status).toBe(200);

    const row1 = await getHousehold(org, f1.householdId);
    expect(row1).toBeNull(); // Purged!

    // 2. Sweep after delete
    const f2 = await createFamily(org);
    await migrator.begin(async (sql) => {
      await sql`set local search_path = pg_catalog, app`;
      await sql`alter table app.households disable trigger user`;
      await sql`
        update app.households
        set deleted_at = now() - interval '721 hours',
            deleted_by = ${org.owner.userId}::uuid
        where id = ${f2.householdId}::uuid
      `;
      await sql`alter table app.households enable trigger user`;
    });

    const fActive1 = await createFamily(org);
    const resDel = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: fActive1.householdId, version: 1 },
      org.owner.accessToken,
    );
    expect(resDel.status).toBe(200);

    const row2 = await getHousehold(org, f2.householdId);
    expect(row2).toBeNull(); // Purged!

    // 3. Sweep after restore
    const f3 = await createFamily(org);
    await migrator.begin(async (sql) => {
      await sql`set local search_path = pg_catalog, app`;
      await sql`alter table app.households disable trigger user`;
      await sql`
        update app.households
        set deleted_at = now() - interval '721 hours',
            deleted_by = ${org.owner.userId}::uuid
        where id = ${f3.householdId}::uuid
      `;
      await sql`alter table app.households enable trigger user`;
    });

    const fHiddenToRestore = await createFamily(org);
    // Hide it normally (so it's eligible to restore)
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, (tx) =>
        hideHousehold(tx, {
          householdId: fHiddenToRestore.householdId,
          version: 1,
          actorUserId: org.owner.userId,
        }),
      ),
    );

    const resRestore = await post(
      "/v1/households/restore",
      { communitySlug: org.slug, householdId: fHiddenToRestore.householdId, version: 2 },
      org.owner.accessToken,
    );
    expect(resRestore.status).toBe(200);

    const row3 = await getHousehold(org, f3.householdId);
    expect(row3).toBeNull(); // Purged!
  });

  it("no emergency contact value reaches a log or an audit row", async () => {
    const org = await createOrg("no-leak");
    const family = await createFamily(org, "UniqueLabelFamily");

    capturedLogs.length = 0;

    const contactName = "UniqueSecretContactName";
    const contactPhone = "+61 411 555 789";
    const contactPhoneClean = "+61411555789";

    // Save contact
    const saveRes = await post(
      "/v1/households/emergency-contacts/save",
      {
        communitySlug: org.slug,
        householdId: family.householdId,
        version: 1,
        contacts: [{ name: contactName, phone: contactPhone, relationship: "spouse" }],
      },
      org.owner.accessToken,
    );
    expect(saveRes.status).toBe(200);

    // Read contact
    const readRes = await post(
      "/v1/households/emergency-contacts/read",
      { communitySlug: org.slug, householdId: family.householdId },
      org.owner.accessToken,
    );
    expect(readRes.status).toBe(200);

    // Failing save
    const failRes = await post(
      "/v1/households/emergency-contacts/save",
      {
        communitySlug: org.slug,
        householdId: family.householdId,
        version: 999,
        contacts: [{ name: contactName, phone: contactPhone, relationship: "spouse" }],
      },
      org.owner.accessToken,
    );
    expect(failRes.status).toBe(409);

    // Verify logs
    expect(capturedLogs.length).toBeGreaterThan(0);
    const logDump = JSON.stringify(capturedLogs);
    expect(logDump).not.toContain(contactName);
    expect(logDump).not.toContain(contactPhone);
    expect(logDump).not.toContain(contactPhoneClean);
    expect(logDump).not.toContain("UniqueLabelFamily");

    // Verify audit rows
    const auditRows = await withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        return tx<Array<Record<string, unknown>>>`
          select *
          from app.audit_events
          where org_id = ${org.orgId}::uuid
        `;
      },
    );
    expect(auditRows.length).toBeGreaterThan(0);
    const auditDump = JSON.stringify(auditRows);
    expect(auditDump).not.toContain(contactName);
    expect(auditDump).not.toContain(contactPhone);
    expect(auditDump).not.toContain(contactPhoneClean);
    expect(auditDump).not.toContain("UniqueLabelFamily");
  });

  it("handles business rules: child blocker, unknown age blocker, restore cutoff, hidden family on all routes", async () => {
    const org = await createOrg("rules-suite");
    const family = await createFamily(org);

    // 1. Delete refuses a family with a minor (409 household_has_children)
    const adult = await createAdultMember(org, family.householdId, "Parent");
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, (tx) =>
        addMinor(tx, kms, KEY_ARN, {
          now,
          householdId: family.householdId,
          givenName: "Child",
          familyName: "Minor",
          dateOfBirth: "2015-01-01",
          guardianId: adult,
          actorUserId: org.owner.userId,
        }),
      ),
    );

    const delMinorRes = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: family.householdId, version: 1 },
      org.owner.accessToken,
    );
    expect(delMinorRes.status).toBe(409);
    expect(await delMinorRes.json()).toEqual({ code: "household_has_children" });

    // 2. Delete refuses a family with an unknown-age minor
    const fUnknown = await createFamily(org);
    await createAdultMember(org, fUnknown.householdId, "ParentU");
    // Insert a minor with age_basis = unknown as migrator
    await migrator.begin(async (sql) => {
      await sql`set local search_path = pg_catalog, app`;
      await sql`alter table app.persons disable trigger user`;
      await sql`
        insert into app.persons (
          id, org_id, community_id, household_id, is_minor, age_basis,
          given_name_restricted, family_name_restricted, version, created_at
        ) values (
          ${newId()}::uuid, ${org.orgId}::uuid, ${org.communityId}::uuid, ${fUnknown.householdId}::uuid,
          true, 'unknown', '\\x01'::bytea, '\\x01'::bytea, 1, now()
        )
      `;
      await sql`alter table app.persons enable trigger user`;
    });

    const delUnknownRes = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: fUnknown.householdId, version: 1 },
      org.owner.accessToken,
    );
    expect(delUnknownRes.status).toBe(409);
    expect(await delUnknownRes.json()).toEqual({ code: "household_has_children" });

    // 3. Restore cutoff: 719h works, 721h answers 404
    const f719 = await createFamily(org);
    await migrator.begin(async (sql) => {
      await sql`set local search_path = pg_catalog, app`;
      await sql`alter table app.households disable trigger user`;
      await sql`
        update app.households
        set deleted_at = now() - interval '719 hours',
            deleted_by = ${org.owner.userId}::uuid
        where id = ${f719.householdId}::uuid
      `;
      await sql`alter table app.households enable trigger user`;
    });
    const res719 = await post(
      "/v1/households/restore",
      { communitySlug: org.slug, householdId: f719.householdId, version: 1 },
      org.owner.accessToken,
    );
    expect(res719.status).toBe(200);

    const f721 = await createFamily(org);
    await migrator.begin(async (sql) => {
      await sql`set local search_path = pg_catalog, app`;
      await sql`alter table app.households disable trigger user`;
      await sql`
        update app.households
        set deleted_at = now() - interval '721 hours',
            deleted_by = ${org.owner.userId}::uuid
        where id = ${f721.householdId}::uuid
      `;
      await sql`alter table app.households enable trigger user`;
    });
    const res721 = await post(
      "/v1/households/restore",
      { communitySlug: org.slug, householdId: f721.householdId, version: 1 },
      org.owner.accessToken,
    );
    expect(res721.status).toBe(404);

    // 4. Hidden family is 404 on reads and writes
    const fHidden = await createFamily(org);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, (tx) =>
        hideHousehold(tx, {
          householdId: fHidden.householdId,
          version: 1,
          actorUserId: org.owner.userId,
        }),
      ),
    );

    const readHidden = await post(
      "/v1/households/read",
      { communitySlug: org.slug, householdId: fHidden.householdId },
      org.owner.accessToken,
    );
    expect(readHidden.status).toBe(404);

    const statusHidden = await post(
      "/v1/households/status",
      { communitySlug: org.slug, householdId: fHidden.householdId, version: 2, status: "inactive" },
      org.owner.accessToken,
    );
    expect(statusHidden.status).toBe(404);

    const deleteHidden = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: fHidden.householdId, version: 2 },
      org.owner.accessToken,
    );
    expect(deleteHidden.status).toBe(404);

    const ecReadHidden = await post(
      "/v1/households/emergency-contacts/read",
      { communitySlug: org.slug, householdId: fHidden.householdId },
      org.owner.accessToken,
    );
    expect(ecReadHidden.status).toBe(404);

    const ecSaveHidden = await post(
      "/v1/households/emergency-contacts/save",
      { communitySlug: org.slug, householdId: fHidden.householdId, version: 2, contacts: [] },
      org.owner.accessToken,
    );
    expect(ecSaveHidden.status).toBe(404);
  });
});
