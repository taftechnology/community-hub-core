import type { webcrypto } from "node:crypto";

import {
  deriveKeys,
  generateAndWrap,
  generateKmsRoot,
  unwrapKey,
  unwrapKmsRoot,
  type KmsPort,
} from "@community-hub/crypto";
import { newId, type AppTransaction } from "@community-hub/db";

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "23505") {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function organisationContext(orgId: string): {
  key_kind: "org";
  org_id: string;
  key_version: "1";
} {
  return { key_kind: "org", org_id: orgId, key_version: "1" };
}

async function setting(
  tx: AppTransaction,
  name: "app.org_id" | "app.community_id",
): Promise<string> {
  const rows = await tx<{ value: string }[]>`
    select current_setting(${name}) as value
  `;
  const value = rows[0]?.value;
  if (value === undefined || value.length === 0) {
    throw new Error("tenant setting is missing");
  }
  return value;
}

type StoredKey = { id: string; wrapped: Uint8Array };

async function selectOrganisationKey(tx: AppTransaction): Promise<StoredKey | undefined> {
  const rows = await tx<StoredKey[]>`
    select id::text as id, wrapped
    from app.organisation_keys
    where org_id = current_setting('app.org_id')::uuid
  `;
  return rows[0];
}

async function selectCommunityKey(tx: AppTransaction): Promise<StoredKey | undefined> {
  const rows = await tx<StoredKey[]>`
    select id::text as id, wrapped
    from app.community_keys
    where community_id = current_setting('app.community_id')::uuid
  `;
  return rows[0];
}

export async function ensureOrganisationKey(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
): Promise<{ keyId: string }> {
  const existing = await selectOrganisationKey(tx);
  if (existing !== undefined) {
    return { keyId: existing.id };
  }
  const orgId = await setting(tx, "app.org_id");
  const context = organisationContext(orgId);
  const { blob } = await generateKmsRoot(kms, keyArn, context);
  const id = newId();
  try {
    await tx.savepoint("organisation_key", async (sp) => {
      await sp`
        insert into app.organisation_keys (id, org_id, wrapped, key_version)
        values (
          ${id}::uuid,
          current_setting('app.org_id')::uuid,
          ${blob},
          '1'
        )
      `;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const winner = await selectOrganisationKey(tx);
    if (winner === undefined) {
      throw error;
    }
    await unwrapKmsRoot(kms, keyArn, winner.wrapped, context);
    return { keyId: winner.id };
  }
  return { keyId: id };
}

export async function openCommunityHkdf(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
): Promise<{ keyId: string; hkdf: webcrypto.CryptoKey }> {
  const { keyId: parentKeyId } = await ensureOrganisationKey(tx, kms, keyArn);
  const organisation = await selectOrganisationKey(tx);
  if (organisation === undefined) {
    throw new Error("organisation key is missing");
  }
  const orgId = await setting(tx, "app.org_id");
  const orgHkdf = await unwrapKmsRoot(
    kms,
    keyArn,
    organisation.wrapped,
    organisationContext(orgId),
  );
  const { wrap } = await deriveKeys(orgHkdf);
  const communityId = await setting(tx, "app.community_id");
  let community = await selectCommunityKey(tx);
  if (community === undefined) {
    const id = newId();
    const { blob } = await generateAndWrap(wrap, {
      tag: "chub/wrap/v1",
      childKind: "community",
      childId: uuidToBytes(communityId),
      childKeyId: uuidToBytes(id),
      parentKeyId: uuidToBytes(parentKeyId),
    });
    try {
      await tx.savepoint("community_key", async (sp) => {
        await sp`
          insert into app.community_keys (
            id, org_id, community_id, wrapped, key_version, parent_key_id
          ) values (
            ${id}::uuid,
            current_setting('app.org_id')::uuid,
            current_setting('app.community_id')::uuid,
            ${blob},
            '1',
            ${parentKeyId}::uuid
          )
        `;
      });
      community = { id, wrapped: blob };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const winner = await selectCommunityKey(tx);
      if (winner === undefined) {
        throw error;
      }
      community = winner;
    }
  }
  const hkdf = await unwrapKey(community.wrapped, wrap, {
    tag: "chub/wrap/v1",
    childKind: "community",
    childId: uuidToBytes(communityId),
    childKeyId: uuidToBytes(community.id),
    parentKeyId: uuidToBytes(parentKeyId),
  });
  return { keyId: community.id, hkdf };
}

export async function ensureCommunityKey(
  tx: AppTransaction,
  kms: KmsPort,
  keyArn: string,
): Promise<{ keyId: string }> {
  const existing = await selectCommunityKey(tx);
  if (existing !== undefined) {
    return { keyId: existing.id };
  }
  const { keyId } = await openCommunityHkdf(tx, kms, keyArn);
  return { keyId };
}
