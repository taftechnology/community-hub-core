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

import { createHousehold, readHousehold } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

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

describe("household create and read", () => {
  it("stores a ciphertext label and audits the read once", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();
    const missingId = newId();
    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'household-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'household-parish', 'au')
        `;
      });
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const created = await createHousehold(tx, kms, KEY_ARN, {
            now: new Date("2026-10-11T00:00:00+11:00"),
            label: " Example ",
            actorUserId: null,
          });
          const stored = await tx<{ label: Uint8Array | null }[]>`
            select label from app.households where id = ${created.householdId}::uuid
          `;
          const label = stored[0]?.label;
          expect(label).toBeInstanceOf(Uint8Array);
          expect(Buffer.from(label ?? new Uint8Array()).toString("utf8")).not.toContain("Example");

          const read = await readHousehold(tx, kms, KEY_ARN, {
            householdId: created.householdId,
            actorUserId: null,
          });
          expect(read).toEqual({ householdId: created.householdId, label: "Example" });

          const missing = await readHousehold(tx, kms, KEY_ARN, {
            householdId: missingId,
            actorUserId: null,
          });
          expect(missing).toBeNull();

          const audits = await tx<
            { action: string; actor_kind: string; actor_id: string | null; seq: string }[]
          >`
            select action, actor_kind, actor_id::text as actor_id, seq::text as seq
            from app.audit_events
            where ${created.householdId}::uuid = any(target_ids)
          `;
          expect(
            [...audits]
              .sort((left, right) => Number(left.seq) - Number(right.seq))
              .map(({ action, actor_kind, actor_id }) => ({ action, actor_kind, actor_id })),
          ).toEqual([
            { action: "people.household.created", actor_kind: "system", actor_id: null },
            { action: "people.household.read", actor_kind: "system", actor_id: null },
          ]);
          const missed = await tx<{ n: number }[]>`
            select count(*)::int as n
            from app.audit_events
            where action = 'people.household.read'
              and ${missingId}::uuid = any(target_ids)
          `;
          expect(missed).toEqual([{ n: 0 }]);
        }),
      );
    } finally {
      await platform.end({ timeout: 1 });
      await app.end({ timeout: 1 });
    }
  });
});
