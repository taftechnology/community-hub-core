import { beforeAll, describe, expect, it } from "vitest";

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

import {
  archiveGroup,
  createGroup,
  listGroups,
  readGroup,
  restoreGroup,
  updateGroup,
} from "../public/index.js";
import { cleanScope, createScope, loadRuntime, roleUrl } from "../test/fixtures/real-scope.js";
import { createSyntheticScopes } from "../test/fixtures/scopes.js";

type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE";

async function privilege(
  sql: ReturnType<typeof createPlaintextDirectSql>,
  role: "app" | "identity" | "platform",
  table: string,
  kind: Privilege,
): Promise<boolean> {
  const rows = await sql<{ granted: boolean }[]>`
    select has_table_privilege(${role}, ${`app.${table}`}, ${kind}) as granted
  `;
  return rows[0]?.granted ?? false;
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

describe("groups schema and privileges", () => {
  it("forces row level security on both tables (pin 1)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      for (const table of ["groups", "group_members"]) {
        const [rel] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
          select c.relrowsecurity, c.relforcerowsecurity
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relname = ${table}
        `;
        expect(rel, `${table} rls`).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("the app role cannot delete a group (pin 2)", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const scopes = createSyntheticScopes();
    try {
      await expect(
        withAppTransaction(appSql, scopes.orgA.community1, async (tx) => {
          await tx`delete from app.groups`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await appSql.end({ timeout: 1 });
    }
  });

  it("gives app select, insert and update on groups, but takes delete and truncate (pin 2)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      expect(await privilege(sql, "app", "groups", "SELECT")).toBe(true);
      expect(await privilege(sql, "app", "groups", "INSERT")).toBe(true);
      expect(await privilege(sql, "app", "groups", "UPDATE")).toBe(true);
      expect(await privilege(sql, "app", "groups", "DELETE")).toBe(false);
      expect(await privilege(sql, "app", "groups", "TRUNCATE")).toBe(false);

      expect(await privilege(sql, "app", "group_members", "SELECT")).toBe(true);
      expect(await privilege(sql, "app", "group_members", "INSERT")).toBe(true);
      expect(await privilege(sql, "app", "group_members", "UPDATE")).toBe(true);
      expect(await privilege(sql, "app", "group_members", "DELETE")).toBe(true);
      expect(await privilege(sql, "app", "group_members", "TRUNCATE")).toBe(false);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("identity and platform have no privileges on either table (pin 2)", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      for (const table of ["groups", "group_members"]) {
        for (const role of ["identity", "platform"] as const) {
          for (const kind of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const) {
            expect(await privilege(sql, role, table, kind), `${role} on ${table} ${kind}`).toBe(
              false,
            );
          }
        }
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

describe("group operations", () => {
  it("creates, reads, updates, archives, restores, and lists groups", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-05-01T10:00:00.000Z");
    const later = new Date("2026-05-01T11:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          // Empty list on a fresh community
          const empty = await listGroups(tx);
          expect(empty).toEqual([]);

          // Create group
          const created = await createGroup(tx, {
            name: "Youth Group",
            description: "For high schoolers",
            kind: "ministry",
            now,
            actorUserId: null,
          });
          expect(created.id).toBeDefined();
          expect(created.name).toBe("Youth Group");
          expect(created.nameKey).toBe("youth group");
          expect(created.description).toBe("For high schoolers");
          expect(created.kind).toBe("ministry");
          expect(created.status).toBe("active");
          expect(created.createdAt).toEqual(now);
          expect(created.updatedAt).toEqual(now);

          // Read group
          const read = await readGroup(tx, created.id);
          expect(read).toEqual(created);

          // Update group
          const updated = await updateGroup(tx, created.id, {
            name: "Senior Youth Group",
            description: "Updated description",
            now: later,
            actorUserId: null,
          });
          expect(updated.name).toBe("Senior Youth Group");
          expect(updated.nameKey).toBe("senior youth group");
          expect(updated.description).toBe("Updated description");
          expect(updated.updatedAt).toEqual(later);

          // Archive group
          const archived = await archiveGroup(tx, created.id, {
            now: later,
            actorUserId: null,
          });
          expect(archived.status).toBe("archived");

          // Listing active groups hides archived by default
          const activeList = await listGroups(tx);
          expect(activeList).toEqual([]);

          // Listing with includeArchived returns it
          const fullList = await listGroups(tx, { includeArchived: true });
          expect(fullList).toHaveLength(1);
          expect(fullList[0]?.id).toBe(created.id);
          expect(fullList[0]?.status).toBe("archived");

          // Archived group rejects edits with group_archived
          await expect(
            updateGroup(tx, created.id, {
              name: "New Name",
              now: later,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "group_archived" });

          // Restore group
          const restored = await restoreGroup(tx, created.id, {
            now: later,
            actorUserId: null,
          });
          expect(restored.status).toBe("active");

          // Active again in listing
          const activeAfterRestore = await listGroups(tx);
          expect(activeAfterRestore).toHaveLength(1);
          expect(activeAfterRestore[0]?.id).toBe(created.id);

          // Non-existent id throws group_not_found
          const missingId = newId();
          await expect(readGroup(tx, missingId)).rejects.toMatchObject({
            code: "group_not_found",
          });
          await expect(
            updateGroup(tx, missingId, { name: "Missing", now: later, actorUserId: null }),
          ).rejects.toMatchObject({ code: "group_not_found" });
          await expect(
            archiveGroup(tx, missingId, { now: later, actorUserId: null }),
          ).rejects.toMatchObject({ code: "group_not_found" });
          await expect(
            restoreGroup(tx, missingId, { now: later, actorUserId: null }),
          ).rejects.toMatchObject({ code: "group_not_found" });
        }),
      );
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

  it("rejects a duplicate active name and allows an archived one to be reused (pin 8)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-05-02T10:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          const g1 = await createGroup(tx, {
            name: "Choir",
            kind: "ministry",
            now,
            actorUserId: null,
          });

          // Duplicate active name rejected
          await expect(
            createGroup(tx, {
              name: "choir",
              kind: "ministry",
              now,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "duplicate_name" });

          // Archive g1
          await archiveGroup(tx, g1.id, { now, actorUserId: null });

          // Archived name can be reused by a new group
          const g2 = await createGroup(tx, {
            name: "Choir",
            kind: "ministry",
            now,
            actorUserId: null,
          });
          expect(g2.id).not.toBe(g1.id);

          // Restoring g1 is blocked while g2 is active with that name
          await expect(restoreGroup(tx, g1.id, { now, actorUserId: null })).rejects.toMatchObject({
            code: "duplicate_name",
          });

          // Archive g2, now g1 can be restored
          await archiveGroup(tx, g2.id, { now, actorUserId: null });
          const restored = await restoreGroup(tx, g1.id, { now, actorUserId: null });
          expect(restored.status).toBe("active");
        }),
      );
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

  it("treats padded and recased names as one (pin 9)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-05-03T10:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await createGroup(tx, {
            name: "Youth Group",
            kind: "group",
            now,
            actorUserId: null,
          });

          // Padded, multiple internal spaces, different case conflicts
          await expect(
            createGroup(tx, {
              name: "  youth   GROUP  ",
              kind: "group",
              now,
              actorUserId: null,
            }),
          ).rejects.toMatchObject({ code: "duplicate_name" });
        }),
      );
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

  it("a duplicate create adds no usage (pin 10)", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-05-04T12:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await createGroup(tx, {
            name: "Duplicate Usage Group",
            kind: "ministry",
            now,
            actorUserId: null,
          });

          // Caught duplicate create inside same transaction
          try {
            await createGroup(tx, {
              name: "Duplicate Usage Group",
              kind: "ministry",
              now,
              actorUserId: null,
            });
          } catch (err) {
            expect(err).toMatchObject({ code: "duplicate_name" });
          }
        }),
      );

      // Usage count must be exactly 1
      const rows = await directSql<{ success_count: number }[]>`
        select success_count
        from app.usage_facts_daily
        where org_id = ${scope.orgId}::uuid
          and community_id = ${scope.communityId}::uuid
          and feature_key = 'groups.basic'
      `;
      expect(rows).toEqual([{ success_count: 1 }]);
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
    "does not deadlock with a writer that audits before it counts (pin 11)",
    { timeout: 30_000 },
    async () => {
      const runtime = loadRuntime();
      const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
      const appSqlA = createPlaintextAppSql(roleUrl(runtime, "app"));
      const appSqlB = createPlaintextAppSql(roleUrl(runtime, "app"));
      const observer = createPlaintextDirectSql(runtime.productOnlyUrl);
      const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
      const scope = await createScope(platform);
      const now = new Date("2026-05-05T12:00:00.000Z");

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
            await appendAuditEvent(tx, {
              actorKind: "system",
              actorId: null,
              action: "groups.group.created",
              purpose: "groups.group.created",
              targetIds: [newId()],
            });
            aAudited = true;
            await holdA;
            await recordSuccess(tx, "groups.basic", now);
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
            await createGroup(tx, {
              name: "Writer B Group",
              kind: "ministry",
              now,
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
            { feature_key: "groups.basic", day: "2026-05-05", success_count: 2 },
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

  it("two concurrent creates of one name end with one active group and one duplicate_name", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const appSql1 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const appSql2 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-05-06T12:00:00.000Z");

    try {
      const task1 = withRequest({ requestId: newId() }, () =>
        withAppTransaction(appSql1, scope, (tx) =>
          createGroup(tx, {
            name: "Concurrent Group",
            kind: "ministry",
            now,
            actorUserId: null,
          }),
        ),
      );

      const task2 = withRequest({ requestId: newId() }, () =>
        withAppTransaction(appSql2, scope, (tx) =>
          createGroup(tx, {
            name: "Concurrent Group",
            kind: "ministry",
            now,
            actorUserId: null,
          }),
        ),
      );

      const [res1, res2] = await Promise.allSettled([task1, task2]);
      const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
      const rejected = [res1, res2].filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "duplicate_name",
      });

      await withAppTransaction(appSql1, scope, async (tx) => {
        const groups = await listGroups(tx);
        expect(groups).toHaveLength(1);
        expect(groups[0]?.name).toBe("Concurrent Group");
      });
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await appSql1.end({ timeout: 1 });
        await appSql2.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("a restore racing a create ends with one active group", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const appSql1 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const appSql2 = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-05-07T12:00:00.000Z");

    try {
      let g1Id = "";
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(appSql1, scope, async (tx) => {
          const g = await createGroup(tx, {
            name: "Racing Group",
            kind: "group",
            now,
            actorUserId: null,
          });
          g1Id = g.id;
          await archiveGroup(tx, g1Id, { now, actorUserId: null });
        }),
      );

      const taskCreate = withRequest({ requestId: newId() }, () =>
        withAppTransaction(appSql1, scope, (tx) =>
          createGroup(tx, {
            name: "Racing Group",
            kind: "group",
            now,
            actorUserId: null,
          }),
        ),
      );

      const taskRestore = withRequest({ requestId: newId() }, () =>
        withAppTransaction(appSql2, scope, (tx) =>
          restoreGroup(tx, g1Id, {
            now,
            actorUserId: null,
          }),
        ),
      );

      const [res1, res2] = await Promise.allSettled([taskCreate, taskRestore]);
      const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
      const rejected = [res1, res2].filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "duplicate_name",
      });

      await withAppTransaction(appSql1, scope, async (tx) => {
        const groups = await listGroups(tx);
        expect(groups).toHaveLength(1);
      });
    } finally {
      try {
        await cleanScope(directSql, scope);
      } finally {
        await platform.end({ timeout: 1 });
        await appSql1.end({ timeout: 1 });
        await appSql2.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("two communities in one organisation see only their own groups (pin 4)", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scopes = createSyntheticScopes();
    const now = new Date("2026-05-08T12:00:00.000Z");

    try {
      let g1Id = "";
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(appSql, scopes.orgA.community1, async (tx) => {
          const g = await createGroup(tx, {
            name: "Comm1 Group",
            kind: "group",
            now,
            actorUserId: null,
          });
          g1Id = g.id;
        }),
      );

      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(appSql, scopes.orgA.community2, async (tx) => {
          const list = await listGroups(tx);
          expect(list).toEqual([]);
          await expect(readGroup(tx, g1Id)).rejects.toMatchObject({
            code: "group_not_found",
          });

          // Same name can be created in community 2
          const g2 = await createGroup(tx, {
            name: "Comm1 Group",
            kind: "group",
            now,
            actorUserId: null,
          });
          expect(g2.id).not.toBe(g1Id);
        }),
      );
    } finally {
      await directSql`delete from app.groups where org_id = ${scopes.orgA.id}::uuid`.catch(
        () => {},
      );
      await appSql.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("two organisations see only their own groups (pin 5)", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scopes = createSyntheticScopes();
    const now = new Date("2026-05-09T12:00:00.000Z");

    try {
      let gAId = "";
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(appSql, scopes.orgA.community1, async (tx) => {
          const g = await createGroup(tx, {
            name: "OrgA Group",
            kind: "ministry",
            now,
            actorUserId: null,
          });
          gAId = g.id;
        }),
      );

      // Org B shares the same community UUID, but different orgId
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(appSql, scopes.orgB.community1, async (tx) => {
          const list = await listGroups(tx);
          expect(list).toEqual([]);
          await expect(readGroup(tx, gAId)).rejects.toMatchObject({
            code: "group_not_found",
          });

          // Can create same name in Org B
          const gB = await createGroup(tx, {
            name: "OrgA Group",
            kind: "ministry",
            now,
            actorUserId: null,
          });
          expect(gB.id).not.toBe(gAId);
        }),
      );
    } finally {
      await directSql`delete from app.groups where org_id in (${scopes.orgA.id}::uuid, ${scopes.orgB.id}::uuid)`.catch(
        () => {},
      );
      await appSql.end({ timeout: 1 });
      await directSql.end({ timeout: 1 });
    }
  });

  it("createGroup adds exactly one to groups.basic usage", async () => {
    const runtime = loadRuntime();
    const platform = createPlaintextPlatformSql(roleUrl(runtime, "platform"));
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scope = await createScope(platform);
    const now = new Date("2026-05-10T12:00:00.000Z");

    try {
      await withRequest({ requestId: newId() }, () =>
        withAppTransaction(app, scope, async (tx) => {
          await createGroup(tx, {
            name: "Usage Test Group",
            kind: "group",
            now,
            actorUserId: null,
          });
        }),
      );

      const rows = await directSql<
        {
          feature_key: string;
          day: string;
          success_count: number;
        }[]
      >`
        select feature_key, day::text as day, success_count
        from app.usage_facts_daily
        where org_id = ${scope.orgId}::uuid
          and community_id = ${scope.communityId}::uuid
      `;
      expect(rows).toEqual([{ feature_key: "groups.basic", day: "2026-05-10", success_count: 1 }]);
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
});
