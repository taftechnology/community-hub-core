import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { createLocalKmsPort } from "@community-hub/crypto/testing";
import {
  appendAuditEvent,
  applyProductMigrations,
  newId,
  withAppTransaction,
} from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextPlatformSql,
} from "@community-hub/db/plaintext";
import { withRequest } from "@community-hub/kernel";
import { recordSuccess } from "@community-hub/usage";

import { createHousehold, createPerson, PeopleError } from "../public/index.js";
import { communityFieldKeys } from "./person-keys.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

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

async function createScope(platform: ReturnType<typeof createPlaintextPlatformSql>): Promise<{
  orgId: string;
  communityId: string;
}> {
  const orgId = newId();
  const communityId = newId();
  await platform.begin(async (tx) => {
    await tx`
      insert into platform.organisations (id, slug, region, kind)
      values (${orgId}, ${`scope-${orgId.slice(0, 8)}`}, 'au', 'implicit')
    `;
    await tx`
      insert into platform.communities (id, organisation_id, slug, region)
      values (${communityId}, ${orgId}, ${`scope-${communityId.slice(0, 8)}`}, 'au')
    `;
  });
  return { orgId, communityId };
}

async function cleanScope(
  directSql: ReturnType<typeof createPlaintextDirectSql>,
  scope: { orgId: string; communityId: string },
): Promise<void> {
  await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`;
  await directSql`delete from app.person_activity where org_id = ${scope.orgId}::uuid`;
  await directSql`delete from app.persons where org_id = ${scope.orgId}::uuid`;
  await directSql`delete from app.guardian_links where org_id = ${scope.orgId}::uuid`;
  await directSql`delete from app.household_keys where org_id = ${scope.orgId}::uuid`;
  await directSql`delete from app.households where org_id = ${scope.orgId}::uuid`;
  await directSql`delete from app.community_keys where org_id = ${scope.orgId}::uuid`;
  await directSql`delete from app.organisation_keys where org_id = ${scope.orgId}::uuid`;
  await directSql`delete from app.audit_events where org_id = ${scope.orgId}::uuid`;
  await directSql`delete from platform.communities where organisation_id = ${scope.orgId}::uuid`;
  await directSql`delete from platform.organisations where id = ${scope.orgId}::uuid`;
}

describe("person creation usage facts", () => {
  it("creating an adult adds 1 to people.directory for that community and the UTC day of now, and a minor adds 1 more", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const now = new Date("2026-01-15T23:30:00.000Z");

    try {
      // 1. Creating an adult adds 1 to people.directory for that community and the UTC day of now
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Adult",
            familyName: "Person",
            email: "adult@example.test",
            phone: null,
            actorUserId: null,
          });
        }),
      );

      await withAppTransaction(app, scope, async (tx) => {
        const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
          where org_id = ${scope.orgId}::uuid
            and community_id = ${scope.communityId}::uuid
        `;
        expect(rows).toEqual([
          { feature_key: "people.directory", day: "2026-01-15", success_count: 1 },
        ]);

        const neighbouringRows = await tx<{ day: string }[]>`
          select day::text as day
          from app.usage_facts_daily
          where org_id = ${scope.orgId}::uuid
            and community_id = ${scope.communityId}::uuid
            and day = '2026-01-16'::date
        `;
        expect(neighbouringRows).toHaveLength(0);
      });

      // 2. Creating a minor (with a household) adds 1 more. The row has the same five columns, and nothing in it identifies the person.
      const household = await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          return createHousehold(tx, kms, KEY_ARN, {
            now,
            label: null,
            actorUserId: null,
          });
        }),
      );

      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: false,
            householdId: household.householdId,
            dateOfBirth: null,
            givenName: "Minor",
            familyName: "Person",
            email: null,
            phone: null,
            actorUserId: null,
          });
        }),
      );

      await withAppTransaction(app, scope, async (tx) => {
        const rows = await tx<Record<string, unknown>[]>`
          select *
          from app.usage_facts_daily
          where org_id = ${scope.orgId}::uuid
            and community_id = ${scope.communityId}::uuid
        `;
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.success_count).toBe(2);
        expect(Object.keys(row).sort()).toEqual([
          "community_id",
          "day",
          "feature_key",
          "org_id",
          "success_count",
        ]);
        expect(row).not.toHaveProperty("person_id");
        expect(row).not.toHaveProperty("is_minor");

        const dayRows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
          where org_id = ${scope.orgId}::uuid
            and community_id = ${scope.communityId}::uuid
        `;
        expect(dayRows).toEqual([
          { feature_key: "people.directory", day: "2026-01-15", success_count: 2 },
        ]);

        const neighbouringRows = await tx<{ day: string }[]>`
          select day::text as day
          from app.usage_facts_daily
          where org_id = ${scope.orgId}::uuid
            and community_id = ${scope.communityId}::uuid
            and day = '2026-01-16'::date
        `;
        expect(neighbouringRows).toHaveLength(0);
      });
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("a duplicate caught by the caller adds nothing", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const kms = createLocalKmsPort();
    const scope = await createScope(platform);
    const now = new Date("2026-02-03T09:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await createPerson(tx, kms, KEY_ARN, {
            now,
            declaredAdult: true,
            householdId: null,
            dateOfBirth: null,
            givenName: "Ada",
            familyName: "Example",
            email: "duplicate@example.test",
            phone: null,
            actorUserId: null,
          });

          let caught: unknown = null;
          try {
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "Duplicate",
              familyName: "Example",
              email: "duplicate@example.test",
              phone: null,
              actorUserId: null,
            });
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(PeopleError);
          expect((caught as PeopleError).code).toBe("duplicate_email");
        }),
      );

      await withAppTransaction(app, scope, async (tx) => {
        const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
          where org_id = ${scope.orgId}::uuid
            and community_id = ${scope.communityId}::uuid
        `;
        expect(rows).toEqual([
          { feature_key: "people.directory", day: "2026-02-03", success_count: 1 },
        ]);
      });
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await app.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it(
    "does not deadlock with a writer that audits before it counts",
    { timeout: 30_000 },
    async () => {
      const runtime = loadRuntime();
      const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
      const appSqlA = createPlaintextAppSql(roleUrl(runtime, "app"));
      const appSqlB = createPlaintextAppSql(roleUrl(runtime, "app"));
      const observer = createPlaintextDirectSql(runtime.productOnlyUrl);
      const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
      const kms = createLocalKmsPort();
      const scope = await createScope(platform);
      const now = new Date("2026-04-20T12:00:00.000Z");

      // Set up the community key before A starts, so B's first lock wait is the audit insert.
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(appSqlA, scope, async (tx) => {
          await communityFieldKeys(tx, kms, KEY_ARN);
        }),
      );

      let releaseA!: () => void;
      const holdA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      let aAudited = false;
      let txAPromise: Promise<void> | undefined;
      let txBPromise: Promise<void> | undefined;

      try {
        txAPromise = withRequest({ requestId: newId() }, () =>
          withAppTransaction(appSqlA, scope, async (tx) => {
            // PERSON_CREATED constant in person.ts is not exported for tests; using registered action literal "people.person.created"
            await appendAuditEvent(tx, {
              actorKind: "system",
              actorId: null,
              action: "people.person.created",
              purpose: "people.person.created",
              targetIds: [newId()],
            });
            aAudited = true;
            await holdA;
            await recordSuccess(tx, "people.directory", now);
          }),
        );

        const startA = Date.now();
        while (!aAudited && Date.now() - startA < 3_000) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(aAudited).toBe(true);

        let bPid: number | null = null;
        let bSettled = false;

        txBPromise = withRequest({ requestId: newId() }, () =>
          withAppTransaction(appSqlB, scope, async (tx) => {
            const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
            bPid = row?.pid ?? null;
            await createPerson(tx, kms, KEY_ARN, {
              now,
              declaredAdult: true,
              householdId: null,
              dateOfBirth: null,
              givenName: "B",
              familyName: "Person",
              email: "b@example.test",
              phone: null,
              actorUserId: null,
            });
          }),
        ).finally(() => {
          bSettled = true;
        });

        const startB = Date.now();
        while (bPid === null && Date.now() - startB < 3_000) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(bPid).not.toBeNull();

        const started = Date.now();
        let waiting = false;
        while (Date.now() - started < 3_000) {
          if (bSettled) break;
          const waitingRows = await observer<{ pid: number }[]>`
            select pid
            from pg_stat_activity
            where datname = current_database()
              and pid = ${bPid}
              and state = 'active'
              and wait_event_type = 'Lock'
          `;
          if (waitingRows.length > 0) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        expect(waiting).toBe(true);

        releaseA();
        const [resA, resB] = await Promise.allSettled([txAPromise!, txBPromise!]);
        if (resA.status === "rejected") {
          throw resA.reason;
        }
        if (resB.status === "rejected") {
          throw resB.reason;
        }
        expect(resA.status).toBe("fulfilled");
        expect(resB.status).toBe("fulfilled");

        await withAppTransaction(appSqlA, scope, async (tx) => {
          const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
            select feature_key, day::text as day, success_count
            from app.usage_facts_daily
            where org_id = ${scope.orgId}::uuid
              and community_id = ${scope.communityId}::uuid
          `;
          expect(rows).toEqual([
            { feature_key: "people.directory", day: "2026-04-20", success_count: 2 },
          ]);
        });
      } finally {
        releaseA?.();
        await txAPromise?.catch(() => undefined);
        await txBPromise?.catch(() => undefined);
        try {
          await cleanScope(directSql, scope);
        } finally {
          await platform.end({ timeout: 1 });
          await appSqlA.end({ timeout: 1 });
          await appSqlB.end({ timeout: 1 });
          await observer.end({ timeout: 1 });
          await directSql.end({ timeout: 1 });
        }
      }
    },
  );
});
