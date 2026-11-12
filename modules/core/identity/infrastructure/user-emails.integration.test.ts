import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type KmsPort } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { applyProductMigrations, newId } from "@community-hub/db";
import { createPlaintextDirectSql, createPlaintextIdentitySql } from "@community-hub/db/plaintext";
import { beforeAll, describe, expect, it } from "vitest";

import { deriveIdentityEmailKeys, insertIdentityUserWithKeys } from "./email-lookup.js";
import { ensureIdentityKey } from "./identity-key.js";
import { readUserEmails } from "./user-emails.js";

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

function createCountingKmsPort(base: KmsPort = createLocalKmsPort()) {
  let decryptCalls = 0;
  let generateDataKeyCalls = 0;
  return {
    get decryptCalls() {
      return decryptCalls;
    },
    get generateDataKeyCalls() {
      return generateDataKeyCalls;
    },
    resetCounts() {
      decryptCalls = 0;
      generateDataKeyCalls = 0;
    },
    async generateDataKey(keyId: string, context: Parameters<KmsPort["generateDataKey"]>[1]) {
      generateDataKeyCalls += 1;
      return base.generateDataKey(keyId, context);
    },
    async decrypt(keyId: string, blob: Uint8Array, context: Parameters<KmsPort["decrypt"]>[2]) {
      decryptCalls += 1;
      return base.decrypt(keyId, blob, context);
    },
  };
}

describe("readUserEmails integration", () => {
  it("decrypts emails for created users", async () => {
    const kms = createCountingKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const keys = await deriveIdentityEmailKeys(sql, kms, KEY_ARN);
      const user1 = await insertIdentityUserWithKeys(sql, keys, "ada@example.com");
      const user2 = await insertIdentityUserWithKeys(sql, keys, "grace@example.com");

      const emails = await readUserEmails(sql, kms, KEY_ARN, [user1.userId, user2.userId]);
      expect(emails.get(user1.userId)).toBe("ada@example.com");
      expect(emails.get(user2.userId)).toBe("grace@example.com");
      expect(emails.size).toBe(2);
    });
  });

  it("reading users in reverse order returns the right email for each (pin 5)", async () => {
    const kms = createCountingKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const keys = await deriveIdentityEmailKeys(sql, kms, KEY_ARN);
      const user1 = await insertIdentityUserWithKeys(sql, keys, "ada@example.com");
      const user2 = await insertIdentityUserWithKeys(sql, keys, "grace@example.com");

      const emails = await readUserEmails(sql, kms, KEY_ARN, [user2.userId, user1.userId]);
      expect(emails.get(user1.userId)).toBe("ada@example.com");
      expect(emails.get(user2.userId)).toBe("grace@example.com");
    });
  });

  it("copying ciphertext onto another user's row throws on read (pin 5)", async () => {
    const kms = createCountingKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const keys = await deriveIdentityEmailKeys(sql, kms, KEY_ARN);
      const user1 = await insertIdentityUserWithKeys(sql, keys, "ada@example.com");
      const user2 = await insertIdentityUserWithKeys(sql, keys, "grace@example.com");

      const [row1] = await sql<{ email: Uint8Array }[]>`
        select email from identity.users where id = ${user1.userId}::uuid
      `;
      expect(row1?.email).toBeDefined();

      await sql`
        update identity.users set email = ${row1!.email} where id = ${user2.userId}::uuid
      `;

      await expect(readUserEmails(sql, kms, KEY_ARN, [user2.userId])).rejects.toThrow(
        "decryption failed",
      );
    });
  });

  it("omits unknown user ids from the map", async () => {
    const kms = createCountingKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const keys = await deriveIdentityEmailKeys(sql, kms, KEY_ARN);
      const user1 = await insertIdentityUserWithKeys(sql, keys, "ada@example.com");
      const unknownId = newId();

      const emails = await readUserEmails(sql, kms, KEY_ARN, [user1.userId, unknownId]);
      expect(emails.get(user1.userId)).toBe("ada@example.com");
      expect(emails.has(unknownId)).toBe(false);
      expect(emails.size).toBe(1);
    });
  });

  it("throws when identity key is missing without generating key (pin 10)", async () => {
    const kms = createCountingKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const keys = await deriveIdentityEmailKeys(sql, kms, KEY_ARN);
      const user1 = await insertIdentityUserWithKeys(sql, keys, "ada@example.com");

      // Delete only identity.identity_keys, keeping users
      await sql`delete from identity.identity_keys`;

      kms.resetCounts();

      await expect(readUserEmails(sql, kms, KEY_ARN, [user1.userId])).rejects.toThrow(
        "identity key is missing",
      );

      const keyRows = await sql<{ count: number }[]>`
        select count(*)::int as count from identity.identity_keys
      `;
      expect(keyRows[0]?.count).toBe(0);
      expect(kms.generateDataKeyCalls).toBe(0);
    });
  });

  it("makes exactly one KMS decrypt call per successful invocation", async () => {
    const kms = createCountingKmsPort();
    await withSql(async (sql) => {
      await ensureIdentityKey(sql, kms, KEY_ARN);
      const keys = await deriveIdentityEmailKeys(sql, kms, KEY_ARN);
      const user1 = await insertIdentityUserWithKeys(sql, keys, "ada@example.com");
      const user2 = await insertIdentityUserWithKeys(sql, keys, "grace@example.com");

      kms.resetCounts();

      const emails = await readUserEmails(sql, kms, KEY_ARN, [user1.userId, user2.userId]);
      expect(emails.size).toBe(2);
      expect(kms.decryptCalls).toBe(1);
      expect(kms.generateDataKeyCalls).toBe(0);
    });
  });
});
