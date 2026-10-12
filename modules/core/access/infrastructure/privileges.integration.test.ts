import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations } from "@community-hub/db";
import { createPlaintextDirectSql } from "@community-hub/db/plaintext";

type Runtime = {
  productOnlyUrl: string;
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

const TABLE = "community_role_grants";

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
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

async function privilege(
  sql: ReturnType<typeof createPlaintextDirectSql>,
  role: "app" | "identity" | "platform",
  kind: "SELECT" | "UPDATE" | "DELETE",
): Promise<boolean> {
  const rows = await sql<{ granted: boolean }[]>`
    select has_table_privilege(${role}, ${`app.${TABLE}`}, ${kind}) as granted
  `;
  return rows[0]?.granted ?? false;
}

describe("access grant privileges", () => {
  it("lets app select and delete community grants, and not update them", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      expect(await privilege(sql, "app", "SELECT")).toBe(true);
      expect(await privilege(sql, "app", "UPDATE")).toBe(false);
      expect(await privilege(sql, "app", "DELETE")).toBe(true);
      expect(await privilege(sql, "identity", "SELECT")).toBe(false);
      expect(await privilege(sql, "platform", "SELECT")).toBe(false);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
