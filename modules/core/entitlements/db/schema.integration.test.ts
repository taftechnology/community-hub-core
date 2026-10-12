import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { applyProductMigrations } from "@community-hub/db";
import {
  createPlaintextAppSql,
  createPlaintextDirectSql,
  createPlaintextIdentitySql,
} from "@community-hub/db/plaintext";

type Runtime = {
  productOnlyUrl: string;
  passwords: { app: string; identity: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function roleUrl(runtime: Runtime, role: "app" | "identity"): string {
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

describe("platform plan privileges", () => {
  it("refuses app and identity a select on platform.plans", async () => {
    const runtime = loadRuntime();
    const app = createPlaintextAppSql(roleUrl(runtime, "app"));
    try {
      await expect(app`select id from platform.plans`).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end({ timeout: 1 });
    }
    const identity = createPlaintextIdentitySql(roleUrl(runtime, "identity"));
    try {
      await expect(identity`select id from platform.plans`).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await identity.end({ timeout: 1 });
    }
  });
});
