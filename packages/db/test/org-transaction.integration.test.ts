import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { withAppTransaction } from "../src/app-transaction.js";
import { createPlaintextAppSql, createPlaintextDirectSql } from "../src/plaintext.js";
import { newId } from "../src/ids.js";
import { applyProductMigrations } from "../src/migrate.js";
import { withOrgTransaction } from "../src/tx.js";
import { applyTestMigrations } from "./migrate-test.js";

type Runtime = {
  directUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Fresh session: 42704. Reused after set_config: ''::uuid → 22P02. */
const COMMUNITY_ID_UNSET =
  /unrecognized configuration parameter "app\.community_id"|invalid input syntax for type uuid/i;

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(path.join(DIR, ".runtime.json"), "utf8")) as Runtime;
}

function pooledAppUrl(runtime: Runtime, alias: "hub" | "hub_reuse"): string {
  return `postgres://app:${encodeURIComponent(runtime.passwords.app)}@127.0.0.1:6432/${alias}`;
}

async function backendPid(sql: ReturnType<typeof createPlaintextAppSql>): Promise<number> {
  const rows = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const pid = rows[0]?.pid;
  expect(pid).toEqual(expect.any(Number));
  return pid as number;
}

async function assertSameBackend(
  a: ReturnType<typeof createPlaintextAppSql>,
  b: ReturnType<typeof createPlaintextAppSql>,
): Promise<void> {
  const pidA = await backendPid(a);
  const pidB = await backendPid(b);
  expect(pidA, "PgBouncer alias must reuse one server backend").toBe(pidB);
}

describe.sequential("withOrgTransaction", () => {
  beforeAll(async () => {
    const runtime = loadRuntime();
    const migration = createPlaintextDirectSql(runtime.directUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }
    await applyTestMigrations({ mode: "test" }, runtime.directUrl);
  });

  it("sets app.org_id and cannot read community-scoped tables", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextAppSql(pooledAppUrl(runtime, "hub"));
    const orgId = newId();
    try {
      const orgRows = await withOrgTransaction(sql, orgId, async (tx) => {
        return tx<{ value: string }[]>`select current_setting('app.org_id') as value`;
      });
      expect(orgRows[0]?.value).toBe(orgId);

      await expect(
        withOrgTransaction(sql, orgId, async (tx) => {
          await tx`select * from app.synthetic_community`;
        }),
      ).rejects.toThrow(COMMUNITY_ID_UNSET);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("does not leak withAppTransaction community_id into withOrgTransaction on hub_reuse", async () => {
    const runtime = loadRuntime();
    const url = pooledAppUrl(runtime, "hub_reuse");
    const a = createPlaintextAppSql(url);
    const b = createPlaintextAppSql(url);
    try {
      await assertSameBackend(a, b);
      await withAppTransaction(a, { orgId: newId(), communityId: newId() }, async (tx) => {
        await tx`select 1`;
      });
      await expect(
        withOrgTransaction(b, newId(), async (tx) => {
          await tx`select * from app.synthetic_community`;
        }),
      ).rejects.toThrow(COMMUNITY_ID_UNSET);
    } finally {
      await a.end({ timeout: 1 });
      await b.end({ timeout: 1 });
    }
  });
});
