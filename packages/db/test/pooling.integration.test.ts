import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { withAppTransaction } from "../src/app-transaction.js";
import { createPlaintextAppSql, createPlaintextDirectSql } from "../src/plaintext.js";
import { newId } from "../src/ids.js";
import { applyProductMigrations } from "../src/migrate.js";
import { applyTestMigrations } from "./migrate-test.js";

type Runtime = {
  directUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const DIR = path.dirname(fileURLToPath(import.meta.url));

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(path.join(DIR, ".runtime.json"), "utf8")) as Runtime;
}

function pooledAppUrl(runtime: Runtime, alias: "hub" | "hub_bleed" | "hub_reuse"): string {
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

describe.sequential("pooled tenant scope", () => {
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

  it("bleeds a session-level set_config into the next client on hub_bleed", async () => {
    const runtime = loadRuntime();
    const url = pooledAppUrl(runtime, "hub_bleed");
    const a = createPlaintextAppSql(url);
    const b = createPlaintextAppSql(url);
    const orgId = newId();
    try {
      await assertSameBackend(a, b);
      await a`select set_config('app.org_id', ${orgId}, ${false})`;
      const rows = await b<{ value: string }[]>`select current_setting('app.org_id') as value`;
      expect(rows[0]?.value).toBe(orgId);
    } finally {
      await b.unsafe("reset app.org_id").catch(() => undefined);
      await a.end({ timeout: 1 });
      await b.end({ timeout: 1 });
    }
  });

  it("does not leak withAppTransaction scope as a readable tenant id on hub_reuse", async () => {
    const runtime = loadRuntime();
    const url = pooledAppUrl(runtime, "hub_reuse");
    const a = createPlaintextAppSql(url);
    const b = createPlaintextAppSql(url);
    try {
      await assertSameBackend(a, b);
      await withAppTransaction(a, { orgId: newId(), communityId: newId() }, async (tx) => {
        await tx`select 1`;
      });
      await expect(b`select * from app.synthetic`).rejects.toThrow(
        /unrecognized configuration parameter "app\.org_id"|invalid input syntax for type uuid/i,
      );
    } finally {
      await a.end({ timeout: 1 });
      await b.end({ timeout: 1 });
    }
  });

  it("keeps two organisations from seeing each other's app.synthetic rows", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextAppSql(pooledAppUrl(runtime, "hub"));
    const orgA = newId();
    const orgB = newId();
    const idA = newId();
    const idB = newId();
    try {
      await withAppTransaction(sql, { orgId: orgA, communityId: newId() }, async (tx) => {
        await tx`insert into app.synthetic (org_id, id) values (${orgA}, ${idA})`;
      });
      await withAppTransaction(sql, { orgId: orgB, communityId: newId() }, async (tx) => {
        await tx`insert into app.synthetic (org_id, id) values (${orgB}, ${idB})`;
      });

      const seenA = await withAppTransaction(
        sql,
        { orgId: orgA, communityId: newId() },
        async (tx) => {
          return tx<{ id: string }[]>`select id from app.synthetic`;
        },
      );
      const seenB = await withAppTransaction(
        sql,
        { orgId: orgB, communityId: newId() },
        async (tx) => {
          return tx<{ id: string }[]>`select id from app.synthetic`;
        },
      );
      expect(seenA.map((row) => row.id)).toEqual([idA]);
      expect(seenB.map((row) => row.id)).toEqual([idB]);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("createIdentitySql does not SET ROLE or set tenant GUC", () => {
    const src = readFileSync(path.join(DIR, "../src/connections.ts"), "utf8");
    expect(src).toMatch(/export function createIdentitySql/);
    expect(src).not.toMatch(/SET ROLE/i);
    expect(src).not.toMatch(/set_config\(\s*['"]app\.org_id['"]/);
  });
});
