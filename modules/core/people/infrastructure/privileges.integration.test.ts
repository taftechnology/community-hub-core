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

describe("people table privileges", () => {
  it("lets app select persons, and not update or delete them", async () => {
    const runtime = loadRuntime();
    const sql = createPlaintextDirectSql(runtime.productOnlyUrl);
    try {
      const rows = await sql<
        {
          persons_update: boolean;
          persons_delete: boolean;
          guardian_delete: boolean;
          identity_select: boolean;
          platform_select: boolean;
          app_select: boolean;
        }[]
      >`
        select
          has_table_privilege('app', 'app.persons', 'UPDATE') as persons_update,
          has_table_privilege('app', 'app.persons', 'DELETE') as persons_delete,
          has_table_privilege('app', 'app.guardian_links', 'DELETE') as guardian_delete,
          has_table_privilege('identity', 'app.persons', 'SELECT') as identity_select,
          has_table_privilege('platform', 'app.persons', 'SELECT') as platform_select,
          has_table_privilege('app', 'app.persons', 'SELECT') as app_select
      `;
      expect(rows).toEqual([
        {
          persons_update: false,
          persons_delete: false,
          guardian_delete: true,
          identity_select: false,
          platform_select: false,
          app_select: true,
        },
      ]);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
