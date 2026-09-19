import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blindIndex, decrypt, deriveKeys, encrypt, generateKmsRoot } from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeAll, describe, expect, it } from "vitest";

import { withAppTransaction } from "../src/app-transaction.js";
import { insertEncrypted } from "../src/insert-encrypted.js";
import { createAppSql } from "../src/connections.js";
import { newId } from "../src/ids.js";
import { applyProductMigrations } from "../src/migrate.js";
import { applyTestMigrations } from "./migrate-test.js";
import { syntheticCrypto } from "./schema-test.js";

type Runtime = {
  directUrl: string;
  passwords: { app: string; identity: string; platform: string };
};

const DIR = path.dirname(fileURLToPath(import.meta.url));
const utf8 = (value: string) => new TextEncoder().encode(value);

function loadRuntime(): Runtime {
  return JSON.parse(readFileSync(path.join(DIR, ".runtime.json"), "utf8")) as Runtime;
}

function pooledAppUrl(runtime: Runtime): string {
  return `postgres://app:${encodeURIComponent(runtime.passwords.app)}@127.0.0.1:6432/hub`;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("encrypted columns through PgBouncer", () => {
  beforeAll(async () => {
    const runtime = loadRuntime();
    await applyProductMigrations(runtime.directUrl);
    await applyTestMigrations({ mode: "test" }, runtime.directUrl);
  });

  it("round-trips ciphertext and finds the row by blind index", async () => {
    const runtime = loadRuntime();
    const sql = createAppSql(pooledAppUrl(runtime));
    const orgId = newId();
    const communityId = newId();
    const id = newId();
    const normalised = utf8("synthetic@example.test");

    try {
      const port = createLocalKmsPort();
      const { hkdfKey } = await generateKmsRoot(port, "kms-round-trip", {
        key_kind: "org",
        org_id: orgId,
        key_version: "v1",
      });
      const { enc, bidx: bidxKey } = await deriveKeys(hkdfKey);
      const keyId = uuidToBytes(newId());
      const ciphertext = await encrypt(enc, normalised, keyId, {
        tag: "chub/field/v1",
        label: "people.email",
        rowId: uuidToBytes(id),
        communityId: uuidToBytes(communityId),
      });
      const emailBidx = await blindIndex(bidxKey, "people.email", normalised);

      const rows = await withAppTransaction(sql, { orgId, communityId }, async (tx) => {
        // TransactionSql has no options.parsers; drizzle() assigns timestamp parsers there.
        const db = drizzle(
          Object.assign(tx, {
            options: {
              parsers: { ...sql.options.parsers },
              serializers: { ...sql.options.serializers },
            },
          }),
        );
        await insertEncrypted(db, syntheticCrypto, {
          orgId,
          communityId,
          id,
          payload: ciphertext,
          emailBidx,
        });
        return db.select().from(syntheticCrypto).where(eq(syntheticCrypto.emailBidx, emailBidx));
      });

      expect(rows).toHaveLength(1);
      const payload = rows[0]?.payload;
      expect(payload).toBeDefined();
      expect(Object.getPrototypeOf(payload)).toBe(Uint8Array.prototype);
      expect(Array.from(payload ?? [])).toEqual(Array.from(ciphertext));
      const opened = await decrypt(payload as typeof ciphertext, () => enc, {
        tag: "chub/field/v1",
        label: "people.email",
        rowId: uuidToBytes(id),
        communityId: uuidToBytes(communityId),
      });
      expect(Array.from(opened)).toEqual(Array.from(normalised));
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
