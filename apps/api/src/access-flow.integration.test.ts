import { readFileSync } from "node:fs";
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
import type { OtpMail } from "@community-hub/identity";
import { withRequest } from "@community-hub/kernel";
import { beforeAll, describe, expect, it } from "vitest";

import { accessRoutes } from "./access-routes.js";
import { authRoutes } from "./auth-routes.js";
import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { startServer } from "./server.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const PORT = 18471;
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

describe("access flow", () => {
  it("grants and revokes through the server and answers unknown and no-role communities the same way", async () => {
    const now = new Date("2026-10-11T00:00:00.000Z");
    const runtime = loadRuntime();
    const identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const kms = createLocalKmsPort();
    const mail = new MemoryMail();
    const organisationId = newId();
    const communityId = newId();
    const otherOrganisationId = newId();
    const otherCommunityId = newId();
    const slug = `flow${organisationId.slice(0, 8)}`;
    const otherSlug = `other${otherOrganisationId.slice(0, 8)}`;
    const email = `flow-${organisationId.slice(0, 8)}@example.com`;
    const subject = newId();
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
    let userId = "";
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
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${otherOrganisationId}, ${otherSlug}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${otherCommunityId}, ${otherOrganisationId}, ${otherSlug}, 'au')
        `;
      });
      await identity`delete from identity.identity_keys`;
      const started = await post(AUTH_HOSTNAME, "/v1/auth/email-otp/start", { email });
      expect(started.status).toBe(204);
      const verified = await post(AUTH_HOSTNAME, "/v1/auth/email-otp/verify", {
        email,
        code: mail.last?.code ?? "",
      });
      expect(verified.status).toBe(200);
      const session = (await verified.json()) as { userId: string; accessToken: string };
      userId = session.userId;
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, (tx) =>
          bootstrapOwner(tx, { now, userId, actorUserId: userId }),
        ),
      );
      const bearer = `Bearer ${session.accessToken}`;
      const listed = await post(
        API_HOSTNAME,
        "/v1/access/grants/list",
        { communitySlug: slug },
        bearer,
      );
      expect(listed.status).toBe(200);
      const directory = (await listed.json()) as { permissions: string[] };
      expect(directory.permissions).toContain("access.roles.manage");
      const granted = await post(
        API_HOSTNAME,
        "/v1/access/grants",
        { communitySlug: slug, userId: subject, roleKey: "member" },
        bearer,
      );
      expect(granted.status).toBe(200);
      const grant = (await granted.json()) as { grantId: string };
      const revoked = await post(
        API_HOSTNAME,
        "/v1/access/grants/revoke",
        { communitySlug: slug, grantId: grant.grantId, scope: "community" },
        bearer,
      );
      expect(revoked.status).toBe(200);
      const missing = await post(
        API_HOSTNAME,
        "/v1/access/grants/list",
        { communitySlug: "no-such-parish" },
        bearer,
      );
      const absent = await post(
        API_HOSTNAME,
        "/v1/access/grants/list",
        { communitySlug: otherSlug },
        bearer,
      );
      expect(missing.status).toBe(absent.status);
      expect(missing.status).toBe(403);
      expect(await missing.text()).toBe("");
      expect(await absent.text()).toBe("");
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      if (userId !== "") {
        await identity`delete from identity.sessions where user_id = ${userId}::uuid`;
        await identity`delete from identity.users where id = ${userId}::uuid`;
      }
      await identity`delete from identity.identity_keys`;
      await identity.end({ timeout: 1 });
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
