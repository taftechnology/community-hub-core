import type { webcrypto } from "node:crypto";
import { deriveKeys, unwrapKmsRoot, type KmsPort } from "@community-hub/crypto";
import { newId } from "@community-hub/db";
import type { Sql } from "postgres";

import { ensureIdentityKey } from "./identity-key.js";

const CONTEXT = { key_kind: "identity", region: "au", key_version: "1" } as const;
const ACCESS_MS = 15 * 60 * 1000;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionTokens = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: 900;
};

export async function createSession(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: { userId: string; now: Date; refreshFamily?: string },
): Promise<SessionTokens> {
  const minted = await mint(sql, kms, keyArn);
  const refreshFamily = input.refreshFamily ?? newId();
  await insertSession(sql, {
    id: newId(),
    userId: input.userId,
    refreshFamily,
    accessHash: minted.accessHash,
    refreshHash: minted.refreshHash,
    now: input.now,
  });
  return {
    userId: input.userId,
    accessToken: minted.accessToken,
    refreshToken: minted.refreshToken,
    expiresIn: 900,
  };
}

export async function readSession(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: { accessToken: string; now: Date },
): Promise<{ userId: string } | null> {
  const raw = decodeToken(input.accessToken);
  if (raw === null) {
    return null;
  }
  const bidx = await bidxKey(sql, kms, keyArn);
  const accessHash = await hmac(bidx, "identity.access", raw);
  const now = input.now.toISOString();
  const rows = await sql<{ user_id: string }[]>`
    select user_id from identity.sessions
    where access_hash = ${accessHash}
      and revoked_at is null
      and access_expires_at > ${now}::timestamptz
  `;
  const row = rows[0];
  return row === undefined ? null : { userId: row.user_id };
}

export async function refreshSession(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: { refreshToken: string; now: Date },
): Promise<SessionTokens | null> {
  const raw = decodeToken(input.refreshToken);
  if (raw === null) {
    return null;
  }
  const bidx = await bidxKey(sql, kms, keyArn);
  const refreshHash = await hmac(bidx, "identity.refresh", raw);
  const now = input.now.toISOString();
  const located = await sql<{ refresh_family: string }[]>`
    select refresh_family
    from identity.sessions
    where refresh_hash = ${refreshHash}
      and refresh_expires_at > ${now}::timestamptz
  `;
  const family = located[0]?.refresh_family;
  if (family === undefined) {
    return null;
  }
  const minted = await mint(sql, kms, keyArn);
  const successorId = newId();
  const accessExpires = new Date(input.now.getTime() + ACCESS_MS).toISOString();
  const refreshExpires = new Date(input.now.getTime() + REFRESH_MS).toISOString();
  const claimed = await sql.begin(async (tx) => {
    await tx`
      select pg_advisory_xact_lock(hashtextextended('family:' || ${family}::text, 0))
    `;
    const rows = await tx<{ id: string; user_id: string; refresh_family: string }[]>`
      update identity.sessions
      set replaced_by = ${successorId}, revoked_at = ${now}::timestamptz
      where refresh_hash = ${refreshHash}
        and refresh_expires_at > ${now}::timestamptz
        and replaced_by is null
        and revoked_at is null
      returning id, user_id, refresh_family
    `;
    const row = rows[0];
    if (row !== undefined) {
      await tx`
        insert into identity.sessions (
          id, user_id, refresh_family, access_hash, refresh_hash, access_expires_at, refresh_expires_at
        )
        values (
          ${successorId},
          ${row.user_id},
          ${row.refresh_family},
          ${minted.accessHash},
          ${minted.refreshHash},
          ${accessExpires}::timestamptz,
          ${refreshExpires}::timestamptz
        )
      `;
      return row;
    }
    const existing = await tx<{ replaced_by: string | null }[]>`
      select replaced_by
      from identity.sessions
      where refresh_hash = ${refreshHash}
        and refresh_expires_at > ${now}::timestamptz
    `;
    if (existing[0]?.replaced_by != null) {
      await tx`
        update identity.sessions
        set revoked_at = ${now}::timestamptz
        where refresh_family = ${family}
          and revoked_at is null
      `;
    }
    return null;
  });
  if (claimed === null) {
    return null;
  }
  return {
    userId: claimed.user_id,
    accessToken: minted.accessToken,
    refreshToken: minted.refreshToken,
    expiresIn: 900,
  };
}

async function mint(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  accessHash: Uint8Array;
  refreshHash: Uint8Array;
}> {
  const bidx = await bidxKey(sql, kms, keyArn);
  const accessRaw = randomBytes();
  const refreshRaw = randomBytes();
  return {
    accessToken: Buffer.from(accessRaw).toString("base64url"),
    refreshToken: Buffer.from(refreshRaw).toString("base64url"),
    accessHash: await hmac(bidx, "identity.access", accessRaw),
    refreshHash: await hmac(bidx, "identity.refresh", refreshRaw),
  };
}

async function insertSession(
  sql: Sql,
  input: {
    id: string;
    userId: string;
    refreshFamily: string;
    accessHash: Uint8Array;
    refreshHash: Uint8Array;
    now: Date;
  },
): Promise<void> {
  const accessExpires = new Date(input.now.getTime() + ACCESS_MS).toISOString();
  const refreshExpires = new Date(input.now.getTime() + REFRESH_MS).toISOString();
  await sql`
    insert into identity.sessions (
      id, user_id, refresh_family, access_hash, refresh_hash, access_expires_at, refresh_expires_at
    )
    values (
      ${input.id},
      ${input.userId},
      ${input.refreshFamily},
      ${input.accessHash},
      ${input.refreshHash},
      ${accessExpires}::timestamptz,
      ${refreshExpires}::timestamptz
    )
  `;
}

function randomBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

function decodeToken(token: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    return null;
  }
  const raw = new Uint8Array(Buffer.from(token, "base64url"));
  return raw.byteLength === 32 ? raw : null;
}

async function hmac(
  bidxKey: webcrypto.CryptoKey,
  purpose: string,
  message: Uint8Array,
): Promise<Uint8Array> {
  const purposeBytes = new TextEncoder().encode(purpose);
  const input = new Uint8Array(purposeBytes.byteLength + 1 + message.byteLength);
  input.set(purposeBytes, 0);
  input[purposeBytes.byteLength] = 0x00;
  input.set(message, purposeBytes.byteLength + 1);
  return new Uint8Array(await crypto.subtle.sign("HMAC", bidxKey, input));
}

async function bidxKey(sql: Sql, kms: KmsPort, keyArn: string): Promise<webcrypto.CryptoKey> {
  await ensureIdentityKey(sql, kms, keyArn);
  const keys = await sql<{ wrapped: Uint8Array }[]>`
    select wrapped from identity.identity_keys where region = 'au' limit 1
  `;
  const key = keys[0];
  if (key === undefined) {
    throw new Error("identity key is missing");
  }
  const hkdfKey = await unwrapKmsRoot(kms, keyArn, key.wrapped, CONTEXT);
  const derived = await deriveKeys(hkdfKey);
  return derived.bidx;
}
