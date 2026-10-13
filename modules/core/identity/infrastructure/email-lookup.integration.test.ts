import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import { beforeAll, describe, expect, it } from "vitest";

import { findOrCreateUserByEmail, findUserByEmail } from "../public/index.js";
import { insertIdentityUser } from "./identity-user.js";

const KEY_ARN = `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-${"ab".repeat(16)}`;

type Runtime = {
  productOnlyUrl: string;
  passwords: { identity: string };
};

const RUNTIME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/test/.runtime.json",
);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(RUNTIME, "utf8")) as Runtime;
}

function identityUrl(runtime: Runtime): string {
  const password = encodeURIComponent(runtime.passwords.identity);
  return `postgres://identity:${password}@127.0.0.1:5432/hub_product_only`;
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

async function clearIdentity(sql: ReturnType<typeof createPlaintextIdentitySql>): Promise<void> {
  await sql`delete from identity.sessions`;
  await sql`delete from identity.passkey_credentials`;
  await sql`delete from identity.passkey_challenges`;
  await sql`delete from identity.otp_challenges`;
  await sql`delete from identity.users`;
  await sql`delete from identity.identity_keys`;
}

async function withSql<T>(
  run: (sql: ReturnType<typeof createPlaintextIdentitySql>) => Promise<T>,
): Promise<T> {
  const sql = createPlaintextIdentitySql(identityUrl(loadRuntime()));
  try {
    await clearIdentity(sql);
    return await run(sql);
  } finally {
    await clearIdentity(sql);
    await sql.end({ timeout: 1 });
  }
}

describe("find user by email", () => {
  it("returns null when no identity.users row exists", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const result = await findUserByEmail(sql, kms, KEY_ARN, { email: "nobody@example.com" });
      expect(result).toBeNull();
    });
  });

  it("resolves a mixed-case, whitespace-padded address to the inserted row", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const created = await insertIdentityUser(sql, kms, KEY_ARN, { email: "Ada@Example.com" });
      const found = await findUserByEmail(sql, kms, KEY_ARN, { email: "  ada@EXAMPLE.com  " });
      expect(found).toEqual({ userId: created.userId });
    });
  });
});

describe("find or create user by email", () => {
  it("creates a new row when the email is absent", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const before = await sql<{ n: number }[]>`select count(*)::int as n from identity.users`;
      expect(before[0]?.n).toBe(0);
      const created = await findOrCreateUserByEmail(sql, kms, KEY_ARN, { email: "Ada@Example.com" });
      expect(created.userId).toEqual(expect.any(String));
      const after = await sql<{ id: string; n: number }[]>`
        select count(*)::int as n from identity.users
      `;
      expect(after[0]?.n).toBe(1);
    });
  });

  it("returns the existing userId without creating a duplicate row", async () => {
    const kms = createLocalKmsPort();
    await withSql(async (sql) => {
      const first = await insertIdentityUser(sql, kms, KEY_ARN, { email: "Ada@Example.com" });
      const resolved = await findOrCreateUserByEmail(sql, kms, KEY_ARN, {
        email: "  ADA@example.COM  ",
      });
      expect(resolved).toEqual({ userId: first.userId });
      const count = await sql<{ n: number }[]>`select count(*)::int as n from identity.users`;
      expect(count[0]?.n).toBe(1);
    });
  });

  it("resolves two racing calls on the same new email to one winning row", async () => {
    const kms = createLocalKmsPort();
    const runtime = loadRuntime();
    const sql = postgres(identityUrl(runtime), { max: 4, prepare: true, onnotice: () => undefined });
    try {
      await clearIdentity(sql);
      const results = await Promise.all([
        findOrCreateUserByEmail(sql, kms, KEY_ARN, { email: "ada@example.com" }),
        findOrCreateUserByEmail(sql, kms, KEY_ARN, { email: "ada@example.com" }),
      ]);
      expect(results[0]?.userId).toBe(results[1]?.userId);
      const count = await sql<{ n: number }[]>`select count(*)::int as n from identity.users`;
      expect(count[0]?.n).toBe(1);
    } finally {
      await clearIdentity(sql);
      await sql.end({ timeout: 1 });
    }
  });
});
