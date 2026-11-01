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

import { createHousehold, PeopleError, readHousehold, renameHousehold } from "../public/index.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = [
  "arn",
  "aws",
  "kms",
  "ap-southeast-2",
  ["12", "34", "56", "78", "90", "12"].join(""),
  `key/mrk-${"ab".repeat(16)}`,
].join(":");
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

async function cleanScope(
  directSql: ReturnType<typeof createPlaintextDirectSql>,
  scope: { orgId: string },
): Promise<void> {
  await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.person_activity where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.guardian_links where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.persons where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from app.household_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.households where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from app.community_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.organisation_keys where org_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`.catch(() => {});
  await directSql`delete from platform.communities where organisation_id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
  await directSql`delete from platform.organisations where id = ${scope.orgId}::uuid`.catch(
    () => {},
  );
}

describe("household create, rename and read", () => {
  it("stores a ciphertext label, returns version 1, and audits the read once", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
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
          expect(created.version).toBe(1);

          const stored = await tx<{ label: Uint8Array | null; version: number }[]>`
            select label, version from app.households where id = ${created.householdId}::uuid
          `;
          const label = stored[0]?.label;
          expect(stored[0]?.version).toBe(1);
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
      try {
        await cleanScope(directSql, { orgId: organisationId });
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("pin 25: createHousehold writes one usage fact, and a failed create writes none", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();
    const now = new Date("2026-11-01T10:00:00.000Z");

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'usage-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'usage-parish', 'au')
        `;
      });

      // 1. Successful createHousehold writes one usage fact for people.households
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          await createHousehold(tx, kms, KEY_ARN, {
            now,
            label: "Usage House",
            actorUserId: null,
          });
        }),
      );

      const usageRows = await directSql<
        { feature_key: string; day: string; success_count: number }[]
      >`
        select feature_key, day::text as day, success_count
        from app.usage_facts_daily
        where org_id = ${organisationId}::uuid
          and community_id = ${communityId}::uuid
      `;
      expect(usageRows).toEqual([
        { feature_key: "people.households", day: "2026-11-01", success_count: 1 },
      ]);

      // 2. Failed createHousehold writes none (rolled back)
      let failedError: unknown = null;
      try {
        await withRequest({ requestId: REQUEST_ID }, () =>
          withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
            await createHousehold(tx, kms, KEY_ARN, {
              now,
              label: "Will Fail",
              actorUserId: null,
            });
            throw new Error("Simulated transaction rollback");
          }),
        );
      } catch (err) {
        failedError = err;
      }
      expect(failedError).not.toBeNull();

      const usageRowsAfterFailure = await directSql<
        { feature_key: string; day: string; success_count: number }[]
      >`
        select feature_key, day::text as day, success_count
        from app.usage_facts_daily
        where org_id = ${organisationId}::uuid
          and community_id = ${communityId}::uuid
      `;
      expect(usageRowsAfterFailure).toEqual([
        { feature_key: "people.households", day: "2026-11-01", success_count: 1 },
      ]);
    } finally {
      try {
        await cleanScope(directSql, { orgId: organisationId });
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("pin 8: renameHousehold updates label, bumps version; stale version returns conflict, row unchanged, no audit row", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const organisationId = newId();
    const communityId = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${organisationId}, 'rename-parish', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${communityId}, ${organisationId}, 'rename-parish', 'au')
        `;
      });

      let householdId = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: new Date("2026-11-01T00:00:00+11:00"),
            label: "Original Label",
            actorUserId: null,
          });
          householdId = hh.householdId;
        }),
      );

      // Clean audits from create
      await directSql`delete from app.audit_events where org_id = ${organisationId}::uuid`;

      // Successful rename from version 1 -> 2
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          const renamed = await renameHousehold(tx, kms, KEY_ARN, {
            householdId,
            version: 1,
            label: "Renamed Family",
            actorUserId: null,
          });
          expect(renamed.version).toBe(2);

          const read = await readHousehold(tx, kms, KEY_ARN, {
            householdId,
            actorUserId: null,
          });
          expect(read?.label).toBe("Renamed Family");
        }),
      );

      // Verify audit row for update
      const updateAudits = await directSql<
        { action: string; purpose: string; target_ids: string[] }[]
      >`
        select action, purpose, target_ids::text[] as target_ids
        from app.audit_events
        where org_id = ${organisationId}::uuid
          and action = 'people.household.updated'
      `;
      expect(updateAudits).toHaveLength(1);
      expect(updateAudits[0]!.target_ids).toEqual([householdId]);

      // Attempt rename with stale version (1 when current is 2) -> conflict
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: organisationId, communityId }, async (tx) => {
          let conflictErr: unknown = null;
          try {
            await renameHousehold(tx, kms, KEY_ARN, {
              householdId,
              version: 1,
              label: "Stale Rename",
              actorUserId: null,
            });
          } catch (err) {
            conflictErr = err;
          }
          expect(conflictErr).toBeInstanceOf(PeopleError);
          expect((conflictErr as PeopleError).code).toBe("conflict");

          // Row unchanged
          const read = await readHousehold(tx, kms, KEY_ARN, {
            householdId,
            actorUserId: null,
          });
          expect(read?.label).toBe("Renamed Family");
        }),
      );

      // No new audit row from failed rename
      const auditsAfterConflict = await directSql<{ action: string }[]>`
        select action
        from app.audit_events
        where org_id = ${organisationId}::uuid
          and action = 'people.household.updated'
      `;
      expect(auditsAfterConflict).toHaveLength(1);
    } finally {
      try {
        await cleanScope(directSql, { orgId: organisationId });
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("pin 12: rename across tenant scope returns not_found", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const orgA = newId();
    const commA = newId();
    const commA2 = newId();
    const orgB = newId();
    const commB = newId();
    const kms = createLocalKmsPort();

    try {
      await platform.begin(async (tx) => {
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${orgA}, 'org-a', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${commA}, ${orgA}, 'comm-a', 'au')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${commA2}, ${orgA}, 'comm-a2', 'au')
        `;
        await tx`
          insert into platform.organisations (id, slug, region, kind)
          values (${orgB}, 'org-b', 'au', 'implicit')
        `;
        await tx`
          insert into platform.communities (id, organisation_id, slug, region)
          values (${commB}, ${orgB}, 'comm-b', 'au')
        `;
      });

      let hhA = "";
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgA, communityId: commA }, async (tx) => {
          const hh = await createHousehold(tx, kms, KEY_ARN, {
            now: new Date("2026-11-01T00:00:00+11:00"),
            label: "Org A HH",
            actorUserId: null,
          });
          hhA = hh.householdId;
        }),
      );

      // Attempt rename from Community A2 in same Org A -> not_found
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgA, communityId: commA2 }, async (tx) => {
          let caught: unknown = null;
          try {
            await renameHousehold(tx, kms, KEY_ARN, {
              householdId: hhA,
              version: 1,
              label: "Cross-community hack",
              actorUserId: null,
            });
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(PeopleError);
          expect((caught as PeopleError).code).toBe("not_found");
        }),
      );

      // Attempt rename from Org B -> not_found
      await withRequest({ requestId: REQUEST_ID }, () =>
        withAppTransaction(app, { orgId: orgB, communityId: commB }, async (tx) => {
          let caught: unknown = null;
          try {
            await renameHousehold(tx, kms, KEY_ARN, {
              householdId: hhA,
              version: 1,
              label: "Hacked",
              actorUserId: null,
            });
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(PeopleError);
          expect((caught as PeopleError).code).toBe("not_found");
        }),
      );
    } finally {
      try {
        await cleanScope(directSql, { orgId: orgA });
        await cleanScope(directSql, { orgId: orgB });
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });
});
