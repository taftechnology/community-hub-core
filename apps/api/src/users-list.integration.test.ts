import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, linkUser } from "@community-hub/access";
import { listUsersResponse } from "@community-hub/contracts/access";
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
import { createPerson } from "@community-hub/people";
import { beforeAll, describe, expect, it } from "vitest";

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

beforeAll(async () => {
  const migration = createPlaintextDirectSql(loadRuntime().productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
});

describe("users list integration", () => {
  it("happy path: an owner is linked to an adult person with a phone and lists themself", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const runtime = loadRuntime();
    const identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const kms = createLocalKmsPort();
    const mail = new MemoryMail();
    const organisationId = newId();
    const communityId = newId();
    const slug = `userlist${organisationId.slice(0, 8)}`;
    const email = `owner-${organisationId.slice(0, 8)}@example.com`;
    const phone = "+61491570123";

    const checkout = async <T>(role: Role, run: (sql: never) => Promise<T>): Promise<T> => {
      if (role === "identity") {
        return run(identity as never);
      }
      if (role === "platform") {
        return run(platform as never);
      }
      return run(app as never);
    };

    const server = startServer({
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

    try {
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
          values (${organisationId}, ${slug}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, ${slug}, 'au')
        `;
      });

      const planKey = `plan_${organisationId.slice(0, 8)}`;
      await upsertPlan(platform, {
        key: planKey,
        entitlements: [{ key: "people.directory", limit: null }],
      });
      await assignPlan(platform, { organisationId, planKey, now });

      const started = await post(AUTH_HOSTNAME, "/v1/auth/email-otp/start", { email });
      expect(started.status).toBe(204);
      const verified = await post(AUTH_HOSTNAME, "/v1/auth/email-otp/verify", {
        email,
        code: mail.last?.code ?? "",
      });
      expect(verified.status).toBe(200);
      const session = (await verified.json()) as { userId: string; accessToken: string };
      const userId = session.userId;

      let personId = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          await bootstrapOwner(tx, { now, userId, actorUserId: userId });
          const person = await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Ada",
            familyName: "Lovelace",
            email: null,
            phone,
            actorUserId: userId,
          });
          personId = person.personId;
          await linkUser(tx, {
            now,
            userId,
            personId: person.personId,
            actorUserId: userId,
          });
        }),
      );

      const bearer = `Bearer ${session.accessToken}`;
      const res = await post(
        API_HOSTNAME,
        "/v1/access/users/list",
        { communitySlug: slug },
        bearer,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");

      const body = await res.json();
      expect(listUsersResponse.safeParse(body).success).toBe(true);
      expect(body).toEqual({
        phoneVisible: true,
        users: [
          {
            userId,
            personId,
            name: { given: "Ada", family: "Lovelace" },
            email,
            phone: "61491570123",
            minor: false,
          },
        ],
      });

      const auditRows = await withAppTransaction(
        app,
        { orgId: organisationId, communityId },
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
        actor_id: userId,
        target_ids: [userId],
      });
    } finally {
      server.close();
      await identity.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
