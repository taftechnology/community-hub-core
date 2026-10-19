import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapOwner,
  createCustomRole,
  grantRole,
  linkUser,
} from "@community-hub/access";
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const billingSpy = vi.fn();
vi.mock("@community-hub/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@community-hub/billing")>();
  return {
    ...actual,
    assertWritable: (...args: Parameters<typeof actual.assertWritable>) => {
      billingSpy(...args);
      return actual.assertWritable(...args);
    },
  };
});

import { accessRoutes } from "./access-routes.js";
import { authRoutes } from "./auth-routes.js";
import type { Role } from "./checkout.js";
import { entitlementRoutes } from "./entitlement-routes.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { productionRoutes } from "./index.js";
import { startServer } from "./server.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const PORT = 18472;
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

type OrgSetup = {
  orgId: string;
  communityId: string;
  slug: string;
  ownerUserId: string;
  token: string;
  now: Date;
};

type Fixture = {
  path: string;
  prepare: (setup: OrgSetup) => Promise<{
    body: Record<string, unknown>;
    count: () => Promise<number>;
  }>;
};

describe("billing guard against a real database", () => {
  const now = new Date("2026-10-19T12:00:00.000Z");
  let runtime: Runtime;
  let identity: ReturnType<typeof createPlaintextIdentitySql>;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let kms: ReturnType<typeof createLocalKmsPort>;
  let mail: MemoryMail;
  let server: Server;
  const userIds: string[] = [];
  let counter = 0;

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

  function token(prefix: string): string {
    counter += 1;
    return `${prefix}_${counter}_${newId().replaceAll("-", "")}`;
  }

  async function createFreshSetup(billingState: "ok" | "read_only"): Promise<OrgSetup> {
    counter += 1;
    const orgId = newId();
    const communityId = newId();
    const slug = `guard${counter}${orgId.slice(0, 8)}`;
    const planKey = `plan${counter}${orgId.slice(0, 8)}`;
    const email = `owner${counter}-${orgId.slice(0, 8)}@example.test`;

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

    await upsertPlan(platform, {
      key: planKey,
      entitlements: [{ key: "people.directory", limit: null }],
    });
    await assignPlan(platform, { organisationId: orgId, planKey, now });

    const cusId = token("cus");
    const subId = token("sub");
    const stripeStatus = billingState === "ok" ? "active" : "canceled";

    await platform`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status)
      values (${orgId}::uuid, 'self_serve', ${cusId}, ${subId}, ${stripeStatus})
    `;

    const ownerSession = await signIn(email);
    const ownerUserId = ownerSession.userId;

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId, communityId }, (tx) =>
        bootstrapOwner(tx, { now, userId: ownerUserId, actorUserId: ownerUserId }),
      ),
    );

    return {
      orgId,
      communityId,
      slug,
      ownerUserId,
      token: ownerSession.accessToken,
      now,
    };
  }

  async function countGrants(setup: OrgSetup): Promise<number> {
    return withAppTransaction(
      app,
      { orgId: setup.orgId, communityId: setup.communityId },
      async (tx) => {
        const rows = await tx<{ n: number }[]>`
          select count(*)::int as n
          from app.community_role_grants
        `;
        return rows[0]!.n;
      },
    );
  }

  async function countCustomRoles(setup: OrgSetup): Promise<number> {
    return withAppTransaction(
      app,
      { orgId: setup.orgId, communityId: setup.communityId },
      async (tx) => {
        const rows = await tx<{ n: number }[]>`
          select count(*)::int as n
          from app.custom_roles
        `;
        return rows[0]!.n;
      },
    );
  }

  async function countUserLinks(setup: OrgSetup): Promise<number> {
    return withAppTransaction(
      app,
      { orgId: setup.orgId, communityId: setup.communityId },
      async (tx) => {
        const rows = await tx<{ n: number }[]>`
          select count(*)::int as n
          from app.user_links
        `;
        return rows[0]!.n;
      },
    );
  }

  async function countToggles(setup: OrgSetup): Promise<number> {
    const rows = await platform<{ n: number }[]>`
      select count(*)::int as n
      from platform.community_toggles
      where community_id = ${setup.communityId}::uuid
    `;
    return rows[0]!.n;
  }

  const fixtureMap = new Map<string, Fixture>([
    [
      "POST /v1/access/grants",
      {
        path: "/v1/access/grants",
        prepare: async (setup) => {
          const subjectUserId = newId();
          return {
            body: {
              communitySlug: setup.slug,
              userId: subjectUserId,
              roleKey: "member",
            },
            count: () => countGrants(setup),
          };
        },
      },
    ],
    [
      "POST /v1/access/grants/revoke",
      {
        path: "/v1/access/grants/revoke",
        prepare: async (setup) => {
          const subjectUserId = newId();
          const grant = await withRequest({ requestId: REQUEST_ID }, () =>
            withAppTransaction(
              app,
              { orgId: setup.orgId, communityId: setup.communityId },
              (tx) =>
                grantRole(tx, {
                  now: setup.now,
                  userId: subjectUserId,
                  roleKey: "member",
                  customRoleId: null,
                  actorUserId: setup.ownerUserId,
                }),
            ),
          );
          return {
            body: {
              communitySlug: setup.slug,
              grantId: grant.grantId,
              scope: "community",
            },
            count: () => countGrants(setup),
          };
        },
      },
    ],
    [
      "POST /v1/access/custom-roles",
      {
        path: "/v1/access/custom-roles",
        prepare: async (setup) => {
          counter += 1;
          const key = `cr_${counter}_${newId().replaceAll("-", "").slice(0, 8)}`;
          return {
            body: {
              communitySlug: setup.slug,
              key,
              permissions: ["access.roles.view"],
            },
            count: () => countCustomRoles(setup),
          };
        },
      },
    ],
    [
      "POST /v1/access/custom-roles/delete",
      {
        path: "/v1/access/custom-roles/delete",
        prepare: async (setup) => {
          counter += 1;
          const key = `crd_${counter}_${newId().replaceAll("-", "").slice(0, 8)}`;
          const role = await withRequest({ requestId: REQUEST_ID }, () =>
            withAppTransaction(
              app,
              { orgId: setup.orgId, communityId: setup.communityId },
              (tx) =>
                createCustomRole(tx, {
                  now: setup.now,
                  key,
                  permissions: ["access.roles.view"],
                  actorUserId: setup.ownerUserId,
                }),
            ),
          );
          return {
            body: {
              communitySlug: setup.slug,
              customRoleId: role.customRoleId,
            },
            count: () => countCustomRoles(setup),
          };
        },
      },
    ],
    [
      "POST /v1/access/user-links",
      {
        path: "/v1/access/user-links",
        prepare: async (setup) => {
          const linkUserId = newId();
          const linkPersonId = newId();
          await withAppTransaction(
            app,
            { orgId: setup.orgId, communityId: setup.communityId },
            async (tx) => {
              await tx`
                insert into app.persons (id, org_id, community_id, is_minor, age_basis, given_name, family_name)
                values (
                  ${linkPersonId}::uuid,
                  current_setting('app.org_id')::uuid,
                  current_setting('app.community_id')::uuid,
                  false,
                  'declared_adult',
                  'Test',
                  'User'
                )
              `;
            },
          );
          return {
            body: {
              communitySlug: setup.slug,
              userId: linkUserId,
              personId: linkPersonId,
            },
            count: () => countUserLinks(setup),
          };
        },
      },
    ],
    [
      "POST /v1/access/user-links/delete",
      {
        path: "/v1/access/user-links/delete",
        prepare: async (setup) => {
          const unlinkUserId = newId();
          const unlinkPersonId = newId();
          await withRequest({ requestId: REQUEST_ID }, () =>
            withAppTransaction(
              app,
              { orgId: setup.orgId, communityId: setup.communityId },
              async (tx) => {
                await tx`
                  insert into app.persons (id, org_id, community_id, is_minor, age_basis, given_name, family_name)
                  values (
                    ${unlinkPersonId}::uuid,
                    current_setting('app.org_id')::uuid,
                    current_setting('app.community_id')::uuid,
                    false,
                    'declared_adult',
                    'Test',
                    'User'
                  )
                `;
                await linkUser(tx, {
                  now: setup.now,
                  userId: unlinkUserId,
                  personId: unlinkPersonId,
                  actorUserId: setup.ownerUserId,
                });
              },
            ),
          );
          return {
            body: {
              communitySlug: setup.slug,
              userId: unlinkUserId,
            },
            count: () => countUserLinks(setup),
          };
        },
      },
    ],
    [
      "POST /v1/entitlements/toggle",
      {
        path: "/v1/entitlements/toggle",
        prepare: async (setup) => {
          return {
            body: {
              communitySlug: setup.slug,
              key: "people.directory",
              enabled: false,
            },
            count: () => countToggles(setup),
          };
        },
      },
    ],
  ]);

  beforeAll(async () => {
    runtime = loadRuntime();
    const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }

    identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    app = createPlaintextAppSql(roleUrl(runtime, "app"));
    kms = createLocalKmsPort();
    mail = new MemoryMail();

    const env = envFor(PORT);
    const serverRoutes = [
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
      ...entitlementRoutes({
        checkout,
        kms,
        keyArn: KEY_ARN,
        now: () => now,
        apiHostname: API_HOSTNAME,
        log: () => undefined,
        guardLog: () => undefined,
      }),
    ];

    server = startServer({
      env,
      routes: serverRoutes,
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
      server.closeAllConnections();
      server.close(() => resolve());
    });
    if (userIds.length > 0) {
      await identity`delete from identity.sessions where user_id in ${identity(userIds)}`;
      await identity`delete from identity.users where id in ${identity(userIds)}`;
    }
    await identity.end({ timeout: 1 });
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
  });

  it(
    "guards every write route through the gate: 2xx and row count changes in ok, 402 with empty body and unchanged rows in read_only (pin 14)",
    async () => {
      const env = envFor(PORT);
      const prodRoutes = productionRoutes(env, pem);
      const prodWriteKeys = new Set(
        prodRoutes
          .filter((r) => (r as { billing?: string }).billing === "write")
          .map((r) => `${r.method} ${r.pattern}`),
      );

      // Verify fixture map covers exactly all write routes
      expect(new Set(fixtureMap.keys())).toEqual(prodWriteKeys);

      for (const [key, fixture] of fixtureMap) {
        // 1. Fresh setup with A 'ok'
        const setupOk = await createFreshSetup("ok");
        const preparedOk = await fixture.prepare(setupOk);
        const countBeforeOk = await preparedOk.count();
        const resOk = await post(fixture.path, preparedOk.body, setupOk.token);

        expect(resOk.status, `expected 2xx for ${key} in ok state`).toBeGreaterThanOrEqual(200);
        expect(resOk.status, `expected 2xx for ${key} in ok state`).toBeLessThan(300);

        const countAfterOk = await preparedOk.count();
        expect(countAfterOk, `expected row count change for ${key} in ok state`).not.toBe(
          countBeforeOk,
        );

        // 2. Fresh setup with A 'read_only'
        const setupRo = await createFreshSetup("read_only");
        const preparedRo = await fixture.prepare(setupRo);
        const countBeforeRo = await preparedRo.count();
        const resRo = await post(fixture.path, preparedRo.body, setupRo.token);

        expect(resRo.status, `expected 402 for ${key} in read_only state`).toBe(402);
        expect(await resRo.text(), `expected empty body for ${key} in read_only state`).toBe("");

        const countAfterRo = await preparedRo.count();
        expect(countAfterRo, `expected row count unchanged for ${key} in read_only state`).toBe(
          countBeforeRo,
        );
      }
    },
    30_000,
  );

  it(
    "enforces tenant and billing boundaries across two organisations in both orders (pin 15)",
    async () => {
      // Order (i): A read_only, B ok
      {
        const setupA = await createFreshSetup("read_only");
        const setupB = await createFreshSetup("ok");

        // Grant-holder of A writing to A -> 402, empty body
        const resAA = await post(
          "/v1/access/grants",
          { communitySlug: setupA.slug, userId: newId(), roleKey: "member" },
          setupA.token,
        );
        expect(resAA.status).toBe(402);
        expect(await resAA.text()).toBe("");

        // Grant-holder of B writing to B -> 200
        const resBB = await post(
          "/v1/access/grants",
          { communitySlug: setupB.slug, userId: newId(), roleKey: "member" },
          setupB.token,
        );
        expect(resBB.status).toBe(200);

        // Grant-holder of B writing to A's community -> 403, empty body (pin 15)
        const resBA = await post(
          "/v1/access/grants",
          { communitySlug: setupA.slug, userId: newId(), roleKey: "member" },
          setupB.token,
        );
        expect(resBA.status).toBe(403);
        expect(await resBA.text()).toBe("");

        // Grant-holder of A writing to B's community -> 403, empty body
        const resAB = await post(
          "/v1/access/grants",
          { communitySlug: setupB.slug, userId: newId(), roleKey: "member" },
          setupA.token,
        );
        expect(resAB.status).toBe(403);
        expect(await resAB.text()).toBe("");
      }

      // Order (ii): A ok, B read_only
      {
        const setupA = await createFreshSetup("ok");
        const setupB = await createFreshSetup("read_only");

        // Grant-holder of A writing to A -> 200
        const resAA = await post(
          "/v1/access/grants",
          { communitySlug: setupA.slug, userId: newId(), roleKey: "member" },
          setupA.token,
        );
        expect(resAA.status).toBe(200);

        // Grant-holder of B writing to B -> 402, empty body
        const resBB = await post(
          "/v1/access/grants",
          { communitySlug: setupB.slug, userId: newId(), roleKey: "member" },
          setupB.token,
        );
        expect(resBB.status).toBe(402);
        expect(await resBB.text()).toBe("");

        // Grant-holder of A writing to B's community -> 403, empty body (pin 15)
        const resAB = await post(
          "/v1/access/grants",
          { communitySlug: setupB.slug, userId: newId(), roleKey: "member" },
          setupA.token,
        );
        expect(resAB.status).toBe(403);
        expect(await resAB.text()).toBe("");

        // Grant-holder of B writing to A's community -> 403, empty body
        const resBA = await post(
          "/v1/access/grants",
          { communitySlug: setupA.slug, userId: newId(), roleKey: "member" },
          setupB.token,
        );
        expect(resBA.status).toBe(403);
        expect(await resBA.text()).toBe("");
      }
    },
    30_000,
  );

  it(
    "answers stranger in read_only with the same 403 and audit count as in ok without reading billing",
    async () => {
      counter += 1;
      const strangerSession = await signIn(`stranger${counter}@example.test`);

      async function countAuditDenied(setup: OrgSetup): Promise<number> {
        return withAppTransaction(
          app,
          { orgId: setup.orgId, communityId: setup.communityId },
          async (tx) => {
            const rows = await tx<{ n: number }[]>`
              select count(*)::int as n
              from app.audit_events
              where action = 'access.permission.denied'
            `;
            return rows[0]!.n;
          },
        );
      }

      // 1. Stranger against ok organisation
      const setupOk = await createFreshSetup("ok");
      const auditBeforeOk = await countAuditDenied(setupOk);
      billingSpy.mockClear();

      const resOk = await post(
        "/v1/access/grants",
        { communitySlug: setupOk.slug, userId: newId(), roleKey: "member" },
        strangerSession.accessToken,
      );
      expect(resOk.status).toBe(403);
      expect(await resOk.text()).toBe("");
      const auditAfterOk = await countAuditDenied(setupOk);
      const auditDeltaOk = auditAfterOk - auditBeforeOk;
      expect(auditDeltaOk).toBe(1);
      expect(billingSpy).not.toHaveBeenCalled();

      // 2. Stranger against read_only organisation
      const setupRo = await createFreshSetup("read_only");
      const auditBeforeRo = await countAuditDenied(setupRo);
      billingSpy.mockClear();

      const resRo = await post(
        "/v1/access/grants",
        { communitySlug: setupRo.slug, userId: newId(), roleKey: "member" },
        strangerSession.accessToken,
      );
      expect(resRo.status).toBe(resOk.status);
      expect(await resRo.text()).toBe("");
      const auditAfterRo = await countAuditDenied(setupRo);
      const auditDeltaRo = auditAfterRo - auditBeforeRo;
      expect(auditDeltaRo).toBe(auditDeltaOk);
      expect(billingSpy).not.toHaveBeenCalled();
    },
    30_000,
  );
});
