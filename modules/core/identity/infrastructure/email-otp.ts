import type { webcrypto } from "node:crypto";
import { deriveKeys, unwrapKmsRoot, type KmsPort } from "@community-hub/crypto";
import { newId } from "@community-hub/db";
import type { Sql } from "postgres";

import { eightDigitsFrom } from "../domain/digits.js";
import { normaliseEmail } from "../domain/email.js";
import { IdentityError } from "../domain/error.js";
import type { OtpMail } from "../domain/otp-mail.js";
import { ensureIdentityKey } from "./identity-key.js";
import { insertIdentityUser } from "./identity-user.js";
import { createSession, type SessionTokens } from "./session.js";

const CONTEXT = { key_kind: "identity", region: "au", key_version: "1" } as const;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CODES_PER_HOUR = 5;

function eightDigits(): string {
  return eightDigitsFrom((bytes) => {
    crypto.getRandomValues(bytes);
  });
}

async function hmac(
  bidxKey: webcrypto.CryptoKey,
  purpose: string,
  message: Uint8Array,
): Promise<Uint8Array> {
  if (purpose.includes("\0")) {
    throw new Error("purpose must not contain NUL");
  }
  const purposeBytes = new TextEncoder().encode(purpose);
  const input = new Uint8Array(purposeBytes.byteLength + 1 + message.byteLength);
  input.set(purposeBytes, 0);
  input[purposeBytes.byteLength] = 0x00;
  input.set(message, purposeBytes.byteLength + 1);
  return new Uint8Array(await crypto.subtle.sign("HMAC", bidxKey, input));
}

function isUsersEmailConflict(error: unknown): boolean {
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

export async function startEmailOtp(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  mail: OtpMail,
  input: { email: string; now: Date },
): Promise<void> {
  const email = normaliseEmail(input.email);
  const bidx = await bidxKey(sql, kms, keyArn);
  const emailBidx = await hmac(bidx, "identity.users.email", new TextEncoder().encode(email));
  const windowStart = new Date(input.now.getTime() - HOUR_MS + TEN_MINUTES_MS).toISOString();
  const recent = await sql<{ n: number }[]>`
    select count(*)::int as n
    from identity.otp_challenges
    where email_bidx = ${emailBidx}
      and expires_at > ${windowStart}::timestamptz
  `;
  if ((recent[0]?.n ?? 0) >= CODES_PER_HOUR) {
    return;
  }
  const code = eightDigits();
  const codeHash = await hmac(bidx, "identity.otp", new TextEncoder().encode(code));
  const challengeId = newId();
  const expiresAt = new Date(input.now.getTime() + TEN_MINUTES_MS).toISOString();
  const now = input.now.toISOString();
  await sql.begin(async (tx) => {
    await tx`
      update identity.otp_challenges
      set consumed_at = ${now}::timestamptz
      where email_bidx = ${emailBidx} and consumed_at is null
    `;
    await tx`
      insert into identity.otp_challenges (id, email_bidx, code_hash, attempts, expires_at)
      values (${challengeId}, ${emailBidx}, ${codeHash}, 0, ${expiresAt}::timestamptz)
    `;
  });
  try {
    await mail.send({ to: email, code });
  } catch (error) {
    await sql`delete from identity.otp_challenges where id = ${challengeId}`;
    throw error;
  }
}

export async function verifyEmailOtp(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: { email: string; code: string; now: Date },
): Promise<SessionTokens | null> {
  let email: string;
  try {
    email = normaliseEmail(input.email);
  } catch (error) {
    if (error instanceof IdentityError && error.code === "invalid_email") {
      return null;
    }
    throw error;
  }
  if (!/^\d{8}$/.test(input.code)) {
    return null;
  }
  const bidx = await bidxKey(sql, kms, keyArn);
  const emailBidx = await hmac(bidx, "identity.users.email", new TextEncoder().encode(email));
  const codeHash = await hmac(bidx, "identity.otp", new TextEncoder().encode(input.code));
  const now = input.now.toISOString();
  const consumed = await sql<{ id: string }[]>`
    update identity.otp_challenges
    set consumed_at = ${now}::timestamptz
    where id = (
      select id from identity.otp_challenges
      where email_bidx = ${emailBidx}
        and consumed_at is null
        and expires_at >= ${now}::timestamptz
        and attempts < 5
        and code_hash = ${codeHash}
      limit 1
      for update
    )
    and consumed_at is null
    returning id
  `;
  if (consumed[0] === undefined) {
    await sql`
      update identity.otp_challenges
      set attempts = attempts + 1,
          consumed_at = case
            when attempts + 1 >= 5 then ${now}::timestamptz
            else consumed_at
          end
      where id = (
        select id from identity.otp_challenges
        where email_bidx = ${emailBidx}
          and consumed_at is null
          and expires_at >= ${now}::timestamptz
          and attempts < 5
          and code_hash <> ${codeHash}
        limit 1
        for update
      )
      and consumed_at is null
    `;
    return null;
  }
  const existing = await sql<{ id: string }[]>`
    select id from identity.users where email_bidx = ${emailBidx}
  `;
  const found = existing[0];
  if (found !== undefined) {
    return createSession(sql, kms, keyArn, { userId: found.id, now: input.now });
  }
  try {
    const created = await insertIdentityUser(sql, kms, keyArn, { email });
    return createSession(sql, kms, keyArn, { userId: created.userId, now: input.now });
  } catch (error) {
    if (!isUsersEmailConflict(error)) {
      throw error;
    }
    const again = await sql<{ id: string }[]>`
      select id from identity.users where email_bidx = ${emailBidx}
    `;
    const winner = again[0];
    return winner === undefined
      ? null
      : createSession(sql, kms, keyArn, { userId: winner.id, now: input.now });
  }
}
