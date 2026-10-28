import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations, withAppTransaction } from "@community-hub/db";
import { createPlaintextAppSql, createPlaintextDirectSql } from "@community-hub/db/plaintext";

import { recordSuccess, UsageError } from "../public/index.js";
import { createSyntheticScopes } from "../test/fixtures/scopes.js";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "identity" | "platform"): string {
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

describe("recordSuccess", () => {
  it("the first call gives 1, a second call the same day gives 2, and a call the next UTC day makes a new row with 1", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scopes = createSyntheticScopes();
    const scope = scopes.orgA.community1;

    try {
      const day1 = new Date("2026-10-28T10:00:00.000Z");
      const day1Later = new Date("2026-10-28T22:30:00.000Z");
      const day2 = new Date("2026-10-29T01:00:00.000Z");

      await withAppTransaction(appSql, scope, async (tx) => {
        await recordSuccess(tx, "people.directory", day1);
      });

      await withAppTransaction(appSql, scope, async (tx) => {
        const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
          order by day
        `;
        expect(rows).toEqual([
          { feature_key: "people.directory", day: "2026-10-28", success_count: 1 },
        ]);
      });

      await withAppTransaction(appSql, scope, async (tx) => {
        await recordSuccess(tx, "people.directory", day1Later);
      });

      await withAppTransaction(appSql, scope, async (tx) => {
        const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
          order by day
        `;
        expect(rows).toEqual([
          { feature_key: "people.directory", day: "2026-10-28", success_count: 2 },
        ]);
      });

      await withAppTransaction(appSql, scope, async (tx) => {
        await recordSuccess(tx, "people.directory", day2);
      });

      await withAppTransaction(appSql, scope, async (tx) => {
        const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
          order by day
        `;
        expect(rows).toEqual([
          { feature_key: "people.directory", day: "2026-10-28", success_count: 2 },
          { feature_key: "people.directory", day: "2026-10-29", success_count: 1 },
        ]);
      });
    } finally {
      try {
        await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`;
      } finally {
        await directSql.end({ timeout: 1 });
        await appSql.end({ timeout: 1 });
      }
    }
  });

  it("a transaction that records and then throws leaves no row", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scopes = createSyntheticScopes();
    const scope = scopes.orgA.community1;

    try {
      const at = new Date("2026-10-28T12:00:00.000Z");
      await expect(
        withAppTransaction(appSql, scope, async (tx) => {
          await recordSuccess(tx, "people.directory", at);
          throw new Error("caller abort");
        }),
      ).rejects.toThrow("caller abort");

      const [row] = await directSql<{ count: string }[]>`
        select count(*)::text as count
        from app.usage_facts_daily
        where org_id = ${scope.orgId}::uuid
      `;
      expect(Number(row?.count ?? 0)).toBe(0);
    } finally {
      try {
        await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`;
      } finally {
        await directSql.end({ timeout: 1 });
        await appSql.end({ timeout: 1 });
      }
    }
  });

  it("keeps the UTC date under an Australian session time zone", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scopes = createSyntheticScopes();
    const scope = scopes.orgA.community1;

    try {
      await withAppTransaction(appSql, scope, async (tx) => {
        await tx`set local time zone 'Australia/Sydney'`;
        await recordSuccess(tx, "people.directory", new Date("2026-03-01T23:59:59.999Z"));
        const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
        `;
        expect(rows).toEqual([
          { feature_key: "people.directory", day: "2026-03-01", success_count: 1 },
        ]);
      });
    } finally {
      try {
        await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`;
      } finally {
        await directSql.end({ timeout: 1 });
        await appSql.end({ timeout: 1 });
      }
    }
  });

  it("two organisations see only their own facts", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scopes = createSyntheticScopes();
    const scopeA = scopes.orgA.community1;
    const scopeB = scopes.orgB.community1;
    expect(scopeA.communityId).toBe(scopeB.communityId);
    expect(scopeA.orgId).not.toBe(scopeB.orgId);

    const at = new Date("2026-10-28T12:00:00.000Z");

    try {
      await withAppTransaction(appSql, scopeA, async (tx) => {
        await recordSuccess(tx, "people.directory", at);
      });

      await withAppTransaction(appSql, scopeB, async (tx) => {
        await recordSuccess(tx, "people.directory", at);
      });

      await withAppTransaction(appSql, scopeA, async (tx) => {
        const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
        `;
        expect(rows).toEqual([
          { feature_key: "people.directory", day: "2026-10-28", success_count: 1 },
        ]);
      });

      await withAppTransaction(appSql, scopeB, async (tx) => {
        const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
        `;
        expect(rows).toEqual([
          { feature_key: "people.directory", day: "2026-10-28", success_count: 1 },
        ]);
      });
    } finally {
      try {
        await directSql`
          delete from app.usage_facts_daily
          where org_id in (${scopeA.orgId}::uuid, ${scopeB.orgId}::uuid)
        `;
      } finally {
        await directSql.end({ timeout: 1 });
        await appSql.end({ timeout: 1 });
      }
    }
  });

  it("two communities in one organisation see only their own facts", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scopes = createSyntheticScopes();
    const scope1 = scopes.orgA.community1;
    const scope2 = scopes.orgA.community2;
    expect(scope1.orgId).toBe(scope2.orgId);
    expect(scope1.communityId).not.toBe(scope2.communityId);

    const at = new Date("2026-10-28T12:00:00.000Z");

    try {
      await withAppTransaction(appSql, scope1, async (tx) => {
        await recordSuccess(tx, "people.directory", at);
      });

      await withAppTransaction(appSql, scope2, async (tx) => {
        await recordSuccess(tx, "people.directory", at);
      });

      await withAppTransaction(appSql, scope1, async (tx) => {
        const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
        `;
        expect(rows).toEqual([
          { feature_key: "people.directory", day: "2026-10-28", success_count: 1 },
        ]);
      });

      await withAppTransaction(appSql, scope2, async (tx) => {
        const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
        `;
        expect(rows).toEqual([
          { feature_key: "people.directory", day: "2026-10-28", success_count: 1 },
        ]);
      });
    } finally {
      try {
        await directSql`delete from app.usage_facts_daily where org_id = ${scope1.orgId}::uuid`;
      } finally {
        await directSql.end({ timeout: 1 });
        await appSql.end({ timeout: 1 });
      }
    }
  });

  it("counts both of two racing first inserts", { timeout: 30_000 }, async () => {
    const runtime = loadRuntime();
    const appSqlA = createPlaintextAppSql(roleUrl(runtime, "app"));
    const appSqlB = createPlaintextAppSql(roleUrl(runtime, "app"));
    const observer = createPlaintextDirectSql(runtime.productOnlyUrl);
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scopes = createSyntheticScopes();
    const scope = scopes.orgA.community1;
    const at = new Date("2026-10-28T12:00:00.000Z");

    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aRecorded = false;

    let txAPromise: Promise<void> | undefined;
    let txBPromise: Promise<void> | undefined;

    try {
      txAPromise = withAppTransaction(appSqlA, scope, async (tx) => {
        await recordSuccess(tx, "people.directory", at);
        aRecorded = true;
        await holdA;
      });

      const startA = Date.now();
      while (!aRecorded && Date.now() - startA < 3_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(aRecorded).toBe(true);

      let bPid: number | null = null;
      let bSettled = false;

      txBPromise = withAppTransaction(appSqlB, scope, async (tx) => {
        const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        bPid = row?.pid ?? null;
        await recordSuccess(tx, "people.directory", at);
      }).finally(() => {
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
      await txAPromise;
      await txBPromise;

      await withAppTransaction(appSqlA, scope, async (tx) => {
        const rows = await tx<{ feature_key: string; day: string; success_count: number }[]>`
          select feature_key, day::text as day, success_count
          from app.usage_facts_daily
        `;
        expect(rows).toEqual([
          { feature_key: "people.directory", day: "2026-10-28", success_count: 2 },
        ]);
      });
    } finally {
      releaseA?.();
      await txAPromise?.catch(() => undefined);
      await txBPromise?.catch(() => undefined);
      try {
        await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`;
      } finally {
        await observer.end({ timeout: 1 });
        await appSqlA.end({ timeout: 1 });
        await appSqlB.end({ timeout: 1 });
        await directSql.end({ timeout: 1 });
      }
    }
  });

  it("rejects a bad key before any SQL", async () => {
    const runtime = loadRuntime();
    const appSql = createPlaintextAppSql(roleUrl(runtime, "app"));
    const directSql = createPlaintextDirectSql(runtime.productOnlyUrl);
    const scopes = createSyntheticScopes();
    const scope = scopes.orgA.community1;
    const validDate = new Date("2026-10-28T12:00:00.000Z");

    try {
      await withAppTransaction(appSql, scope, async (tx) => {
        await expect(recordSuccess(tx, "people", validDate)).rejects.toThrow(
          new UsageError("invalid_feature_key"),
        );
        const [res] = await tx<{ ok: number }[]>`select 1 as ok`;
        expect(res?.ok).toBe(1);
      });

      await withAppTransaction(appSql, scope, async (tx) => {
        await expect(recordSuccess(tx, "People.directory", validDate)).rejects.toThrow(
          new UsageError("invalid_feature_key"),
        );
        const [res] = await tx<{ ok: number }[]>`select 1 as ok`;
        expect(res?.ok).toBe(1);
      });

      await withAppTransaction(appSql, scope, async (tx) => {
        await expect(recordSuccess(tx, "people.directory", new Date("not-a-date"))).rejects.toThrow(
          new UsageError("invalid_time"),
        );
        const [res] = await tx<{ ok: number }[]>`select 1 as ok`;
        expect(res?.ok).toBe(1);
      });

      const [row] = await directSql<{ count: string }[]>`
        select count(*)::text as count
        from app.usage_facts_daily
        where org_id = ${scope.orgId}::uuid
      `;
      expect(Number(row?.count ?? 0)).toBe(0);
    } finally {
      try {
        await directSql`delete from app.usage_facts_daily where org_id = ${scope.orgId}::uuid`;
      } finally {
        await directSql.end({ timeout: 1 });
        await appSql.end({ timeout: 1 });
      }
    }
  });
});
