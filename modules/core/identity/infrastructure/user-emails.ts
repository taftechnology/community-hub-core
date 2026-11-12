import { decrypt, deriveKeys, unwrapKmsRoot, type KmsPort } from "@community-hub/crypto";
import type { Sql } from "postgres";

import { IdentityError } from "../domain/error.js";

const CONTEXT = { key_kind: "identity", region: "au", key_version: "1" } as const;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Decrypts sign-in emails for a set of user ids under the AU identity key.
 * Never creates an identity key, never logs or returns a ciphertext, and omits
 * user ids that have no corresponding row in identity.users.
 */
export async function readUserEmails(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }

  if (userIds.length > 500) {
    throw new IdentityError("invalid_input");
  }

  for (const id of userIds) {
    if (typeof id !== "string" || !UUID_REGEX.test(id)) {
      throw new IdentityError("invalid_input");
    }
  }

  const keys = await sql<{ id: string; wrapped: Uint8Array }[]>`
    select id, wrapped from identity.identity_keys where region = 'au' limit 1
  `;
  const key = keys[0];
  if (key === undefined) {
    throw new Error("identity key is missing");
  }

  const hkdfKey = await unwrapKmsRoot(kms, keyArn, key.wrapped, CONTEXT);
  const { enc } = await deriveKeys(hkdfKey);

  const rows = await sql<{ id: string; email: Uint8Array }[]>`
    select id, email from identity.users where id = any(${userIds}::uuid[])
  `;

  const result = new Map<string, string>();
  for (const row of rows) {
    const plaintext = await decrypt(row.email as never, () => enc, {
      tag: "chub/field-identity/v1",
      label: "identity.users.email",
      rowId: uuidToBytes(row.id),
      region: "au",
    });
    result.set(row.id, new TextDecoder().decode(plaintext));
  }

  return result;
}
