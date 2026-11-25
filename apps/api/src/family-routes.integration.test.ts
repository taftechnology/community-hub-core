import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, createCustomRole, grantRole } from "@community-hub/access";
import { addMember } from "@community-hub/access/testing";
import {
  deletedHouseholdsListResponse,
  EMERGENCY_CONTACT_RELATIONSHIPS as CONTRACT_RELATIONSHIPS,
  listHouseholdsResponse,
  readHouseholdResponse,
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
const HOURS_720_MS = 720 * 60 * 60 * 1000;

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

  async function addCommunityToOrg(
    orgId: string,
    slugPrefix: string,
  ): Promise<{ communityId: string; slug: string }> {
    const communityId = newId();
    const slug = `fam-${slugPrefix}-${communityId.slice(0, 8)}`;
    await platform`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}::uuid, ${orgId}::uuid, ${slug}, 'au')
    `;
    return { communityId, slug };
  }

  async function customCaller(
    org: Org,
    permissions: string[],
    communityId = org.communityId,
  ): Promise<Session> {
    counter += 1;
    const session = await signIn(`caller-${counter}-${org.orgId.slice(0, 8)}@example.test`);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId }, async (tx) => {
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
    communityId = org.communityId,
  ): Promise<{ householdId: string; version: number }> {
    return withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId }, (tx) =>
        createHousehold(tx, kms, KEY_ARN, {
          now,
          label,
          actorUserId: org.owner.userId,
        }),
      ),
    );
  }

  async function hideFamily(
    org: Org,
    householdId: string,
    version: number,
    communityId = org.communityId,
  ): Promise<{ version: number }> {
    return withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId }, (tx) =>
        hideHousehold(tx, {
          householdId,
          version,
          actorUserId: org.owner.userId,
        }),
      ),
    );
  }

  // Shared helper for aging a family past retention threshold with user triggers disabled.
  async function ageFamily(
    org: Org,
    householdId: string,
    hours = 721,
    communityId = org.communityId,
  ): Promise<void> {
    await withAppTransaction(migrator, { orgId: org.orgId, communityId }, async (tx) => {
      await tx.unsafe("ALTER TABLE app.households DISABLE TRIGGER USER");
      await tx`
        update app.households
        set deleted_at = now() - (${hours} * interval '1 hour'),
            deleted_by = ${org.owner.userId}::uuid
        where id = ${householdId}::uuid
      `;
      await tx.unsafe("ALTER TABLE app.households ENABLE TRIGGER USER");
    });
  }

  async function createAdultMember(
    org: Org,
    householdId: string,
    givenName = "Parent",
    communityId = org.communityId,
  ): Promise<string> {
    return withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId }, (tx) =>
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

  async function getHousehold(
    org: Org,
    householdId: string,
    communityId = org.communityId,
  ): Promise<HouseholdRow | null> {
    return withAppTransaction(app, { orgId: org.orgId, communityId }, async (tx) => {
      const rows = await tx<HouseholdRow[]>`
        select id::text as id, version, status, deleted_at, deleted_by::text as deleted_by, emergency_contacts
        from app.households
        where id = ${householdId}::uuid
      `;
      return rows[0] ?? null;
    });
  }

  async function countAllDenials(org: Org): Promise<number> {
    return withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        const rows = await tx<Array<{ count: string }>>`
        select count(*)::text as count
        from app.audit_events
        where action = 'people.permission.denied'
      `;
        return Number.parseInt(rows[0]?.count ?? "0", 10);
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

  async function householdAuditEvents(
    org: Org,
    communityId = org.communityId,
  ): Promise<Array<{ action: string; target_ids: string[] }>> {
    return withAppTransaction(app, { orgId: org.orgId, communityId }, async (tx) => {
      return tx<Array<{ action: string; target_ids: string[] }>>`
        select action, target_ids
        from app.audit_events
        where action like 'people.household.%'
        order by id desc
      `;
    });
  }

  async function readPrivileges(target: "households" | "purge") {
    if (target === "households") {
      const tablePrivileges = await migrator<
        Array<{ grantee: string; table_schema: string; table_name: string; privilege_type: string }>
      >`
        select grantee, table_schema, table_name, privilege_type
        from information_schema.table_privileges
        where table_schema = 'app' and table_name = 'households' and grantee = 'app'
        order by privilege_type
      `;
      const columnPrivileges = await migrator<
        Array<{
          grantee: string;
          table_schema: string;
          table_name: string;
          column_name: string;
          privilege_type: string;
        }>
      >`
        select grantee, table_schema, table_name, column_name, privilege_type
        from information_schema.column_privileges
        where table_schema = 'app' and table_name = 'households' and grantee = 'app'
        order by column_name, privilege_type
      `;
      return { tablePrivileges, columnPrivileges };
    }
    const routinePrivileges = await migrator<
      Array<{
        grantee: string;
        routine_schema: string;
        routine_name: string;
        privilege_type: string;
      }>
    >`
      select grantee, routine_schema, routine_name, privilege_type
      from information_schema.routine_privileges
      where routine_schema = 'app' and routine_name = 'purge_deleted_households' and grantee = 'app'
      order by privilege_type
    `;
    return { routinePrivileges };
  }

  it("the contract and domain relationship lists are equal", () => {
    expect(CONTRACT_RELATIONSHIPS).toEqual(DOMAIN_RELATIONSHIPS);
  });

  // Pin 66
  it("every family route answers 404 for another community's household id", async () => {
    const orgA = await createOrg("cross-comm-a");
    const comm2 = await addCommunityToOrg(orgA.orgId, "c2");

    // Families in second community of the SAME organization
    const familySameOrg = await createFamily(orgA, "SameOrgOtherComm", comm2.communityId);
    const hiddenSameOrg = await createFamily(orgA, "HiddenSameOrgOtherComm", comm2.communityId);
    const hiddenSameOrgRes = await hideFamily(
      orgA,
      hiddenSameOrg.householdId,
      hiddenSameOrg.version,
      comm2.communityId,
    );

    // Families in another organisation
    const orgB = await createOrg("cross-comm-b");
    const familyOtherOrg = await createFamily(orgB, "OtherOrg");
    const hiddenOtherOrg = await createFamily(orgB, "HiddenOtherOrg");
    const hiddenOtherOrgRes = await hideFamily(
      orgB,
      hiddenOtherOrg.householdId,
      hiddenOtherOrg.version,
    );

    const testTargets = [
      {
        label: "same organisation another community",
        org: orgA,
        commId: comm2.communityId,
        family: familySameOrg,
        hidden: { householdId: hiddenSameOrg.householdId, version: hiddenSameOrgRes.version },
      },
      {
        label: "another organisation",
        org: orgB,
        commId: orgB.communityId,
        family: familyOtherOrg,
        hidden: { householdId: hiddenOtherOrg.householdId, version: hiddenOtherOrgRes.version },
      },
    ];

    const beforeEventsA1 = await householdAuditEvents(orgA, orgA.communityId);
    const beforeEventsA2 = await householdAuditEvents(orgA, comm2.communityId);
    const beforeEventsB = await householdAuditEvents(orgB, orgB.communityId);

    for (const target of testTargets) {
      const routes = [
        {
          path: "/v1/households/status",
          body: {
            communitySlug: orgA.slug,
            householdId: target.family.householdId,
            version: target.family.version,
            status: "inactive",
          },
        },
        {
          path: "/v1/households/delete",
          body: {
            communitySlug: orgA.slug,
            householdId: target.family.householdId,
            version: target.family.version,
          },
        },
        {
          path: "/v1/households/restore",
          body: {
            communitySlug: orgA.slug,
            householdId: target.hidden.householdId,
            version: target.hidden.version,
          },
        },
        {
          path: "/v1/households/emergency-contacts/read",
          body: {
            communitySlug: orgA.slug,
            householdId: target.family.householdId,
          },
        },
        {
          path: "/v1/households/emergency-contacts/save",
          body: {
            communitySlug: orgA.slug,
            householdId: target.family.householdId,
            version: target.family.version,
            contacts: [],
          },
        },
      ];

      for (const r of routes) {
        const res = await post(r.path, r.body, orgA.owner.accessToken);
        expect(res.status, `expected 404 on ${r.path} for ${target.label}`).toBe(404);
        expect(await res.text()).toBe("");
        expect(res.headers.get("cache-control")).toContain("no-store");
      }
    }

    // Verify version, status, deleted_at and emergency_contacts are unchanged for each
    const sameOrgRow = await getHousehold(orgA, familySameOrg.householdId, comm2.communityId);
    expect(sameOrgRow?.version).toBe(familySameOrg.version);
    expect(sameOrgRow?.status).toBe("active");
    expect(sameOrgRow?.deleted_at).toBeNull();
    expect(sameOrgRow?.emergency_contacts).toBeNull();

    const sameOrgHiddenRow = await getHousehold(orgA, hiddenSameOrg.householdId, comm2.communityId);
    expect(sameOrgHiddenRow?.version).toBe(hiddenSameOrgRes.version);
    expect(sameOrgHiddenRow?.deleted_at).not.toBeNull();

    const otherOrgRow = await getHousehold(orgB, familyOtherOrg.householdId);
    expect(otherOrgRow?.version).toBe(familyOtherOrg.version);
    expect(otherOrgRow?.status).toBe("active");
    expect(otherOrgRow?.deleted_at).toBeNull();
    expect(otherOrgRow?.emergency_contacts).toBeNull();

    const otherOrgHiddenRow = await getHousehold(orgB, hiddenOtherOrg.householdId);
    expect(otherOrgHiddenRow?.version).toBe(hiddenOtherOrgRes.version);
    expect(otherOrgHiddenRow?.deleted_at).not.toBeNull();

    // Verify no new people.household.* event was written for them across all three communities
    const afterEventsA1 = await householdAuditEvents(orgA, orgA.communityId);
    const afterEventsA2 = await householdAuditEvents(orgA, comm2.communityId);
    const afterEventsB = await householdAuditEvents(orgB, orgB.communityId);
    expect(afterEventsA1).toEqual(beforeEventsA1);
    expect(afterEventsA2).toEqual(beforeEventsA2);
    expect(afterEventsB).toEqual(beforeEventsB);
  });

  // Pin 63, 63b, 63c
  it("each family route refuses each missing permission with its status and denial row", async () => {
    const org = await createOrg("perm-check");

    const cases = [
      // /v1/households/delete: people.view (people.person.view), people.delete (people.permission.denied), people.restricted.read (people.restricted.read)
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
        isRestore: false,
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
        isRestore: false,
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
        isRestore: false,
      },
      // /v1/households/restore: same keys as delete, uses hidden family
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
        isRestore: true,
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
        isRestore: true,
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
        isRestore: true,
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
        isRestore: false,
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
        isRestore: false,
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
        isRestore: false,
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
        isRestore: false,
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
        isRestore: false,
      },
    ];

    for (const c of cases) {
      const permissions = [
        ...c.allKeys.filter((k) => k !== c.missingKey),
        ...(c.extraGranted ?? []),
      ];
      const caller = await customCaller(org, permissions);

      let targetHouseholdId: string;
      let targetVersion: number;
      if (c.isRestore) {
        const family = await createFamily(org);
        const hidden = await hideFamily(org, family.householdId, family.version);
        targetHouseholdId = family.householdId;
        targetVersion = hidden.version;
      } else {
        const family = await createFamily(org);
        targetHouseholdId = family.householdId;
        targetVersion = family.version;
      }

      const beforeRow = await getHousehold(org, targetHouseholdId);
      const beforeTotalDenials = await countAllDenials(org);

      const res = await post(
        c.route,
        c.makeBody(targetHouseholdId, targetVersion),
        caller.accessToken,
      );

      expect(res.status, `expected 403 on ${c.route} missing ${c.missingKey}`).toBe(403);
      expect(await res.text()).toBe("");
      expect(res.headers.get("cache-control"), `expected no-store on ${c.route}`).toContain(
        "no-store",
      );

      const afterTotalDenials = await countAllDenials(org);
      expect(
        afterTotalDenials,
        `expected exactly one new denial row of ANY purpose on ${c.route} missing ${c.missingKey}`,
      ).toBe(beforeTotalDenials + 1);

      const denialsWithPurpose = await auditDenialRows(org, c.expectedPurpose);
      expect(denialsWithPurpose[0]!.action).toBe("people.permission.denied");
      expect(denialsWithPurpose[0]!.purpose).toBe(c.expectedPurpose);
      expect(denialsWithPurpose[0]!.target_ids).toEqual([org.orgId, org.communityId]);

      const afterRow = await getHousehold(org, targetHouseholdId);
      expect(afterRow?.version).toBe(beforeRow?.version);
      expect(afterRow?.status).toBe(beforeRow?.status);
      expect(afterRow?.deleted_at).toEqual(beforeRow?.deleted_at);
      expect(afterRow?.emergency_contacts).toEqual(beforeRow?.emergency_contacts);
    }
  });

  // Pin 64
  it("family list and read without people.view answer 403 with a denial row", async () => {
    const org = await createOrg("list-read-denial");
    const caller = await customCaller(org, ["people.manage"]); // has manage, no view
    const family = await createFamily(org);

    // List without people.view
    const listBefore = await countAllDenials(org);
    const listRes = await post(
      "/v1/households/list",
      { communitySlug: org.slug },
      caller.accessToken,
    );
    expect(listRes.status).toBe(403);
    expect(await listRes.text()).toBe("");
    const listAfter = await countAllDenials(org);
    expect(listAfter).toBe(listBefore + 1);

    const listDenials = await auditDenialRows(org, "people.person.view");
    expect(listDenials[0]!.action).toBe("people.permission.denied");
    expect(listDenials[0]!.purpose).toBe("people.person.view");
    expect(listDenials[0]!.target_ids).toEqual([org.orgId, org.communityId]);

    // Read without people.view
    const readBefore = await countAllDenials(org);
    const readRes = await post(
      "/v1/households/read",
      { communitySlug: org.slug, householdId: family.householdId },
      caller.accessToken,
    );
    expect(readRes.status).toBe(403);
    expect(await readRes.text()).toBe("");
    const readAfter = await countAllDenials(org);
    expect(readAfter).toBe(readBefore + 1);

    const readDenials = await auditDenialRows(org, "people.person.view");
    expect(readDenials[0]!.action).toBe("people.permission.denied");
    expect(readDenials[0]!.purpose).toBe("people.person.view");
    expect(readDenials[0]!.target_ids).toEqual([org.orgId, org.communityId]);
  });

  // Pin 65, 65b
  it("the deleted filter without all three keys answers 400 with a denial row", async () => {
    const org = await createOrg("deleted-filter-denial");

    // 1. Without people.view: 403 with exactly one people.person.view row
    const callerNoView = await customCaller(org, ["people.delete", "people.restricted.read"]);
    const beforeNoView = await countAllDenials(org);
    const resNoView = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "deleted" },
      callerNoView.accessToken,
    );
    expect(resNoView.status).toBe(403);
    expect(await resNoView.text()).toBe("");
    expect(resNoView.headers.get("cache-control")).toContain("no-store");

    const afterNoView = await countAllDenials(org);
    expect(afterNoView).toBe(beforeNoView + 1);
    const denialNoView = (await auditDenialRows(org, "people.person.view"))[0]!;
    expect(denialNoView.action).toBe("people.permission.denied");
    expect(denialNoView.purpose).toBe("people.person.view");

    // 2. Has people.view + people.restricted.read, but missing people.delete: 400 with purpose people.permission.denied
    const callerNoDelete = await customCaller(org, ["people.view", "people.restricted.read"]);
    const beforeNoDelete = await countAllDenials(org);
    const resNoDelete = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "deleted" },
      callerNoDelete.accessToken,
    );
    expect(resNoDelete.status).toBe(400);
    expect(await resNoDelete.text()).toBe("");
    expect(resNoDelete.headers.get("cache-control")).toContain("no-store");

    const afterNoDelete = await countAllDenials(org);
    expect(afterNoDelete).toBe(beforeNoDelete + 1);
    const denialNoDelete = (await auditDenialRows(org, "people.permission.denied"))[0]!;
    expect(denialNoDelete.action).toBe("people.permission.denied");
    expect(denialNoDelete.purpose).toBe("people.permission.denied");

    // 3. Has people.view + people.delete, but missing people.restricted.read: 400 with purpose people.permission.denied
    const callerNoRestricted = await customCaller(org, ["people.view", "people.delete"]);
    const beforeNoRestricted = await countAllDenials(org);
    const resNoRestricted = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "deleted" },
      callerNoRestricted.accessToken,
    );
    expect(resNoRestricted.status).toBe(400);
    expect(await resNoRestricted.text()).toBe("");
    expect(resNoRestricted.headers.get("cache-control")).toContain("no-store");

    const afterNoRestricted = await countAllDenials(org);
    expect(afterNoRestricted).toBe(beforeNoRestricted + 1);
    const denialNoRestricted = (await auditDenialRows(org, "people.permission.denied"))[0]!;
    expect(denialNoRestricted.action).toBe("people.permission.denied");
    expect(denialNoRestricted.purpose).toBe("people.permission.denied");

    // Assert no people.household.listed_deleted event was written in any of them
    const allListedDeleted = await withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        return tx`select * from app.audit_events where action = 'people.household.listed_deleted'`;
      },
    );
    expect(allListedDeleted.length).toBe(0);
  });

  // Pin 67, 67b, 67c
  it("every family route and the deleted list answer no-store, refusals included", async () => {
    const org = await createOrg("no-store-suite");
    const family = await createFamily(org);
    const hiddenFam = await createFamily(org, "HiddenNoStore");
    const hiddenRes = await hideFamily(org, hiddenFam.householdId, hiddenFam.version);
    const callerNoPerms = await customCaller(org, ["access.users.view"]);

    const routes = [
      {
        path: "/v1/households/status",
        validBody: {
          communitySlug: org.slug,
          householdId: family.householdId,
          version: family.version,
          status: "inactive",
        },
        isWrite: true,
      },
      {
        path: "/v1/households/delete",
        validBody: {
          communitySlug: org.slug,
          householdId: family.householdId,
          version: family.version,
        },
        isWrite: true,
      },
      {
        path: "/v1/households/restore",
        validBody: {
          communitySlug: org.slug,
          householdId: hiddenFam.householdId,
          version: hiddenRes.version,
        },
        isWrite: true,
      },
      {
        path: "/v1/households/emergency-contacts/read",
        validBody: { communitySlug: org.slug, householdId: family.householdId },
        isWrite: false,
      },
      {
        path: "/v1/households/emergency-contacts/save",
        validBody: {
          communitySlug: org.slug,
          householdId: family.householdId,
          version: family.version,
          contacts: [],
        },
        isWrite: true,
      },
    ];

    // Loop over each of the five routes
    for (const r of routes) {
      // 400 bad body
      const resBad = await post(r.path, { bad: "body" }, org.owner.accessToken);
      expect(resBad.status, `expected 400 on ${r.path}`).toBe(400);
      expect(resBad.headers.get("cache-control")).toContain("no-store");

      // 401 unauthenticated
      const res401 = await post(r.path, r.validBody);
      expect(res401.status, `expected 401 on ${r.path}`).toBe(401);
      expect(res401.headers.get("cache-control")).toContain("no-store");

      // 404 foreign host
      const resForeign = await post(
        r.path,
        r.validBody,
        org.owner.accessToken,
        "auth.au.example.test",
      );
      expect(resForeign.status, `expected 404 on ${r.path} foreign host`).toBe(404);
      expect(resForeign.headers.get("cache-control")).toContain("no-store");

      // 403 missing permission
      const res403 = await post(r.path, r.validBody, callerNoPerms.accessToken);
      expect(res403.status, `expected 403 on ${r.path}`).toBe(403);
      expect(res403.headers.get("cache-control")).toContain("no-store");

      // 404 unknown household id
      const resUnknownId = await post(
        r.path,
        { ...r.validBody, householdId: newId() },
        org.owner.accessToken,
      );
      expect(resUnknownId.status, `expected 404 on ${r.path} unknown id`).toBe(404);
      expect(resUnknownId.headers.get("cache-control")).toContain("no-store");

      // unknown community slug
      const resUnknownSlug = await post(
        r.path,
        { ...r.validBody, communitySlug: "unknown-slug-xyz" },
        org.owner.accessToken,
      );
      expect(resUnknownSlug.status, `expected 403 on ${r.path} unknown slug`).toBe(403);
      expect(await resUnknownSlug.text()).toBe("");
      expect(resUnknownSlug.headers.get("cache-control")).toContain("no-store");
    }

    // 409 conflict on the four writes
    for (const r of routes.filter((x) => x.isWrite)) {
      const res409 = await post(r.path, { ...r.validBody, version: 999 }, org.owner.accessToken);
      expect(res409.status, `expected 409 on ${r.path}`).toBe(409);
      expect(res409.headers.get("cache-control")).toContain("no-store");
    }

    // Billing refusal on the four writes in a read-only community
    const orgRo = await createOrg("ro-no-store", { billing: "read_only" });
    const famRo = await createFamily(orgRo);
    const rowRoBefore = await getHousehold(orgRo, famRo.householdId);
    for (const r of routes.filter((x) => x.isWrite)) {
      const resRo = await post(
        r.path,
        { ...r.validBody, communitySlug: orgRo.slug, householdId: famRo.householdId },
        orgRo.owner.accessToken,
      );
      expect(resRo.status, `expected 402 on ${r.path} in read-only`).toBe(402);
      expect(resRo.headers.get("cache-control")).toContain("no-store");
    }
    const rowRoAfter = await getHousehold(orgRo, famRo.householdId);
    expect(rowRoAfter).toEqual(rowRoBefore);

    // Entitlement refusal with people.households off on all five
    const orgNoHouseholds = await createOrg("no-hh-ent", { entitlements: ["people.directory"] });
    for (const r of routes) {
      const resEnt = await post(
        r.path,
        { ...r.validBody, communitySlug: orgNoHouseholds.slug },
        orgNoHouseholds.owner.accessToken,
      );
      expect(resEnt.status, `expected 403 on ${r.path} with households entitlement off`).toBe(403);
      expect(resEnt.headers.get("cache-control")).toContain("no-store");
    }

    // Deleted list with 401, entitlement off, unknown community slug and 500
    // 401
    const del401 = await post("/v1/households/list", {
      communitySlug: org.slug,
      status: "deleted",
    });
    expect(del401.status).toBe(401);
    expect(del401.headers.get("cache-control")).toContain("no-store");

    // Entitlement off
    const delEntOff = await post(
      "/v1/households/list",
      { communitySlug: orgNoHouseholds.slug, status: "deleted" },
      orgNoHouseholds.owner.accessToken,
    );
    expect(delEntOff.status).toBe(403);
    expect(delEntOff.headers.get("cache-control")).toContain("no-store");

    // Unknown community slug
    const delUnknownSlug = await post(
      "/v1/households/list",
      { communitySlug: "unknown-slug-xyz", status: "deleted" },
      org.owner.accessToken,
    );
    expect(delUnknownSlug.status).toBe(403);
    expect(await delUnknownSlug.text()).toBe("");
    expect(delUnknownSlug.headers.get("cache-control")).toContain("no-store");

    // 500 by temporary revoke of SELECT on app.households from app
    const privsBeforeSelect = await readPrivileges("households");
    await migrator`revoke select on app.households from app`;
    try {
      const del500 = await post(
        "/v1/households/list",
        { communitySlug: org.slug, status: "deleted" },
        org.owner.accessToken,
      );
      expect(del500.status).toBe(500);
      expect(await del500.text()).toBe("");
      expect(del500.headers.get("cache-control")).toContain("no-store");
    } finally {
      await migrator`grant select on app.households to app`;
    }
    const privsAfterSelect = await readPrivileges("households");
    expect(privsAfterSelect).toEqual(privsBeforeSelect);
  });

  // Pin 68
  it("the family sweep does not run in a read-only community", async () => {
    const org = await createOrg("sweep-ro", { billing: "read_only" });
    const family = await createFamily(org);

    // Age an existing family past 720 hours
    const agedFam = await createFamily(org, "AgedRoFamily");
    await ageFamily(org, agedFam.householdId, 721);

    const rowBefore = await getHousehold(org, family.householdId);

    // The four writes are refused and change nothing
    const resStatus = await post(
      "/v1/households/status",
      {
        communitySlug: org.slug,
        householdId: family.householdId,
        version: family.version,
        status: "inactive",
      },
      org.owner.accessToken,
    );
    expect(resStatus.status).toBe(402);

    const resDel = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: family.householdId, version: family.version },
      org.owner.accessToken,
    );
    expect(resDel.status).toBe(402);

    const resRestore = await post(
      "/v1/households/restore",
      { communitySlug: org.slug, householdId: family.householdId, version: family.version },
      org.owner.accessToken,
    );
    expect(resRestore.status).toBe(402);

    const resEcSave = await post(
      "/v1/households/emergency-contacts/save",
      {
        communitySlug: org.slug,
        householdId: family.householdId,
        version: family.version,
        contacts: [],
      },
      org.owner.accessToken,
    );
    expect(resEcSave.status).toBe(402);

    const rowAfter = await getHousehold(org, family.householdId);
    expect(rowAfter).toEqual(rowBefore);

    // Emergency contacts read and list answer 200
    const resEcRead = await post(
      "/v1/households/emergency-contacts/read",
      { communitySlug: org.slug, householdId: family.householdId },
      org.owner.accessToken,
    );
    expect(resEcRead.status).toBe(200);

    const resList = await post(
      "/v1/households/list",
      { communitySlug: org.slug },
      org.owner.accessToken,
    );
    expect(resList.status).toBe(200);

    // The sweep does not run: aged family is still present
    const agedRow = await getHousehold(org, agedFam.householdId);
    expect(agedRow).not.toBeNull();
    expect(agedRow?.deleted_at).not.toBeNull();
  });

  it("stale version on delete, restore, status and save answers 409 with an empty body", async () => {
    const org = await createOrg("stale-ver");
    const family = await createFamily(org);
    const hiddenFam = await createFamily(org, "HiddenStale");
    const hiddenRes = await hideFamily(org, hiddenFam.householdId, hiddenFam.version);

    const beforeFam = await getHousehold(org, family.householdId);
    const beforeHidden = await getHousehold(org, hiddenFam.householdId);

    // 1. Delete with stale version
    const delStale = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: family.householdId, version: 999 },
      org.owner.accessToken,
    );
    expect(delStale.status).toBe(409);
    expect(await delStale.text()).toBe("");

    // 2. Restore with stale version
    const resRestoreStale = await post(
      "/v1/households/restore",
      {
        communitySlug: org.slug,
        householdId: hiddenFam.householdId,
        version: hiddenRes.version + 10,
      },
      org.owner.accessToken,
    );
    expect(resRestoreStale.status).toBe(409);
    expect(await resRestoreStale.text()).toBe("");

    // 3. Status with stale version
    const resStatusStale = await post(
      "/v1/households/status",
      {
        communitySlug: org.slug,
        householdId: family.householdId,
        version: 999,
        status: "inactive",
      },
      org.owner.accessToken,
    );
    expect(resStatusStale.status).toBe(409);
    expect(await resStatusStale.text()).toBe("");

    // 4. Emergency contacts save with stale version
    const resEcStale = await post(
      "/v1/households/emergency-contacts/save",
      { communitySlug: org.slug, householdId: family.householdId, version: 999, contacts: [] },
      org.owner.accessToken,
    );
    expect(resEcStale.status).toBe(409);
    expect(await resEcStale.text()).toBe("");

    // Check nothing changed
    const afterFam = await getHousehold(org, family.householdId);
    expect(afterFam).toEqual(beforeFam);

    const afterHidden = await getHousehold(org, hiddenFam.householdId);
    expect(afterHidden).toEqual(beforeHidden);
  });

  it("household list active, inactive and none filters return the right families with status and parse", async () => {
    const org = await createOrg("list-status-filters");
    const activeFam = await createFamily(org, "Active Family");
    const inactiveFam = await createFamily(org, "Inactive Family");

    // Transition inactiveFam to inactive
    const statusRes = await post(
      "/v1/households/status",
      {
        communitySlug: org.slug,
        householdId: inactiveFam.householdId,
        version: inactiveFam.version,
        status: "inactive",
      },
      org.owner.accessToken,
    );
    expect(statusRes.status).toBe(200);

    // 1. Filter: "active"
    const resActive = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "active" },
      org.owner.accessToken,
    );
    expect(resActive.status).toBe(200);
    const bodyActive = await resActive.json();
    expect(listHouseholdsResponse.safeParse(bodyActive).success).toBe(true);
    const parsedActive = listHouseholdsResponse.parse(bodyActive);
    expect(parsedActive.items.some((i) => i.householdId === activeFam.householdId)).toBe(true);
    expect(parsedActive.items.some((i) => i.householdId === inactiveFam.householdId)).toBe(false);
    expect(parsedActive.items.find((i) => i.householdId === activeFam.householdId)?.status).toBe(
      "active",
    );

    // 2. Filter: "inactive"
    const resInactive = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "inactive" },
      org.owner.accessToken,
    );
    expect(resInactive.status).toBe(200);
    const bodyInactive = await resInactive.json();
    expect(listHouseholdsResponse.safeParse(bodyInactive).success).toBe(true);
    const parsedInactive = listHouseholdsResponse.parse(bodyInactive);
    expect(parsedInactive.items.some((i) => i.householdId === activeFam.householdId)).toBe(false);
    expect(parsedInactive.items.some((i) => i.householdId === inactiveFam.householdId)).toBe(true);
    expect(
      parsedInactive.items.find((i) => i.householdId === inactiveFam.householdId)?.status,
    ).toBe("inactive");

    // 3. Filter: none (all)
    const resAll = await post(
      "/v1/households/list",
      { communitySlug: org.slug },
      org.owner.accessToken,
    );
    expect(resAll.status).toBe(200);
    const bodyAll = await resAll.json();
    expect(listHouseholdsResponse.safeParse(bodyAll).success).toBe(true);
    const parsedAll = listHouseholdsResponse.parse(bodyAll);
    expect(parsedAll.items.some((i) => i.householdId === activeFam.householdId)).toBe(true);
    expect(parsedAll.items.some((i) => i.householdId === inactiveFam.householdId)).toBe(true);

    // Detail reads parse strictly with readHouseholdResponse
    const readActive = await post(
      "/v1/households/read",
      { communitySlug: org.slug, householdId: activeFam.householdId },
      org.owner.accessToken,
    );
    expect(readActive.status).toBe(200);
    const bodyReadActive = await readActive.json();
    expect(readHouseholdResponse.safeParse(bodyReadActive).success).toBe(true);
    expect(readHouseholdResponse.parse(bodyReadActive).status).toBe("active");

    const readInactive = await post(
      "/v1/households/read",
      { communitySlug: org.slug, householdId: inactiveFam.householdId },
      org.owner.accessToken,
    );
    expect(readInactive.status).toBe(200);
    const bodyReadInactive = await readInactive.json();
    expect(readHouseholdResponse.safeParse(bodyReadInactive).success).toBe(true);
    expect(readHouseholdResponse.parse(bodyReadInactive).status).toBe("inactive");
  });

  it("deleted households list returns exact items, pages and writes audit event", async () => {
    const org = await createOrg("del-list-pages");
    const comm2 = await addCommunityToOrg(org.orgId, "c2-del");

    // Create 3 hidden families in org.communityId
    const f1 = await createFamily(org, "Deleted Family 1");
    await createAdultMember(org, f1.householdId, "AdultOne");
    await hideFamily(org, f1.householdId, f1.version);
    await ageFamily(org, f1.householdId, 30);

    const f2 = await createFamily(org, "Deleted Family 2");
    await createAdultMember(org, f2.householdId, "AdultTwoA");
    await createAdultMember(org, f2.householdId, "AdultTwoB");
    await hideFamily(org, f2.householdId, f2.version);
    await ageFamily(org, f2.householdId, 20);

    const f3 = await createFamily(org, "Deleted Family 3");
    await hideFamily(org, f3.householdId, f3.version);
    await ageFamily(org, f3.householdId, 10);

    // Create a hidden family in comm2 (must NOT be in org.communityId's list)
    const fComm2 = await createFamily(org, "ForeignDeleted", comm2.communityId);
    await hideFamily(org, fComm2.householdId, fComm2.version, comm2.communityId);

    // Read the exact rows as recorded in the database
    const rowF1 = await withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        const [r] = await tx<
          Array<{ id: string; version: number; deleted_at: Date; purge_after: Date }>
        >`
          select id::text as id, version, deleted_at, (deleted_at + interval '720 hours') as purge_after
          from app.households where id = ${f1.householdId}::uuid
        `;
        return r!;
      },
    );
    const rowF2 = await withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        const [r] = await tx<
          Array<{ id: string; version: number; deleted_at: Date; purge_after: Date }>
        >`
          select id::text as id, version, deleted_at, (deleted_at + interval '720 hours') as purge_after
          from app.households where id = ${f2.householdId}::uuid
        `;
        return r!;
      },
    );
    const rowF3 = await withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        const [r] = await tx<
          Array<{ id: string; version: number; deleted_at: Date; purge_after: Date }>
        >`
          select id::text as id, version, deleted_at, (deleted_at + interval '720 hours') as purge_after
          from app.households where id = ${f3.householdId}::uuid
        `;
        return r!;
      },
    );

    // Page 1 (limit 1): newest deletedAt first is f3
    const resP1 = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "deleted", limit: 1 },
      org.owner.accessToken,
    );
    expect(resP1.status).toBe(200);
    const bodyP1 = deletedHouseholdsListResponse.parse(await resP1.json());
    expect(bodyP1.items).toEqual([
      {
        householdId: f3.householdId,
        label: "Deleted Family 3",
        adultCount: 0,
        version: rowF3.version,
        deletedAt: rowF3.deleted_at.toISOString(),
        purgeAfter: rowF3.purge_after.toISOString(),
      },
    ]);
    expect(bodyP1.nextCursor).not.toBeNull();

    // Page 2 (limit 1): next is f2
    const resP2 = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "deleted", limit: 1, cursor: bodyP1.nextCursor! },
      org.owner.accessToken,
    );
    expect(resP2.status).toBe(200);
    const bodyP2 = deletedHouseholdsListResponse.parse(await resP2.json());
    expect(bodyP2.items).toEqual([
      {
        householdId: f2.householdId,
        label: "Deleted Family 2",
        adultCount: 2,
        version: rowF2.version,
        deletedAt: rowF2.deleted_at.toISOString(),
        purgeAfter: rowF2.purge_after.toISOString(),
      },
    ]);
    expect(bodyP2.nextCursor).not.toBeNull();

    // Page 3 (limit 1): oldest is f1, nextCursor null on the last page
    const resP3 = await post(
      "/v1/households/list",
      { communitySlug: org.slug, status: "deleted", limit: 1, cursor: bodyP2.nextCursor! },
      org.owner.accessToken,
    );
    expect(resP3.status).toBe(200);
    const bodyP3 = deletedHouseholdsListResponse.parse(await resP3.json());
    expect(bodyP3.items).toEqual([
      {
        householdId: f1.householdId,
        label: "Deleted Family 1",
        adultCount: 1,
        version: rowF1.version,
        deletedAt: rowF1.deleted_at.toISOString(),
        purgeAfter: rowF1.purge_after.toISOString(),
      },
    ]);
    expect(bodyP3.nextCursor).toBeNull();

    // Verify all 3 returned with no duplicate and no gap
    const allIds = [
      bodyP1.items[0]!.householdId,
      bodyP2.items[0]!.householdId,
      bodyP3.items[0]!.householdId,
    ];
    expect(new Set(allIds).size).toBe(3);
    expect(allIds).toContain(f1.householdId);
    expect(allIds).toContain(f2.householdId);
    expect(allIds).toContain(f3.householdId);
    expect(allIds).not.toContain(fComm2.householdId);

    // Validate exact items fields and 720 hours purgeAfter calculation
    for (const item of [...bodyP1.items, ...bodyP2.items, ...bodyP3.items]) {
      expect(item.householdId).toBeDefined();
      expect(typeof item.version).toBe("number");
      expect(typeof item.adultCount).toBe("number");
      // ISO string check
      expect(new Date(item.deletedAt).toISOString()).toBe(item.deletedAt);
      expect(new Date(item.purgeAfter).toISOString()).toBe(item.purgeAfter);
      // purgeAfter 720 hours after deletedAt
      const diffMs = new Date(item.purgeAfter).getTime() - new Date(item.deletedAt).getTime();
      expect(diffMs).toBe(HOURS_720_MS);
    }

    // Adult counts match
    const itemF1 = [...bodyP1.items, ...bodyP2.items, ...bodyP3.items].find(
      (i) => i.householdId === f1.householdId,
    );
    expect(itemF1?.adultCount).toBe(1);
    const itemF2 = [...bodyP1.items, ...bodyP2.items, ...bodyP3.items].find(
      (i) => i.householdId === f2.householdId,
    );
    expect(itemF2?.adultCount).toBe(2);
    const itemF3 = [...bodyP1.items, ...bodyP2.items, ...bodyP3.items].find(
      (i) => i.householdId === f3.householdId,
    );
    expect(itemF3?.adultCount).toBe(0);

    // Verify people.household.listed_deleted events
    const listedEvents = await withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        return tx<Array<{ id: string }>>`
          select id::text as id from app.audit_events where action = 'people.household.listed_deleted'
        `;
      },
    );
    // 3 calls made above = exactly 3 events
    expect(listedEvents).toHaveLength(3);

    // Empty page check: also writes exactly one people.household.listed_deleted event
    const emptyOrg = await createOrg("empty-del-list");
    const emptyRes = await post(
      "/v1/households/list",
      { communitySlug: emptyOrg.slug, status: "deleted" },
      emptyOrg.owner.accessToken,
    );
    expect(emptyRes.status).toBe(200);
    const emptyBody = deletedHouseholdsListResponse.parse(await emptyRes.json());
    expect(emptyBody.items).toHaveLength(0);

    const emptyListedEvents = await withAppTransaction(
      app,
      { orgId: emptyOrg.orgId, communityId: emptyOrg.communityId },
      async (tx) => {
        return tx<Array<{ id: string }>>`
          select id::text as id from app.audit_events where action = 'people.household.listed_deleted'
        `;
      },
    );
    expect(emptyListedEvents).toHaveLength(1);
  });

  // Pin 85, 85b, 85c
  it("a family past 720 hours is purged after a list, a delete and a restore", async () => {
    const org = await createOrg("sweep-triggers");

    // Helper to fetch purged events
    async function purgedEvents(): Promise<
      Array<{ action: string; actor_kind: string; target_ids: string[] }>
    > {
      return withAppTransaction(
        app,
        { orgId: org.orgId, communityId: org.communityId },
        async (tx) => {
          return tx<Array<{ action: string; actor_kind: string; target_ids: string[] }>>`
          select action, actor_kind, target_ids
          from app.audit_events
          where action = 'people.household.purged'
          order by id desc
        `;
        },
      );
    }

    // 1. Sweep after list
    const f1 = await createFamily(org, "PurgeFamilyList");
    await ageFamily(org, f1.householdId, 721);

    const resList = await post(
      "/v1/households/list",
      { communitySlug: org.slug },
      org.owner.accessToken,
    );
    expect(resList.status).toBe(200);

    const row1 = await getHousehold(org, f1.householdId);
    expect(row1).toBeNull(); // Purged!

    const eventsAfterList = await purgedEvents();
    expect(eventsAfterList).toHaveLength(1);
    expect(eventsAfterList[0]!.actor_kind).toBe("system");
    expect(eventsAfterList[0]!.target_ids).toEqual([f1.householdId]);

    // 2. Sweep after delete
    const f2 = await createFamily(org, "PurgeFamilyDelete");
    await ageFamily(org, f2.householdId, 721);

    const fActive = await createFamily(org, "ActiveToDelete");
    const resDel = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: fActive.householdId, version: fActive.version },
      org.owner.accessToken,
    );
    expect(resDel.status).toBe(200);

    const row2 = await getHousehold(org, f2.householdId);
    expect(row2).toBeNull(); // Purged!

    const eventsAfterDel = await purgedEvents();
    expect(eventsAfterDel).toHaveLength(2);
    expect(eventsAfterDel[0]!.actor_kind).toBe("system");
    expect(eventsAfterDel[0]!.target_ids).toEqual([f2.householdId]);

    // 3. Sweep after restore
    const f3 = await createFamily(org, "PurgeFamilyRestore");
    await ageFamily(org, f3.householdId, 721);

    const fHiddenToRestore = await createFamily(org, "HiddenToRestore");
    const hiddenRes = await hideFamily(org, fHiddenToRestore.householdId, fHiddenToRestore.version);

    const resRestore = await post(
      "/v1/households/restore",
      {
        communitySlug: org.slug,
        householdId: fHiddenToRestore.householdId,
        version: hiddenRes.version,
      },
      org.owner.accessToken,
    );
    expect(resRestore.status).toBe(200);

    const row3 = await getHousehold(org, f3.householdId);
    expect(row3).toBeNull(); // Purged!

    const eventsAfterRestore = await purgedEvents();
    expect(eventsAfterRestore).toHaveLength(3);
    expect(eventsAfterRestore[0]!.actor_kind).toBe("system");
    expect(eventsAfterRestore[0]!.target_ids).toEqual([f3.householdId]);

    // Add: the sweep does NOT run after status, emergency contacts read, and emergency contacts save
    const fNoSweep = await createFamily(org, "NoSweepFamily");
    await ageFamily(org, fNoSweep.householdId, 721);

    const famForWrites = await createFamily(org, "FamForWrites");

    // After status
    const resStatus = await post(
      "/v1/households/status",
      {
        communitySlug: org.slug,
        householdId: famForWrites.householdId,
        version: famForWrites.version,
        status: "inactive",
      },
      org.owner.accessToken,
    );
    expect(resStatus.status).toBe(200);
    expect(await getHousehold(org, fNoSweep.householdId)).not.toBeNull();
    expect(await purgedEvents()).toHaveLength(3);

    // After emergency contacts read
    const resEcRead = await post(
      "/v1/households/emergency-contacts/read",
      { communitySlug: org.slug, householdId: famForWrites.householdId },
      org.owner.accessToken,
    );
    expect(resEcRead.status).toBe(200);
    expect(await getHousehold(org, fNoSweep.householdId)).not.toBeNull();
    expect(await purgedEvents()).toHaveLength(3);

    // After emergency contacts save
    const resEcSave = await post(
      "/v1/households/emergency-contacts/save",
      { communitySlug: org.slug, householdId: famForWrites.householdId, version: 2, contacts: [] },
      org.owner.accessToken,
    );
    expect(resEcSave.status).toBe(200);
    expect(await getHousehold(org, fNoSweep.householdId)).not.toBeNull();
    expect(await purgedEvents()).toHaveLength(3);
  });

  // Pin 69b
  it("the family sweep does not run after a refusal", async () => {
    const org = await createOrg("sweep-refusal");
    const familyToPurge = await createFamily(org);
    await ageFamily(org, familyToPurge.householdId, 721);

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

  // Pin 69
  it("a failing family sweep does not change the answer and logs the class only", async () => {
    const org = await createOrg("sweep-fail");
    const family = await createFamily(org);
    await ageFamily(org, family.householdId, 721);

    // Revoke EXECUTE on app.purge_deleted_households from app to force sweep failure
    const privsBeforePurge = await readPrivileges("purge");
    await migrator`revoke execute on function app.purge_deleted_households(integer) from app`;
    try {
      // 1. Run for list
      capturedLogs.length = 0;
      const listRes = await post(
        "/v1/households/list",
        { communitySlug: org.slug },
        org.owner.accessToken,
      );
      expect(listRes.status).toBe(200);

      const listFailLog = capturedLogs.filter((l) => l.message === "family_sweep_failed");
      expect(listFailLog).toHaveLength(1);
      expect(listFailLog[0]!.fields).toEqual({
        errorClass: expect.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
        path: "/v1/households/list",
      });

      // 2. Run for delete
      capturedLogs.length = 0;
      const fToDel = await createFamily(org, "ToDelSweepFail");
      const delRes = await post(
        "/v1/households/delete",
        { communitySlug: org.slug, householdId: fToDel.householdId, version: fToDel.version },
        org.owner.accessToken,
      );
      expect(delRes.status).toBe(200);

      const delFailLog = capturedLogs.filter((l) => l.message === "family_sweep_failed");
      expect(delFailLog).toHaveLength(1);
      expect(delFailLog[0]!.fields).toEqual({
        errorClass: expect.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
        path: "/v1/households/delete",
      });

      // 3. Run for restore
      capturedLogs.length = 0;
      const fToRestore = await createFamily(org, "ToRestoreSweepFail");
      const hToRestore = await hideFamily(org, fToRestore.householdId, fToRestore.version);
      const restoreRes = await post(
        "/v1/households/restore",
        {
          communitySlug: org.slug,
          householdId: fToRestore.householdId,
          version: hToRestore.version,
        },
        org.owner.accessToken,
      );
      expect(restoreRes.status).toBe(200);

      const restoreFailLog = capturedLogs.filter((l) => l.message === "family_sweep_failed");
      expect(restoreFailLog).toHaveLength(1);
      expect(restoreFailLog[0]!.fields).toEqual({
        errorClass: expect.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
        path: "/v1/households/restore",
      });

      // Assert the audit table has no purged event
      const purgedEvents = await withAppTransaction(
        app,
        { orgId: org.orgId, communityId: org.communityId },
        async (tx) => {
          return tx`select * from app.audit_events where action = 'people.household.purged'`;
        },
      );
      expect(purgedEvents).toHaveLength(0);

      // The aged family is still there
      const row = await getHousehold(org, family.householdId);
      expect(row).not.toBeNull();
    } finally {
      await migrator`grant execute on function app.purge_deleted_households(integer) to app`;
    }
    const privsAfterPurge = await readPrivileges("purge");
    expect(privsAfterPurge).toEqual(privsBeforePurge);
  });

  // Pin 86
  it("no emergency contact value reaches a log or an audit row", async () => {
    const org = await createOrg("no-leak");
    const family = await createFamily(org, "UniqueLabelFamily");

    capturedLogs.length = 0;

    const contactName = "UniqueSecretContactName";
    const contactPhone = "+61 411 555 789";
    const contactPhoneClean = "+61411555789";
    const contactPhoneDigits = "61411555789";

    // 1. Save contact (200)
    const saveRes = await post(
      "/v1/households/emergency-contacts/save",
      {
        communitySlug: org.slug,
        householdId: family.householdId,
        version: family.version,
        contacts: [{ name: contactName, phone: contactPhone, relationship: "spouse" }],
      },
      org.owner.accessToken,
    );
    expect(saveRes.status).toBe(200);

    // 2. Read contact (200)
    const readRes = await post(
      "/v1/households/emergency-contacts/read",
      { communitySlug: org.slug, householdId: family.householdId },
      org.owner.accessToken,
    );
    expect(readRes.status).toBe(200);

    // 3. Failing save (409 conflict)
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
    expect(await failRes.text()).toBe("");

    // 4. Save that fails with 500 (temporary revoke of UPDATE on emergency_contacts from app)
    const privsBeforeUpdate = await readPrivileges("households");
    await migrator`revoke update (emergency_contacts) on app.households from app`;
    try {
      const fail500Res = await post(
        "/v1/households/emergency-contacts/save",
        {
          communitySlug: org.slug,
          householdId: family.householdId,
          version: 2,
          contacts: [{ name: contactName, phone: contactPhone, relationship: "spouse" }],
        },
        org.owner.accessToken,
      );
      expect(fail500Res.status).toBe(500);
      expect(await fail500Res.text()).toBe("");
      expect(fail500Res.headers.get("cache-control")).toContain("no-store");
    } finally {
      await migrator`grant update (emergency_contacts) on app.households to app`;
    }
    const privsAfterUpdate = await readPrivileges("households");
    expect(privsAfterUpdate).toEqual(privsBeforeUpdate);

    // Verify logs
    expect(capturedLogs.length).toBeGreaterThan(0);
    const logDump = JSON.stringify(capturedLogs);
    expect(logDump).not.toContain(contactName);
    expect(logDump).not.toContain(contactPhone);
    expect(logDump).not.toContain(contactPhoneClean);
    expect(logDump).not.toContain(contactPhoneDigits);
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
    expect(auditDump).not.toContain(contactPhoneDigits);
    expect(auditDump).not.toContain("UniqueLabelFamily");
  });

  it("emergency contacts save refuses invalid input with 400 and changes nothing", async () => {
    const org = await createOrg("ec-invalid-save");
    const family = await createFamily(org);

    const beforeRow = await getHousehold(org, family.householdId);

    // 1. Unknown relationship
    const resBadRel = await post(
      "/v1/households/emergency-contacts/save",
      {
        communitySlug: org.slug,
        householdId: family.householdId,
        version: family.version,
        contacts: [{ name: "Alice", phone: "+61 411 555 111", relationship: "invalid_rel" }],
      },
      org.owner.accessToken,
    );
    expect(resBadRel.status).toBe(400);
    expect(await resBadRel.text()).toBe("");
    expect(resBadRel.headers.get("cache-control")).toContain("no-store");

    // 2. Sixth contact
    const sixContacts = Array.from({ length: 6 }, (_, i) => ({
      name: `Contact ${i + 1}`,
      phone: `+61 411 555 10${i}`,
      relationship: "friend",
    }));
    const resSixth = await post(
      "/v1/households/emergency-contacts/save",
      {
        communitySlug: org.slug,
        householdId: family.householdId,
        version: family.version,
        contacts: sixContacts,
      },
      org.owner.accessToken,
    );
    expect(resSixth.status).toBe(400);
    expect(await resSixth.text()).toBe("");
    expect(resSixth.headers.get("cache-control")).toContain("no-store");

    // 3. Bad phone
    const resBadPhone = await post(
      "/v1/households/emergency-contacts/save",
      {
        communitySlug: org.slug,
        householdId: family.householdId,
        version: family.version,
        contacts: [{ name: "Alice", phone: "12345", relationship: "friend" }],
      },
      org.owner.accessToken,
    );
    expect(resBadPhone.status).toBe(400);
    expect(await resBadPhone.text()).toBe("");
    expect(resBadPhone.headers.get("cache-control")).toContain("no-store");

    // 4. Empty name
    const resEmptyName = await post(
      "/v1/households/emergency-contacts/save",
      {
        communitySlug: org.slug,
        householdId: family.householdId,
        version: family.version,
        contacts: [{ name: "   ", phone: "+61 411 555 111", relationship: "friend" }],
      },
      org.owner.accessToken,
    );
    expect(resEmptyName.status).toBe(400);
    expect(await resEmptyName.text()).toBe("");
    expect(resEmptyName.headers.get("cache-control")).toContain("no-store");

    // Verify nothing changed
    const afterRow = await getHousehold(org, family.householdId);
    expect(afterRow).toEqual(beforeRow);
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
    await withAppTransaction(
      migrator,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
        await tx`
        insert into app.persons (
          id, org_id, community_id, household_id, is_minor, age_basis,
          given_name_restricted, family_name_restricted, version, created_at
        ) values (
          ${newId()}::uuid, ${org.orgId}::uuid, ${org.communityId}::uuid, ${fUnknown.householdId}::uuid,
          true, 'unknown', '\\x01'::bytea, '\\x01'::bytea, 1, now()
        )
      `;
        await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
      },
    );

    const delUnknownRes = await post(
      "/v1/households/delete",
      { communitySlug: org.slug, householdId: fUnknown.householdId, version: 1 },
      org.owner.accessToken,
    );
    expect(delUnknownRes.status).toBe(409);
    expect(await delUnknownRes.json()).toEqual({ code: "household_has_children" });

    // 3. Restore cutoff: 719h works, 721h answers 404
    const f719 = await createFamily(org);
    await ageFamily(org, f719.householdId, 719);
    const res719 = await post(
      "/v1/households/restore",
      { communitySlug: org.slug, householdId: f719.householdId, version: 1 },
      org.owner.accessToken,
    );
    expect(res719.status).toBe(200);

    const f721 = await createFamily(org);
    await ageFamily(org, f721.householdId, 721);
    const res721 = await post(
      "/v1/households/restore",
      { communitySlug: org.slug, householdId: f721.householdId, version: 1 },
      org.owner.accessToken,
    );
    expect(res721.status).toBe(404);

    // 4. Hidden family is 404 on reads and writes
    const fHidden = await createFamily(org);
    await hideFamily(org, fHidden.householdId, fHidden.version);

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

  it("the family tests leave the app role's household grants as the migrations set them", async () => {
    // app has UPDATE on exactly the six columns (deleted_at, deleted_by, emergency_contacts, label, status, version)
    const updatableColumns = await migrator<Array<{ column_name: string }>>`
      select column_name
      from information_schema.column_privileges
      where table_schema = 'app'
        and table_name = 'households'
        and grantee = 'app'
        and privilege_type = 'UPDATE'
      order by column_name
    `;
    const sixColumns = [
      "deleted_at",
      "deleted_by",
      "emergency_contacts",
      "label",
      "status",
      "version",
    ].sort();
    expect(updatableColumns.map((c) => c.column_name).sort()).toEqual(sixColumns);

    // No table-level UPDATE
    const tableUpdate = await migrator<Array<{ privilege_type: string }>>`
      select privilege_type
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'households'
        and grantee = 'app'
        and privilege_type = 'UPDATE'
    `;
    expect(tableUpdate).toHaveLength(0);
    const [tableUpdatePriv] = await migrator<{ has: boolean }[]>`
      select has_table_privilege('app', 'app.households', 'UPDATE') as has
    `;
    expect(tableUpdatePriv?.has).toBe(false);

    // No DELETE
    const tableDelete = await migrator<Array<{ privilege_type: string }>>`
      select privilege_type
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'households'
        and grantee = 'app'
        and privilege_type = 'DELETE'
    `;
    expect(tableDelete).toHaveLength(0);
    const [tableDeletePriv] = await migrator<{ has: boolean }[]>`
      select has_table_privilege('app', 'app.households', 'DELETE') as has
    `;
    expect(tableDeletePriv?.has).toBe(false);

    // EXECUTE on app.purge_deleted_households for app
    const [appExecute] = await migrator<{ has: boolean }[]>`
      select has_function_privilege('app', 'app.purge_deleted_households(integer)', 'EXECUTE') as has
    `;
    expect(appExecute?.has).toBe(true);

    const appRoutinePriv = await migrator<Array<{ privilege_type: string }>>`
      select privilege_type
      from information_schema.routine_privileges
      where routine_schema = 'app'
        and routine_name = 'purge_deleted_households'
        and grantee = 'app'
        and privilege_type = 'EXECUTE'
    `;
    expect(appRoutinePriv).toHaveLength(1);

    // PUBLIC has no EXECUTE on it
    const [publicExecute] = await migrator<{ has: boolean }[]>`
      select has_function_privilege('public', 'app.purge_deleted_households(integer)', 'EXECUTE') as has
    `;
    expect(publicExecute?.has).toBe(false);

    const publicRoutinePriv = await migrator<Array<{ privilege_type: string }>>`
      select privilege_type
      from information_schema.routine_privileges
      where routine_schema = 'app'
        and routine_name = 'purge_deleted_households'
        and grantee = 'PUBLIC'
    `;
    expect(publicRoutinePriv).toHaveLength(0);
  });
});
