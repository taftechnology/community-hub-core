import { type KmsPort } from "@community-hub/crypto";
import { newId } from "@community-hub/db";
import type { Sql } from "postgres";

import { eightDigitsFrom } from "../domain/digits.js";
import { normaliseEmail } from "../domain/email.js";
import { IdentityError } from "../domain/error.js";
import type { OtpMail } from "../domain/otp-mail.js";
import {
  deriveIdentityEmailKeys,
  emailBlindIndex,
  findOrCreateUserByKeys,
} from "./email-lookup.js";
import { hmac } from "./hmac.js";
import { createSession, type SessionTokens } from "./session.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CODES_PER_HOUR = 5;

export type OtpPurpose = "sign_in" | "operator_enrolment";

function eightDigits(): string {
  return eightDigitsFrom((bytes) => {
    crypto.getRandomValues(bytes);
  });
}

export async function startEmailOtp(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  mail: OtpMail,
  input: { email: string; now: Date; purpose?: OtpPurpose },
): Promise<void> {
  const email = normaliseEmail(input.email);
  const purpose = input.purpose ?? "sign_in";
  const { bidx } = await deriveIdentityEmailKeys(sql, kms, keyArn);
  const emailBidx = await emailBlindIndex(bidx, email);
  const windowStart = new Date(input.now.getTime() - HOUR_MS + TEN_MINUTES_MS).toISOString();
  const code = eightDigits();
  const codeHash = await hmac(bidx, "identity.otp", new TextEncoder().encode(code));
  const challengeId = newId();
  const expiresAt = new Date(input.now.getTime() + TEN_MINUTES_MS).toISOString();
  const now = input.now.toISOString();
  const inserted = await sql.begin(async (tx) => {
    await tx`
      select pg_advisory_xact_lock(hashtextextended('otp:' || encode(${emailBidx}, 'hex'), 0))
    `;
    const recent = await tx<{ n: number }[]>`
      select count(*)::int as n
      from identity.otp_challenges
      where email_bidx = ${emailBidx}
        and purpose = ${purpose}
        and expires_at > ${windowStart}::timestamptz
    `;
    if ((recent[0]?.n ?? 0) >= CODES_PER_HOUR) {
      return false;
    }
    await tx`
      update identity.otp_challenges
      set consumed_at = ${now}::timestamptz
      where email_bidx = ${emailBidx}
        and purpose = ${purpose}
        and consumed_at is null
    `;
    await tx`
      insert into identity.otp_challenges (id, email_bidx, code_hash, attempts, expires_at, purpose)
      values (${challengeId}, ${emailBidx}, ${codeHash}, 0, ${expiresAt}::timestamptz, ${purpose})
    `;
    return true;
  });
  if (!inserted) {
    return;
  }
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
  const keys = await deriveIdentityEmailKeys(sql, kms, keyArn);
  const emailBidx = await emailBlindIndex(keys.bidx, email);
  const codeHash = await hmac(keys.bidx, "identity.otp", new TextEncoder().encode(input.code));
  const now = input.now.toISOString();
  const decided = await sql<{ matched: boolean }[]>`
    update identity.otp_challenges
    set
      attempts = case
        when code_hash = ${codeHash} then attempts
        else attempts + 1
      end,
      consumed_at = case
        when code_hash = ${codeHash} then ${now}::timestamptz
        when attempts + 1 >= 5 then ${now}::timestamptz
        else consumed_at
      end
    where id = (
      select id
      from identity.otp_challenges
      where email_bidx = ${emailBidx}
        and purpose = 'sign_in'
        and consumed_at is null
        and expires_at >= ${now}::timestamptz
        and attempts < 5
      limit 1
      for update
    )
    returning (code_hash = ${codeHash}) as matched
  `;
  if (decided[0]?.matched !== true) {
    return null;
  }
  const { userId } = await findOrCreateUserByKeys(sql, keys, email, emailBidx);
  return createSession(sql, kms, keyArn, { userId, now: input.now });
}
