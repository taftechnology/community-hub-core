import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, parseInvitationToken, type InvitationMail } from "@community-hub/access";
import { addMember } from "@community-hub/access/testing";
import { listUsersResponse, type ListUsersResponse } from "@community-hub/contracts/access";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import {
  applyProductMigrations,
  newId,
  withAppTransaction,
  type AppTransaction,
} from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { assignPlan, upsertPlan } from "@community-hub/entitlements";
import type { OtpMail } from "@community-hub/identity";
import * as identity from "@community-hub/identity";
import { withRequest } from "@community-hub/kernel";
import { createPerson } from "@community-hub/people";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accessRoutes } from "./access-routes.js";
import { authRoutes } from "./auth-routes.js";
import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { invitationRoutes } from "./invitation-routes.js";
import { startServer } from "./server.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const API_HOSTNAME = "au.api.example.test";
const AUTH_HOSTNAME = "auth.au.example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const PORT = 18488;
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";

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

type Scope = { orgId: string; communityId: string };

type Community = { communityId: string; slug: string };

type Org = { organisationId: string; communities: Community[] };

type Session = { userId: string; bearer: string; email: string };

type Answer = { status: number; text: string };

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

class RecordingMail implements InvitationMail {
  readonly sent: { to: string; link: string }[] = [];
  fail = false;

  send(input: { to: string; communitySlug: string; link: string; expiresAt: Date }): Promise<void> {
    if (this.fail) {
      return Promise.reject(new Error("mail unavailable"));
    }
    this.sent.push({ to: input.to, link: input.link });
    return Promise.resolve();
  }
}

function tokenFrom(link: string): string {
  const marker = "#invite=";
  const at = link.lastIndexOf(marker);
  if (at < 0 || at + marker.length >= link.length) {
    throw new Error("invitation link is missing a token");
  }
  return link.slice(at + marker.length);
}

function replaceTokenId(token: string, offset: number, id: string): string {
  const encoded = token.slice(3);
  const buf = Buffer.from(encoded, "base64url");
  if (buf.length !== 80) {
    throw new Error("invitation token payload length");
  }
  const hex = id.replaceAll("-", "");
  for (let i = 0; i < 16; i += 1) {
    buf[offset + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const next = `v1.${buf.toString("base64url")}`;
  const parsed = parseInvitationToken(next);
  if (parsed === "invalid") {
    throw new Error("tampered invitation token did not parse");
  }
  const got =
    offset === 0 ? parsed.orgId : offset === 16 ? parsed.communityId : parsed.invitationId;
  if (got !== id) {
    throw new Error("tampered invitation token kept the original id");
  }
  return next;
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

async function readAnswer(res: Response): Promise<Answer> {
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  const migration = createPlaintextDirectSql(loadRuntime().productOnlyUrl);
  try {
    await applyProductMigrations(migration);
  } finally {
    await migration.end({ timeout: 1 });
  }
}, 120_000);

describe("invitations and members-only access", () => {
  const runtime = loadRuntime();
  const identitySql = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
  const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  const kms = createLocalKmsPort();
  const otpMail = new MemoryMail();
  const invitationMail = new RecordingMail();
  const logLines: string[] = [];
  const secrets: string[] = [];
  const extraScopes: Scope[] = [];
  let server: Server;
  let tenantSeq = 0;
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  const checkout = async <T>(role: Role, run: (sql: never) => Promise<T>): Promise<T> => {
    if (role === "identity") {
      return run(identitySql as never);
    }
    if (role === "platform") {
      return run(platform as never);
    }
    return run(app as never);
  };

  function capture(args: unknown[]): void {
    logLines.push(
      args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
    );
  }

  function routeLog(message: string, fields: Record<string, unknown>): void {
    logLines.push(JSON.stringify({ message, ...fields }));
  }

  function remember(value: string): string {
    secrets.push(value);
    return value;
  }

  function uniqueSlug(prefix: string): string {
    tenantSeq += 1;
    const rand = newId().replace(/-/g, "").slice(16, 28);
    return `${prefix}${tenantSeq}${rand}`;
  }

  function uniqueEmail(prefix: string): string {
    return remember(`${uniqueSlug(prefix)}@example.test`);
  }

  async function cleanIdentity(): Promise<void> {
    await identitySql`delete from identity.sessions`;
    await identitySql`delete from identity.passkey_credentials`;
    await identitySql`delete from identity.passkey_challenges`;
    await identitySql`delete from identity.otp_challenges`;
    await identitySql`delete from identity.invitation_emails`;
    await identitySql`delete from identity.users`;
    await identitySql`delete from identity.identity_keys`;
  }

  async function inScope<T>(scope: Scope, run: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return withRequest({ requestId: REQUEST_ID }, () => withAppTransaction(app, scope, run));
  }

  async function createOrg(communityCount = 1): Promise<Org> {
    const organisationId = newId();
    const communities: Community[] = [];
    const orgSlug = uniqueSlug("org");
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${organisationId}, ${orgSlug}, 'au', 'implicit')
      `;
      for (let i = 0; i < communityCount; i += 1) {
        const communityId = newId();
        const slug = i === 0 ? orgSlug : uniqueSlug("com");
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, ${slug}, 'au')
        `;
        communities.push({ communityId, slug });
      }
    });
    const planKey = `plan_${organisationId.slice(0, 8)}`;
    const now = new Date();
    await upsertPlan(platform, {
      key: planKey,
      entitlements: [
        { key: "people.directory", limit: null },
        { key: "people.households", limit: null },
      ],
    });
    await assignPlan(platform, { organisationId, planKey, now });
    return { organisationId, communities };
  }

  function scopeOf(org: Org, index = 0): Scope {
    const community = org.communities[index];
    if (community === undefined) {
      throw new Error("community is missing");
    }
    return { orgId: org.organisationId, communityId: community.communityId };
  }

  async function createSession(email: string): Promise<Session> {
    const started = await readAnswer(
      await post(AUTH_HOSTNAME, "/v1/auth/email-otp/start", { email }),
    );
    expect(started.status).toBe(204);
    const verified = await readAnswer(
      await post(AUTH_HOSTNAME, "/v1/auth/email-otp/verify", {
        email,
        code: otpMail.last?.code ?? "",
      }),
    );
    expect(verified.status).toBe(200);
    const session = JSON.parse(verified.text) as { userId: string; accessToken: string };
    return { userId: session.userId, bearer: `Bearer ${session.accessToken}`, email };
  }

  async function setupOwner(org: Org, email = uniqueEmail("owner")): Promise<Session> {
    const user = await createSession(email);
    const now = new Date();
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeOf(org), (tx) =>
        bootstrapOwner(tx, { now, userId: user.userId, actorUserId: user.userId }),
      ),
    );
    return user;
  }

  async function createAdult(org: Org, actorUserId: string): Promise<string> {
    let personId = "";
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeOf(org), async (tx) => {
        const person = await createPerson(tx, kms, KEY_ARN, {
          now: new Date(),
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "Nia",
          familyName: "Pell",
          email: null,
          phone: null,
          actorUserId,
        });
        personId = person.personId;
      }),
    );
    return personId;
  }

  async function api(pathName: string, body: unknown, bearer?: string): Promise<Answer> {
    return readAnswer(await post(API_HOSTNAME, pathName, body, bearer));
  }

  async function invite(
    org: Org,
    bearer: string,
    email: string,
    extra: { roleKey?: string; personId?: string } = {},
  ): Promise<{ invitationId: string; token: string }> {
    const created = await api(
      "/v1/access/invitations/create",
      {
        communitySlug: org.communities[0]!.slug,
        email,
        ...extra,
      },
      bearer,
    );
    expect(created.status, created.text).toBe(201);
    const body = JSON.parse(created.text) as { invitationId: string };
    const last = invitationMail.sent.at(-1);
    if (last === undefined || last.to !== email) {
      throw new Error("invitation mail was not recorded");
    }
    return { invitationId: body.invitationId, token: remember(tokenFrom(last.link)) };
  }

  async function auditCount(scope: Scope): Promise<number> {
    const rows = await inScope(
      scope,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.audit_events`,
    );
    return rows[0]?.n ?? 0;
  }

  async function counted(
    scope: Scope,
    table: "app.organisation_members" | "app.community_role_grants" | "app.user_links",
    userId: string,
  ): Promise<number> {
    const rows = await inScope(scope, (tx) => {
      if (table === "app.organisation_members") {
        return tx<{ n: number }[]>`
          select count(*)::int as n
          from app.organisation_members
          where user_id = ${userId}::uuid
        `;
      }
      if (table === "app.community_role_grants") {
        return tx<{ n: number }[]>`
          select count(*)::int as n
          from app.community_role_grants
          where user_id = ${userId}::uuid
        `;
      }
      return tx<{ n: number }[]>`
        select count(*)::int as n from app.user_links where user_id = ${userId}::uuid
      `;
    });
    return rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    await cleanIdentity();
    console.log = (...args: unknown[]) => {
      capture(args);
      originalConsole.log(...args);
    };
    console.info = (...args: unknown[]) => {
      capture(args);
      originalConsole.info(...args);
    };
    console.warn = (...args: unknown[]) => {
      capture(args);
      originalConsole.warn(...args);
    };
    console.error = (...args: unknown[]) => {
      capture(args);
      originalConsole.error(...args);
    };
    // Invitation routes read the session and the invitation expiry on a wall clock.
    // Identity compares expires_at with the database clock.
    const wall = () => new Date();
    server = startServer({
      env: envFor(PORT),
      routes: [
        ...authRoutes({
          checkout,
          kms,
          keyArn: KEY_ARN,
          mail: otpMail,
          now: wall,
          authHostname: AUTH_HOSTNAME,
          log: routeLog,
        }),
        ...accessRoutes({
          checkout,
          kms,
          keyArn: KEY_ARN,
          now: wall,
          apiHostname: API_HOSTNAME,
          log: routeLog,
          guardLog: routeLog,
        }),
        ...invitationRoutes({
          checkout,
          kms,
          keyArn: KEY_ARN,
          now: wall,
          apiHostname: API_HOSTNAME,
          adminOrigin: ADMIN_ORIGIN,
          mail: invitationMail,
          log: routeLog,
          guardLog: routeLog,
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
  }, 120_000);

  afterAll(async () => {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    await cleanIdentity();
    await identitySql.end({ timeout: 1 });
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
  }, 120_000);

  it("happy path: invite with a role and a contact, then accept", async () => {
    const org = await createOrg(2);
    const owner = await setupOwner(org);
    const personId = await createAdult(org, owner.userId);
    const inviteeEmail = uniqueEmail("invitee");
    const created = await invite(org, owner.bearer, inviteeEmail, {
      roleKey: "member",
      personId,
    });
    const invitee = await createSession(inviteeEmail);

    const accepted = await api("/v1/invitations/accept", { token: created.token }, invitee.bearer);
    expect(accepted.status, accepted.text).toBe(200);
    expect(JSON.parse(accepted.text)).toEqual({ communitySlug: org.communities[0]!.slug });

    const scope = scopeOf(org);
    const members = await inScope(
      scope,
      (tx) =>
        tx<{ source: string; invitation_id: string }[]>`
        select source, invitation_id::text as invitation_id
        from app.organisation_members
        where user_id = ${invitee.userId}::uuid
      `,
    );
    expect(members).toEqual([{ source: "invitation", invitation_id: created.invitationId }]);

    const grants = await inScope(
      scope,
      (tx) =>
        tx<{ role_key: string | null }[]>`
        select role_key
        from app.community_role_grants
        where user_id = ${invitee.userId}::uuid
      `,
    );
    expect(grants).toEqual([{ role_key: "member" }]);

    const links = await inScope(
      scope,
      (tx) =>
        tx<{ person_id: string }[]>`
        select person_id::text as person_id
        from app.user_links
        where user_id = ${invitee.userId}::uuid
      `,
    );
    expect(links).toEqual([{ person_id: personId }]);

    const listed = await api(
      "/v1/access/users/list",
      { communitySlug: org.communities[0]!.slug },
      owner.bearer,
    );
    expect(listed.status).toBe(200);
    const users = JSON.parse(listed.text) as ListUsersResponse;
    expect(listUsersResponse.safeParse(users).success).toBe(true);
    expect(users.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: invitee.userId,
          personId,
          email: inviteeEmail,
        }),
      ]),
    );

    const pending = await api(
      "/v1/access/invitations/list",
      { communitySlug: org.communities[0]!.slug },
      owner.bearer,
    );
    expect(pending.status).toBe(200);
    expect(JSON.parse(pending.text)).toEqual({ invitations: [] });

    const address = await identitySql<
      {
        email: Uint8Array | null;
        email_bidx: Uint8Array | null;
        dedupe_key: Uint8Array | null;
        closed_at: Date | null;
      }[]
    >`
      select email, email_bidx, dedupe_key, closed_at
      from identity.invitation_emails
      where invitation_id = ${created.invitationId}::uuid
    `;
    expect(address).toHaveLength(1);
    expect(address[0]!.email).toBeNull();
    expect(address[0]!.email_bidx).toBeNull();
    expect(address[0]!.dedupe_key).toBeNull();
    expect(address[0]!.closed_at).not.toBeNull();
  }, 60_000);

  it("pin 12: three non-member ids get byte-identical 422 bodies and no grant rows", async () => {
    const orgA = await createOrg(2);
    const ownerA = await setupOwner(orgA);
    const orgB = await createOrg(1);
    const ownerB = await setupOwner(orgB);
    const stranger = await createSession(uniqueEmail("stranger"));
    const randomId = newId();
    const ids = [ownerB.userId, randomId, stranger.userId];

    const answers: Answer[] = [];
    for (const userId of ids) {
      answers.push(
        await api(
          "/v1/access/grants",
          { communitySlug: orgA.communities[0]!.slug, userId, roleKey: "member" },
          ownerA.bearer,
        ),
      );
    }

    expect(answers.map((answer) => answer.status)).toEqual([422, 422, 422]);
    expect(answers[0]!.text).toBe(answers[1]!.text);
    expect(answers[1]!.text).toBe(answers[2]!.text);
    expect(answers[0]!.text).toBe('{"error":"user_not_member"}');

    const scope = scopeOf(orgA);
    const grants = await inScope(
      scope,
      (tx) =>
        tx<{ n: number }[]>`
        select (
          (select count(*) from app.community_role_grants where user_id = any(${ids}::uuid[]))
          + (select count(*) from app.organisation_role_grants where user_id = any(${ids}::uuid[]))
        )::int as n
      `,
    );
    expect(grants[0]!.n).toBe(0);
  }, 60_000);

  it("org isolation: organisation A never lists or decrypts organisation B", async () => {
    const orgA = await createOrg(2);
    const ownerA = await setupOwner(orgA);
    const orgB = await createOrg(1);
    const ownerB = await setupOwner(orgB);
    const userB = await createSession(uniqueEmail("memberb"));
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeOf(orgB), (tx) => addMember(tx, userB.userId)),
    );
    const granted = await api(
      "/v1/access/grants",
      { communitySlug: orgB.communities[0]!.slug, userId: userB.userId, roleKey: "member" },
      ownerB.bearer,
    );
    expect(granted.status, granted.text).toBe(200);

    const spy = vi.spyOn(identity, "readUserEmails");
    spy.mockClear();
    try {
      const listed = await api(
        "/v1/access/users/list",
        { communitySlug: orgA.communities[0]!.slug },
        ownerA.bearer,
      );
      expect(listed.status).toBe(200);
      const body = JSON.parse(listed.text) as ListUsersResponse;
      const ids = body.users.map((user) => user.userId);
      expect(ids).toContain(ownerA.userId);
      expect(ids).not.toContain(ownerB.userId);
      expect(ids).not.toContain(userB.userId);
      const seen = spy.mock.calls.flatMap((call) => [...(call[3] as readonly string[])]);
      expect(seen).toContain(ownerA.userId);
      expect(seen).not.toContain(ownerB.userId);
      expect(seen).not.toContain(userB.userId);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it("pin 44: a valid token in a billing read-only organisation answers 402 and writes nothing", async () => {
    const org = await createOrg(1);
    const owner = await setupOwner(org);
    const inviteeEmail = uniqueEmail("readonly");
    const created = await invite(org, owner.bearer, inviteeEmail, { roleKey: "member" });
    const invitee = await createSession(inviteeEmail);
    const marker = newId().replaceAll("-", "");
    await platform`
      insert into platform.billing_accounts (
        organisation_id, mode, stripe_customer_id, stripe_subscription_id, stripe_status
      ) values (
        ${org.organisationId}::uuid,
        'self_serve',
        ${`cus_${marker}`},
        ${`sub_${marker}`},
        'canceled'
      )
    `;

    const accepted = await api("/v1/invitations/accept", { token: created.token }, invitee.bearer);
    expect(accepted.status).toBe(402);
    expect(accepted.text).toBe("");

    const scope = scopeOf(org);
    const rows = await inScope(
      scope,
      (tx) =>
        tx<{ status: string }[]>`
        select status from app.invitations where id = ${created.invitationId}::uuid
      `,
    );
    expect(rows).toEqual([{ status: "pending" }]);
    expect(await counted(scope, "app.organisation_members", invitee.userId)).toBe(0);
    expect(await counted(scope, "app.community_role_grants", invitee.userId)).toBe(0);
    expect(await counted(scope, "app.user_links", invitee.userId)).toBe(0);
  }, 60_000);

  it("forged and tampered tokens answer 404 invitation_invalid with no audit row", async () => {
    const orgA = await createOrg(1);
    const ownerA = await setupOwner(orgA);
    const orgB = await createOrg(1);
    await setupOwner(orgB);
    const created = await invite(orgA, ownerA.bearer, uniqueEmail("forged"), { roleKey: "member" });
    const scopeA = scopeOf(orgA);
    const scopeB = scopeOf(orgB);
    const beforeA = await auditCount(scopeA);
    const beforeB = await auditCount(scopeB);

    const replay = replaceTokenId(
      replaceTokenId(created.token, 0, orgB.organisationId),
      16,
      orgB.communities[0]!.communityId,
    );
    const tamperedOrg = replaceTokenId(created.token, 0, newId());
    const tamperedCommunity = replaceTokenId(created.token, 16, newId());
    const tamperedInvitation = replaceTokenId(created.token, 32, newId());
    for (const token of [replay, tamperedOrg, tamperedCommunity, tamperedInvitation]) {
      remember(token);
    }
    const parsedOrg = parseInvitationToken(tamperedOrg);
    const parsedCommunity = parseInvitationToken(tamperedCommunity);
    if (parsedOrg === "invalid" || parsedCommunity === "invalid") {
      throw new Error("tampered invitation token did not parse");
    }
    extraScopes.push(
      { orgId: parsedOrg.orgId, communityId: parsedOrg.communityId },
      { orgId: parsedCommunity.orgId, communityId: parsedCommunity.communityId },
    );

    for (const token of [replay, tamperedOrg, tamperedCommunity, tamperedInvitation]) {
      const accepted = await api("/v1/invitations/accept", { token }, ownerA.bearer);
      expect(accepted.status).toBe(404);
      expect(accepted.text).toBe('{"error":"invitation_invalid"}');
    }

    expect(await auditCount(scopeA)).toBe(beforeA);
    expect(await auditCount(scopeB)).toBe(beforeB);
  }, 60_000);

  it("wrong address: another signed-in user gets 403 and the invitation stays pending", async () => {
    const org = await createOrg(1);
    const owner = await setupOwner(org);
    const created = await invite(org, owner.bearer, uniqueEmail("intended"), { roleKey: "member" });
    const other = await createSession(uniqueEmail("other"));

    const accepted = await api("/v1/invitations/accept", { token: created.token }, other.bearer);
    expect(accepted.status).toBe(403);
    expect(accepted.text).toBe('{"error":"wrong_address"}');

    const scope = scopeOf(org);
    const rows = await inScope(
      scope,
      (tx) =>
        tx<{ status: string }[]>`
        select status from app.invitations where id = ${created.invitationId}::uuid
      `,
    );
    expect(rows).toEqual([{ status: "pending" }]);
    expect(await counted(scope, "app.organisation_members", other.userId)).toBe(0);
    expect(await counted(scope, "app.community_role_grants", other.userId)).toBe(0);
    expect(await counted(scope, "app.user_links", other.userId)).toBe(0);
  }, 60_000);

  it("void persists: a step 5 failure answers 409 invitation_void and commits the void", async () => {
    const org = await createOrg(1);
    const owner = await setupOwner(org);
    const slug = org.communities[0]!.slug;
    const usersRole = await api(
      "/v1/access/custom-roles",
      {
        communitySlug: slug,
        key: "invite_users",
        permissions: ["access.users.manage", "access.users.view"],
      },
      owner.bearer,
    );
    expect(usersRole.status, usersRole.text).toBe(200);
    const rolesRole = await api(
      "/v1/access/custom-roles",
      {
        communitySlug: slug,
        key: "invite_roles",
        permissions: ["access.roles.manage"],
      },
      owner.bearer,
    );
    expect(rolesRole.status, rolesRole.text).toBe(200);
    const usersRoleId = (JSON.parse(usersRole.text) as { customRoleId: string }).customRoleId;
    const rolesRoleId = (JSON.parse(rolesRole.text) as { customRoleId: string }).customRoleId;

    const inviter = await createSession(uniqueEmail("inviter"));
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeOf(org), (tx) => addMember(tx, inviter.userId)),
    );
    const usersGrant = await api(
      "/v1/access/grants",
      { communitySlug: slug, userId: inviter.userId, customRoleId: usersRoleId },
      owner.bearer,
    );
    expect(usersGrant.status, usersGrant.text).toBe(200);
    const rolesGrant = await api(
      "/v1/access/grants",
      { communitySlug: slug, userId: inviter.userId, customRoleId: rolesRoleId },
      owner.bearer,
    );
    expect(rolesGrant.status, rolesGrant.text).toBe(200);
    const usersGrantId = (JSON.parse(usersGrant.text) as { grantId: string }).grantId;

    const inviteeEmail = uniqueEmail("voided");
    const created = await invite(org, inviter.bearer, inviteeEmail, { roleKey: "member" });
    const revoked = await api(
      "/v1/access/grants/revoke",
      { communitySlug: slug, grantId: usersGrantId, scope: "community" },
      owner.bearer,
    );
    expect(revoked.status, revoked.text).toBe(200);

    const invitee = await createSession(inviteeEmail);
    const accepted = await api("/v1/invitations/accept", { token: created.token }, invitee.bearer);
    expect(accepted.status).toBe(409);
    expect(accepted.text).toBe('{"error":"invitation_void"}');

    const scope = scopeOf(org);
    const rows = await inScope(
      scope,
      (tx) =>
        tx<{ status: string }[]>`
        select status from app.invitations where id = ${created.invitationId}::uuid
      `,
    );
    expect(rows).toEqual([{ status: "void" }]);
    const voided = await inScope(
      scope,
      (tx) =>
        tx<{ n: number }[]>`
        select count(*)::int as n
        from app.audit_events
        where action = 'access.invitation.voided'
      `,
    );
    expect(voided[0]!.n).toBe(1);
    const address = await identitySql<{ closed_at: Date | null; email: Uint8Array | null }[]>`
      select closed_at, email
      from identity.invitation_emails
      where invitation_id = ${created.invitationId}::uuid
    `;
    expect(address).toHaveLength(1);
    expect(address[0]!.email).toBeNull();
    expect(address[0]!.closed_at).not.toBeNull();
  }, 60_000);

  it("route denials are audited in the database", async () => {
    const org = await createOrg(1);
    const owner = await setupOwner(org);
    const slug = org.communities[0]!.slug;
    const personId = await createAdult(org, owner.userId);
    const role = await api(
      "/v1/access/custom-roles",
      {
        communitySlug: slug,
        key: "limited_staff",
        permissions: ["access.users.manage", "access.users.view"],
      },
      owner.bearer,
    );
    expect(role.status, role.text).toBe(200);
    const customRoleId = (JSON.parse(role.text) as { customRoleId: string }).customRoleId;
    const member = await createSession(uniqueEmail("limited"));
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, scopeOf(org), (tx) => addMember(tx, member.userId)),
    );
    const granted = await api(
      "/v1/access/grants",
      { communitySlug: slug, userId: member.userId, customRoleId },
      owner.bearer,
    );
    expect(granted.status, granted.text).toBe(200);

    const created = await api(
      "/v1/access/invitations/create",
      { communitySlug: slug, email: uniqueEmail("contact"), personId },
      member.bearer,
    );
    expect(created.status).toBe(403);
    expect(created.text).toBe("");
    const scope = scopeOf(org);
    const createDenied = await inScope(
      scope,
      (tx) =>
        tx<{ n: number }[]>`
        select count(*)::int as n
        from app.audit_events
        where action = 'access.permission.denied'
          and purpose = 'people.person.view'
      `,
    );
    expect(createDenied[0]!.n).toBe(1);

    const listed = await api("/v1/access/invitations/list", { communitySlug: slug }, member.bearer);
    expect(listed.status).toBe(403);
    expect(listed.text).toBe("");
    const listDenied = await inScope(
      scope,
      (tx) =>
        tx<{ n: number }[]>`
        select count(*)::int as n
        from app.audit_events
        where action = 'access.permission.denied'
          and purpose = 'access.roles.view'
      `,
    );
    expect(listDenied[0]!.n).toBe(1);
  }, 60_000);

  it("already invited rolls back to one invitation and one created audit row", async () => {
    const org = await createOrg(1);
    const owner = await setupOwner(org);
    const email = uniqueEmail("twice");
    const created = await invite(org, owner.bearer, email, { roleKey: "member" });
    const again = await api(
      "/v1/access/invitations/create",
      { communitySlug: org.communities[0]!.slug, email, roleKey: "member" },
      owner.bearer,
    );
    expect(again.status).toBe(409);
    expect(again.text).toBe('{"error":"already_invited"}');

    const scope = scopeOf(org);
    const invitations = await inScope(
      scope,
      (tx) => tx<{ id: string }[]>`select id::text as id from app.invitations`,
    );
    expect(invitations).toEqual([{ id: created.invitationId }]);
    const audits = await inScope(
      scope,
      (tx) =>
        tx<{ n: number }[]>`
        select count(*)::int as n
        from app.audit_events
        where action = 'access.invitation.created'
      `,
    );
    expect(audits[0]!.n).toBe(1);
  }, 60_000);

  it("resend rotates the token and revoke closes the address", async () => {
    const org = await createOrg(1);
    const owner = await setupOwner(org);
    const slug = org.communities[0]!.slug;
    const inviteeEmail = uniqueEmail("resend");
    const created = await invite(org, owner.bearer, inviteeEmail, { roleKey: "member" });
    const invitee = await createSession(inviteeEmail);
    const scope = scopeOf(org);
    const before = await inScope(
      scope,
      (tx) =>
        tx<{ token_hash: Uint8Array }[]>`
        select token_hash from app.invitations where id = ${created.invitationId}::uuid
      `,
    );
    const sentBefore = invitationMail.sent.length;

    const resent = await api(
      "/v1/access/invitations/resend",
      { communitySlug: slug, invitationId: created.invitationId },
      owner.bearer,
    );
    expect(resent.status).toBe(204);
    expect(resent.text).toBe("");
    expect(invitationMail.sent.length).toBe(sentBefore + 1);
    const resentToken = remember(tokenFrom(invitationMail.sent.at(-1)!.link));
    expect(resentToken).not.toBe(created.token);
    const after = await inScope(
      scope,
      (tx) =>
        tx<{ token_hash: Uint8Array }[]>`
        select token_hash from app.invitations where id = ${created.invitationId}::uuid
      `,
    );
    expect(Buffer.from(after[0]!.token_hash).equals(Buffer.from(before[0]!.token_hash))).toBe(
      false,
    );

    const stale = await api("/v1/invitations/accept", { token: created.token }, invitee.bearer);
    expect(stale.status).toBe(404);
    expect(stale.text).toBe('{"error":"invitation_invalid"}');

    const revoked = await api(
      "/v1/access/invitations/revoke",
      { communitySlug: slug, invitationId: created.invitationId },
      owner.bearer,
    );
    expect(revoked.status).toBe(204);
    expect(revoked.text).toBe("");
    const rows = await inScope(
      scope,
      (tx) =>
        tx<{ status: string }[]>`
        select status from app.invitations where id = ${created.invitationId}::uuid
      `,
    );
    expect(rows).toEqual([{ status: "revoked" }]);
    const address = await identitySql<{ closed_at: Date | null; email: Uint8Array | null }[]>`
      select closed_at, email
      from identity.invitation_emails
      where invitation_id = ${created.invitationId}::uuid
    `;
    expect(address[0]!.email).toBeNull();
    expect(address[0]!.closed_at).not.toBeNull();
    const pending = await api("/v1/access/invitations/list", { communitySlug: slug }, owner.bearer);
    expect(pending.status).toBe(200);
    expect(JSON.parse(pending.text)).toEqual({ invitations: [] });
  }, 60_000);

  it("mail failure: create answers 503 with no invitation row and resend voids", async () => {
    const org = await createOrg(1);
    const owner = await setupOwner(org);
    const slug = org.communities[0]!.slug;
    const scope = scopeOf(org);
    const beforeIds = new Set(
      (
        await identitySql<{ id: string }[]>`
          select invitation_id::text as id from identity.invitation_emails
        `
      ).map((row) => row.id),
    );
    const beforeApp = await inScope(
      scope,
      (tx) => tx<{ id: string }[]>`select id::text as id from app.invitations`,
    );

    invitationMail.fail = true;
    try {
      const created = await api(
        "/v1/access/invitations/create",
        { communitySlug: slug, email: uniqueEmail("bounced"), roleKey: "member" },
        owner.bearer,
      );
      expect(created.status).toBe(503);
      expect(created.text).toBe("");
    } finally {
      invitationMail.fail = false;
    }

    const afterApp = await inScope(
      scope,
      (tx) => tx<{ id: string }[]>`select id::text as id from app.invitations`,
    );
    expect(afterApp).toEqual(beforeApp);
    const addresses = await identitySql<
      { id: string; email: Uint8Array | null; closed_at: Date | null }[]
    >`
      select invitation_id::text as id, email, closed_at
      from identity.invitation_emails
    `;
    for (const row of addresses) {
      if (beforeIds.has(row.id)) {
        continue;
      }
      expect(row.email).toBeNull();
      expect(row.closed_at).not.toBeNull();
    }

    const liveEmail = uniqueEmail("live");
    const live = await invite(org, owner.bearer, liveEmail, { roleKey: "member" });
    invitationMail.fail = true;
    try {
      const resent = await api(
        "/v1/access/invitations/resend",
        { communitySlug: slug, invitationId: live.invitationId },
        owner.bearer,
      );
      expect(resent.status).toBe(503);
      expect(resent.text).toBe("");
    } finally {
      invitationMail.fail = false;
    }
    const voided = await inScope(
      scope,
      (tx) =>
        tx<{ status: string }[]>`
        select status from app.invitations where id = ${live.invitationId}::uuid
      `,
    );
    expect(voided).toEqual([{ status: "void" }]);
  }, 60_000);

  it("no leaks: no log line and no audit row contains a fixture address or an issued token", async () => {
    expect(secrets.length).toBeGreaterThan(0);
    const direct = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const rows = await direct<{ payload: unknown }[]>`
        select to_jsonb(a) as payload from app.audit_events a
      `;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const serialized = JSON.stringify(row.payload);
        for (const secret of secrets) {
          if (serialized.includes(secret)) {
            throw new Error("a fixture address or token matched an audit row");
          }
        }
      }
    } finally {
      await direct.end({ timeout: 1 });
    }
    for (const scope of extraScopes) {
      const rows = await inScope(
        scope,
        (tx) => tx<{ payload: unknown }[]>`select to_jsonb(a) as payload from app.audit_events a`,
      );
      for (const row of rows) {
        const serialized = JSON.stringify(row.payload);
        for (const secret of secrets) {
          if (serialized.includes(secret)) {
            throw new Error("a fixture address or token matched an audit row");
          }
        }
      }
    }
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      for (const secret of secrets) {
        if (line.includes(secret)) {
          throw new Error("a fixture address or token matched a log line");
        }
      }
    }
  }, 60_000);
});
