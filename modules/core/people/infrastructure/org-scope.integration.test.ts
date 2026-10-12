import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId, withAppTransaction } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";

import { createHousehold, createPerson, createTag } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-10-11T00:00:00+11:00");

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

type Tenants = { orgA: string; communityA: string; orgB: string; communityB: string };

async function withTenants(
  slug: string,
  run: (tenants: Tenants, app: ReturnType<typeof createPlaintextAppSql>) => Promise<void>,
): Promise<void> {
  const runtime = loadRuntime();
  const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
  const app = createPlaintextAppSql(roleUrl(runtime, "app"));
  const tenants: Tenants = {
    orgA: newId(),
    communityA: newId(),
    orgB: newId(),
    communityB: newId(),
  };
  try {
    await platform.begin(async (tx) => {
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${tenants.orgA}, ${`${slug}-a`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${tenants.communityA}, ${tenants.orgA}, ${`${slug}-a`}, 'au')
      `;
      await tx`
        insert into platform.organisations (id, slug, region, kind)
        values (${tenants.orgB}, ${`${slug}-b`}, 'au', 'implicit')
      `;
      await tx`
        insert into platform.communities (id, organisation_id, slug, region)
        values (${tenants.communityB}, ${tenants.orgB}, ${`${slug}-b`}, 'au')
      `;
    });
    await withRequest({ requestId: REQUEST_ID }, () => run(tenants, app));
  } finally {
    await platform.end({ timeout: 1 });
    await app.end({ timeout: 1 });
  }
}

describe("organisation-scoped unique keys", () => {
  it("lets an organisation create keys after another organisation used its community id", async () => {
    const kms = createLocalKmsPort();
    await withTenants("scope-keys", async ({ orgA, communityA, orgB }, app) => {
      await withAppTransaction(app, { orgId: orgB, communityId: communityA }, async (tx) => {
        await createHousehold(tx, kms, KEY_ARN, { now: NOW, label: "Stray", actorUserId: null });
      });
      await withAppTransaction(app, { orgId: orgA, communityId: communityA }, async (tx) => {
        const household = await createHousehold(tx, kms, KEY_ARN, {
          now: NOW,
          label: "Example",
          actorUserId: null,
        });
        expect(household.householdId).toBeTypeOf("string");
        const person = await createPerson(tx, kms, KEY_ARN, {
          now: NOW,
          declaredAdult: true,
          householdId: null,
          dateOfBirth: null,
          givenName: "Ada",
          familyName: "Example",
          email: null,
          phone: null,
          actorUserId: null,
        });
        expect(person.personId).toBeTypeOf("string");
      });
    });
  });

  it("lets an organisation create a tag label that another organisation holds on its community id", async () => {
    await withTenants("scope-tags", async ({ orgA, communityA, orgB }, app) => {
      await withAppTransaction(app, { orgId: orgB, communityId: communityA }, async (tx) => {
        await createTag(tx, { label: "choir" });
      });
      await withAppTransaction(app, { orgId: orgA, communityId: communityA }, async (tx) => {
        const tag = await createTag(tx, { label: "choir" });
        expect(tag.tagId).toBeTypeOf("string");
      });
    });
  });
});
