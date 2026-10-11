import { newId } from "@community-hub/db";
import { generateKmsRoot, unwrapKmsRoot, type KmsPort } from "@community-hub/crypto";
import type { Sql } from "postgres";

const CONTEXT = { key_kind: "identity", region: "au", key_version: "1" } as const;

function isRegionConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === "identity_keys_region_unique"
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export async function ensureIdentityKey(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
): Promise<{ keyRowId: string }> {
  const existing = await sql<{ id: string }[]>`
    select id from identity.identity_keys where region = 'au' limit 1
  `;
  const found = existing[0];
  if (found !== undefined) {
    return { keyRowId: found.id };
  }

  const keyRowId = newId();
  const { blob } = await generateKmsRoot(kms, keyArn, CONTEXT);
  try {
    await sql.begin(async (tx) => {
      await tx`
        insert into identity.identity_keys (id, region, wrapped, key_version)
        values (${keyRowId}, 'au', ${blob}, '1')
      `;
    });
  } catch (error) {
    if (!isRegionConflict(error)) {
      throw error;
    }
    const winner = await sql<{ id: string; wrapped: Uint8Array }[]>`
      select id, wrapped from identity.identity_keys where region = 'au' limit 1
    `;
    const row = winner[0];
    if (row === undefined) {
      throw error;
    }
    await unwrapKmsRoot(kms, keyArn, row.wrapped, CONTEXT);
    return { keyRowId: row.id };
  }
  return { keyRowId };
}
