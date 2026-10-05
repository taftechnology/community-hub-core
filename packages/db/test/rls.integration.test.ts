import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createPlaintextDirectSql } from "../src/plaintext.js";
import { applyProductMigrations } from "../src/migrate.js";
import { applyTestMigrations } from "./migrate-test.js";

type Runtime = {
  directUrl: string;
};

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE = path.join(DIR, "../drizzle");

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(path.join(DIR, ".runtime.json"), "utf8")) as Runtime;
}

describe("applyTestMigrations", () => {
  it("requires { mode: 'test' }", async () => {
    const runtime = loadRuntime();
    await expect(
      applyTestMigrations({ mode: "prod" } as unknown as { mode: "test" }, runtime.directUrl),
    ).rejects.toThrow(/mode: 'test'/i);
  });

  it("owns app.synthetic as migrator and FORCE RLS blocks the owner", async () => {
    const runtime = loadRuntime();
    const migration = createPlaintextDirectSql(runtime.directUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }
    await applyTestMigrations({ mode: "test" }, runtime.directUrl);

    const sql = createPlaintextDirectSql(runtime.directUrl);
    try {
      const [{ owner }] = await sql<{ owner: string }[]>`
        select r.rolname as owner
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_roles r on r.oid = c.relowner
        where n.nspname = 'app' and c.relname = 'synthetic'
      `;
      expect(owner).toBe("migrator");

      await sql.unsafe("set role migrator");
      await expect(sql`select * from app.synthetic`).rejects.toThrow(
        /unrecognized configuration parameter "app\.org_id"/i,
      );
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("does not write the synthetic migration into the product journal", async () => {
    const runtime = loadRuntime();
    const migration = createPlaintextDirectSql(runtime.directUrl);
    try {
      await applyProductMigrations(migration);
    } finally {
      await migration.end({ timeout: 1 });
    }
    await applyTestMigrations({ mode: "test" }, runtime.directUrl);
    const again = createPlaintextDirectSql(runtime.directUrl);
    try {
      await applyProductMigrations(again);
    } finally {
      await again.end({ timeout: 1 });
    }

    const sql = createPlaintextDirectSql(runtime.directUrl);
    try {
      const product = await sql<{ hash: string }[]>`
        select hash from migrator.__drizzle_migrations
      `;
      const journal = JSON.parse(
        readFileSync(path.join(DRIZZLE, "meta/_journal.json"), "utf8"),
      ) as { entries: unknown[] };
      expect(product).toHaveLength(journal.entries.length);

      const [{ testN }] = await sql<{ testN: string }[]>`
        select count(*)::text as "testN" from migrator.__drizzle_migrations_test
      `;
      expect(testN).toBe("3");
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
