import type { webcrypto } from "node:crypto";
import { deriveKeys, unwrapKmsRoot, type KmsPort } from "@community-hub/crypto";
import { newId } from "@community-hub/db";
import type { Sql } from "postgres";

import { IdentityError } from "../domain/error.js";
import { hmac } from "./hmac.js";
import { ensureIdentityKey } from "./identity-key.js";

const CONTEXT = { key_kind: "identity", region: "au", key_version: "1" } as const;
const ACCESS_MS = 15 * 60 * 1000;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionKind = "tenant" | "operator" | "enrolment";

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
  input: {
    userId: string;
    now: Date;
    refreshFamily?: string;
    kind?: SessionKind;
    absoluteExpiresAt?: Date;
  },
): Promise<SessionTokens> {
  const kind: SessionKind = input.kind ?? "tenant";
  if (kind === "operator") {
    if (!input.absoluteExpiresAt || input.absoluteExpiresAt.getTime() <= input.now.getTime()) {
      throw new IdentityError("invalid_ceremony");
    }
  } else {
    if (input.absoluteExpiresAt !== undefined) {
      throw new IdentityError("invalid_ceremony");
    }
    if (kind !== "tenant" && kind !== "enrolment") {
      throw new IdentityError("invalid_ceremony");
    }
  }

  let accessExpiresAt: Date;
  let refreshExpiresAt: Date;
  if (kind === "operator") {
    const absMs = input.absoluteExpiresAt!.getTime();
    accessExpiresAt = new Date(Math.min(input.now.getTime() + ACCESS_MS, absMs));
    refreshExpiresAt = new Date(Math.min(input.now.getTime() + REFRESH_MS, absMs));
  } else if (kind === "enrolment") {
    accessExpiresAt = new Date(input.now.getTime() + ACCESS_MS);
    refreshExpiresAt = accessExpiresAt;
  } else {
    accessExpiresAt = new Date(input.now.getTime() + ACCESS_MS);
    refreshExpiresAt = new Date(input.now.getTime() + REFRESH_MS);
  }

  const minted = await mint(sql, kms, keyArn);
  const refreshFamily = input.refreshFamily ?? newId();
  await insertSession(sql, {
    id: newId(),
    userId: input.userId,
    refreshFamily,
    accessHash: minted.accessHash,
    refreshHash: minted.refreshHash,
    accessExpiresAt,
    refreshExpiresAt,
    kind,
    absoluteExpiresAt: input.absoluteExpiresAt ?? null,
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
  input: { accessToken: string; now: Date; kinds?: readonly SessionKind[] },
): Promise<{ userId: string } | null> {
  const raw = decodeToken(input.accessToken);
  if (raw === null) {
    return null;
  }
  const kinds = input.kinds ?? ["tenant"];
  if (kinds.length === 0) {
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
      and kind = any(${sql.array([...kinds])})
  `;
  const row = rows[0];
  return row === undefined ? null : { userId: row.user_id };
}

export async function readSessionWithKind(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: { accessToken: string; now: Date; kinds: readonly SessionKind[] },
): Promise<{ userId: string; kind: SessionKind } | null> {
  const raw = decodeToken(input.accessToken);
  if (raw === null) {
    return null;
  }
  if (input.kinds.length === 0) {
    return null;
  }
  const bidx = await bidxKey(sql, kms, keyArn);
  const accessHash = await hmac(bidx, "identity.access", raw);
  const now = input.now.toISOString();
  const rows = await sql<{ user_id: string; kind: SessionKind }[]>`
    select user_id, kind from identity.sessions
    where access_hash = ${accessHash}
      and revoked_at is null
      and access_expires_at > ${now}::timestamptz
      and kind = any(${sql.array([...input.kinds])})
  `;
  const row = rows[0];
  return row === undefined ? null : { userId: row.user_id, kind: row.kind };
}

export async function refreshSession(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: { refreshToken: string; now: Date; kinds?: readonly SessionKind[] },
): Promise<SessionTokens | null> {
  const raw = decodeToken(input.refreshToken);
  if (raw === null) {
    return null;
  }
  const kinds = (input.kinds ?? ["tenant"]).filter((k) => k !== "enrolment");
  if (kinds.length === 0) {
    return null;
  }
  const bidx = await bidxKey(sql, kms, keyArn);
  const refreshHash = await hmac(bidx, "identity.refresh", raw);
  const now = input.now.toISOString();
  const located = await sql<{ refresh_family: string }[]>`
    select refresh_family
    from identity.sessions
    where refresh_hash = ${refreshHash}
      and kind = any(${sql.array([...kinds])})
  `;
  const family = located[0]?.refresh_family;
  if (family === undefined) {
    return null;
  }
  const minted = await mint(sql, kms, keyArn);
  const successorId = newId();
  const claimed = await sql.begin(async (tx) => {
    await tx`
      select pg_advisory_xact_lock(hashtextextended('family:' || ${family}::text, 0))
    `;
    const rows = await tx<
      {
        id: string;
        user_id: string;
        refresh_family: string;
        kind: SessionKind;
        absolute_expires_at: Date | null;
      }[]
    >`
      update identity.sessions
      set replaced_by = ${successorId}, revoked_at = ${now}::timestamptz
      where refresh_hash = ${refreshHash}
        and refresh_expires_at > ${now}::timestamptz
        and replaced_by is null
        and revoked_at is null
        -- Intentional defence in depth: the locate select already refuses other kinds.
        and kind = any(${sql.array([...kinds])})
      returning id, user_id, refresh_family, kind, absolute_expires_at
    `;
    const row = rows[0];
    if (row !== undefined) {
      let accessExpiresAt: Date;
      let refreshExpiresAt: Date;
      if (row.kind === "operator") {
        const absMs = row.absolute_expires_at!.getTime();
        accessExpiresAt = new Date(Math.min(input.now.getTime() + ACCESS_MS, absMs));
        refreshExpiresAt = new Date(Math.min(input.now.getTime() + REFRESH_MS, absMs));
      } else {
        accessExpiresAt = new Date(input.now.getTime() + ACCESS_MS);
        refreshExpiresAt = new Date(input.now.getTime() + REFRESH_MS);
      }
      await tx`
        insert into identity.sessions (
          id, user_id, refresh_family, access_hash, refresh_hash,
          access_expires_at, refresh_expires_at, kind, absolute_expires_at
        )
        values (
          ${successorId},
          ${row.user_id},
          ${row.refresh_family},
          ${minted.accessHash},
          ${minted.refreshHash},
          ${accessExpiresAt.toISOString()}::timestamptz,
          ${refreshExpiresAt.toISOString()}::timestamptz,
          ${row.kind},
          ${row.absolute_expires_at ? row.absolute_expires_at.toISOString() : null}::timestamptz
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
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
    kind: SessionKind;
    absoluteExpiresAt: Date | null;
  },
): Promise<void> {
  await sql`
    insert into identity.sessions (
      id, user_id, refresh_family, access_hash, refresh_hash,
      access_expires_at, refresh_expires_at, kind, absolute_expires_at
    )
    values (
      ${input.id},
      ${input.userId},
      ${input.refreshFamily},
      ${input.accessHash},
      ${input.refreshHash},
      ${input.accessExpiresAt.toISOString()}::timestamptz,
      ${input.refreshExpiresAt.toISOString()}::timestamptz,
      ${input.kind},
      ${input.absoluteExpiresAt ? input.absoluteExpiresAt.toISOString() : null}::timestamptz
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
