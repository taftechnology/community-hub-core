import { type KmsPort } from "@community-hub/crypto";
import type { Sql } from "postgres";

import { normaliseEmail } from "../domain/email.js";
import { deriveIdentityEmailKeys, insertIdentityUserWithKeys } from "./email-lookup.js";

/**
 * Inserts a fresh `identity.users` row for an email. The read-keyed lookups for
 * the same table live in `email-lookup.ts`; this file stays insert-only so the
 * ciphertext `email` column is never filtered on here (§1 rule 3).
 */
export async function insertIdentityUser(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: { email: string },
): Promise<{ userId: string }> {
  const email = normaliseEmail(input.email);
  const keys = await deriveIdentityEmailKeys(sql, kms, keyArn);
  return insertIdentityUserWithKeys(sql, keys, email);
}
