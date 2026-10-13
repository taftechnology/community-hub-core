import type { webcrypto } from "node:crypto";
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

/**
 * The key material an email lookup or insert needs, derived once from the
 * region's wrapped identity key. `enc` encrypts the email for storage and
 * `bidx` computes its blind index for lookup; both halves come from the same
 * `deriveKeys` call so the OTP sign-in path and the provisioning path can never
 * drift to different derivations of the same address.
 */
export type IdentityEmailKeys = {
  readonly keyId: string;
  readonly enc: webcrypto.CryptoKey;
  readonly bidx: webcrypto.CryptoKey;
};

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Runs the one derivation chain every email path shares: ensure the region key
 * exists, read it, unwrap the KMS root, and derive `{ enc, bidx }`. Callers that
 * only need the blind index (the OTP lookup) use the `.bidx` half; callers that
 * also store an email (the insert path) use `.enc` and `keyId` too.
 */
export async function deriveIdentityEmailKeys(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
): Promise<IdentityEmailKeys> {
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
  return { keyId: key.id, enc, bidx };
}

/**
 * The blind index for an `identity.users.email` value, under the shared bidx
 * key. This is the one derivation of the column's lookup token, reused by the
 * OTP flow and the provisioning lookups.
 */
export async function emailBlindIndex(
  bidx: webcrypto.CryptoKey,
  email: string,
): Promise<Uint8Array> {
  const index = await blindIndex(bidx, "identity.users.email", new TextEncoder().encode(email));
  // Launder the branded blind index to raw bytes so it can serve as the lookup
  // token in SQL and query helpers, the same way the insert path launders its
  // ciphertext before binding it.
  const bytes: Uint8Array = index;
  return bytes;
}

/**
 * True when `error` is the unique-constraint violation raised by a race to
 * insert the same email, so a caller can re-query for the winning row instead
 * of failing.
 */
export function isUsersEmailConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === "users_email_bidx_unique"
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Inserts an `identity.users` row for an already-normalised email, using key
 * material the caller already derived. Shared by `insertIdentityUser` and the
 * find-or-create path so neither re-derives the region key.
 */
export async function insertIdentityUserWithKeys(
  sql: Sql,
  keys: IdentityEmailKeys,
  email: string,
): Promise<{ userId: string }> {
  const userId = newId();
  const ciphertext = await encrypt(
    keys.enc,
    new TextEncoder().encode(email),
    uuidToBytes(keys.keyId),
    {
      tag: "chub/field-identity/v1",
      label: "identity.users.email",
      rowId: uuidToBytes(userId),
      region: "au",
    },
  );
  const emailBidx = await emailBlindIndex(keys.bidx, email);
  // A tagged template cannot take the branded ciphertext. The insert stores the bytes.
  const emailBytes: Uint8Array = ciphertext;
  await sql`
    insert into identity.users (id, region, email, email_bidx)
    values (${userId}, 'au', ${emailBytes}, ${emailBidx})
  `;
  return { userId };
}

/**
 * Finds the `identity.users` row for an email, creating it on the winning side
 * of a race, given key material the caller already derived and the email's
 * blind index. This is the single find-or-create core: the OTP sign-in path and
 * the public `findOrCreateUserByEmail` both go through it, so a mixed-case or
 * padded address always resolves to the same row either way.
 */
export async function findOrCreateUserByKeys(
  sql: Sql,
  keys: IdentityEmailKeys,
  email: string,
  emailBidx: Uint8Array,
): Promise<{ userId: string }> {
  const existing = await sql<{ id: string }[]>`
    select id from identity.users where email_bidx = ${emailBidx}
  `;
  const found = existing[0];
  if (found !== undefined) {
    return { userId: found.id };
  }
  try {
    return await insertIdentityUserWithKeys(sql, keys, email);
  } catch (error) {
    if (!isUsersEmailConflict(error)) {
      throw error;
    }
    const again = await sql<{ id: string }[]>`
      select id from identity.users where email_bidx = ${emailBidx}
    `;
    const winner = again[0];
    if (winner === undefined) {
      throw error;
    }
    return { userId: winner.id };
  }
}

/**
 * Read-only lookup of the `identity.users` row for an email. Uses the same
 * `normaliseEmail` and `email_bidx` blind index as the OTP sign-in path, so a
 * mixed-case or whitespace-padded address matches the row the OTP flow would
 * resolve. Never inserts.
 */
export async function findUserByEmail(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: { email: string },
): Promise<{ userId: string } | null> {
  const email = normaliseEmail(input.email);
  const keys = await deriveIdentityEmailKeys(sql, kms, keyArn);
  const emailBidx = await emailBlindIndex(keys.bidx, email);
  const rows = await sql<{ id: string }[]>`
    select id from identity.users where email_bidx = ${emailBidx}
  `;
  const found = rows[0];
  return found === undefined ? null : { userId: found.id };
}

/**
 * Finds or creates the `identity.users` row for an email, through the same
 * normalisation, derivation, and race handling as the OTP sign-in path.
 */
export async function findOrCreateUserByEmail(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: { email: string },
): Promise<{ userId: string }> {
  const email = normaliseEmail(input.email);
  const keys = await deriveIdentityEmailKeys(sql, kms, keyArn);
  const emailBidx = await emailBlindIndex(keys.bidx, email);
  return findOrCreateUserByKeys(sql, keys, email, emailBidx);
}
