import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner } from "@community-hub/access";
import { serviceTimesPublicSchema } from "@community-hub/contracts/service-times";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { getPublishedServiceTimes } from "@community-hub/engagement";
import { assignPlan, upsertPlan } from "@community-hub/entitlements";
import type { OtpMail } from "@community-hub/identity";
import { startEmailOtp, verifyEmailOtp } from "@community-hub/identity";
import { withRequest } from "@community-hub/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { engagementRoutes, type EngagementLog } from "./engagement-routes.js";
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
const PORT = 18486;
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

describe("engagement routes integration tests (real DB, Round trip)", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  let identity: ReturnType<typeof createPlaintextIdentitySql>;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let directSql: ReturnType<typeof createPlaintextDirectSql>;
  let kms: ReturnType<typeof createLocalKmsPort>;
  let mail: MemoryMail;
  let server: Server;

  const orgIdA = newId();
  const orgIdNoEntitlement = newId();
  const communityIdA = newId();
  const communityIdNoEntitlement = newId();

  const slugA = `eng-comm-a-${newId().slice(-8)}`;
  const slugNoEntitlement = `eng-comm-noent-${newId().slice(-8)}`;

  let tokenA: string;
  let tokenNoEntitlement: string;
  const userIds: string[] = [];

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
    const routes = engagementRoutes({
      checkout,
      kms,
      keyArn: KEY_ARN,
      now: () => now,
      apiHostname: API_HOSTNAME,
      log: (() => undefined) as EngagementLog,
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
          (${orgIdA}::uuid, ${`eng-org-a-${newId().slice(-8)}`}, 'au', 'implicit'),
          (${orgIdNoEntitlement}::uuid, ${`eng-org-noent-${newId().slice(-8)}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values
          (${communityIdA}::uuid, ${orgIdA}::uuid, ${slugA}, 'au'),
          (${communityIdNoEntitlement}::uuid, ${orgIdNoEntitlement}::uuid, ${slugNoEntitlement}, 'au')
      `;
    });

    // 2. Setup plans and entitlements
    const planKeyA = `eng_plan_${orgIdA.slice(-8)}`;
    await upsertPlan(platform, {
      key: planKeyA,
      entitlements: [{ key: "module.engagement", limit: null }],
    });
    await assignPlan(platform, { organisationId: orgIdA, planKey: planKeyA, now });

    const planKeyNoEnt = `eng_no_plan_${orgIdNoEntitlement.slice(-8)}`;
    await upsertPlan(platform, {
      key: planKeyNoEnt,
      entitlements: [],
    });
    await assignPlan(platform, { organisationId: orgIdNoEntitlement, planKey: planKeyNoEnt, now });

    // Billing accounts (active)
    await platform`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status)
      values
        (${orgIdA}::uuid, 'self_serve', ${`cus_${newId().slice(-8)}`}, ${`sub_${newId().slice(-8)}`}, 'active'),
        (${orgIdNoEntitlement}::uuid, 'self_serve', ${`cus_${newId().slice(-8)}`}, ${`sub_${newId().slice(-8)}`}, 'active')
    `;

    // 3. Setup users & role grants
    const uA = await signIn(`admin-${newId().slice(-8)}@example.test`);
    tokenA = uA.accessToken;

    const uNoEnt = await signIn(`noent-${newId().slice(-8)}@example.test`);
    tokenNoEntitlement = uNoEnt.accessToken;

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA }, async (tx) => {
        await bootstrapOwner(tx, {
          now,
          userId: uA.userId,
          actorUserId: uA.userId,
        });
      }),
    );

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(
        app,
        { orgId: orgIdNoEntitlement, communityId: communityIdNoEntitlement },
        async (tx) => {
          await bootstrapOwner(tx, {
            now,
            userId: uNoEnt.userId,
            actorUserId: uNoEnt.userId,
          });
        },
      ),
    );
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    if (userIds.length > 0) {
      await identity`delete from identity.sessions where user_id in ${identity(userIds)}`;
      await identity`delete from identity.users where id in ${identity(userIds)}`;
    }
    await identity`delete from identity.identity_keys`;
    await directSql?.end({ timeout: 1 });
    await app?.end({ timeout: 1 });
    await platform?.end({ timeout: 1 });
    await identity?.end({ timeout: 1 });
  });

  it("get on an empty community returns { html: '', version: 0 }", async () => {
    const response = await postRoute(
      "/v1/engagement/service-times/get",
      { communitySlug: slugA },
      tokenA,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      html: "",
      version: 0,
    });
  });

  it("save with version 0 returns version 1 and cleaned html", async () => {
    const rawHtml = "<h2>Sunday Mass</h2><p>10:00 AM</p><script>alert('xss')</script>";
    const response = await postRoute(
      "/v1/engagement/service-times/save",
      {
        communitySlug: slugA,
        html: rawHtml,
        version: 0,
      },
      tokenA,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      html: "<h2>Sunday Mass</h2><p>10:00 AM</p>",
      version: 1,
    });
  });

  it("save with a stale version returns 409 and stored text is unchanged", async () => {
    // Attempt save with expected version 0 (stale, because row is at version 1)
    const response = await postRoute(
      "/v1/engagement/service-times/save",
      {
        communitySlug: slugA,
        html: "<p>Overwriting text</p>",
        version: 0,
      },
      tokenA,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("");

    // Verify stored text is unchanged
    const getRes = await postRoute(
      "/v1/engagement/service-times/get",
      { communitySlug: slugA },
      tokenA,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({
      html: "<h2>Sunday Mass</h2><p>10:00 AM</p>",
      version: 1,
    });
  });

  it("with entitlement OFF the route is blocked with 403", async () => {
    const getRes = await postRoute(
      "/v1/engagement/service-times/get",
      { communitySlug: slugNoEntitlement },
      tokenNoEntitlement,
    );
    expect(getRes.status).toBe(403);
    expect(await getRes.text()).toBe("");

    const saveRes = await postRoute(
      "/v1/engagement/service-times/save",
      { communitySlug: slugNoEntitlement, html: "<p>Text</p>", version: 0 },
      tokenNoEntitlement,
    );
    expect(saveRes.status).toBe(403);
    expect(await saveRes.text()).toBe("");
  });

  it("round trip: after save, read getPublishedServiceTimes in a real transaction and parse with serviceTimesPublicSchema", async () => {
    // Save version 2
    const saveRes = await postRoute(
      "/v1/engagement/service-times/save",
      {
        communitySlug: slugA,
        html: "<h3>Vigil Mass</h3><p>Saturday 6:00 PM</p>",
        version: 1,
      },
      tokenA,
    );
    expect(saveRes.status).toBe(200);
    const staffResponse = await saveRes.json();
    expect(staffResponse).toEqual({
      html: "<h3>Vigil Mass</h3><p>Saturday 6:00 PM</p>",
      version: 2,
    });

    // Read published service times in real transaction
    const publicResult = await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: orgIdA, communityId: communityIdA }, async (tx) => {
        return getPublishedServiceTimes(tx);
      }),
    );

    // serviceTimesPublicSchema parse succeeds and equals { html: <cleaned> }
    const parsed = serviceTimesPublicSchema.parse(publicResult);
    expect(parsed).toEqual({
      html: "<h3>Vigil Mass</h3><p>Saturday 6:00 PM</p>",
    });

    // serviceTimesPublicSchema rejects the staff response shape (because it has a version)
    expect(() => serviceTimesPublicSchema.parse(staffResponse)).toThrow();
  });
});
