import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runBootstrap } from "../src/bootstrap.js";
import { createDirectSql, createPooledSql } from "../src/connections.js";

type Runtime = {
  directUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

function loadRuntime(): Runtime {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), ".runtime.json");
  return JSON.parse(readFileSync(file, "utf8")) as Runtime;
}

describe("bootstrap", () => {
  it("is idempotent", async () => {
    const runtime = loadRuntime();
    const sql = createDirectSql(runtime.directUrl);
    try {
      await runBootstrap(sql);
      await runBootstrap(sql);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("creates four roles with migrator NOLOGIN and migrator-owned schema", async () => {
    const runtime = loadRuntime();
    const sql = createDirectSql(runtime.directUrl);
    try {
      const roles = await sql<
        {
          rolname: string;
          rolcanlogin: boolean;
        }[]
      >`
        select rolname, rolcanlogin
        from pg_roles
        where rolname in ('migrator', 'app', 'identity', 'platform')
        order by rolname
      `;
      expect(roles).toEqual([
        { rolname: "app", rolcanlogin: true },
        { rolname: "identity", rolcanlogin: true },
        { rolname: "migrator", rolcanlogin: false },
        { rolname: "platform", rolcanlogin: true },
      ]);

      const schemas = await sql<{ nspname: string; owner: string }[]>`
        select n.nspname, r.rolname as owner
        from pg_namespace n
        join pg_roles r on r.oid = n.nspowner
        where n.nspname = 'migrator'
      `;
      expect(schemas).toEqual([{ nspname: "migrator", owner: "migrator" }]);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("denies CREATE TEMP TABLE to app, identity and platform", async () => {
    const runtime = loadRuntime();
    for (const role of ["app", "identity", "platform"] as const) {
      const sql = createPooledSql(pooledUrl(runtime, role, "hub"));
      try {
        await expect(sql.unsafe("create temp table t (id int)")).rejects.toThrow(
          /permission denied to create temporary tables/i,
        );
      } finally {
        await sql.end({ timeout: 1 });
      }
    }
  });

  it("lets app authenticate through PgBouncer with the env plaintext", async () => {
    const runtime = loadRuntime();
    const sql = createPooledSql(pooledUrl(runtime, "app", "hub"));
    try {
      const [{ ok }] = await sql<{ ok: number }[]>`select 1 as ok`;
      expect(ok).toBe(1);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

function pooledUrl(runtime: Runtime, role: "app" | "identity" | "platform", db: string): string {
  const password = encodeURIComponent(runtime.passwords[role]);
  return `postgres://${role}:${password}@127.0.0.1:6432/${db}`;
}
