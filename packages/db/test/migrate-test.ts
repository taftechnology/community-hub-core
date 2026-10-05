import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../src/migrate.js";
import { createPlaintextDirectSql } from "../src/plaintext.js";

const TEST_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../drizzle-test");
const TEST_TABLE = "__drizzle_migrations_test";

export async function applyTestMigrations(opts: { mode: "test" }, url: string): Promise<void> {
  if (opts?.mode !== "test") {
    throw new Error("applyTestMigrations requires { mode: 'test' }");
  }
  const sql = createPlaintextDirectSql(url);
  try {
    await applyMigrations({
      sql,
      folder: TEST_FOLDER,
      table: TEST_TABLE,
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
}
