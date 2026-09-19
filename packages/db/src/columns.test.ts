import { eq } from "drizzle-orm";
import { uuid } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import {
  decrypt,
  deriveKeys,
  encrypt,
  generateKmsRoot,
  type BlindIndex,
  type Ciphertext,
} from "@community-hub/crypto";
import { createLocalKmsPort } from "@community-hub/crypto/testing";

import { blindIndexColumn, encryptedColumn, labelOf } from "./columns.js";
import { insertEncrypted } from "./insert-encrypted.js";
import { newId } from "./ids.js";
import { app } from "./schema.js";

const utf8 = (value: string) => new TextEncoder().encode(value);

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const typeTable = app.table("encrypted_insert_types", {
  orgId: uuid("org_id").notNull(),
  communityId: uuid("community_id").notNull(),
  id: uuid("id").notNull().defaultRandom(),
  payload: encryptedColumn("payload", { label: "people.email" }),
  emailBidx: blindIndexColumn("email_bidx", { purpose: "people.email" }),
  phoneBidx: blindIndexColumn("phone_bidx", { purpose: "people.phone" }),
});

function compileColumnQueryTypes(
  db: PostgresJsDatabase,
  emailBidx: BlindIndex<"people.email">,
  phoneBidx: BlindIndex<"people.phone">,
): void {
  // @ts-expect-error ciphertext is not comparable to plaintext
  eq(typeTable.payload, "plain");
  // @ts-expect-error email-index vs phone-index eq does not compile
  eq(typeTable.emailBidx, phoneBidx);
  eq(typeTable.emailBidx, emailBidx);
  // TypeScript allows orderBy; the ESLint rule (T6) flags it. Do not @ts-expect-error.
  db.select().from(typeTable).orderBy(typeTable.payload);
  db.select().from(typeTable).orderBy(typeTable.emailBidx);
}

function compileInsertRequiresId(
  db: PostgresJsDatabase,
  payload: Ciphertext,
  emailBidx: BlindIndex<"people.email">,
): void {
  // @ts-expect-error insertEncrypted requires id even when the table has a default
  insertEncrypted(db, typeTable, {
    orgId: "018f0000-0000-7000-8000-000000000001",
    communityId: "018f0000-0000-7000-8000-000000000002",
    payload,
    emailBidx,
  });
}

describe("encryptedColumn label", () => {
  it("encrypts and decrypts with people.email when SQL names differ", async () => {
    const originalTable = app.table("encrypted_label_original", {
      payload: encryptedColumn("email_cipher", { label: "people.email" }).notNull(),
    });
    const renamedTable = app.table("encrypted_label_renamed", {
      payload: encryptedColumn("renamed_email", { label: "people.email" }).notNull(),
    });
    expect(labelOf(originalTable.payload)).toBe("people.email");
    expect(labelOf(renamedTable.payload)).toBe("people.email");

    const port = createLocalKmsPort();
    const { hkdfKey } = await generateKmsRoot(port, "kms-test", {
      key_kind: "org",
      org_id: "org-synthetic",
      key_version: "v1",
    });
    const { enc } = await deriveKeys(hkdfKey);
    const rowId = uuidToBytes(newId());
    const communityId = uuidToBytes(newId());
    const keyId = uuidToBytes(newId());
    const plaintext = utf8("synthetic@example.test");

    const ciphertext = await encrypt(enc, plaintext, keyId, {
      tag: "chub/field/v1",
      label: labelOf(originalTable.payload),
      rowId,
      communityId,
    });
    const opened = await decrypt(ciphertext, () => enc, {
      tag: "chub/field/v1",
      label: labelOf(renamedTable.payload),
      rowId,
      communityId,
    });
    expect(new TextDecoder().decode(opened)).toBe("synthetic@example.test");
  });

  it("keeps compile-time guards for eq, insert id, and orderBy", () => {
    expect(compileColumnQueryTypes).toBeTypeOf("function");
    expect(compileInsertRequiresId).toBeTypeOf("function");
  });
});
