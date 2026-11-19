import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { armed } = vi.hoisted(() => ({ armed: { value: false } }));

vi.mock("@community-hub/db", async (importActual) => {
  const actual = await importActual<typeof import("@community-hub/db")>();
  return {
    ...actual,
    appendAuditEvent: async (...args: Parameters<typeof actual.appendAuditEvent>) => {
      const [, event] = args;
      if (armed.value && event.action === "people.person.household_moved") {
        throw new Error("injected household_moved audit failure");
      }
      return actual.appendAuditEvent(...args);
    },
  };
});

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { addAdult, createHousehold } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-01T00:00:00+11:00");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "platform"): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:5432/hub_product_only`;
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

describe("household members: add adult atomicity (pin 10)", () => {
  it("addAdult: a failed household audit append leaves no person, activity, audit or usage row", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const kms = createLocalKmsPort();
    const organisationId = newId();
    const communityId = newId();
    const tenantSlug = `atomicity-${organisationId.slice(0, 8)}`;

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, ${tenantSlug}, 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, ${tenantSlug}, 'au')
        `;
      });

      let homeId!: string;
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const home = await createHousehold(tx, kms, KEY_ARN, {
            now: NOW,
            label: "Atomicity Home",
            actorUserId: null,
          });
          homeId = home.householdId;
        }),
      );

      // Baseline counts for this community
      let personsBefore = 0;
      let activityBefore = 0;
      let auditBefore = 0;
      let usageBefore = 0;

      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const p = await tx<
            { count: number }[]
          >`select count(*)::int as count from app.persons where community_id = ${communityId}::uuid`;
          personsBefore = p[0]!.count;
          const a = await tx<
            { count: number }[]
          >`select count(*)::int as count from app.person_activity where community_id = ${communityId}::uuid`;
          activityBefore = a[0]!.count;
          const au = await tx<
            { count: number }[]
          >`select count(*)::int as count from app.audit_events where action in ('people.person.created', 'people.person.household_moved')`;
          auditBefore = au[0]!.count;
          const u = await tx<
            { count: number }[]
          >`select coalesce(sum(success_count), 0)::int as count from app.usage_facts_daily where feature_key = 'people.directory'`;
          usageBefore = u[0]!.count;
        }),
      );

      armed.value = true;
      try {
        await expect(
          withRequest({ requestId: REQUEST_ID }, () =>
            withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
              await addAdult(tx, kms, KEY_ARN, {
                now: NOW,
                householdId: homeId,
                givenName: "FailAudit",
                familyName: "Person",
                email: "fail.audit@example.test",
                phone: "+61412555138",
                dateOfBirth: "1990-01-01",
                actorUserId: null,
              });
            }),
          ),
        ).rejects.toThrow("injected household_moved audit failure");
      } finally {
        armed.value = false;
      }

      // Check all counts unchanged in a fresh transaction
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const p = await tx<
            { count: number }[]
          >`select count(*)::int as count from app.persons where community_id = ${communityId}::uuid`;
          expect(p[0]!.count).toBe(personsBefore);
          const a = await tx<
            { count: number }[]
          >`select count(*)::int as count from app.person_activity where community_id = ${communityId}::uuid`;
          expect(a[0]!.count).toBe(activityBefore);
          const au = await tx<
            { count: number }[]
          >`select count(*)::int as count from app.audit_events where action in ('people.person.created', 'people.person.household_moved')`;
          expect(au[0]!.count).toBe(auditBefore);
          const u = await tx<
            { count: number }[]
          >`select coalesce(sum(success_count), 0)::int as count from app.usage_facts_daily where feature_key = 'people.directory'`;
          expect(u[0]!.count).toBe(usageBefore);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
