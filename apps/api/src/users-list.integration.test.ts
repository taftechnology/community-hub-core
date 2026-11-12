import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, linkUser } from "@community-hub/access";
import { listUsersResponse, type ListUsersResponse } from "@community-hub/contracts/access";
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
import { withRequest } from "@community-hub/kernel";
import { createHousehold, createPerson } from "@community-hub/people";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accessRoutes } from "./access-routes.js";
import { authRoutes } from "./auth-routes.js";
import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { startServer } from "./server.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const PORT = 18487;
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
      AUTH_HOSTNAME,
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
      APP_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app",
      IDENTITY_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity",
      PLATFORM_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform",
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
  hostname: string,
  pathName: string,
  body: unknown,
  authorization?: string,
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    "x-community-hub-hostname": hostname,
  });
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return fetch(`http://127.0.0.1:${PORT}${pathName}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function cleanIdentity(sql: ReturnType<typeof createPlaintextIdentitySql>): Promise<void> {
  await sql`delete from identity.sessions`;
  await sql`delete from identity.passkey_credentials`;
  await sql`delete from identity.passkey_challenges`;
  await sql`delete from identity.otp_challenges`;
  await sql`delete from identity.users`;
  await sql`delete from identity.identity_keys`;
}

beforeAll(async () => {
  const migration = createPlaintextDirectSql(loadRuntime().productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

describe("users list integration", () => {
  const now = new Date("2026-10-11T00:00:00.000Z");
  const runtime = loadRuntime();
  const identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
  const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  const kms = createLocalKmsPort();
  const mail = new MemoryMail();
  let server: Server;

  const checkout = async <T>(role: Role, run: (sql: never) => Promise<T>): Promise<T> => {
    if (role === "identity") {
      return run(identity as never);
    }
    if (role === "platform") {
      return run(platform as never);
    }
    return run(app as never);
  };

  beforeAll(async () => {
    await cleanIdentity(identity);
    server = startServer({
      env: envFor(PORT),
      routes: [
        ...authRoutes({
          checkout,
          kms,
          keyArn: KEY_ARN,
          mail,
          now: () => now,
          authHostname: AUTH_HOSTNAME,
          log: () => undefined,
        }),
        ...accessRoutes({
          checkout,
          kms,
          keyArn: KEY_ARN,
          now: () => now,
          apiHostname: API_HOSTNAME,
          log: () => undefined,
          guardLog: () => undefined,
        }),
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
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    await cleanIdentity(identity);
    await identity.end({ timeout: 1 });
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
  });

  let tenantSeq = 0;
  function uniqueSlug(prefix: string): string {
    tenantSeq += 1;
    const rand = newId().replace(/-/g, "").slice(16, 28);
    return `${prefix}${tenantSeq}${rand}`;
  }

  function uniqueEmail(prefix: string): string {
    return `${uniqueSlug(prefix)}@example.com`;
  }

  async function createTenant(planKeyPrefix = "plan") {
    const organisationId = newId();
    const communityId = newId();
    const slug = uniqueSlug("org");
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${organisationId}, ${slug}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}, ${organisationId}, ${slug}, 'au')
      `;
    });
    const planKey = `${planKeyPrefix}_${organisationId.slice(0, 8)}`;
    await upsertPlan(platform, {
      key: planKey,
      entitlements: [
        { key: "people.directory", limit: null },
        { key: "people.households", limit: null },
      ],
    });
    await assignPlan(platform, { organisationId, planKey, now });
    return { organisationId, communityId, slug };
  }

  async function createCommunity(organisationId: string) {
    const communityId = newId();
    const slug = uniqueSlug("com");
    await platform`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${organisationId}, ${slug}, 'au')
    `;
    return { communityId, slug };
  }

  async function createSession(email: string) {
    const started = await post(AUTH_HOSTNAME, "/v1/auth/email-otp/start", { email });
    expect(started.status).toBe(204);
    const verified = await post(AUTH_HOSTNAME, "/v1/auth/email-otp/verify", {
      email,
      code: mail.last?.code ?? "",
    });
    expect(verified.status).toBe(200);
    const session = (await verified.json()) as { userId: string; accessToken: string };
    return {
      userId: session.userId,
      accessToken: session.accessToken,
      bearer: `Bearer ${session.accessToken}`,
      email,
    };
  }

  async function setupOwner(
    tenant: { organisationId: string; communityId: string },
    email = uniqueEmail("owner"),
  ) {
    const user = await createSession(email);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(
        app,
        { orgId: tenant.organisationId, communityId: tenant.communityId },
        (tx) => bootstrapOwner(tx, { now, userId: user.userId, actorUserId: user.userId }),
      ),
    );
    return user;
  }

  it("happy path: an owner is linked to an adult person with a phone and lists themself", async () => {
    const tenant = await createTenant();
    const phone = "+61491570006";
    const email = uniqueEmail("owner");
    const owner = await setupOwner(tenant, email);

    let personId = "";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(
        app,
        { orgId: tenant.organisationId, communityId: tenant.communityId },
        async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Morgan",
            familyName: "Finch",
            email: null,
            phone,
            actorUserId: owner.userId,
          });
          personId = person.personId;
          await linkUser(tx, {
            now,
            userId: owner.userId,
            personId: person.personId,
            actorUserId: owner.userId,
          });
        },
      ),
    );

    const res = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenant.slug },
      owner.bearer,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.json();
    expect(listUsersResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      phoneVisible: true,
      users: [
        {
          userId: owner.userId,
          personId,
          name: { given: "Morgan", family: "Finch" },
          email,
          phone: "61491570006",
          minor: false,
        },
      ],
    });

    const auditRows = await withAppTransaction(
      app,
      { orgId: tenant.organisationId, communityId: tenant.communityId },
      async (tx) =>
        tx<{ action: string; purpose: string; actor_id: string; target_ids: string[] }[]>`
          select action, purpose, actor_id::text as actor_id, target_ids::text[] as target_ids
          from app.audit_events
          where action = 'access.users.listed'
            and org_id = current_setting('app.org_id')::uuid
        `,
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toEqual({
      action: "access.users.listed",
      purpose: "access.users.listed",
      actor_id: owner.userId,
      target_ids: [owner.userId],
    });
  });

  // Tenancy
  it("tenancy: a caller in organisation A never sees a user who belongs only to organisation B", async () => {
    const tenantA = await createTenant();
    const ownerA = await setupOwner(tenantA);
    const tenantB = await createTenant();
    const ownerB = await setupOwner(tenantB);

    const userB = await createSession(uniqueEmail("userb"));
    const grantB = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: tenantB.slug,
        userId: userB.userId,
        roleKey: "member",
      },
      ownerB.bearer,
    );
    expect(grantB.status).toBe(200);

    const res = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenantA.slug },
      ownerA.bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListUsersResponse;
    expect(listUsersResponse.safeParse(body).success).toBe(true);

    expect(body.users.some((u) => u.userId === userB.userId)).toBe(false);
    expect(body.users.some((u) => u.userId === ownerB.userId)).toBe(false);

    // Positive control: organisation B's list does include user B
    const resB = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenantB.slug },
      ownerB.bearer,
    );
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as ListUsersResponse;
    expect(listUsersResponse.safeParse(bodyB).success).toBe(true);
    expect(bodyB.users.some((u) => u.userId === userB.userId)).toBe(true);
  });

  it("tenancy: a caller in community 1 never sees a user who belongs only to community 2", async () => {
    const tenant = await createTenant();
    const owner = await setupOwner(tenant);
    const comm2 = await createCommunity(tenant.organisationId);

    const userC2 = await createSession(uniqueEmail("userc2"));
    const grantC2 = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: comm2.slug,
        userId: userC2.userId,
        roleKey: "member",
      },
      owner.bearer,
    );
    expect(grantC2.status).toBe(200);

    const res = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenant.slug },
      owner.bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListUsersResponse;
    expect(listUsersResponse.safeParse(body).success).toBe(true);

    expect(body.users.some((u) => u.userId === userC2.userId)).toBe(false);
  });

  it("tenancy: an org-level user linked only in community 2 shows in community 1 with personId: null and email only", async () => {
    const tenant = await createTenant();
    const owner = await setupOwner(tenant);
    const comm2 = await createCommunity(tenant.organisationId);

    const orgUser = await createSession(uniqueEmail("orguser"));
    const grantOrg = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: tenant.slug,
        userId: orgUser.userId,
        roleKey: "org_admin",
      },
      owner.bearer,
    );
    expect(grantOrg.status).toBe(200);

    let personC2Id = "";
    const phone = "+61491570156";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(
        app,
        { orgId: tenant.organisationId, communityId: comm2.communityId },
        async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Robin",
            familyName: "Taylor",
            email: null,
            phone,
            actorUserId: owner.userId,
          });
          personC2Id = person.personId;
          await linkUser(tx, {
            now,
            userId: orgUser.userId,
            personId: person.personId,
            actorUserId: owner.userId,
          });
        },
      ),
    );

    // In community 1: orgUser shows with personId null, no name, no phone, but email visible
    const res1 = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenant.slug },
      owner.bearer,
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as ListUsersResponse;
    expect(listUsersResponse.safeParse(body1).success).toBe(true);
    const row1 = body1.users.find((u) => u.userId === orgUser.userId);
    expect(row1).toEqual({
      userId: orgUser.userId,
      personId: null,
      name: null,
      email: orgUser.email,
      phone: null,
      minor: false,
    });

    // In community 2: orgUser shows with personId, name, phone and email
    const res2 = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: comm2.slug },
      owner.bearer,
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as ListUsersResponse;
    expect(listUsersResponse.safeParse(body2).success).toBe(true);
    const row2 = body2.users.find((u) => u.userId === orgUser.userId);
    expect(row2).toEqual({
      userId: orgUser.userId,
      personId: personC2Id,
      name: { given: "Robin", family: "Taylor" },
      email: orgUser.email,
      phone: "61491570156",
      minor: false,
    });
  });

  // Identity, minors and links
  it("identity: a user who belongs to both organisations shows the same email in each", async () => {
    const tenantA = await createTenant();
    const ownerA = await setupOwner(tenantA);
    const tenantB = await createTenant();
    const ownerB = await setupOwner(tenantB);

    const sharedUser = await createSession(uniqueEmail("shared"));

    const grantA = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: tenantA.slug,
        userId: sharedUser.userId,
        roleKey: "member",
      },
      ownerA.bearer,
    );
    expect(grantA.status).toBe(200);

    const grantB = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: tenantB.slug,
        userId: sharedUser.userId,
        roleKey: "member",
      },
      ownerB.bearer,
    );
    expect(grantB.status).toBe(200);

    const resA = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenantA.slug },
      ownerA.bearer,
    );
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as ListUsersResponse;
    const rowA = bodyA.users.find((u) => u.userId === sharedUser.userId);
    expect(rowA?.email).toBe(sharedUser.email);

    const resB = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenantB.slug },
      ownerB.bearer,
    );
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as ListUsersResponse;
    const rowB = bodyB.users.find((u) => u.userId === sharedUser.userId);
    expect(rowB?.email).toBe(sharedUser.email);
    expect(rowA?.email).toBe(rowB?.email);
  });

  it("minors: a minor-linked user returns minor: true and null details for community_admin and staff", async () => {
    const tenant = await createTenant();
    const owner = await setupOwner(tenant);

    let minorPersonId = "";
    const minorPhone = "+61491570157";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(
        app,
        { orgId: tenant.organisationId, communityId: tenant.communityId },
        async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now,
            label: "Household Minor Test",
            actorUserId: owner.userId,
          });
          const minor = await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: false,
            householdId: hh.householdId,
            dateOfBirth: "2015-05-05",
            givenName: "MinorGiven",
            familyName: "MinorFamily",
            email: null,
            phone: minorPhone,
            actorUserId: owner.userId,
          });
          minorPersonId = minor.personId;
        },
      ),
    );

    const minorUser = await createSession(uniqueEmail("minoruser"));
    const grantMinor = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: tenant.slug,
        userId: minorUser.userId,
        roleKey: "member",
      },
      owner.bearer,
    );
    expect(grantMinor.status).toBe(200);

    // Link minor user directly through the owner connection (linkUser refuses minors)
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await direct`
        insert into app.user_links (id, org_id, community_id, user_id, person_id)
        values (${newId()}, ${tenant.organisationId}, ${tenant.communityId}, ${minorUser.userId}, ${minorPersonId})
      `;
    } finally {
      await direct.end({ timeout: 1 });
    }

    // 1. Check for community_admin
    const adminUser = await createSession(uniqueEmail("admin"));
    const grantAdmin = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: tenant.slug,
        userId: adminUser.userId,
        roleKey: "community_admin",
      },
      owner.bearer,
    );
    expect(grantAdmin.status).toBe(200);

    const adminRes = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenant.slug },
      adminUser.bearer,
    );
    expect(adminRes.status).toBe(200);
    const adminRawText = await adminRes.text();
    expect(adminRawText).not.toContain(minorUser.email);
    expect(adminRawText).not.toContain(minorPhone);
    expect(adminRawText).not.toContain("61491570157");
    expect(adminRawText).not.toContain("MinorGiven");
    const adminBody = JSON.parse(adminRawText) as ListUsersResponse;
    expect(listUsersResponse.safeParse(adminBody).success).toBe(true);
    const adminRow = adminBody.users.find((u) => u.userId === minorUser.userId);
    expect(adminRow).toEqual({
      userId: minorUser.userId,
      personId: minorPersonId,
      name: null,
      email: null,
      phone: null,
      minor: true,
    });

    // 2. Check for staff
    const staffUser = await createSession(uniqueEmail("staff"));
    const grantStaff = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: tenant.slug,
        userId: staffUser.userId,
        roleKey: "staff",
      },
      owner.bearer,
    );
    expect(grantStaff.status).toBe(200);

    const staffRes = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenant.slug },
      staffUser.bearer,
    );
    expect(staffRes.status).toBe(200);
    const staffRawText = await staffRes.text();
    expect(staffRawText).not.toContain(minorUser.email);
    expect(staffRawText).not.toContain(minorPhone);
    expect(staffRawText).not.toContain("61491570157");
    expect(staffRawText).not.toContain("MinorGiven");
    const staffBody = JSON.parse(staffRawText) as ListUsersResponse;
    expect(listUsersResponse.safeParse(staffBody).success).toBe(true);
    const staffRow = staffBody.users.find((u) => u.userId === minorUser.userId);
    expect(staffRow).toEqual({
      userId: minorUser.userId,
      personId: minorPersonId,
      name: null,
      email: null,
      phone: null,
      minor: true,
    });
  });

  it("amendment A1 on a real database: minor person in community 2 linked in community 1 returns minor: true and email is omitted from body", async () => {
    const tenant = await createTenant();
    const owner = await setupOwner(tenant);
    const comm2 = await createCommunity(tenant.organisationId);

    // In community 2, create a household and minor person
    let minorPersonC2Id = "";
    const minorPhone = "+61491570158";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(
        app,
        { orgId: tenant.organisationId, communityId: comm2.communityId },
        async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now,
            label: "Household C2 Minor",
            actorUserId: owner.userId,
          });
          const minor = await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: false,
            householdId: hh.householdId,
            dateOfBirth: "2015-05-05",
            givenName: "MinorTwo",
            familyName: "SmithTwo",
            email: null,
            phone: minorPhone,
            actorUserId: owner.userId,
          });
          minorPersonC2Id = minor.personId;
        },
      ),
    );

    const userA1 = await createSession(uniqueEmail("usera1"));
    const grantA1 = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: tenant.slug,
        userId: userA1.userId,
        roleKey: "member",
      },
      owner.bearer,
    );
    expect(grantA1.status).toBe(200);

    // Insert user_links in community 1 pointing at the minor person in community 2
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await direct`
        insert into app.user_links (id, org_id, community_id, user_id, person_id)
        values (${newId()}, ${tenant.organisationId}, ${tenant.communityId}, ${userA1.userId}, ${minorPersonC2Id})
      `;
    } finally {
      await direct.end({ timeout: 1 });
    }

    // Call users/list as community 1 admin
    const adminUser = await createSession(uniqueEmail("c1admin"));
    const grantAdmin = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: tenant.slug,
        userId: adminUser.userId,
        roleKey: "community_admin",
      },
      owner.bearer,
    );
    expect(grantAdmin.status).toBe(200);

    const res = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenant.slug },
      adminUser.bearer,
    );
    expect(res.status).toBe(200);
    const rawText = await res.text();
    expect(rawText).not.toContain(userA1.email);
    expect(rawText).not.toContain(minorPhone);
    expect(rawText).not.toContain("61491570158");
    expect(rawText).not.toContain("MinorTwo");

    const body = JSON.parse(rawText) as ListUsersResponse;
    expect(listUsersResponse.safeParse(body).success).toBe(true);
    const row = body.users.find((u) => u.userId === userA1.userId);
    expect(row).toEqual({
      userId: userA1.userId,
      personId: minorPersonC2Id,
      name: null,
      email: null,
      phone: null,
      minor: true,
    });
  });

  // Audit, rollback, denial
  it("audit (pin 18): a successful call by a caller holding people.view writes users.listed and person.read rows", async () => {
    const tenant = await createTenant();
    const owner = await setupOwner(tenant);

    const phone = "+61491570159";
    let personId = "";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(
        app,
        { orgId: tenant.organisationId, communityId: tenant.communityId },
        async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Avery",
            familyName: "Quill",
            email: null,
            phone,
            actorUserId: owner.userId,
          });
          personId = person.personId;
          await linkUser(tx, {
            now,
            userId: owner.userId,
            personId: person.personId,
            actorUserId: owner.userId,
          });
        },
      ),
    );

    const res = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenant.slug },
      owner.bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListUsersResponse;
    expect(listUsersResponse.safeParse(body).success).toBe(true);

    const auditRows = await withAppTransaction(
      app,
      { orgId: tenant.organisationId, communityId: tenant.communityId },
      async (tx) =>
        tx<
          {
            action: string;
            purpose: string;
            actor_id: string;
            target_ids: string[];
          }[]
        >`
          select action, purpose, actor_id::text as actor_id, target_ids::text[] as target_ids
          from app.audit_events
          where org_id = current_setting('app.org_id')::uuid
            and action in ('access.users.listed', 'people.person.read')
          order by seq asc
        `,
    );

    const listedRows = auditRows.filter((r) => r.action === "access.users.listed");
    const readRows = auditRows.filter((r) => r.action === "people.person.read");

    expect(listedRows).toHaveLength(1);
    expect(listedRows[0]).toEqual({
      action: "access.users.listed",
      purpose: "access.users.listed",
      actor_id: owner.userId,
      target_ids: body.users.map((u) => u.userId),
    });

    expect(readRows).toHaveLength(1);
    expect(readRows[0]).toEqual({
      action: "people.person.read",
      purpose: "people.person.read",
      actor_id: owner.userId,
      target_ids: [personId],
    });

    const auditText = JSON.stringify(auditRows);
    expect(auditText).not.toContain("Avery");
    expect(auditText).not.toContain("Quill");
    expect(auditText).not.toContain(owner.email);
    expect(auditText).not.toContain(phone);
    expect(auditText).not.toContain("61491570159");
  });

  it("rollback (pin 7): a corrupted identity email ciphertext returns empty 500 and commits no audit rows", async () => {
    const tenant = await createTenant();
    const owner = await setupOwner(tenant);

    const targetEmail = uniqueEmail("target");
    const targetUser = await createSession(targetEmail);
    const targetPhone = "+61491570110";

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(
        app,
        { orgId: tenant.organisationId, communityId: tenant.communityId },
        async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Jordan",
            familyName: "River",
            email: null,
            phone: targetPhone,
            actorUserId: owner.userId,
          });
          await linkUser(tx, {
            now,
            userId: targetUser.userId,
            personId: person.personId,
            actorUserId: owner.userId,
          });
        },
      ),
    );

    const countSpecific = async (action: string): Promise<number> => {
      const rows = await withAppTransaction(
        app,
        { orgId: tenant.organisationId, communityId: tenant.communityId },
        async (tx) =>
          tx<{ count: number }[]>`
            select count(*)::int as count
            from app.audit_events
            where org_id = current_setting('app.org_id')::uuid
              and action = ${action}
          `,
      );
      return rows[0]!.count;
    };

    const beforeListed = await countSpecific("access.users.listed");
    const beforeRead = await countSpecific("people.person.read");

    // Corrupt target user's identity email ciphertext through identity connection (flip a byte)
    const [row] = await identity<{ email: Uint8Array }[]>`
      select email from identity.users where id = ${targetUser.userId}::uuid
    `;
    expect(row?.email).toBeDefined();
    const corrupted = new Uint8Array(row!.email);
    corrupted[corrupted.length - 1]! ^= 1;
    await identity`
      update identity.users set email = ${corrupted} where id = ${targetUser.userId}::uuid
    `;

    const res = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenant.slug },
      owner.bearer,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const afterListed = await countSpecific("access.users.listed");
    const afterRead = await countSpecific("people.person.read");
    expect(afterListed).toBe(beforeListed);
    expect(afterRead).toBe(beforeRead);
  });

  it("denial (pin 8): caller with access.roles.view only gets empty 403 and access.permission.denied row", async () => {
    const tenant = await createTenant();
    const owner = await setupOwner(tenant);

    const roleKey = uniqueSlug("cr");
    const createRoleRes = await post(
      API_HOSTNAME,
      "/v1/access/custom-roles",
      {
        communitySlug: tenant.slug,
        key: roleKey,
        permissions: ["access.roles.view"],
      },
      owner.bearer,
    );
    expect(createRoleRes.status).toBe(200);
    const { customRoleId } = (await createRoleRes.json()) as { customRoleId: string };

    const customCaller = await createSession(uniqueEmail("custom"));
    const grantRes = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: tenant.slug,
        userId: customCaller.userId,
        customRoleId,
      },
      owner.bearer,
    );
    expect(grantRes.status).toBe(200);

    const phone = "+61491570110";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(
        app,
        { orgId: tenant.organisationId, communityId: tenant.communityId },
        async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Custom",
            familyName: "Viewer",
            email: null,
            phone,
            actorUserId: owner.userId,
          });
          await linkUser(tx, {
            now,
            userId: customCaller.userId,
            personId: person.personId,
            actorUserId: owner.userId,
          });
        },
      ),
    );

    const countSpecific = async (action: string): Promise<number> => {
      const rows = await withAppTransaction(
        app,
        { orgId: tenant.organisationId, communityId: tenant.communityId },
        async (tx) =>
          tx<{ count: number }[]>`
            select count(*)::int as count
            from app.audit_events
            where org_id = current_setting('app.org_id')::uuid
              and action = ${action}
          `,
      );
      return rows[0]!.count;
    };

    const beforeDenied = await countSpecific("access.permission.denied");
    const beforeListed = await countSpecific("access.users.listed");
    const beforeRead = await countSpecific("people.person.read");

    const res = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenant.slug },
      customCaller.bearer,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const afterListed = await countSpecific("access.users.listed");
    const afterRead = await countSpecific("people.person.read");
    expect(afterListed).toBe(beforeListed);
    expect(afterRead).toBe(beforeRead);

    const deniedRows = await withAppTransaction(
      app,
      { orgId: tenant.organisationId, communityId: tenant.communityId },
      async (tx) =>
        tx<{ action: string; purpose: string; actor_id: string; target_ids: string[] }[]>`
          select action, purpose, actor_id::text as actor_id, target_ids::text[] as target_ids
          from app.audit_events
          where org_id = current_setting('app.org_id')::uuid
            and action = 'access.permission.denied'
          order by seq asc
        `,
    );
    expect(deniedRows.length).toBe(beforeDenied + 1);
    const latest = deniedRows[deniedRows.length - 1]!;
    expect(latest).toEqual({
      action: "access.permission.denied",
      purpose: "access.users.view",
      actor_id: customCaller.userId,
      target_ids: [customCaller.userId],
    });
  });

  // Edge cases
  it("edge cases: a user id with no identity.users row returns email: null", async () => {
    const tenant = await createTenant();
    const owner = await setupOwner(tenant);

    const freshUserId = newId();
    const grantRes = await post(
      API_HOSTNAME,
      "/v1/access/grants",
      {
        communitySlug: tenant.slug,
        userId: freshUserId,
        roleKey: "member",
      },
      owner.bearer,
    );
    expect(grantRes.status).toBe(200);

    const res = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenant.slug },
      owner.bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListUsersResponse;
    expect(listUsersResponse.safeParse(body).success).toBe(true);

    const ghost = body.users.find((u) => u.userId === freshUserId);
    expect(ghost).toEqual({
      userId: freshUserId,
      personId: null,
      name: null,
      email: null,
      phone: null,
      minor: false,
    });
  });

  it("edge cases: when the caller is the only user, the list holds exactly the caller", async () => {
    const tenant = await createTenant();
    const owner = await setupOwner(tenant);

    const res = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenant.slug },
      owner.bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListUsersResponse;
    expect(listUsersResponse.safeParse(body).success).toBe(true);

    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toEqual({
      userId: owner.userId,
      personId: null,
      name: null,
      email: owner.email,
      phone: null,
      minor: false,
    });
  });

  it("edge cases: unknown community slug and second organisation slug both return empty 403 with no-store", async () => {
    const tenantA = await createTenant();
    const ownerA = await setupOwner(tenantA);
    const tenantB = await createTenant();

    const missing = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: "no-such-parish" },
      ownerA.bearer,
    );
    const absent = await post(
      API_HOSTNAME,
      "/v1/access/users/list",
      { communitySlug: tenantB.slug },
      ownerA.bearer,
    );

    expect(missing.status).toBe(absent.status);
    expect(missing.status).toBe(403);
    expect(await missing.text()).toBe("");
    expect(await absent.text()).toBe("");
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(absent.headers.get("cache-control")).toBe("no-store");
  });

  // Route-level missing-identity-key is not testable, because readSession
  // creates the key first (session.ts:475-477). Pin 10 covers it at the export.
  it("edge cases: route returns empty 500 and creates no community key row when community key is missing", async () => {
    const tenant = await createTenant();
    const owner = await setupOwner(tenant);

    // Link an adult with a phone so the route attempts to open the community key
    const phone = "+61491570313";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(
        app,
        { orgId: tenant.organisationId, communityId: tenant.communityId },
        async (tx) => {
          const person = await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Casey",
            familyName: "Rowan",
            email: null,
            phone,
            actorUserId: owner.userId,
          });
          await linkUser(tx, {
            now,
            userId: owner.userId,
            personId: person.personId,
            actorUserId: owner.userId,
          });
        },
      ),
    );

    // In a community with no households, delete the community key row through the owner direct connection
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await direct`
        delete from app.community_keys where community_id = ${tenant.communityId}::uuid
      `;
      const beforeCount = await direct<{ n: number }[]>`
        select count(*)::int as n from app.community_keys where community_id = ${tenant.communityId}::uuid
      `;
      expect(beforeCount[0]!.n).toBe(0);

      const res = await post(
        API_HOSTNAME,
        "/v1/access/users/list",
        { communitySlug: tenant.slug },
        owner.bearer,
      );
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("");
      expect(res.headers.get("cache-control")).toBe("no-store");

      const afterCount = await direct<{ n: number }[]>`
        select count(*)::int as n from app.community_keys where community_id = ${tenant.communityId}::uuid
      `;
      expect(afterCount[0]!.n).toBe(0);
    } finally {
      await direct.end({ timeout: 1 });
    }
  });
});
