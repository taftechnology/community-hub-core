import {
  blindIndex,
  deriveKeys,
  encrypt,
  unwrapKmsRoot,
  type KmsPort,
} from "@community-hub/crypto";
import { newId } from "@community-hub/db";
import type { Sql } from "postgres";

import { normaliseEmail } from "../domain/email.js";
import { ensureIdentityKey } from "./identity-key.js";

const CONTEXT = { key_kind: "identity", region: "au", key_version: "1" } as const;

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function insertIdentityUser(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: { email: string },
): Promise<{ userId: string }> {
  const email = normaliseEmail(input.email);
  await ensureIdentityKey(sql, kms, keyArn);
  const keys = await sql<{ id: string; wrapped: Uint8Array }[]>`
    select id, wrapped from identity.identity_keys where region = 'au' limit 1
  `;
  const key = keys[0];
  if (key === undefined) {
    throw new Error("identity key is missing");
  }
  const hkdfKey = await unwrapKmsRoot(kms, keyArn, key.wrapped, CONTEXT);
  const { enc, bidx } = await deriveKeys(hkdfKey);
  const userId = newId();
  const ciphertext = await encrypt(enc, new TextEncoder().encode(email), uuidToBytes(key.id), {
    tag: "chub/field-identity/v1",
    label: "identity.users.email",
    rowId: uuidToBytes(userId),
    region: "au",
  });
  const emailBidx = await blindIndex(bidx, "identity.users.email", new TextEncoder().encode(email));
  await sql`
    insert into identity.users (id, region, email, email_bidx)
    values (${userId}, 'au', ${ciphertext}, ${emailBidx})
  `;
  return { userId };
}
