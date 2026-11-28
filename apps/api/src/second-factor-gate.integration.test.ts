import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import {
  confirmTotpSetup,
  rejectingSecondFactorNotice,
  startEmailOtp,
  startTotpSetup,
  verifyEmailOtp,
  type OtpMail,
} from "@community-hub/identity";
import { withRequest } from "@community-hub/kernel";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createSession,
  sessionAccessHash,
} from "../../../modules/core/identity/infrastructure/session.js";
import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { productionRoutes } from "./index.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const WEBHOOKS_HOSTNAME = "webhooks.au.example.test";
const OPS_HOSTNAME = "ops.au.example.test";
const ADMIN_ORIGIN = "https://admin.au.example.test";
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const ZERO_UUID = "00000000-0000-4000-8000-000000000001";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function totpCodeAt(secretBase32: string, now: Date): string {
  const clean = secretBase32.replace(/=+$/u, "").toUpperCase();
  let bits = 0;
  let buffer = 0;
  const keyBytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    buffer = (buffer << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      keyBytes.push((buffer >>> bits) & 0xff);
    }
  }
  const step = Math.floor(now.getTime() / 30_000);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", new Uint8Array(keyBytes)).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

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

function roleUrl(runtime: Runtime, role: Role): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
}

const runtimeState = loadRuntime();
const appSql = createPlaintextAppSql(roleUrl(runtimeState, "app"));
const identitySql = createPlaintextIdentitySql(roleUrl(runtimeState, "identity"));
const platformSql = createPlaintextPlatformSql(roleUrl(runtimeState, "platform"));
const directSql = createPlaintextDirectSql(runtimeState.productOnlyUrl);
const localKms = createLocalKmsPort();

vi.mock("./checkout.js", () => ({
  createCheckout:
    () =>
    async <T>(role: Role, run: (sql: unknown) => Promise<T>) => {
      const db = role === "app" ? appSql : role === "identity" ? identitySql : platformSql;
      return run(db);
    },
}));

vi.mock("./kms/aws-kms-adapter.js", () => ({
  createAwsKmsPort: () => localKms,
}));

function buildEnv(): ServiceEnv {
  const read = readServiceEnv(
    {
      PORT: "18499",
      PGPORT: "5432",
      AWS_REGION: "ap-southeast-2",
      NODE_ENV: "test",
      COMMUNITY_HUB_ENVIRONMENT: "staging",
      API_HOSTNAME,
      AUTH_HOSTNAME,
      WEBHOOKS_HOSTNAME,
      OPS_HOSTNAME,
      PGHOST: "127.0.0.1",
      PGDATABASE: "hub_product_only",
      PGUSER_APP: "app",
      PGUSER_IDENTITY: "identity",
      PGUSER_PLATFORM: "platform",
      PGPASSWORD_APP: runtimeState.passwords.app,
      PGPASSWORD_IDENTITY: runtimeState.passwords.identity,
      PGPASSWORD_PLATFORM: runtimeState.passwords.platform,
      ENVELOPE_KEY_ARN: KEY_ARN,
      APP_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app",
      IDENTITY_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity",
      PLATFORM_SECRET_ARN: "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform",
      ADMIN_ORIGIN,
      BILLING_SECRET_ARN:
        "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:staging-billing-123456",
    },
    pem,
  );
  if (!read.ok) {
    throw new Error("invalid synthetic env");
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

async function cleanIdentity(): Promise<void> {
  await directSql`delete from identity.second_factor_events`;
  await identitySql`delete from identity.backup_codes`;
  await identitySql`delete from identity.totp_credentials`;
  await identitySql`delete from identity.sessions`;
  await identitySql`delete from identity.passkey_credentials`;
  await identitySql`delete from identity.passkey_challenges`;
  await identitySql`delete from identity.otp_challenges`;
  await identitySql`delete from identity.users`;
  await identitySql`delete from identity.identity_keys`;
}

beforeAll(async () => {
  await applyProductMigrations(directSql);
});

afterAll(async () => {
  await cleanIdentity();
  await appSql.end({ timeout: 1 });
  await identitySql.end({ timeout: 1 });
  await platformSql.end({ timeout: 1 });
  await directSql.end({ timeout: 1 });
});

const PUBLIC_ROUTES = new Set<string>([
  "GET /health",
  "POST /v1/auth/email-otp/start",
  "POST /v1/auth/email-otp/verify",
  "POST /v1/auth/passkey/authenticate/options",
  "POST /v1/auth/passkey/authenticate/verify",
  "POST /v1/auth/session/refresh",
  "POST /v1/stripe/webhook",
]);

const PRE_2FA_ROUTES = new Set<string>([
  "POST /v1/auth/second-factor/verify",
  "POST /v1/auth/second-factor/passkey/options",
  "POST /v1/auth/second-factor/passkey/verify",
  "POST /v1/auth/second-factor/totp/start",
  "POST /v1/auth/second-factor/totp/confirm",
  "POST /v1/auth/passkey/register/options",
  "POST /v1/auth/passkey/register/verify",
]);

const OPS_ROUTES = new Set<string>([
  "POST /v1/ops/enrolment/start",
  "POST /v1/ops/enrolment/verify",
  "POST /v1/ops/passkey/register/options",
  "POST /v1/ops/passkey/register/verify",
  "POST /v1/ops/passkey/authenticate/options",
  "POST /v1/ops/passkey/authenticate/verify",
  "POST /v1/ops/session/refresh",
  "POST /v1/ops/session/end",
  "GET /v1/ops/me",
  "GET /v1/ops/directory",
]);

type RouteSpec = { hostname: string; body?: unknown };

const slug = "missing-community";
const SESSION_ROUTES = new Map<string, RouteSpec>([
  ["GET /v1/auth/second-factor", { hostname: AUTH_HOSTNAME }],
  ["POST /v1/auth/second-factor/fresh", { hostname: AUTH_HOSTNAME, body: { code: "123456" } }],
  ["POST /v1/auth/second-factor/fresh/passkey/options", { hostname: AUTH_HOSTNAME, body: {} }],
  [
    "POST /v1/auth/second-factor/fresh/passkey/verify",
    {
      hostname: AUTH_HOSTNAME,
      body: {
        credentialId: "YQ",
        clientDataJSON: "YQ",
        authenticatorData: "YQ",
        signature: "YQ",
      },
    },
  ],
  ["POST /v1/auth/second-factor/totp/remove", { hostname: AUTH_HOSTNAME, body: {} }],
  [
    "POST /v1/auth/second-factor/passkeys/remove",
    { hostname: AUTH_HOSTNAME, body: { passkeyId: ZERO_UUID } },
  ],
  ["POST /v1/auth/second-factor/backup-codes", { hostname: AUTH_HOSTNAME, body: {} }],
  [
    "POST /v1/billing/checkout",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, planKey: "starter" } },
  ],
  ["POST /v1/billing/portal", { hostname: API_HOSTNAME, body: { communitySlug: slug } }],
  ["POST /v1/billing/status", { hostname: API_HOSTNAME, body: { communitySlug: slug } }],
  ["POST /v1/billing/plans", { hostname: API_HOSTNAME, body: { communitySlug: slug } }],
  ["POST /v1/invitations/accept", { hostname: API_HOSTNAME, body: { token: "sample-token" } }],
  ["POST /v1/access/grants/list", { hostname: API_HOSTNAME, body: { communitySlug: slug } }],
  ["POST /v1/access/users/list", { hostname: API_HOSTNAME, body: { communitySlug: slug } }],
  ["POST /v1/access/capabilities", { hostname: API_HOSTNAME, body: { communitySlug: slug } }],
  ["POST /v1/access/invitations/list", { hostname: API_HOSTNAME, body: { communitySlug: slug } }],
  [
    "POST /v1/access/invitations/create",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, email: "invite@example.test", roleKey: "member" },
    },
  ],
  [
    "POST /v1/access/invitations/resend",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, invitationId: ZERO_UUID } },
  ],
  [
    "POST /v1/access/invitations/revoke",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, invitationId: ZERO_UUID } },
  ],
  [
    "POST /v1/access/grants",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, userId: ZERO_UUID, roleKey: "member" } },
  ],
  [
    "POST /v1/access/grants/revoke",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, grantId: ZERO_UUID, scope: "community" },
    },
  ],
  [
    "POST /v1/access/custom-roles",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, key: "role_a", permissions: [] } },
  ],
  [
    "POST /v1/access/custom-roles/delete",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, customRoleId: ZERO_UUID } },
  ],
  [
    "POST /v1/access/user-links",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, userId: ZERO_UUID, personId: ZERO_UUID },
    },
  ],
  [
    "POST /v1/access/user-links/delete",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, userId: ZERO_UUID } },
  ],
  ["POST /v1/people/list", { hostname: API_HOSTNAME, body: { communitySlug: slug } }],
  [
    "POST /v1/people/read",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, personId: ZERO_UUID } },
  ],
  [
    "POST /v1/people/summary",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, addedSince: "2026-01-01T00:00:00.000Z" },
    },
  ],
  [
    "POST /v1/people/create",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, givenName: "Ada", familyName: "Lovelace" },
    },
  ],
  [
    "POST /v1/people/update",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, personId: ZERO_UUID, version: 1, givenName: "Ada" },
    },
  ],
  [
    "POST /v1/people/status",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, personId: ZERO_UUID, version: 1, status: "active" },
    },
  ],
  [
    "POST /v1/people/delete",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, personId: ZERO_UUID, version: 1 } },
  ],
  [
    "POST /v1/people/restore",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, personId: ZERO_UUID, version: 1 } },
  ],
  [
    "POST /v1/people/life-events/list",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, personId: ZERO_UUID } },
  ],
  [
    "POST /v1/people/life-events/create",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, personId: ZERO_UUID, type: "baptism", date: "2026-01-01" },
    },
  ],
  [
    "POST /v1/people/life-events/update",
    {
      hostname: API_HOSTNAME,
      body: {
        communitySlug: slug,
        eventId: ZERO_UUID,
        version: 1,
        type: "baptism",
        date: "2026-01-01",
      },
    },
  ],
  [
    "POST /v1/people/minors/view",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, personId: ZERO_UUID, field: "name" },
    },
  ],
  [
    "POST /v1/people/minors/life-events/view",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, personId: ZERO_UUID, lifeEventId: ZERO_UUID, field: "place" },
    },
  ],
  ["POST /v1/households/list", { hostname: API_HOSTNAME, body: { communitySlug: slug } }],
  [
    "POST /v1/households/read",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, householdId: ZERO_UUID } },
  ],
  [
    "POST /v1/households/create",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, label: "Lovelace" } },
  ],
  [
    "POST /v1/households/rename",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, householdId: ZERO_UUID, version: 1, label: "Lovelace" },
    },
  ],
  [
    "POST /v1/households/members/move-adult",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, householdId: ZERO_UUID, personId: ZERO_UUID, version: 1 },
    },
  ],
  [
    "POST /v1/households/members/add-minor",
    {
      hostname: API_HOSTNAME,
      body: {
        communitySlug: slug,
        householdId: ZERO_UUID,
        givenName: "Child",
        familyName: "Lovelace",
        dateOfBirth: "2020-01-01",
        guardianId: ZERO_UUID,
      },
    },
  ],
  [
    "POST /v1/households/members/add-adult",
    {
      hostname: API_HOSTNAME,
      body: {
        communitySlug: slug,
        householdId: ZERO_UUID,
        givenName: "Charles",
        familyName: "Babbage",
      },
    },
  ],
  [
    "POST /v1/households/guardians/link",
    {
      hostname: API_HOSTNAME,
      body: {
        communitySlug: slug,
        householdId: ZERO_UUID,
        guardianId: ZERO_UUID,
        childId: ZERO_UUID,
      },
    },
  ],
  [
    "POST /v1/households/guardians/unlink",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, householdId: ZERO_UUID, linkId: ZERO_UUID },
    },
  ],
  [
    "POST /v1/households/status",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, householdId: ZERO_UUID, version: 1, status: "active" },
    },
  ],
  [
    "POST /v1/households/delete",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, householdId: ZERO_UUID, version: 1 } },
  ],
  [
    "POST /v1/households/restore",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, householdId: ZERO_UUID, version: 1 } },
  ],
  [
    "POST /v1/households/emergency-contacts/read",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, householdId: ZERO_UUID } },
  ],
  [
    "POST /v1/households/emergency-contacts/save",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, householdId: ZERO_UUID, version: 1, contacts: [] },
    },
  ],
  [
    "POST /v1/engagement/service-times/get",
    { hostname: API_HOSTNAME, body: { communitySlug: slug } },
  ],
  [
    "POST /v1/engagement/service-times/save",
    { hostname: API_HOSTNAME, body: { communitySlug: slug, html: "<p>9am</p>", version: 0 } },
  ],
  ["POST /v1/entitlements/list", { hostname: API_HOSTNAME, body: { communitySlug: slug } }],
  [
    "POST /v1/entitlements/toggle",
    {
      hostname: API_HOSTNAME,
      body: { communitySlug: slug, key: "people.directory", enabled: true },
    },
  ],
]);

describe("second-factor route gate", () => {
  it("every session route refuses a second_factor token (walks productionRoutes; a route on no list fails)", async () => {
    const now = new Date();
    const mail = new MemoryMail();
    const routes = productionRoutes(buildEnv(), pem);

    await cleanIdentity();
    const email = `gate-sf-${newId()}@example.test`;
    await startEmailOtp(identitySql, localKms, KEY_ARN, mail, { email, now });
    const firstPre = await verifyEmailOtp(identitySql, localKms, KEY_ARN, {
      email,
      code: mail.last?.code ?? "",
      now,
    });
    expect(firstPre).not.toBeNull();
    const started = await startTotpSetup(identitySql, localKms, KEY_ARN, {
      accessToken: firstPre!.accessToken,
      now,
      adminRpId: "admin.au.example.test",
    });
    expect(started.outcome).toBe("started");
    if (started.outcome === "started") {
      await confirmTotpSetup(
        identitySql,
        localKms,
        KEY_ARN,
        {
          accessToken: firstPre!.accessToken,
          now,
          code: totpCodeAt(started.secret, now),
          adminRpId: "admin.au.example.test",
        },
        { notice: rejectingSecondFactorNotice },
      );
    }
    const sf = await createSession(identitySql, localKms, KEY_ARN, {
      userId: firstPre!.userId,
      now,
      kind: "second_factor",
    });

    const seenKeys = new Set<string>();
    for (const route of routes) {
      const key = `${route.method} ${route.pattern}`;
      seenKeys.add(key);

      if (PUBLIC_ROUTES.has(key) || PRE_2FA_ROUTES.has(key) || OPS_ROUTES.has(key)) {
        continue;
      }
      if (key === "POST /v1/auth/session/end") {
        continue;
      }

      const spec = SESSION_ROUTES.get(key);
      expect(spec, `unclassified production route ${key}`).toBeDefined();
      if (spec === undefined) {
        continue;
      }

      const headers = new Headers({
        "x-community-hub-hostname": spec.hostname,
        authorization: `Bearer ${sf!.accessToken}`,
      });
      const init: RequestInit = { method: route.method, headers };
      if (route.method !== "GET") {
        headers.set("content-type", "application/json");
        init.body = JSON.stringify(spec.body ?? {});
      }

      const response = await withRequest({ requestId: REQUEST_ID }, () =>
        Promise.resolve(
          route.handle(new Request(`http://127.0.0.1${route.pattern}`, init), {
            billing: route.billing,
            pattern: route.pattern,
          }),
        ),
      );
      expect(response.status, `expected 401 for ${key} with second_factor token`).toBe(401);
      expect(await response.text(), `expected empty body for ${key}`).toBe("");
    }

    for (const expectedKey of SESSION_ROUTES.keys()) {
      expect(seenKeys.has(expectedKey), `missing expected session route ${expectedKey}`).toBe(true);
    }

    // Check session/end accepts second_factor and returns 204
    const endRoute = routes.find((r) => `${r.method} ${r.pattern}` === "POST /v1/auth/session/end");
    expect(endRoute).toBeDefined();
    const endRes = await withRequest({ requestId: REQUEST_ID }, () =>
      Promise.resolve(
        endRoute!.handle(
          new Request("http://127.0.0.1/v1/auth/session/end", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-community-hub-hostname": AUTH_HOSTNAME,
              authorization: `Bearer ${sf!.accessToken}`,
            },
            body: JSON.stringify({}),
          }),
          { billing: endRoute!.billing, pattern: endRoute!.pattern },
        ),
      ),
    );
    expect(endRes.status).toBe(204);
  });

  it("a tenant session with no factor is refused", async () => {
    const now = new Date();
    const mail = new MemoryMail();
    const routes = productionRoutes(buildEnv(), pem);

    await cleanIdentity();
    const email = `gate-nofactor-${newId()}@example.test`;
    await startEmailOtp(identitySql, localKms, KEY_ARN, mail, { email, now });
    const pre = await verifyEmailOtp(identitySql, localKms, KEY_ARN, {
      email,
      code: mail.last?.code ?? "",
      now,
    });
    expect(pre).not.toBeNull();

    // A tenant row with no factor is what an image from before the second factor left behind. The
    // service no longer mints one, so the test clears the factor of a normal session.
    const factorless = await createSession(identitySql, localKms, KEY_ARN, {
      userId: pre!.userId,
      now,
      kind: "tenant",
      factor: "otp_totp",
    });
    const factorlessHash = await sessionAccessHash(
      identitySql,
      localKms,
      KEY_ARN,
      factorless.accessToken,
    );
    await identitySql`update identity.sessions set factor = null where access_hash = ${factorlessHash}`;

    const listGrants = routes.find(
      (r) => `${r.method} ${r.pattern}` === "POST /v1/access/grants/list",
    );
    expect(listGrants).toBeDefined();
    const resGrants = await withRequest({ requestId: REQUEST_ID }, () =>
      Promise.resolve(
        listGrants!.handle(
          new Request("http://127.0.0.1/v1/access/grants/list", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-community-hub-hostname": API_HOSTNAME,
              authorization: `Bearer ${factorless.accessToken}`,
            },
            body: JSON.stringify({ communitySlug: slug }),
          }),
          { billing: listGrants!.billing, pattern: listGrants!.pattern },
        ),
      ),
    );
    expect(resGrants.status).toBe(401);
    expect(await resGrants.text()).toBe("");

    const securityList = routes.find(
      (r) => `${r.method} ${r.pattern}` === "GET /v1/auth/second-factor",
    );
    expect(securityList).toBeDefined();
    const resSec = await withRequest({ requestId: REQUEST_ID }, () =>
      Promise.resolve(
        securityList!.handle(
          new Request("http://127.0.0.1/v1/auth/second-factor", {
            method: "GET",
            headers: {
              "x-community-hub-hostname": AUTH_HOSTNAME,
              authorization: `Bearer ${factorless.accessToken}`,
            },
          }),
          { billing: securityList!.billing, pattern: securityList!.pattern },
        ),
      ),
    );
    expect(resSec.status).toBe(401);
    expect(await resSec.text()).toBe("");
  });
});
