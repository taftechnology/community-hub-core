import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, createCustomRole, grantRole } from "@community-hub/access";
import { addMember } from "@community-hub/access/testing";
import {
  deletedPeopleListResponse,
  personDeleteResponse,
  personRestoreResponse,
} from "@community-hub/contracts/people";
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
  hidePerson,
  linkGuardian,
} from "@community-hub/people";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { armed } = vi.hoisted(() => ({
  armed: { purgeSecret: "", deadlock: false },
}));

vi.mock("@community-hub/people", async (importActual) => {
  const actual = await importActual<typeof import("@community-hub/people")>();
  return {
    ...actual,
    purgeDeletedPersons: async (...args: Parameters<typeof actual.purgeDeletedPersons>) => {
      if (armed.purgeSecret !== "") {
        throw new Error(`purge failure carrying secret: ${armed.purgeSecret}`);
      }
      return actual.purgeDeletedPersons(...args);
    },
    hidePerson: async (...args: Parameters<typeof actual.hidePerson>) => {
      if (armed.deadlock) {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }
      return actual.hidePerson(...args);
    },
  };
});

import type { Role } from "./checkout.js";
import { readServiceEnv, type ServiceEnv } from "./env.js";
import { householdRoutes } from "./household-routes.js";
import { peopleRoutes, type PeopleLog } from "./people-routes.js";
import { startServer } from "./server.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");

const API_HOSTNAME = "au.api.example.test";
const PORT = 18491;
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
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

// The body as the client sees it: parsed JSON, or the text "<empty>" when there is none. A missing
// body then fails the assertion on the code instead of throwing from inside the test.
async function codeBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") {
    return "<empty>";
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return "<not json>";
  }
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

type PersonState = {
  exists: boolean;
  version: number | null;
  deletedAt: Date | null;
  deletedBy: string | null;
};

describe("contact delete routes against a real database", () => {
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

  const now = new Date("2026-10-11T00:00:00.000Z");

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

  const log: PeopleLog = (message, fields) => {
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

    const deps = {
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
      routes: [...peopleRoutes(deps), ...householdRoutes(deps)],
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
    const slug = `del-${prefix}-${counter}-${orgId.slice(0, 8)}`;
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

  async function memberCaller(org: Org): Promise<Session> {
    counter += 1;
    const session = await signIn(`member-${counter}-${org.orgId.slice(0, 8)}@example.test`);
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        await addMember(tx, session.userId);
        await grantRole(tx, {
          now,
          userId: session.userId,
          roleKey: "member",
          customRoleId: null,
          actorUserId: org.owner.userId,
        });
      }),
    );
    return session;
  }

  async function addAdult(
    org: Org,
    givenName: string,
    options: { email?: string | null; householdId?: string | null } = {},
  ): Promise<string> {
    return withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        const created = await createPerson(tx, kms, KEY_ARN, {
          now,
          declaredAdult: true,
          householdId: options.householdId ?? null,
          dateOfBirth: null,
          givenName,
          familyName: "Example",
          email: options.email ?? null,
          phone: null,
          actorUserId: org.owner.userId,
        });
        return created.personId;
      }),
    );
  }

  async function addHousehold(org: Org): Promise<string> {
    return withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        const household = await createHousehold(tx, kms, KEY_ARN, {
          now,
          label: "Delete Test Family",
          actorUserId: org.owner.userId,
        });
        return household.householdId;
      }),
    );
  }

  async function addChild(
    org: Org,
    householdId: string,
    guardianId: string,
  ): Promise<{ minorId: string }> {
    return withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        const minor = await addMinor(tx, kms, KEY_ARN, {
          now,
          householdId,
          givenName: "Child",
          familyName: "Example",
          dateOfBirth: "2018-03-04",
          guardianId,
          actorUserId: org.owner.userId,
        });
        return { minorId: minor.personId };
      }),
    );
  }

  async function addCoGuardian(
    org: Org,
    householdId: string,
    guardianId: string,
    childId: string,
  ): Promise<void> {
    await withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        await linkGuardian(tx, {
          now,
          householdId,
          guardianPersonId: guardianId,
          childPersonId: childId,
          consent: true,
          pickup: false,
          view: true,
          manage: false,
          actorUserId: org.owner.userId,
        });
      }),
    );
  }

  async function hide(org: Org, personId: string): Promise<{ version: number }> {
    // Seeding hides through the module itself, with the real hidePerson: the mock above only
    // fails when `armed.deadlock` is set, and no test arms it while seeding.
    return withRequest({ requestId: REQUEST_ID }, () =>
      withAppTransaction(app, { orgId: org.orgId, communityId: org.communityId }, async (tx) => {
        const result = await hidePerson(tx, { personId, actorUserId: org.owner.userId });
        return { version: result.version };
      }),
    );
  }

  // A committed, short migrator transaction (plan Global constraints): create the contact
  // normally, then age it past 720 hours with the trigger off.
  async function age(org: Org, personId: string, hours = 721): Promise<void> {
    await withAppTransaction(
      migrator,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        await tx.unsafe("ALTER TABLE app.persons DISABLE TRIGGER USER");
        await tx`
          update app.persons
          set deleted_at = now() - (${hours} * interval '1 hour'),
              deleted_by = ${org.owner.userId}::uuid
          where id = ${personId}::uuid
        `;
        await tx.unsafe("ALTER TABLE app.persons ENABLE TRIGGER USER");
      },
    );
  }

  async function agedContact(org: Org, givenName = "Aged"): Promise<string> {
    const personId = await addAdult(org, givenName);
    await age(org, personId);
    return personId;
  }

  async function stateOf(org: Org, personId: string): Promise<PersonState> {
    return withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        const rows = await tx<
          { version: number; deleted_at: Date | null; deleted_by: string | null }[]
        >`
          select version, deleted_at, deleted_by::text as deleted_by
          from app.persons
          where id = ${personId}::uuid
        `;
        const row = rows[0];
        if (row === undefined) {
          return { exists: false, version: null, deletedAt: null, deletedBy: null };
        }
        return {
          exists: true,
          version: row.version,
          deletedAt: row.deleted_at,
          deletedBy: row.deleted_by,
        };
      },
    );
  }

  async function auditRows(
    org: Org,
    action: string,
  ): Promise<
    { action: string; purpose: string; actorKind: string; actorId: string | null; ids: string[] }[]
  > {
    return withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        const rows = await tx<
          {
            action: string;
            purpose: string;
            actor_kind: string;
            actor_id: string | null;
            target_ids: string[];
          }[]
        >`
          select action, purpose, actor_kind, actor_id::text as actor_id, target_ids
          from app.audit_events
          where action = ${action}
          order by occurred_at asc
        `;
        return rows.map((row) => ({
          action: row.action,
          purpose: row.purpose,
          actorKind: row.actor_kind,
          actorId: row.actor_id,
          ids: row.target_ids,
        }));
      },
    );
  }

  async function personCount(org: Org): Promise<number> {
    return withAppTransaction(
      app,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        const rows = await tx<{ n: number }[]>`select count(*)::int as n from app.persons`;
        return rows[0]!.n;
      },
    );
  }

  function del(org: Org, token: string, personId: string, version: number): Promise<Response> {
    return post("/v1/people/delete", { communitySlug: org.slug, personId, version }, token);
  }

  function restore(org: Org, token: string, personId: string, version: number): Promise<Response> {
    return post("/v1/people/restore", { communitySlug: org.slug, personId, version }, token);
  }

  function list(org: Org, token: string, body: Record<string, unknown> = {}): Promise<Response> {
    return post("/v1/people/list", { communitySlug: org.slug, ...body }, token);
  }

  async function deniedRows(org: Org, userId: string) {
    const rows = await auditRows(org, "people.permission.denied");
    return rows.filter((row) => row.actorId === userId);
  }

  it("delete hides an adult, answers its purge date and writes one audit event", async () => {
    const org = await createOrg("del-ok");
    const personId = await addAdult(org, "Hidden");

    const res = await del(org, org.owner.accessToken, personId, 1);
    expect(res.status).toBe(200);
    const body = personDeleteResponse.parse(await res.json());
    expect(body.personId).toBe(personId);
    expect(body.version).toBe(2);

    const state = await stateOf(org, personId);
    expect(state.deletedAt).not.toBeNull();
    expect(state.deletedBy).toBe(org.owner.userId);
    expect(state.version).toBe(2);
    expect(new Date(body.purgeAfter).getTime() - state.deletedAt!.getTime()).toBe(HOURS_720_MS);

    const events = await auditRows(org, "people.person.deleted");
    expect(events).toHaveLength(1);
    expect(events[0]!.ids).toEqual([personId]);
    expect(events[0]!.actorId).toBe(org.owner.userId);

    const listed = await list(org, org.owner.accessToken);
    const items = ((await listed.json()) as { items: { personId: string }[] }).items;
    expect(items.map((item) => item.personId)).not.toContain(personId);
  });

  it("restore brings a hidden contact back and answers its version", async () => {
    const org = await createOrg("restore-ok");
    const personId = await addAdult(org, "Restorable");
    const hidden = await hide(org, personId);

    const res = await restore(org, org.owner.accessToken, personId, hidden.version);
    expect(res.status).toBe(200);
    const body = personRestoreResponse.parse(await res.json());
    expect(body).toEqual({ personId, version: hidden.version + 1 });

    const state = await stateOf(org, personId);
    expect(state.deletedAt).toBeNull();
    expect(state.deletedBy).toBeNull();
    expect(state.version).toBe(hidden.version + 1);

    const events = await auditRows(org, "people.person.restored");
    expect(events).toHaveLength(1);
    expect(events[0]!.ids).toEqual([personId]);

    const listed = await list(org, org.owner.accessToken);
    const items = ((await listed.json()) as { items: { personId: string }[] }).items;
    expect(items.map((item) => item.personId)).toContain(personId);
  });

  it("delete answers 403 to a people.manage holder without people.delete", async () => {
    const org = await createOrg("pin72");
    const caller = await customCaller(org, ["people.view", "people.manage"]);
    const personId = await addAdult(org, "Target");
    const before = await stateOf(org, personId);
    expect(await deniedRows(org, caller.userId)).toHaveLength(0);

    const res = await del(org, caller.accessToken, personId, 1);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");

    expect(await stateOf(org, personId)).toEqual(before);
    const denied = await deniedRows(org, caller.userId);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.purpose).toBe("people.permission.denied");
    expect(denied[0]!.ids).toEqual([org.orgId, org.communityId]);
  });

  it("delete answers 403 to a people.delete holder without people.view", async () => {
    const org = await createOrg("pin73");
    const caller = await customCaller(org, ["people.delete"]);
    const personId = await addAdult(org, "Target");
    const before = await stateOf(org, personId);
    expect(await deniedRows(org, caller.userId)).toHaveLength(0);

    const res = await del(org, caller.accessToken, personId, 1);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");

    expect(await stateOf(org, personId)).toEqual(before);
    const denied = await deniedRows(org, caller.userId);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.purpose).toBe("people.person.view");
    expect(denied[0]!.ids).toEqual([org.orgId, org.communityId]);
  });

  it("restore answers 403 without people.delete", async () => {
    const org = await createOrg("pin74");
    const caller = await customCaller(org, ["people.view"]);
    const personId = await addAdult(org, "Target");
    const hidden = await hide(org, personId);
    const before = await stateOf(org, personId);
    expect(await deniedRows(org, caller.userId)).toHaveLength(0);

    const res = await restore(org, caller.accessToken, personId, hidden.version);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");

    expect(await stateOf(org, personId)).toEqual(before);
    expect((await stateOf(org, personId)).deletedAt).not.toBeNull();
    const denied = await deniedRows(org, caller.userId);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.purpose).toBe("people.permission.denied");
  });

  it("restore answers 403 without people.view", async () => {
    const org = await createOrg("pin75");
    const caller = await customCaller(org, ["people.delete"]);
    const personId = await addAdult(org, "Target");
    const hidden = await hide(org, personId);
    const before = await stateOf(org, personId);
    expect(await deniedRows(org, caller.userId)).toHaveLength(0);

    const res = await restore(org, caller.accessToken, personId, hidden.version);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");

    expect(await stateOf(org, personId)).toEqual(before);
    expect((await stateOf(org, personId)).deletedAt).not.toBeNull();
    const denied = await deniedRows(org, caller.userId);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.purpose).toBe("people.person.view");
  });

  it("delete and restore answer 403 without the people.directory entitlement", async () => {
    const org = await createOrg("pin76", { entitlements: ["people.households"] });
    const visible = await addAdult(org, "Visible");
    const hiddenId = await addAdult(org, "Hidden");
    const hidden = await hide(org, hiddenId);
    const visibleBefore = await stateOf(org, visible);
    const hiddenBefore = await stateOf(org, hiddenId);

    const resDelete = await del(org, org.owner.accessToken, visible, 1);
    expect(resDelete.status).toBe(403);
    expect(await resDelete.text()).toBe("");
    const resRestore = await restore(org, org.owner.accessToken, hiddenId, hidden.version);
    expect(resRestore.status).toBe(403);
    expect(await resRestore.text()).toBe("");

    expect(await stateOf(org, visible)).toEqual(visibleBefore);
    expect(await stateOf(org, hiddenId)).toEqual(hiddenBefore);
  });

  it("delete answers 409 linked_user and 409 pending_invitation", async () => {
    const org = await createOrg("pin77");
    const linked = await addAdult(org, "Linked");
    const invited = await addAdult(org, "Invited");
    const expired = await addAdult(org, "Expired");

    const linkedUser = newId();
    await withAppTransaction(
      migrator,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        await tx`
          insert into app.organisation_members (org_id, user_id, source, created_at)
          values (${org.orgId}::uuid, ${linkedUser}::uuid, 'provision', now())
        `;
        await tx`
          insert into app.user_links (id, org_id, community_id, user_id, person_id)
          values (${newId()}::uuid, ${org.orgId}::uuid, ${org.communityId}::uuid, ${linkedUser}::uuid, ${linked}::uuid)
        `;
        await tx`
          insert into app.invitations (
            id, org_id, community_id, invited_by, token_hash, person_id,
            status, expires_at, resend_count, last_sent_at, created_at
          ) values
            (${newId()}::uuid, ${org.orgId}::uuid, ${org.communityId}::uuid, ${org.owner.userId}::uuid,
             ${Buffer.from("0123456789abcdef0123456789abcdef")}, ${invited}::uuid,
             'pending', now() + interval '7 days', 0, now(), now()),
            (${newId()}::uuid, ${org.orgId}::uuid, ${org.communityId}::uuid, ${org.owner.userId}::uuid,
             ${Buffer.from("fedcba9876543210fedcba9876543210")}, ${expired}::uuid,
             'pending', now() - interval '1 day', 0, now(), now())
        `;
      },
    );
    const linkedBefore = await stateOf(org, linked);
    const invitedBefore = await stateOf(org, invited);

    const resLinked = await del(org, org.owner.accessToken, linked, 1);
    expect(resLinked.status).toBe(409);
    expect(await codeBody(resLinked)).toEqual({ code: "linked_user" });

    const resInvited = await del(org, org.owner.accessToken, invited, 1);
    expect(resInvited.status).toBe(409);
    expect(await codeBody(resInvited)).toEqual({ code: "pending_invitation" });

    expect(await stateOf(org, linked)).toEqual(linkedBefore);
    expect(await stateOf(org, invited)).toEqual(invitedBefore);
    expect(await auditRows(org, "people.person.deleted")).toHaveLength(0);

    // An expired pending invitation does not block the delete.
    const resExpired = await del(org, org.owner.accessToken, expired, 1);
    expect(resExpired.status).toBe(200);
    expect((await stateOf(org, expired)).deletedAt).not.toBeNull();
  });

  it("delete answers 409 sole_guardian with the code in the body", async () => {
    const org = await createOrg("pin78");
    const householdId = await addHousehold(org);
    const guardianA = await addAdult(org, "GuardianA", { householdId });
    const guardianB = await addAdult(org, "GuardianB", { householdId });
    const { minorId } = await addChild(org, householdId, guardianA);
    await addCoGuardian(org, householdId, guardianB, minorId);

    // With two guardians, the first can be deleted.
    const first = await del(org, org.owner.accessToken, guardianA, 1);
    expect(first.status).toBe(200);
    expect((await stateOf(org, guardianA)).deletedAt).not.toBeNull();

    // The other is now the only unhidden guardian of the child.
    const beforeSole = await stateOf(org, guardianB);
    const minorBefore = await stateOf(org, minorId);
    const res = await del(org, org.owner.accessToken, guardianB, 1);
    expect(res.status).toBe(409);
    expect(await codeBody(res)).toEqual({ code: "sole_guardian" });
    expect(await stateOf(org, guardianB)).toEqual(beforeSole);
    expect(await stateOf(org, minorId)).toEqual(minorBefore);
    expect(await auditRows(org, "people.person.deleted")).toHaveLength(1);
  });

  it("delete maps a deadlock to an empty 409", async () => {
    const org = await createOrg("deadlock");
    const personId = await addAdult(org, "Contended");
    const before = await stateOf(org, personId);

    armed.deadlock = true;
    try {
      const res = await del(org, org.owner.accessToken, personId, 1);
      expect(res.status).toBe(409);
      expect(await res.text()).toBe("");
    } finally {
      armed.deadlock = false;
    }
    expect(await stateOf(org, personId)).toEqual(before);
  });

  it("delete and restore answer 404 for a minor, an unknown id, another community and the wrong state", async () => {
    const org = await createOrg("notfound");
    const other = await createOrg("notfound-other");
    const householdId = await addHousehold(org);
    const guardian = await addAdult(org, "Guardian", { householdId });
    const { minorId } = await addChild(org, householdId, guardian);
    const visible = await addAdult(org, "Visible");
    const hiddenId = await addAdult(org, "Hidden");
    const hidden = await hide(org, hiddenId);
    const foreign = await addAdult(other, "Foreign");

    const minorBefore = await stateOf(org, minorId);
    const visibleBefore = await stateOf(org, visible);
    const hiddenBefore = await stateOf(org, hiddenId);
    const foreignBefore = await stateOf(other, foreign);

    for (const response of [
      await del(org, org.owner.accessToken, minorId, 1),
      await del(org, org.owner.accessToken, newId(), 1),
      await del(org, org.owner.accessToken, foreign, 1),
      await del(org, org.owner.accessToken, hiddenId, hidden.version),
      await restore(org, org.owner.accessToken, minorId, 1),
      await restore(org, org.owner.accessToken, newId(), 1),
      await restore(org, org.owner.accessToken, foreign, 1),
      await restore(org, org.owner.accessToken, visible, 1),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }

    expect(await stateOf(org, minorId)).toEqual(minorBefore);
    expect(await stateOf(org, visible)).toEqual(visibleBefore);
    expect(await stateOf(org, hiddenId)).toEqual(hiddenBefore);
    expect(await stateOf(other, foreign)).toEqual(foreignBefore);

    // Control: the same routes do answer 200 for a contact in the right state, so the 404s
    // above are refusals and not a missing route.
    expect((await del(org, org.owner.accessToken, visible, 1)).status).toBe(200);
    expect((await restore(org, org.owner.accessToken, hiddenId, hidden.version)).status).toBe(200);
  });

  it("restore answers 404 for a contact hidden 721 hours and leaves it hidden", async () => {
    const org = await createOrg("pin75b");
    const personId = await agedContact(org, "Late");
    const before = await withAppTransaction(
      migrator,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        const rows = await tx<{ version: number; deleted_at: Date | null }[]>`
          select version, deleted_at from app.persons where id = ${personId}::uuid
        `;
        return rows[0]!;
      },
    );
    expect(before.deleted_at).not.toBeNull();

    const res = await restore(org, org.owner.accessToken, personId, before.version);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");

    const after = await withAppTransaction(
      migrator,
      { orgId: org.orgId, communityId: org.communityId },
      async (tx) => {
        const rows = await tx<{ version: number; deleted_at: Date | null }[]>`
          select version, deleted_at from app.persons where id = ${personId}::uuid
        `;
        return rows[0];
      },
    );
    expect(after).toEqual(before);
    expect(await auditRows(org, "people.person.purged")).toHaveLength(0);
    expect(await auditRows(org, "people.person.restored")).toHaveLength(0);
  });

  it("a version conflict answers 409 with an empty body", async () => {
    const org = await createOrg("pin80");
    const visible = await addAdult(org, "Visible");
    const hiddenId = await addAdult(org, "Hidden");
    const hidden = await hide(org, hiddenId);
    const visibleBefore = await stateOf(org, visible);
    const hiddenBefore = await stateOf(org, hiddenId);

    const staleDelete = await del(org, org.owner.accessToken, visible, 7);
    expect(staleDelete.status).toBe(409);
    expect(await staleDelete.text()).toBe("");

    const staleRestore = await restore(org, org.owner.accessToken, hiddenId, hidden.version + 5);
    expect(staleRestore.status).toBe(409);
    expect(await staleRestore.text()).toBe("");

    // Every other refusal stays status-only too: bad body, unknown contact, no permission.
    const badBody = await post(
      "/v1/people/delete",
      { communitySlug: org.slug, personId: "not-a-uuid", version: 1 },
      org.owner.accessToken,
    );
    expect(badBody.status).toBe(400);
    expect(await badBody.text()).toBe("");

    const unknown = await del(org, org.owner.accessToken, newId(), 1);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("");

    const caller = await customCaller(org, ["people.view"]);
    const denied = await del(org, caller.accessToken, visible, 1);
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("");

    expect(await stateOf(org, visible)).toEqual(visibleBefore);
    expect(await stateOf(org, hiddenId)).toEqual(hiddenBefore);
  });

  it("the Deleted list returns names and dates only, in pages, and audits each non-empty page", async () => {
    const org = await createOrg("deleted-list");
    const first = await addAdult(org, "Alpha", { email: `alpha-${newId()}@example.test` });
    const second = await addAdult(org, "Bravo", { email: `bravo-${newId()}@example.test` });
    await addAdult(org, "Visible");
    await hide(org, first);
    await hide(org, second);

    const page1 = await list(org, org.owner.accessToken, { status: "deleted", limit: 1 });
    expect(page1.status).toBe(200);
    const body1 = deletedPeopleListResponse.parse(await page1.json());
    expect(body1.items).toHaveLength(1);
    expect(body1.nextCursor).not.toBeNull();
    expect(Object.keys(body1.items[0]!).sort()).toEqual(
      ["deletedAt", "familyName", "givenName", "id", "purgeAfter", "version"].sort(),
    );
    expect(
      new Date(body1.items[0]!.purgeAfter).getTime() -
        new Date(body1.items[0]!.deletedAt).getTime(),
    ).toBe(HOURS_720_MS);

    const page2 = await list(org, org.owner.accessToken, {
      status: "deleted",
      limit: 1,
      cursor: body1.nextCursor!,
    });
    expect(page2.status).toBe(200);
    const body2 = deletedPeopleListResponse.parse(await page2.json());
    expect(body2.items).toHaveLength(1);
    expect(new Set([body1.items[0]!.id, body2.items[0]!.id])).toEqual(new Set([first, second]));
    expect(JSON.stringify([body1, body2])).not.toContain("example.test");

    const search = await list(org, org.owner.accessToken, { status: "deleted", search: "Alp" });
    const searched = deletedPeopleListResponse.parse(await search.json());
    expect(searched.items.map((item) => item.id)).toEqual([first]);

    const events = await auditRows(org, "people.person.listed_deleted");
    expect(events).toHaveLength(3);
    expect(events[0]!.ids).toEqual([body1.items[0]!.id]);
  });

  it("the Deleted list refuses a source, a group, the minors kind and a search that is not a search", async () => {
    const org = await createOrg("deleted-refused");
    // Control: the filter on its own is accepted, so the refusals below are the refinement.
    const plain = await list(org, org.owner.accessToken, { status: "deleted" });
    expect(plain.status).toBe(200);
    for (const extra of [
      { source: "manual" },
      { groupId: newId() },
      { kind: "minors" },
      { search: "" },
    ]) {
      const res = await list(org, org.owner.accessToken, { status: "deleted", ...extra });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("");
    }
  });

  it("the deleted filter answers 400 without people.delete", async () => {
    const org = await createOrg("pin79");
    const caller = await customCaller(org, ["people.view"]);
    const personId = await addAdult(org, "Hidden");
    await hide(org, personId);
    const aged = await agedContact(org);
    const before = await stateOf(org, personId);
    expect(await deniedRows(org, caller.userId)).toHaveLength(0);

    const res = await list(org, caller.accessToken, { status: "deleted" });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");

    expect(await stateOf(org, personId)).toEqual(before);
    expect((await stateOf(org, aged)).exists).toBe(true);
    expect(await auditRows(org, "people.person.listed_deleted")).toHaveLength(0);
    const denied = await deniedRows(org, caller.userId);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.purpose).toBe("people.permission.denied");

    // The same caller still lists active contacts.
    const active = await list(org, caller.accessToken, { status: "active" });
    expect(active.status).toBe(200);
  });

  it("the sweep runs after the adult list, the Deleted list, delete and restore", async () => {
    const calls: {
      name: string;
      run: (org: Org) => Promise<Response>;
    }[] = [
      { name: "adult list", run: (org) => list(org, org.owner.accessToken) },
      {
        name: "Deleted list",
        run: (org) => list(org, org.owner.accessToken, { status: "deleted" }),
      },
      {
        name: "delete",
        run: async (org) => {
          const target = await addAdult(org, "Target");
          return del(org, org.owner.accessToken, target, 1);
        },
      },
      {
        name: "restore",
        run: async (org) => {
          const target = await addAdult(org, "Target");
          const hidden = await hide(org, target);
          return restore(org, org.owner.accessToken, target, hidden.version);
        },
      },
    ];

    for (const call of calls) {
      const org = await createOrg("sweeps");
      const aged = await agedContact(org);
      const young = await addAdult(org, "Young");
      await hide(org, young);

      const res = await call.run(org);
      expect(res.status, `${call.name} answers 200`).toBe(200);

      expect((await stateOf(org, aged)).exists, `${call.name} purges the aged contact`).toBe(false);
      expect((await stateOf(org, young)).exists, `${call.name} keeps a young hidden one`).toBe(
        true,
      );
      const purged = await auditRows(org, "people.person.purged");
      expect(purged).toHaveLength(1);
      expect(purged[0]!.actorKind).toBe("system");
      expect(purged[0]!.actorId).toBeNull();
      expect(purged[0]!.ids).toEqual([aged]);
    }
  });

  it("the sweep does not run after the minors list, the summary or a read", async () => {
    const org = await createOrg("nosweep");
    const aged = await agedContact(org);
    const visible = await addAdult(org, "Visible");

    const minors = await list(org, org.owner.accessToken, { kind: "minors" });
    expect(minors.status).toBe(200);
    const summary = await post(
      "/v1/people/summary",
      { communitySlug: org.slug, addedSince: "2026-01-01T00:00:00.000Z" },
      org.owner.accessToken,
    );
    expect(summary.status).toBe(200);
    const read = await post(
      "/v1/people/read",
      { communitySlug: org.slug, personId: visible },
      org.owner.accessToken,
    );
    expect(read.status).toBe(200);

    expect((await stateOf(org, aged)).exists).toBe(true);
    expect(await auditRows(org, "people.person.purged")).toHaveLength(0);

    // Control: the adult list does sweep the same community.
    const adults = await list(org, org.owner.accessToken);
    expect(adults.status).toBe(200);
    expect((await stateOf(org, aged)).exists).toBe(false);
  });

  it("a refused list does not purge", async () => {
    const org = await createOrg("pin81");
    const aged = await agedContact(org);
    const member = await memberCaller(org);
    const viewer = await customCaller(org, ["people.view"]);

    const forbidden = await list(org, member.accessToken);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe("");
    expect((await stateOf(org, aged)).exists).toBe(true);

    const refused = await list(org, viewer.accessToken, { status: "deleted" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe("");
    expect((await stateOf(org, aged)).exists).toBe(true);

    const minorsDenied = await list(org, viewer.accessToken, { kind: "minors" });
    expect(minorsDenied.status).toBe(403);
    expect((await stateOf(org, aged)).exists).toBe(true);
    expect(await auditRows(org, "people.person.purged")).toHaveLength(0);

    // Control: the owner's list sweeps in the same community.
    const permitted = await list(org, org.owner.accessToken);
    expect(permitted.status).toBe(200);
    expect((await stateOf(org, aged)).exists).toBe(false);
  });

  it("a delete or restore that is refused does not purge", async () => {
    const org = await createOrg("refused-writes");
    const aged = await agedContact(org);
    const visible = await addAdult(org, "Visible");

    const stale = await del(org, org.owner.accessToken, visible, 9);
    expect(stale.status).toBe(409);
    const unknown = await restore(org, org.owner.accessToken, newId(), 1);
    expect(unknown.status).toBe(404);

    expect((await stateOf(org, aged)).exists).toBe(true);
    expect(await auditRows(org, "people.person.purged")).toHaveLength(0);
  });

  it("a read-only community is not swept", async () => {
    const org = await createOrg("pin82", { billing: "read_only" });
    const aged = await agedContact(org);

    const res = await list(org, org.owner.accessToken);
    expect(res.status).toBe(200);
    expect((await stateOf(org, aged)).exists).toBe(true);
    expect(await auditRows(org, "people.person.purged")).toHaveLength(0);

    const deleted = await list(org, org.owner.accessToken, { status: "deleted" });
    expect(deleted.status).toBe(200);
    expect((await stateOf(org, aged)).exists).toBe(true);
    expect(await auditRows(org, "people.person.purged")).toHaveLength(0);
  });

  it("a failing sweep keeps the 200 and logs the error class only", async () => {
    const org = await createOrg("pin83");
    const aged = await agedContact(org);
    const visible = await addAdult(org, "Visible");
    const planted = `planted-secret-${newId()}`;

    capturedLogs.length = 0;
    armed.purgeSecret = planted;
    try {
      const listed = await list(org, org.owner.accessToken);
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as { items: { personId: string }[]; nextCursor: unknown };
      expect(body.items.map((item) => item.personId)).toContain(visible);
      expect(body.nextCursor).toBeNull();

      const deletedList = await list(org, org.owner.accessToken, { status: "deleted" });
      expect(deletedList.status).toBe(200);
      deletedPeopleListResponse.parse(await deletedList.json());

      const res = await del(org, org.owner.accessToken, visible, 1);
      expect(res.status).toBe(200);
      personDeleteResponse.parse(await res.json());
    } finally {
      armed.purgeSecret = "";
    }

    const text = JSON.stringify(capturedLogs);
    expect(text).not.toContain(planted);
    expect(text).not.toContain("purge failure");
    const failures = capturedLogs.filter((entry) => entry.message === "contact_sweep_failed");
    expect(failures).toHaveLength(3);
    for (const failure of failures) {
      expect(failure.fields?.errorClass).toBe("Error");
      expect(Object.keys(failure.fields ?? {}).sort()).toEqual(["errorClass", "path"]);
    }
    // The failed sweep wrote nothing: the aged contact is still there and no purge event exists.
    expect((await stateOf(org, aged)).exists).toBe(true);
    expect(await auditRows(org, "people.person.purged")).toHaveLength(0);
  });

  it("create and update answer 409 duplicate_deleted for a hidden holder", async () => {
    const org = await createOrg("dup-people");
    const email = `holder-${newId()}@example.test`;
    const holder = await addAdult(org, "Holder", { email });
    await hide(org, holder);
    const other = await addAdult(org, "Other", { email: `other-${newId()}@example.test` });

    const created = await post(
      "/v1/people/create",
      { communitySlug: org.slug, givenName: "Newcomer", familyName: "Example", email },
      org.owner.accessToken,
    );
    expect(created.status).toBe(409);
    expect(await codeBody(created)).toEqual({ code: "duplicate_deleted" });

    const updated = await post(
      "/v1/people/update",
      { communitySlug: org.slug, personId: other, version: 1, email },
      org.owner.accessToken,
    );
    expect(updated.status).toBe(409);
    expect(await codeBody(updated)).toEqual({ code: "duplicate_deleted" });

    // A visible holder keeps the old, status-only answer.
    const visibleEmail = `visible-${newId()}@example.test`;
    await addAdult(org, "Visible", { email: visibleEmail });
    const duplicate = await post(
      "/v1/people/create",
      { communitySlug: org.slug, givenName: "Again", familyName: "Example", email: visibleEmail },
      org.owner.accessToken,
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toBe("");
    expect(await personCount(org)).toBe(3);
  });

  it("add-adult answers 409 duplicate_deleted for a hidden holder", async () => {
    const org = await createOrg("pin87");
    const householdId = await addHousehold(org);
    const email = `holder-${newId()}@example.test`;
    const holder = await addAdult(org, "Holder", { email });
    await hide(org, holder);
    const countBefore = await personCount(org);

    const res = await post(
      "/v1/households/members/add-adult",
      {
        communitySlug: org.slug,
        householdId,
        givenName: "Newcomer",
        familyName: "Example",
        email,
      },
      org.owner.accessToken,
    );
    expect(res.status).toBe(409);
    expect(await codeBody(res)).toEqual({ code: "duplicate_deleted" });
    expect(await personCount(org)).toBe(countBefore);
  });
});
