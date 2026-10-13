import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, grantRole } from "@community-hub/access";
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
import { beforeAll, describe, expect, it } from "vitest";

import type { Role } from "./checkout.js";
import { entitlementRoutes } from "./entitlement-routes.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const API_HOSTNAME = "au.api.example.test";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";

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

class MemoryMail implements OtpMail {
  last: { to: string; code: string } | undefined;

  send(input: { to: string; code: string }): Promise<void> {
    this.last = input;
    return Promise.resolve();
  }
}

function request(pathName: string, body: unknown, authorization: string): Request {
  return new Request(`http://127.0.0.1${pathName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-community-hub-hostname": API_HOSTNAME,
      authorization: `Bearer ${authorization}`,
    },
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

describe("entitlement flow", () => {
  it("lists and toggles a community without an organisation id in the body", async () => {
    const now = new Date("2026-10-12T00:00:00.000Z");
    const runtime = loadRuntime();
    const identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const kms = createLocalKmsPort();
    const organisationId = newId();
    const communityId = newId();
    const slug = `ent${organisationId.slice(0, 8)}`;
    const planKey = `plan${organisationId.slice(0, 8)}`;
    const logs: { message: string; fields: Record<string, unknown> }[] = [];
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
    const routes = entitlementRoutes({
      checkout,
      kms,
      keyArn: KEY_ARN,
      now: () => now,
      apiHostname: API_HOSTNAME,
      log: (message, fields) => {
        logs.push({ message, fields });
      },
    });
    const list = routes.find((item) => item.pattern === "/v1/entitlements/list");
    const toggle = routes.find((item) => item.pattern === "/v1/entitlements/toggle");
    if (list === undefined || toggle === undefined) {
      throw new Error("routes");
    }

    async function signIn(email: string): Promise<{ userId: string; accessToken: string }> {
      const mail = new MemoryMail();
      await startEmailOtp(identity, kms, KEY_ARN, mail, { email, now });
      const session = await verifyEmailOtp(identity, kms, KEY_ARN, {
        email,
        code: mail.last?.code ?? "",
        now,
      });
      if (session === null) {
        throw new Error("session");
      }
      userIds.push(session.userId);
      return session;
    }

    async function call(
      handler: (input: Request) => Response | Promise<Response>,
      pathName: string,
      body: unknown,
      token: string,
      requestId = REQUEST_ID,
    ): Promise<Response> {
      return withRequest({ requestId }, async () => handler(request(pathName, body, token)));
    }

    try {
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
      await upsertPlan(platform, {
        key: planKey,
        entitlements: [{ key: "people.directory", limit: null }],
      });
      await assignPlan(platform, { organisationId, planKey, now });
      await identity`delete from identity.identity_keys`;
      const admin = await signIn(`admin-${organisationId.slice(0, 8)}@example.com`);
      const staff = await signIn(`staff-${organisationId.slice(0, 8)}@example.com`);
      const stranger = await signIn(`none-${organisationId.slice(0, 8)}@example.com`);
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, (tx) =>
          bootstrapOwner(tx, { now, userId: admin.userId, actorUserId: admin.userId }),
        ),
      );
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, (tx) =>
          grantRole(tx, {
            now,
            userId: staff.userId,
            roleKey: "staff",
            customRoleId: null,
            actorUserId: admin.userId,
          }),
        ),
      );

      const listed = await call(
        list.handle,
        list.pattern,
        { communitySlug: slug },
        admin.accessToken,
      );
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({
        keys: [{ key: "people.directory", enabled: true }],
        canManage: true,
      });

      const staffListed = await call(
        list.handle,
        list.pattern,
        { communitySlug: slug },
        staff.accessToken,
      );
      expect(staffListed.status).toBe(200);
      expect(await staffListed.json()).toEqual({
        keys: [{ key: "people.directory", enabled: true }],
        canManage: false,
      });

      const staffToggle = await call(
        toggle.handle,
        toggle.pattern,
        { communitySlug: slug, key: "people.directory", enabled: false },
        staff.accessToken,
      );
      expect(staffToggle.status).toBe(403);
      expect(await staffToggle.text()).toBe("");
      const staffToggleAudits = await withAppTransaction(
        app,
        { orgId: organisationId, communityId },
        (tx) =>
          tx<{ n: number }[]>`
            select count(*)::int as n
            from app.audit_events
            where action = 'entitlements.toggle.changed'
          `,
      );
      expect(staffToggleAudits).toEqual([{ n: 0 }]);

      const turnedOff = await call(
        toggle.handle,
        toggle.pattern,
        { communitySlug: slug, key: "people.directory", enabled: false },
        admin.accessToken,
      );
      expect(turnedOff.status).toBe(200);
      expect(await turnedOff.text()).toBe("");
      const changed = await withAppTransaction(
        app,
        { orgId: organisationId, communityId },
        (tx) =>
          tx<{ target_ids: string[] }[]>`
          select target_ids::text[] as target_ids
          from app.audit_events
          where action = 'entitlements.toggle.changed'
        `,
      );
      expect(changed).toEqual([{ target_ids: [organisationId, communityId] }]);

      const again = await call(
        toggle.handle,
        toggle.pattern,
        { communitySlug: slug, key: "people.directory", enabled: false },
        admin.accessToken,
      );
      expect(again.status).toBe(200);
      const stillOne = await withAppTransaction(
        app,
        { orgId: organisationId, communityId },
        (tx) =>
          tx<{ n: number }[]>`
            select count(*)::int as n
            from app.audit_events
            where action = 'entitlements.toggle.changed'
          `,
      );
      expect(stillOne).toEqual([{ n: 1 }]);

      const missing = await call(
        toggle.handle,
        toggle.pattern,
        { communitySlug: slug, key: "people.households", enabled: false },
        admin.accessToken,
      );
      expect(missing.status).toBe(400);
      expect(await missing.text()).toBe("");
      const unchangedCount = await withAppTransaction(
        app,
        { orgId: organisationId, communityId },
        (tx) =>
          tx<{ n: number }[]>`
            select count(*)::int as n
            from app.audit_events
            where action = 'entitlements.toggle.changed'
          `,
      );
      expect(unchangedCount).toEqual([{ n: 1 }]);
      const household = await platform<{ entitlement_key: string }[]>`
        select entitlement_key
        from platform.community_toggles
        where community_id = ${communityId}::uuid
          and entitlement_key = 'people.households'
      `;
      expect(household).toEqual([]);

      const denied = await call(
        list.handle,
        list.pattern,
        { communitySlug: slug },
        stranger.accessToken,
      );
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe("");
      const denials = await withAppTransaction(
        app,
        { orgId: organisationId, communityId },
        (tx) =>
          tx<{ target_ids: string[] }[]>`
          select target_ids::text[] as target_ids
          from app.audit_events
          where action = 'entitlements.permission.denied'
        `,
      );
      expect(denials).toHaveLength(2);
      for (const row of denials) {
        expect(row).toEqual({ target_ids: [organisationId, communityId] });
      }

      const rolled = await call(
        toggle.handle,
        toggle.pattern,
        { communitySlug: slug, key: "people.directory", enabled: true },
        admin.accessToken,
        "not-a-uuid",
      );
      expect(rolled.status).toBe(500);
      const restored = await platform<{ enabled: boolean }[]>`
        select enabled
        from platform.community_toggles
        where community_id = ${communityId}::uuid
          and entitlement_key = 'people.directory'
      `;
      expect(restored).toEqual([{ enabled: false }]);

      for (const entry of logs) {
        expect(Object.keys(entry.fields).sort()).toEqual(["path", "requestId", "status"]);
        const serialised = JSON.stringify(entry.fields);
        expect(serialised).not.toContain(slug);
        expect(serialised).not.toContain("people.directory");
        expect(serialised).not.toContain("people.households");
      }
    } finally {
      for (const userId of userIds) {
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
