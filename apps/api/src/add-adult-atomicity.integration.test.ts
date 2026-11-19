import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner } from "@community-hub/access";
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
import { createHousehold } from "@community-hub/people";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { armed } = vi.hoisted(() => ({ armed: { value: false } }));

vi.mock("@community-hub/people", async (importActual) => {
  const actual = await importActual<typeof import("@community-hub/people")>();
  return {
    ...actual,
    addAdult: async (...args: Parameters<typeof actual.addAdult>) => {
      const result = await actual.addAdult(...args);
      if (armed.value) {
        throw new Error("injected");
      }
      return result;
    },
  };
});

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
const PORT = 18489;
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";

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
  const runtime = loadRuntime();
  const migration = createPlaintextDirectSql(runtime.productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

describe("household routes atomicity (finding IA)", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  let identity: ReturnType<typeof createPlaintextIdentitySql>;
  let platform: ReturnType<typeof createPlaintextPlatformSql>;
  let app: ReturnType<typeof createPlaintextAppSql>;
  let secondApp: ReturnType<typeof createPlaintextAppSql>;
  let kms: ReturnType<typeof createLocalKmsPort>;
  let mail: MemoryMail;
  let server: Server;

  const orgId = newId();
  const communityId = newId();
  const slug = `atomicity-${orgId.slice(0, 8)}`;
  let ownerToken: string;
  let homeId: string;

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

    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${orgId}::uuid, ${`org-${newId().slice(0, 8)}`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${communityId}::uuid, ${orgId}::uuid, ${slug}, 'au')
      `;
    });

    const planKey = `synth_plan_${orgId.slice(0, 8)}`;
    await upsertPlan(platform, {
      key: planKey,
      entitlements: [
        { key: "people.directory", limit: null },
        { key: "people.households", limit: null },
      ],
    });
    await assignPlan(platform, { organisationId: orgId, planKey, now });

    const cus = `cus_${newId().replaceAll("-", "")}`;
    const sub = `sub_${newId().replaceAll("-", "")}`;
    await platform`
      insert into platform.billing_accounts (organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status)
      values (${orgId}::uuid, 'self_serve', ${cus}, ${sub}, 'active')
    `;

    const ownerSession = await signIn(`owner-${orgId.slice(0, 8)}@example.test`);
    ownerToken = ownerSession.accessToken;
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId, communityId }, (tx) =>
        bootstrapOwner(tx, {
          now,
          userId: ownerSession.userId,
          actorUserId: ownerSession.userId,
        }),
      ),
    );

    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId, communityId }, async (tx) => {
        const home = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: "Atomicity Household",
          actorUserId: ownerSession.userId,
        });
        homeId = home.householdId;
      }),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await identity.end({ timeout: 1 });
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
    await secondApp.end({ timeout: 1 });
  });

  it("add-adult: a throw after addAdult answers 500 and leaves no person row", async () => {
    const scope = { orgId, communityId };
    const getCounts = async () => {
      return withAppTransaction(secondApp, scope, async (tx) => {
        const [persons] = await tx<
          { count: number }[]
        >`select count(*)::int as count from app.persons where community_id = ${communityId}::uuid`;
        const [activity] = await tx<
          { count: number }[]
        >`select count(*)::int as count from app.person_activity where community_id = ${communityId}::uuid`;
        const [audit] = await tx<
          { count: number }[]
        >`select count(*)::int as count from app.audit_events where action in ('people.person.created', 'people.person.household_moved')`;
        const [usage] = await tx<
          { count: number }[]
        >`select coalesce(sum(success_count), 0)::int as count from app.usage_facts_daily where feature_key = 'people.directory'`;
        return {
          persons: persons!.count,
          activity: activity!.count,
          audit: audit!.count,
          usage: usage!.count,
        };
      });
    };

    // Positive control: successful add-adult answers 201 and its person row exists
    const controlRes = await post(
      "/v1/households/members/add-adult",
      {
        communitySlug: slug,
        householdId: homeId,
        givenName: "Control",
        familyName: "Adult",
        email: "control.adult@example.test",
        phone: "+61412555111",
        dateOfBirth: "1988-02-02",
      },
      ownerToken,
    );
    expect(controlRes.status).toBe(201);
    const controlBody = (await controlRes.json()) as { personId: string };
    expect(controlBody.personId).toBeDefined();

    await withAppTransaction(secondApp, scope, async (tx) => {
      const [row] = await tx<
        { count: number }[]
      >`select count(*)::int as count from app.persons where id = ${controlBody.personId}::uuid`;
      expect(row!.count).toBe(1);
    });

    const initial = await getCounts();
    armed.value = true;
    try {
      const res = await post(
        "/v1/households/members/add-adult",
        {
          communitySlug: slug,
          householdId: homeId,
          givenName: "Rollback",
          familyName: "Adult",
          email: "rollback.adult@example.test",
          phone: "+61412555999",
          dateOfBirth: "1985-01-01",
        },
        ownerToken,
      );
      expect(res.status).toBe(500);
    } finally {
      armed.value = false;
    }

    const after = await getCounts();
    expect(after).toEqual(initial);
  });
});
