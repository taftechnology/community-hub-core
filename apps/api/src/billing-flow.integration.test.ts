import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapOwner, grantRole } from "@community-hub/access";
import {
  insertSettings,
  setMode,
  type CreateCheckoutSessionInput,
  type CreatePortalSessionInput,
  type StripeBilling,
  type StripePrice,
} from "@community-hub/billing";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { bannerStatusResponse, fullStatusResponse } from "@community-hub/contracts/billing";
import { assignPlan, setPlanBilling, upsertPlan } from "@community-hub/entitlements";
import type { OtpMail } from "@community-hub/identity";
import { startEmailOtp, verifyEmailOtp } from "@community-hub/identity";
import { withRequest } from "@community-hub/kernel";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { billingRoutes } from "./billing-routes.js";
import type { Role } from "./checkout.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const API_HOSTNAME = "au.api.example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
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

describe("billing flow (two organisations)", () => {
  it("enforces tenant boundary across two organisations and reports status", async () => {
    const now = new Date("2026-10-18T10:00:00.000Z");
    const runtime = loadRuntime();
    const identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const kms = createLocalKmsPort();

    const orgAId = newId();
    const commAId = newId();
    const slugA = `flow-a-${orgAId.slice(0, 8)}`;

    const orgBId = newId();
    const commBId = newId();
    const slugB = `flow-b-${orgBId.slice(0, 8)}`;

    const planKey = `plan${orgAId.slice(0, 8)}`;
    const lookupKey = `price_${planKey}_monthly`;

    const userIds: string[] = [];
    const checkoutCalls: { role: Role }[] = [];

    const checkout = async <T>(role: Role, run: (sql: never) => Promise<T>): Promise<T> => {
      checkoutCalls.push({ role });
      if (role === "identity") {
        return run(identity as never);
      }
      if (role === "platform") {
        return run(platform as never);
      }
      return run(app as never);
    };

    const checkoutSessionCalls: CreateCheckoutSessionInput[] = [];
    const portalSessionCalls: CreatePortalSessionInput[] = [];

    const fakePort: StripeBilling = {
      createCheckoutSession: vi.fn(async (input: CreateCheckoutSessionInput) => {
        checkoutSessionCalls.push(input);
        return { url: "https://checkout.stripe.com/pay/cs_test_two_org" };
      }),
      createPortalSession: vi.fn(async (input: CreatePortalSessionInput) => {
        portalSessionCalls.push(input);
        return { url: "https://billing.stripe.com/p/session/portal_test_two_org" };
      }),
      findPriceByLookupKey: vi.fn(async (priceKey: string): Promise<StripePrice | null> => {
        if (priceKey === lookupKey) {
          return { id: "price_two_org_123", lookupKey: priceKey };
        }
        return null;
      }),
      createTaxRate: vi.fn(),
      updateDefaultTaxRate: vi.fn(),
      updateQuantity: vi.fn(),
      retrieveSubscription: vi.fn(),
      subscriptionForInvoice: vi.fn(),
      ensureProduct: vi.fn(),
      ensurePrice: vi.fn(),
      verifyEvent: vi.fn(),
    };

    const routes = billingRoutes({
      checkout,
      kms,
      keyArn: KEY_ARN,
      now: () => now,
      apiHostname: API_HOSTNAME,
      adminOrigin: ADMIN_ORIGIN,
      port: fakePort,
      log: () => undefined,
    });

    const checkoutRoute = routes.find((item) => item.pattern === "/v1/billing/checkout");
    const portalRoute = routes.find((item) => item.pattern === "/v1/billing/portal");
    const statusRoute = routes.find((item) => item.pattern === "/v1/billing/status");

    if (checkoutRoute === undefined || portalRoute === undefined || statusRoute === undefined) {
      throw new Error("Missing billing routes");
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
      handler: (
        request: Request,
        context: { billing: "exempt"; pattern: string },
      ) => Response | Promise<Response>,
      pathName: string,
      body: unknown,
      token: string,
      requestId = REQUEST_ID,
    ): Promise<Response> {
      return withRequest({ requestId }, async () =>
        handler(request(pathName, body, token), { billing: "exempt", pattern: pathName }),
      );
    }

    try {
      // 1. Setup Organisation A and Community A
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${orgAId}, ${slugA}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${commAId}, ${orgAId}, ${slugA}, 'au')
        `;
      });

      // 2. Setup Organisation B and Community B
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${orgBId}, ${slugB}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${commBId}, ${orgBId}, ${slugB}, 'au')
        `;
      });

      // 3. Setup plan & settings
      await upsertPlan(platform, {
        key: planKey,
        entitlements: [{ key: "people.directory", limit: null }],
      });
      await setPlanBilling(platform, planKey, {
        stripeLookupKey: lookupKey,
        trialEligible: true,
      });
      await assignPlan(platform, { organisationId: orgAId, planKey, now });
      await assignPlan(platform, { organisationId: orgBId, planKey, now });

      await insertSettings(platform, {
        gstRateBps: 1000,
        pricesIncludeGst: true,
        trialDays: 14,
        graceDays: 7,
        stripeTaxRateId: "txr_test_flow",
        note: "integration test settings",
      });

      // Set org A to self_serve (no subscription yet -> state none)
      await setMode(platform, orgAId, "self_serve");
      // Set org B to self_serve
      await setMode(platform, orgBId, "self_serve");

      // 4. Setup users
      await identity`delete from identity.identity_keys`;
      const ownerA = await signIn(`owner-a-${orgAId.slice(0, 8)}@example.com`);
      const memberA = await signIn(`member-a-${orgAId.slice(0, 8)}@example.com`);
      const ownerB = await signIn(`owner-b-${orgBId.slice(0, 8)}@example.com`);

      // Bootstrap owner of Org A
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgAId, communityId: commAId }, (tx) =>
          bootstrapOwner(tx, { now, userId: ownerA.userId, actorUserId: ownerA.userId }),
        ),
      );

      // Grant member role in Org A
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgAId, communityId: commAId }, (tx) =>
          grantRole(tx, {
            now,
            userId: memberA.userId,
            roleKey: "member",
            customRoleId: null,
            actorUserId: ownerA.userId,
          }),
        ),
      );

      // Bootstrap owner of Org B
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgBId, communityId: commBId }, (tx) =>
          bootstrapOwner(tx, { now, userId: ownerB.userId, actorUserId: ownerB.userId }),
        ),
      );

      // --- TEST SUITE ---

      // Test 1: User of A calls Checkout with B's slug -> 403
      const crossCheckoutRes = await call(
        checkoutRoute.handle,
        checkoutRoute.pattern,
        { communitySlug: slugB, planKey },
        ownerA.accessToken,
      );
      expect(crossCheckoutRes.status).toBe(403);
      expect(await crossCheckoutRes.text()).toBe("");
      expect(fakePort.createCheckoutSession).not.toHaveBeenCalled();

      // Test 2: User of A calls Portal with B's slug -> 403
      const crossPortalRes = await call(
        portalRoute.handle,
        portalRoute.pattern,
        { communitySlug: slugB },
        ownerA.accessToken,
      );
      expect(crossPortalRes.status).toBe(403);
      expect(await crossPortalRes.text()).toBe("");
      expect(fakePort.createPortalSession).not.toHaveBeenCalled();

      // Test 3: User of A calls Status with B's slug -> 403
      const crossStatusRes = await call(
        statusRoute.handle,
        statusRoute.pattern,
        { communitySlug: slugB },
        ownerA.accessToken,
      );
      expect(crossStatusRes.status).toBe(403);
      expect(await crossStatusRes.text()).toBe("");

      // Test 4: Unknown slug -> 403 for Checkout, Portal, Status
      const unknownSlug = "unknown-slug-xyz123";
      const unknownCheckout = await call(
        checkoutRoute.handle,
        checkoutRoute.pattern,
        { communitySlug: unknownSlug, planKey },
        ownerA.accessToken,
      );
      expect(unknownCheckout.status).toBe(403);
      expect(await unknownCheckout.text()).toBe("");

      const unknownPortal = await call(
        portalRoute.handle,
        portalRoute.pattern,
        { communitySlug: unknownSlug },
        ownerA.accessToken,
      );
      expect(unknownPortal.status).toBe(403);
      expect(await unknownPortal.text()).toBe("");

      const unknownStatus = await call(
        statusRoute.handle,
        statusRoute.pattern,
        { communitySlug: unknownSlug },
        ownerA.accessToken,
      );
      expect(unknownStatus.status).toBe(403);
      expect(await unknownStatus.text()).toBe("");

      // Test 5: Checkout for A passes A's id as client_reference_id / organisationId
      const checkoutARes = await call(
        checkoutRoute.handle,
        checkoutRoute.pattern,
        { communitySlug: slugA, planKey },
        ownerA.accessToken,
      );
      expect(checkoutARes.status).toBe(200);
      expect(await checkoutARes.json()).toEqual({
        url: "https://checkout.stripe.com/pay/cs_test_two_org",
      });
      expect(fakePort.createCheckoutSession).toHaveBeenCalledTimes(1);
      const checkoutArg = checkoutSessionCalls[0];
      expect(checkoutArg?.organisationId).toBe(orgAId);
      expect(checkoutArg?.idempotencyKey).toBe(`checkout:${orgAId}:${REQUEST_ID}`);

      // Test 6: Status for A called by User A (owner) -> full object with billing.view
      const statusARes = await call(
        statusRoute.handle,
        statusRoute.pattern,
        { communitySlug: slugA },
        ownerA.accessToken,
      );
      expect(statusARes.status).toBe(200);
      const statusAData = await statusARes.json();
      const parsedFull = fullStatusResponse.parse(statusAData);
      expect(parsedFull).toEqual({
        state: "none",
        planKey,
        quantity: null,
        current_period_end: null,
        trial_end: null,
        grace_until: null,
        canView: true,
        canManage: true,
      });

      // Test 7: Status for A called by Member of A -> banner fields only (no planKey, quantity, current_period_end)
      const statusMemberRes = await call(
        statusRoute.handle,
        statusRoute.pattern,
        { communitySlug: slugA },
        memberA.accessToken,
      );
      expect(statusMemberRes.status).toBe(200);
      const statusMemberData = await statusMemberRes.json();
      const parsedBanner = bannerStatusResponse.parse(statusMemberData);
      expect(parsedBanner).toEqual({
        state: "none",
        trial_end: null,
        grace_until: null,
        canView: false,
        canManage: false,
      });
      expect(statusMemberData).not.toHaveProperty("planKey");
      expect(statusMemberData).not.toHaveProperty("quantity");
      expect(statusMemberData).not.toHaveProperty("current_period_end");

      // Test 8: Member of A calls Status with slug B -> 403
      const memberCrossRes = await call(
        statusRoute.handle,
        statusRoute.pattern,
        { communitySlug: slugB },
        memberA.accessToken,
      );
      expect(memberCrossRes.status).toBe(403);
      expect(await memberCrossRes.text()).toBe("");

      // Test 9: Audits:
      // In Org A: no audit event for the member's banner fallback;
      const auditsA = await withAppTransaction(
        app,
        { orgId: orgAId, communityId: commAId },
        (tx) =>
          tx<{ action: string }[]>`
            select action
            from app.audit_events
            where action = 'billing.permission.denied'
          `,
      );
      expect(auditsA).toEqual([]);

      // In Org B: cross-tenant attempts from User A and Member A each generated one audit event in B
      const auditsB = await withAppTransaction(
        app,
        { orgId: orgBId, communityId: commBId },
        (tx) =>
          tx<{ action: string; purpose: string; target_ids: string[] }[]>`
            select action, purpose, target_ids::text[] as target_ids
            from app.audit_events
            where action = 'billing.permission.denied'
          `,
      );
      // Cross calls to Org B:
      // 1: ownerA checkout -> 1 audit
      // 2: ownerA portal -> 1 audit
      // 3: ownerA status -> 1 audit
      // 4: memberA status -> 1 audit
      expect(auditsB).toHaveLength(4);
      for (const row of auditsB) {
        expect(row.action).toBe("billing.permission.denied");
        expect(row.purpose).toBe("billing.permission.denied");
        expect(row.target_ids).toEqual([orgBId, commBId]);
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
