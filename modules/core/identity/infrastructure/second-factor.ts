import type { webcrypto } from "node:crypto";
import { decrypt, encrypt, type KmsPort } from "@community-hub/crypto";
import { newId } from "@community-hub/db";
import type { Sql, TransactionSql } from "postgres";

import { newBackupCodes, normaliseBackupCode } from "../domain/backup-code.js";
import { IdentityError } from "../domain/error.js";
import type { SecondFactorNotice, SecondFactorNoticeKind } from "../domain/second-factor-notice.js";
import { base32Encode, newTotpKey, otpauthUri, verifyTotp } from "../domain/totp.js";
import { deriveIdentityEmailKeys, type IdentityEmailKeys } from "./email-lookup.js";
import { hmac } from "./hmac.js";
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  verifyPasskeyAssertionInTx,
  type PasskeyAuthenticationOptions,
  type PasskeyRegistrationOptions,
} from "./passkey.js";
import { lockSecondFactor } from "./second-factor-lock.js";
import {
  createSessionInTransaction,
  endOtherSessions,
  sessionAccessHash,
  type SessionFactor,
  type SessionKind,
  type SessionTokens,
} from "./session.js";
import { readUserEmails } from "./user-emails.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_SESSION_ATTEMPTS = 5;
const MAX_HOURLY_FAILURES = 10;
const IDENTITY_REGION = "au";
const AAD_TAG = "chub/field-identity/v1";
const TOTP_SECRET_LABEL = "identity.totp_secret";
const TOTP_PENDING_SECRET_LABEL = "identity.totp_pending_secret";
const BACKUP_CODE_LABEL = "identity.backup_code";

type TotpLabel = typeof TOTP_SECRET_LABEL | typeof TOTP_PENDING_SECRET_LABEL;

type SecondFactorEvent =
  | "totp_enrolled"
  | "totp_removed"
  | "passkey_enrolled"
  | "passkey_removed"
  | "backup_codes_generated"
  | "backup_code_used"
  | "verify_failed";

type SessionRow = {
  id: string;
  user_id: string;
  kind: SessionKind;
  factor: SessionFactor | null;
  revoked_at: Date | null;
  access_expires_at: Date;
  fresh_factor_at: Date | null;
  recovery_until: Date | null;
  second_factor_attempts: number;
};

export type StartTotpSetupInput = {
  accessToken: string;
  now: Date;
  adminRpId: string | null;
};

export type StartTotpSetupResult =
  { outcome: "started"; secret: string; otpauthUri: string } | { outcome: "refused" };

export type ConfirmTotpSetupInput = {
  accessToken: string;
  now: Date;
  code: string;
  adminRpId: string | null;
};

export type ConfirmTotpSetupResult =
  | { outcome: "confirmed"; backupCodes: string[]; tokens: SessionTokens }
  | { outcome: "confirmed"; backupCodes?: undefined; tokens?: undefined }
  | { outcome: "refused" };

export type VerifySecondStepMethod = "totp" | "backup_code";

export type VerifySecondStepInput = {
  accessToken: string;
  now: Date;
  method: VerifySecondStepMethod;
  code: string;
};

export type VerifySecondStepResult =
  | { outcome: "verified"; tokens: SessionTokens; backupCodesLeft?: number | undefined }
  | { outcome: "refused" }
  | { outcome: "limited" };

export type ListedPasskey = {
  id: string;
  createdAt: Date | null;
};

export type ListSecondFactorsInput = {
  accessToken: string;
  now: Date;
  adminRpId: string | null;
};

export type ListSecondFactorsResult =
  | {
      outcome: "listed";
      totp: { confirmedAt: Date } | null;
      passkeys: ListedPasskey[];
      backupCodesLeft: number;
      freshUntil: Date | null;
      recoveryUntil: Date | null;
    }
  | { outcome: "refused" };

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function encryptTotpKey(
  enc: webcrypto.CryptoKey,
  keyId: string,
  rowId: string,
  label: TotpLabel,
  plaintextKey: Uint8Array,
): Promise<Uint8Array> {
  const ciphertext = await encrypt(enc, plaintextKey, uuidToBytes(keyId), {
    tag: AAD_TAG,
    label,
    rowId: uuidToBytes(rowId),
    region: IDENTITY_REGION,
  });
  // Tagged templates cannot bind the branded Ciphertext type directly.
  const bytes: Uint8Array = ciphertext;
  return bytes;
}

async function decryptTotpKey(
  enc: webcrypto.CryptoKey,
  rowId: string,
  label: TotpLabel,
  blob: Uint8Array,
): Promise<Uint8Array> {
  return decrypt(blob as never, () => enc, {
    tag: AAD_TAG,
    label,
    rowId: uuidToBytes(rowId),
    region: IDENTITY_REGION,
  });
}

function isFreshFactor(session: SessionRow, now: Date): boolean {
  return (
    session.recovery_until === null &&
    session.fresh_factor_at !== null &&
    session.fresh_factor_at.getTime() >= now.getTime() - FIVE_MINUTES_MS
  );
}

function isInRecoveryWindow(session: SessionRow, now: Date): boolean {
  return session.recovery_until !== null && session.recovery_until.getTime() > now.getTime();
}

function canManageTenantFactors(session: SessionRow, now: Date): boolean {
  return isFreshFactor(session, now) || isInRecoveryWindow(session, now);
}

async function resolveSessionBeforeLock(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  accessToken: string,
): Promise<{ sessionId: string; userId: string; keys: IdentityEmailKeys } | null> {
  const accessHash = await sessionAccessHash(sql, kms, keyArn, accessToken);
  if (accessHash === null) {
    return null;
  }
  const keys = await deriveIdentityEmailKeys(sql, kms, keyArn);
  const rows = await sql<{ id: string; user_id: string }[]>`
    select id, user_id
    from identity.sessions
    where access_hash = ${accessHash}
    limit 1
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return { sessionId: row.id, userId: row.user_id, keys };
}

async function readActiveSessionInTx(
  tx: TransactionSql,
  sessionId: string,
  now: Date,
): Promise<SessionRow | null> {
  const rows = await tx<SessionRow[]>`
    select
      id,
      user_id,
      kind,
      factor,
      revoked_at,
      access_expires_at,
      fresh_factor_at,
      recovery_until,
      second_factor_attempts
    from identity.sessions
    where id = ${sessionId}
  `;
  const session = rows[0];
  if (
    session === undefined ||
    session.revoked_at !== null ||
    session.access_expires_at.getTime() <= now.getTime() ||
    (session.kind === "tenant" && session.factor === null)
  ) {
    return null;
  }
  return session;
}

async function appendSecondFactorEvent(
  tx: TransactionSql,
  userId: string,
  event: SecondFactorEvent,
  now: Date,
): Promise<void> {
  await tx`
    insert into identity.second_factor_events (id, user_id, event, occurred_at)
    values (${newId()}, ${userId}, ${event}, ${now.toISOString()}::timestamptz)
  `;
}

async function writeBackupCodes(
  tx: TransactionSql,
  bidx: webcrypto.CryptoKey,
  userId: string,
  now: Date,
): Promise<string[]> {
  const codes = newBackupCodes();
  const nowIso = now.toISOString();
  for (const code of codes) {
    const normalised = normaliseBackupCode(code);
    if (normalised === null) {
      throw new Error("generated backup code failed normalisation");
    }
    const codeHash = await hmac(bidx, BACKUP_CODE_LABEL, new TextEncoder().encode(normalised));
    await tx`
      insert into identity.backup_codes (id, user_id, code_hash, used_at, created_at)
      values (${newId()}, ${userId}, ${codeHash}, null, ${nowIso}::timestamptz)
    `;
  }
  return codes;
}

// Internal helper; not exported from public/.
export async function hasSecondFactor(
  tx: TransactionSql,
  userId: string,
  adminRpId: string | null,
): Promise<boolean> {
  const totpRows = await tx<{ id: string }[]>`
    select id
    from identity.totp_credentials
    where user_id = ${userId}
      and confirmed_at is not null
    limit 1
  `;
  if (totpRows[0] !== undefined) {
    return true;
  }
  if (!adminRpId) {
    const anyVerifiedPasskeys = await tx<{ id: string }[]>`
      select id
      from identity.passkey_credentials
      where user_id = ${userId}
        and user_verified = true
      limit 1
    `;
    return anyVerifiedPasskeys[0] !== undefined;
  }
  const passkeyRows = await tx<{ id: string }[]>`
    select id
    from identity.passkey_credentials
    where user_id = ${userId}
      and user_verified = true
      and rp_id = ${adminRpId}
    limit 1
  `;
  return passkeyRows[0] !== undefined;
}

export async function startTotpSetup(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: StartTotpSetupInput,
): Promise<StartTotpSetupResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  return sql.begin(async (tx) => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (session === null) {
      return { outcome: "refused" };
    }

    if (session.kind === "second_factor") {
      if (await hasSecondFactor(tx, session.user_id, input.adminRpId)) {
        return { outcome: "refused" };
      }
    } else if (session.kind === "tenant") {
      if (!canManageTenantFactors(session, input.now)) {
        return { outcome: "refused" };
      }
    } else {
      return { outcome: "refused" };
    }

    const existingRows = await tx<{ id: string; confirmed_at: Date | null }[]>`
      select id, confirmed_at
      from identity.totp_credentials
      where user_id = ${session.user_id}
    `;
    const existing = existingRows[0];
    const key = newTotpKey();
    const nowIso = input.now.toISOString();

    if (existing === undefined || existing.confirmed_at === null) {
      const rowId = existing?.id ?? newId();
      const secretBytes = await encryptTotpKey(
        resolved.keys.enc,
        resolved.keys.keyId,
        rowId,
        TOTP_SECRET_LABEL,
        key,
      );
      if (existing === undefined) {
        await tx`
          insert into identity.totp_credentials (
            id, user_id, secret, pending_secret, last_used_step, confirmed_at, created_at
          ) values (
            ${rowId}, ${session.user_id}, ${secretBytes}, null, null, null, ${nowIso}::timestamptz
          )
        `;
      } else {
        await tx`
          update identity.totp_credentials
          set secret = ${secretBytes},
              pending_secret = null,
              last_used_step = null,
              confirmed_at = null,
              created_at = ${nowIso}::timestamptz
          where id = ${existing.id}
        `;
      }
    } else {
      const pendingBytes = await encryptTotpKey(
        resolved.keys.enc,
        resolved.keys.keyId,
        existing.id,
        TOTP_PENDING_SECRET_LABEL,
        key,
      );
      await tx`
        update identity.totp_credentials
        set pending_secret = ${pendingBytes}
        where id = ${existing.id}
      `;
    }

    return {
      outcome: "started",
      secret: base32Encode(key),
      otpauthUri: otpauthUri(key),
    };
  });
}

export async function confirmTotpSetup(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: ConfirmTotpSetupInput,
  deps: SecondFactorNoticeDeps,
): Promise<ConfirmTotpSetupResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  const result = await confirmTotpSetupTx(sql, resolved, input);
  if (result.outcome === "confirmed" && resolved !== null) {
    await sendFactorNotice(sql, kms, keyArn, resolved.userId, "totp_set_up", deps);
  }
  return result;
}

async function confirmTotpSetupTx(
  sql: Sql,
  resolved: Awaited<ReturnType<typeof resolveSessionBeforeLock>>,
  input: ConfirmTotpSetupInput,
): Promise<ConfirmTotpSetupResult> {
  if (resolved === null) {
    return { outcome: "refused" };
  }

  return sql.begin(async (tx) => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (session === null) {
      return { outcome: "refused" };
    }

    if (session.kind === "second_factor") {
      if (await hasSecondFactor(tx, session.user_id, input.adminRpId)) {
        return { outcome: "refused" };
      }
    } else if (session.kind === "tenant") {
      if (!canManageTenantFactors(session, input.now)) {
        return { outcome: "refused" };
      }
    } else {
      return { outcome: "refused" };
    }

    const credRows = await tx<
      {
        id: string;
        secret: Uint8Array;
        pending_secret: Uint8Array | null;
        confirmed_at: Date | null;
      }[]
    >`
      select id, secret, pending_secret, confirmed_at
      from identity.totp_credentials
      where user_id = ${session.user_id}
    `;
    const cred = credRows[0];
    if (cred === undefined) {
      return { outcome: "refused" };
    }

    const isReplacement = cred.confirmed_at !== null;
    let encryptedToVerify: Uint8Array;
    let verifyLabel: TotpLabel;
    if (isReplacement) {
      if (cred.pending_secret === null) {
        return { outcome: "refused" };
      }
      encryptedToVerify = cred.pending_secret;
      verifyLabel = TOTP_PENDING_SECRET_LABEL;
    } else {
      encryptedToVerify = cred.secret;
      verifyLabel = TOTP_SECRET_LABEL;
    }

    const key = await decryptTotpKey(resolved.keys.enc, cred.id, verifyLabel, encryptedToVerify);
    const matchedStep = verifyTotp(key, input.code, input.now);
    if (matchedStep === null) {
      return { outcome: "refused" };
    }

    const nowIso = input.now.toISOString();
    if (isReplacement) {
      const newSecretBytes = await encryptTotpKey(
        resolved.keys.enc,
        resolved.keys.keyId,
        cred.id,
        TOTP_SECRET_LABEL,
        key,
      );
      await tx`
        update identity.totp_credentials
        set secret = ${newSecretBytes},
            pending_secret = null,
            confirmed_at = ${nowIso}::timestamptz,
            last_used_step = ${matchedStep}
        where id = ${cred.id}
      `;
      await endOtherSessions(tx, session.user_id, session.id, input.now);
      await appendSecondFactorEvent(tx, session.user_id, "totp_enrolled", input.now);
      return { outcome: "confirmed" };
    }

    await tx`
      update identity.totp_credentials
      set confirmed_at = ${nowIso}::timestamptz,
          last_used_step = ${matchedStep}
      where id = ${cred.id}
    `;
    await appendSecondFactorEvent(tx, session.user_id, "totp_enrolled", input.now);

    if (session.kind === "second_factor") {
      const backupCodes = await writeBackupCodes(
        tx,
        resolved.keys.bidx,
        session.user_id,
        input.now,
      );
      await appendSecondFactorEvent(tx, session.user_id, "backup_codes_generated", input.now);
      await tx`
        update identity.sessions
        set revoked_at = ${nowIso}::timestamptz
        where id = ${session.id}
          and revoked_at is null
      `;
      const tokens = await createSessionInTransaction(tx, resolved.keys.bidx, {
        userId: session.user_id,
        now: input.now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: null,
      });
      return { outcome: "confirmed", backupCodes, tokens };
    }

    if (isInRecoveryWindow(session, input.now)) {
      await endOtherSessions(tx, session.user_id, session.id, input.now);
    }
    return { outcome: "confirmed" };
  });
}

export async function verifySecondStep(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: VerifySecondStepInput,
): Promise<VerifySecondStepResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  return sql.begin(async (tx) => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (session === null || session.kind !== "second_factor") {
      return { outcome: "refused" };
    }

    const hourAgoIso = new Date(input.now.getTime() - HOUR_MS).toISOString();
    const recentFailures = await tx<{ n: number }[]>`
      select count(*)::int as n
      from identity.second_factor_events
      where user_id = ${session.user_id}
        and event = 'verify_failed'
        and occurred_at > ${hourAgoIso}::timestamptz
    `;
    if ((recentFailures[0]?.n ?? 0) >= MAX_HOURLY_FAILURES) {
      return { outcome: "limited" };
    }

    const attemptRows = await tx<{ second_factor_attempts: number }[]>`
      update identity.sessions
      set second_factor_attempts = second_factor_attempts + 1
      where id = ${session.id}
        and revoked_at is null
        and second_factor_attempts < ${MAX_SESSION_ATTEMPTS}
      returning second_factor_attempts
    `;
    const attemptRow = attemptRows[0];
    if (attemptRow === undefined) {
      return { outcome: "limited" };
    }
    const attempts = attemptRow.second_factor_attempts;
    const nowIso = input.now.toISOString();

    let matched = false;
    let backupCodesLeft: number | undefined;

    if (input.method === "totp") {
      const totpRows = await tx<{ id: string; secret: Uint8Array }[]>`
        select id, secret
        from identity.totp_credentials
        where user_id = ${session.user_id}
          and confirmed_at is not null
      `;
      const totpRow = totpRows[0];
      if (totpRow !== undefined) {
        const key = await decryptTotpKey(
          resolved.keys.enc,
          totpRow.id,
          TOTP_SECRET_LABEL,
          totpRow.secret,
        );
        const matchedStep = verifyTotp(key, input.code, input.now);
        if (matchedStep !== null) {
          const advanced = await tx<{ id: string }[]>`
            update identity.totp_credentials
            set last_used_step = ${matchedStep}
            where id = ${totpRow.id}
              and confirmed_at is not null
              and (last_used_step is null or last_used_step < ${matchedStep})
            returning id
          `;
          if (advanced[0] !== undefined) {
            const rechecked = await tx<{ id: string }[]>`
              select id
              from identity.totp_credentials
              where id = ${totpRow.id}
                and user_id = ${session.user_id}
                and confirmed_at is not null
            `;
            matched = rechecked[0] !== undefined;
          }
        }
      }
    } else if (input.method === "backup_code") {
      const normalised = normaliseBackupCode(input.code);
      if (normalised !== null) {
        const codeHash = await hmac(
          resolved.keys.bidx,
          BACKUP_CODE_LABEL,
          new TextEncoder().encode(normalised),
        );
        const consumed = await tx<{ id: string }[]>`
          update identity.backup_codes
          set used_at = ${nowIso}::timestamptz
          where user_id = ${session.user_id}
            and code_hash = ${codeHash}
            and used_at is null
          returning id
        `;
        const consumedRow = consumed[0];
        if (consumedRow !== undefined) {
          await appendSecondFactorEvent(tx, session.user_id, "backup_code_used", input.now);
          const rechecked = await tx<{ id: string }[]>`
            select id
            from identity.backup_codes
            where id = ${consumedRow.id}
              and user_id = ${session.user_id}
              and used_at is not null
          `;
          if (rechecked[0] !== undefined) {
            const remaining = await tx<{ n: number }[]>`
              select count(*)::int as n
              from identity.backup_codes
              where user_id = ${session.user_id}
                and used_at is null
            `;
            backupCodesLeft = remaining[0]?.n ?? 0;
            matched = true;
          }
        }
      }
    }

    if (!matched) {
      await appendSecondFactorEvent(tx, session.user_id, "verify_failed", input.now);
      if (attempts >= MAX_SESSION_ATTEMPTS) {
        await tx`
          update identity.sessions
          set revoked_at = ${nowIso}::timestamptz
          where id = ${session.id}
            and revoked_at is null
        `;
      }
      return { outcome: "refused" };
    }

    await tx`
      update identity.sessions
      set revoked_at = ${nowIso}::timestamptz
      where id = ${session.id}
        and revoked_at is null
    `;

    if (input.method === "totp") {
      const tokens = await createSessionInTransaction(tx, resolved.keys.bidx, {
        userId: session.user_id,
        now: input.now,
        kind: "tenant",
        factor: "otp_totp",
        freshFactorAt: input.now,
        recoveryUntil: null,
      });
      return { outcome: "verified", tokens };
    }

    const recoveryUntil = new Date(input.now.getTime() + TEN_MINUTES_MS);
    const tokens = await createSessionInTransaction(tx, resolved.keys.bidx, {
      userId: session.user_id,
      now: input.now,
      kind: "tenant",
      factor: "otp_backup_code",
      freshFactorAt: null,
      recoveryUntil,
    });
    return { outcome: "verified", tokens, backupCodesLeft };
  });
}

export async function listSecondFactors(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: ListSecondFactorsInput,
): Promise<ListSecondFactorsResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  return sql.begin(async (tx) => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (session === null || session.kind !== "tenant") {
      return { outcome: "refused" };
    }

    const totpRows = await tx<{ confirmed_at: Date }[]>`
      select confirmed_at
      from identity.totp_credentials
      where user_id = ${session.user_id}
        and confirmed_at is not null
      limit 1
    `;
    const totp = totpRows[0] !== undefined ? { confirmedAt: totpRows[0].confirmed_at } : null;

    let passkeys: ListedPasskey[] = [];
    if (input.adminRpId) {
      const passkeyRows = await tx<{ id: string; created_at: Date | null }[]>`
        select id, created_at
        from identity.passkey_credentials
        where user_id = ${session.user_id}
          and user_verified = true
          and rp_id = ${input.adminRpId}
        order by created_at asc nulls last, id asc
      `;
      passkeys = passkeyRows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
      }));
    }

    const backupRows = await tx<{ n: number }[]>`
      select count(*)::int as n
      from identity.backup_codes
      where user_id = ${session.user_id}
        and used_at is null
    `;
    const backupCodesLeft = backupRows[0]?.n ?? 0;

    const freshUntil =
      isFreshFactor(session, input.now) && session.fresh_factor_at !== null
        ? new Date(session.fresh_factor_at.getTime() + FIVE_MINUTES_MS)
        : null;
    // The window a backup-code sign-in opened, while it lasts. A session in one never has a fresh
    // factor, so this is how a caller tells it apart from a session that needs a fresh check.
    const recoveryUntil = isInRecoveryWindow(session, input.now) ? session.recovery_until : null;

    return {
      outcome: "listed",
      totp,
      passkeys,
      backupCodesLeft,
      freshUntil,
      recoveryUntil,
    };
  });
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SecondFactorNoticeLogFields = {
  event: "second_factor_notice_failed";
  kind: SecondFactorNoticeKind;
};

export type SecondFactorNoticeDeps = {
  notice: SecondFactorNotice;
  log?: ((fields: SecondFactorNoticeLogFields) => void) | undefined;
};

export type FreshCheckTotpInput = {
  accessToken: string;
  now: Date;
  code: string;
};

export type FreshCheckTotpResult =
  { outcome: "fresh" } | { outcome: "refused" } | { outcome: "limited" };

export type RegenerateBackupCodesInput = {
  accessToken: string;
  now: Date;
};

export type RegenerateBackupCodesResult =
  { outcome: "made"; backupCodes: string[] } | { outcome: "refused" };

export type RemoveTotpInput = {
  accessToken: string;
  now: Date;
  adminRpId: string | null;
};

// `last_factor`: the change would leave no authenticator app and no counting passkey.
// `not_found`: there is nothing of the caller's to remove (an unknown id, another user's id, a
// passkey that does not count, or no authenticator app). `refused`: the session, its fresh factor
// or its recovery window does not allow the change.
export type RemoveTotpResult =
  | { outcome: "removed" }
  | { outcome: "last_factor" }
  | { outcome: "not_found" }
  | { outcome: "refused" };

export type RemovePasskeyInput = {
  accessToken: string;
  now: Date;
  adminRpId: string | null;
  passkeyId: string;
};

export type RemovePasskeyResult =
  | { outcome: "removed" }
  | { outcome: "last_factor" }
  | { outcome: "not_found" }
  | { outcome: "refused" };

async function hasReachedHourlyFailureLimit(
  tx: TransactionSql,
  userId: string,
  now: Date,
): Promise<boolean> {
  const hourAgoIso = new Date(now.getTime() - HOUR_MS).toISOString();
  const recentFailures = await tx<{ n: number }[]>`
    select count(*)::int as n
    from identity.second_factor_events
    where user_id = ${userId}
      and event = 'verify_failed'
      and occurred_at > ${hourAgoIso}::timestamptz
  `;
  return (recentFailures[0]?.n ?? 0) >= MAX_HOURLY_FAILURES;
}

async function consumeSessionAttempt(
  tx: TransactionSql,
  sessionId: string,
): Promise<number | null> {
  const attemptRows = await tx<{ second_factor_attempts: number }[]>`
    update identity.sessions
    set second_factor_attempts = second_factor_attempts + 1
    where id = ${sessionId}
      and revoked_at is null
      and second_factor_attempts < ${MAX_SESSION_ATTEMPTS}
    returning second_factor_attempts
  `;
  return attemptRows[0]?.second_factor_attempts ?? null;
}

async function verifyConfirmedTotpInTx(
  tx: TransactionSql,
  encKey: webcrypto.CryptoKey,
  userId: string,
  code: string,
  now: Date,
): Promise<boolean> {
  const totpRows = await tx<{ id: string; secret: Uint8Array }[]>`
    select id, secret
    from identity.totp_credentials
    where user_id = ${userId}
      and confirmed_at is not null
  `;
  const totpRow = totpRows[0];
  if (totpRow === undefined) {
    return false;
  }
  const key = await decryptTotpKey(encKey, totpRow.id, TOTP_SECRET_LABEL, totpRow.secret);
  const matchedStep = verifyTotp(key, code, now);
  if (matchedStep === null) {
    return false;
  }
  const advanced = await tx<{ id: string }[]>`
    update identity.totp_credentials
    set last_used_step = ${matchedStep}
    where id = ${totpRow.id}
      and confirmed_at is not null
      and (last_used_step is null or last_used_step < ${matchedStep})
    returning id
  `;
  if (advanced[0] === undefined) {
    return false;
  }
  const rechecked = await tx<{ id: string }[]>`
    select id
    from identity.totp_credentials
    where id = ${totpRow.id}
      and user_id = ${userId}
      and confirmed_at is not null
  `;
  return rechecked[0] !== undefined;
}

async function hasConfirmedTotp(tx: TransactionSql, userId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    select id
    from identity.totp_credentials
    where user_id = ${userId}
      and confirmed_at is not null
    limit 1
  `;
  return rows[0] !== undefined;
}

async function hasCountingPasskey(
  tx: TransactionSql,
  userId: string,
  adminRpId: string | null,
  excludePasskeyId?: string | undefined,
): Promise<boolean> {
  if (!adminRpId) {
    return false;
  }
  const rows = excludePasskeyId
    ? await tx<{ id: string }[]>`
        select id
        from identity.passkey_credentials
        where user_id = ${userId}
          and id <> ${excludePasskeyId}
          and user_verified = true
          and rp_id = ${adminRpId}
        limit 1
      `
    : await tx<{ id: string }[]>`
        select id
        from identity.passkey_credentials
        where user_id = ${userId}
          and user_verified = true
          and rp_id = ${adminRpId}
        limit 1
      `;
  return rows[0] !== undefined;
}

async function sendFactorNotice(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  userId: string,
  kind: SecondFactorNoticeKind,
  deps: SecondFactorNoticeDeps,
): Promise<void> {
  try {
    const emails = await readUserEmails(sql, kms, keyArn, [userId]);
    const to = emails.get(userId);
    if (to === undefined) {
      deps.log?.({ event: "second_factor_notice_failed", kind });
      return;
    }
    await deps.notice.send({ to, kind });
  } catch {
    deps.log?.({ event: "second_factor_notice_failed", kind });
  }
}

export async function freshCheckTotp(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: FreshCheckTotpInput,
): Promise<FreshCheckTotpResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  return sql.begin(async (tx) => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (session === null || session.kind !== "tenant" || session.recovery_until !== null) {
      return { outcome: "refused" };
    }

    if (await hasReachedHourlyFailureLimit(tx, session.user_id, input.now)) {
      return { outcome: "limited" };
    }

    const attempts = await consumeSessionAttempt(tx, session.id);
    if (attempts === null) {
      return { outcome: "limited" };
    }

    const matched = await verifyConfirmedTotpInTx(
      tx,
      resolved.keys.enc,
      session.user_id,
      input.code,
      input.now,
    );
    if (!matched) {
      await appendSecondFactorEvent(tx, session.user_id, "verify_failed", input.now);
      return { outcome: "refused" };
    }

    const nowIso = input.now.toISOString();
    await tx`
      update identity.sessions
      set fresh_factor_at = ${nowIso}::timestamptz
      where id = ${session.id}
        and revoked_at is null
    `;
    return { outcome: "fresh" };
  });
}

export async function regenerateBackupCodes(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: RegenerateBackupCodesInput,
  deps: SecondFactorNoticeDeps,
): Promise<RegenerateBackupCodesResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  const result = await sql.begin(async (tx): Promise<RegenerateBackupCodesResult> => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (
      session === null ||
      session.kind !== "tenant" ||
      !canManageTenantFactors(session, input.now)
    ) {
      return { outcome: "refused" };
    }

    await tx`
      delete from identity.backup_codes
      where user_id = ${session.user_id}
    `;
    const backupCodes = await writeBackupCodes(tx, resolved.keys.bidx, session.user_id, input.now);
    await appendSecondFactorEvent(tx, session.user_id, "backup_codes_generated", input.now);
    await endOtherSessions(tx, session.user_id, session.id, input.now);
    return { outcome: "made", backupCodes };
  });

  if (result.outcome === "made") {
    await sendFactorNotice(sql, kms, keyArn, resolved.userId, "backup_codes_made", deps);
  }
  return result;
}

export async function removeTotp(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: RemoveTotpInput,
  deps: SecondFactorNoticeDeps,
): Promise<RemoveTotpResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  const result = await sql.begin(async (tx): Promise<RemoveTotpResult> => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (session === null || session.kind !== "tenant" || !isFreshFactor(session, input.now)) {
      return { outcome: "refused" };
    }

    if (!(await hasConfirmedTotp(tx, session.user_id))) {
      return { outcome: "not_found" };
    }

    if (!(await hasCountingPasskey(tx, session.user_id, input.adminRpId))) {
      return { outcome: "last_factor" };
    }

    await tx`
      delete from identity.totp_credentials
      where user_id = ${session.user_id}
    `;
    await appendSecondFactorEvent(tx, session.user_id, "totp_removed", input.now);
    await endOtherSessions(tx, session.user_id, session.id, input.now);
    return { outcome: "removed" };
  });

  if (result.outcome === "removed") {
    await sendFactorNotice(sql, kms, keyArn, resolved.userId, "totp_removed", deps);
  }
  return result;
}

export async function removePasskey(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: RemovePasskeyInput,
  deps: SecondFactorNoticeDeps,
): Promise<RemovePasskeyResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  const result = await sql.begin(async (tx): Promise<RemovePasskeyResult> => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (
      session === null ||
      session.kind !== "tenant" ||
      !canManageTenantFactors(session, input.now)
    ) {
      return { outcome: "refused" };
    }

    if (!input.adminRpId || !UUID_REGEX.test(input.passkeyId)) {
      return { outcome: "not_found" };
    }

    const targetRows = await tx<{ id: string }[]>`
      select id
      from identity.passkey_credentials
      where id = ${input.passkeyId}
        and user_id = ${session.user_id}
        and rp_id = ${input.adminRpId}
        and user_verified = true
    `;
    if (targetRows[0] === undefined) {
      return { outcome: "not_found" };
    }

    const hasTotp = await hasConfirmedTotp(tx, session.user_id);
    const hasOtherPasskey = await hasCountingPasskey(
      tx,
      session.user_id,
      input.adminRpId,
      input.passkeyId,
    );
    if (!hasTotp && !hasOtherPasskey) {
      return { outcome: "last_factor" };
    }

    await tx`
      delete from identity.passkey_credentials
      where id = ${input.passkeyId}
        and user_id = ${session.user_id}
    `;
    await appendSecondFactorEvent(tx, session.user_id, "passkey_removed", input.now);
    await endOtherSessions(tx, session.user_id, session.id, input.now);
    return { outcome: "removed" };
  });

  if (result.outcome === "removed") {
    await sendFactorNotice(sql, kms, keyArn, resolved.userId, "passkey_removed", deps);
  }
  return result;
}

export type BeginTenantPasskeyRegistrationInput = {
  accessToken: string;
  now: Date;
  adminRpId: string | null;
};

export type BeginTenantPasskeyRegistrationResult =
  { outcome: "started"; options: PasskeyRegistrationOptions } | { outcome: "refused" };

export type FinishTenantPasskeyRegistrationInput = {
  accessToken: string;
  now: Date;
  adminRpId: string | null;
  clientDataJSON: Uint8Array;
  attestationObject: Uint8Array;
};

export type FinishTenantPasskeyRegistrationResult =
  | { outcome: "enrolled"; backupCodes: string[]; tokens: SessionTokens }
  | { outcome: "enrolled"; backupCodes?: undefined; tokens?: undefined }
  | { outcome: "refused" };

export type BeginSecondStepPasskeyInput = {
  accessToken: string;
  now: Date;
  adminRpId: string | null;
};

export type BeginSecondStepPasskeyResult =
  { outcome: "started"; options: PasskeyAuthenticationOptions } | { outcome: "refused" };

export type VerifySecondStepPasskeyInput = {
  accessToken: string;
  now: Date;
  adminRpId: string | null;
  credentialId: Uint8Array;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
};

export type VerifySecondStepPasskeyResult =
  { outcome: "verified"; tokens: SessionTokens } | { outcome: "refused" } | { outcome: "limited" };

export type BeginFreshPasskeyInput = {
  accessToken: string;
  now: Date;
  adminRpId: string | null;
};

export type BeginFreshPasskeyResult =
  { outcome: "started"; options: PasskeyAuthenticationOptions } | { outcome: "refused" };

export type VerifyFreshPasskeyInput = {
  accessToken: string;
  now: Date;
  adminRpId: string | null;
  credentialId: Uint8Array;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
};

export type VerifyFreshPasskeyResult =
  { outcome: "fresh" } | { outcome: "refused" } | { outcome: "limited" };

export type SignInWithPasskeyInput = {
  adminRpId: string | null;
  now: Date;
  credentialId: Uint8Array;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
};

export type SignInWithPasskeyResult =
  { outcome: "signed_in"; tokens: SessionTokens } | { outcome: "refused" };

class TenantPasskeyRefusedError extends Error {}

async function isCountingPasskeyRow(
  tx: TransactionSql,
  credentialRowId: string,
  userId: string,
  adminRpId: string,
): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    select id
    from identity.passkey_credentials
    where id = ${credentialRowId}
      and user_id = ${userId}
      and rp_id = ${adminRpId}
      and user_verified = true
  `;
  return rows[0] !== undefined;
}

export async function beginTenantPasskeyRegistration(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: BeginTenantPasskeyRegistrationInput,
): Promise<BeginTenantPasskeyRegistrationResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  return sql.begin(async (tx) => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (session === null || !input.adminRpId) {
      return { outcome: "refused" };
    }

    if (session.kind === "second_factor") {
      if (await hasSecondFactor(tx, session.user_id, input.adminRpId)) {
        return { outcome: "refused" };
      }
    } else if (session.kind === "tenant") {
      if (!canManageTenantFactors(session, input.now)) {
        return { outcome: "refused" };
      }
    } else {
      return { outcome: "refused" };
    }

    try {
      const options = await beginPasskeyRegistration(tx, {
        userId: session.user_id,
        rpId: input.adminRpId,
        now: input.now,
        userVerification: "required",
        excludeExisting: true,
        requireUserVerified: true,
      });
      return { outcome: "started", options };
    } catch (error) {
      if (error instanceof IdentityError && error.code === "invalid_ceremony") {
        return { outcome: "refused" };
      }
      throw error;
    }
  });
}

export async function finishTenantPasskeyRegistration(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: FinishTenantPasskeyRegistrationInput,
  deps: SecondFactorNoticeDeps,
): Promise<FinishTenantPasskeyRegistrationResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null || !input.adminRpId) {
    return { outcome: "refused" };
  }

  const adminRpId = input.adminRpId;
  let capturedSession: SessionRow | undefined;
  let firstFactorOutput: { backupCodes: string[]; tokens: SessionTokens } | undefined;

  try {
    await finishPasskeyRegistration(sql, {
      userId: resolved.userId,
      rpId: adminRpId,
      now: input.now,
      clientDataJSON: input.clientDataJSON,
      attestationObject: input.attestationObject,
      acceptLegacy: false,
      requireUvFlag: true,
      beforeStore: async (tx) => {
        await lockSecondFactor(tx, resolved.userId);
        const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
        if (session === null) {
          throw new TenantPasskeyRefusedError();
        }
        if (session.kind === "second_factor") {
          if (await hasSecondFactor(tx, session.user_id, adminRpId)) {
            throw new TenantPasskeyRefusedError();
          }
        } else if (session.kind === "tenant") {
          if (!canManageTenantFactors(session, input.now)) {
            throw new TenantPasskeyRefusedError();
          }
        } else {
          throw new TenantPasskeyRefusedError();
        }
        capturedSession = session;
      },
      onStored: async (tx) => {
        if (capturedSession === undefined) {
          throw new TenantPasskeyRefusedError();
        }
        await appendSecondFactorEvent(tx, capturedSession.user_id, "passkey_enrolled", input.now);
        if (capturedSession.kind === "second_factor") {
          const backupCodes = await writeBackupCodes(
            tx,
            resolved.keys.bidx,
            capturedSession.user_id,
            input.now,
          );
          await appendSecondFactorEvent(
            tx,
            capturedSession.user_id,
            "backup_codes_generated",
            input.now,
          );
          const nowIso = input.now.toISOString();
          await tx`
            update identity.sessions
            set revoked_at = ${nowIso}::timestamptz
            where id = ${capturedSession.id}
              and revoked_at is null
          `;
          const tokens = await createSessionInTransaction(tx, resolved.keys.bidx, {
            userId: capturedSession.user_id,
            now: input.now,
            kind: "tenant",
            factor: "otp_passkey",
            freshFactorAt: null,
          });
          firstFactorOutput = { backupCodes, tokens };
          return;
        }
        if (isInRecoveryWindow(capturedSession, input.now)) {
          await endOtherSessions(tx, capturedSession.user_id, capturedSession.id, input.now);
        }
      },
    });
  } catch (error) {
    if (
      error instanceof TenantPasskeyRefusedError ||
      (error instanceof IdentityError && error.code === "invalid_ceremony")
    ) {
      return { outcome: "refused" };
    }
    throw error;
  }

  await sendFactorNotice(sql, kms, keyArn, resolved.userId, "passkey_added", deps);
  if (firstFactorOutput !== undefined) {
    return {
      outcome: "enrolled",
      backupCodes: firstFactorOutput.backupCodes,
      tokens: firstFactorOutput.tokens,
    };
  }
  return { outcome: "enrolled" };
}

export async function beginSecondStepPasskey(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: BeginSecondStepPasskeyInput,
): Promise<BeginSecondStepPasskeyResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  return sql.begin(async (tx) => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (session === null || session.kind !== "second_factor" || !input.adminRpId) {
      return { outcome: "refused" };
    }

    const options = await beginPasskeyAuthentication(tx, {
      rpId: input.adminRpId,
      now: input.now,
      userVerification: "required",
      challengeUserId: session.user_id,
    });
    return { outcome: "started", options };
  });
}

export async function verifySecondStepPasskey(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: VerifySecondStepPasskeyInput,
): Promise<VerifySecondStepPasskeyResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  return sql.begin(async (tx) => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (session === null || session.kind !== "second_factor" || !input.adminRpId) {
      return { outcome: "refused" };
    }

    if (await hasReachedHourlyFailureLimit(tx, session.user_id, input.now)) {
      return { outcome: "limited" };
    }

    const attempts = await consumeSessionAttempt(tx, session.id);
    if (attempts === null) {
      return { outcome: "limited" };
    }

    const verified = await verifyPasskeyAssertionInTx(tx, {
      rpId: input.adminRpId,
      now: input.now,
      credentialId: input.credentialId,
      clientDataJSON: input.clientDataJSON,
      authenticatorData: input.authenticatorData,
      signature: input.signature,
      acceptLegacy: false,
      requireUvFlag: true,
      requireUserVerified: true,
      challengeUserId: session.user_id,
      expectedUserId: session.user_id,
    });

    const matched =
      verified !== null &&
      (await isCountingPasskeyRow(tx, verified.credentialRowId, verified.userId, input.adminRpId));
    const nowIso = input.now.toISOString();

    if (!matched) {
      await appendSecondFactorEvent(tx, session.user_id, "verify_failed", input.now);
      if (attempts >= MAX_SESSION_ATTEMPTS) {
        await tx`
          update identity.sessions
          set revoked_at = ${nowIso}::timestamptz
          where id = ${session.id}
            and revoked_at is null
        `;
      }
      return { outcome: "refused" };
    }

    await tx`
      update identity.sessions
      set revoked_at = ${nowIso}::timestamptz
      where id = ${session.id}
        and revoked_at is null
    `;
    const tokens = await createSessionInTransaction(tx, resolved.keys.bidx, {
      userId: session.user_id,
      now: input.now,
      kind: "tenant",
      factor: "otp_passkey",
      freshFactorAt: input.now,
      recoveryUntil: null,
    });
    return { outcome: "verified", tokens };
  });
}

export async function beginFreshPasskey(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: BeginFreshPasskeyInput,
): Promise<BeginFreshPasskeyResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  return sql.begin(async (tx) => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (
      session === null ||
      session.kind !== "tenant" ||
      session.recovery_until !== null ||
      !input.adminRpId
    ) {
      return { outcome: "refused" };
    }

    const options = await beginPasskeyAuthentication(tx, {
      rpId: input.adminRpId,
      now: input.now,
      userVerification: "required",
      challengeUserId: session.user_id,
    });
    return { outcome: "started", options };
  });
}

export async function verifyFreshPasskey(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: VerifyFreshPasskeyInput,
): Promise<VerifyFreshPasskeyResult> {
  const resolved = await resolveSessionBeforeLock(sql, kms, keyArn, input.accessToken);
  if (resolved === null) {
    return { outcome: "refused" };
  }

  return sql.begin(async (tx) => {
    await lockSecondFactor(tx, resolved.userId);
    const session = await readActiveSessionInTx(tx, resolved.sessionId, input.now);
    if (
      session === null ||
      session.kind !== "tenant" ||
      session.recovery_until !== null ||
      !input.adminRpId
    ) {
      return { outcome: "refused" };
    }

    if (await hasReachedHourlyFailureLimit(tx, session.user_id, input.now)) {
      return { outcome: "limited" };
    }

    const attempts = await consumeSessionAttempt(tx, session.id);
    if (attempts === null) {
      return { outcome: "limited" };
    }

    const verified = await verifyPasskeyAssertionInTx(tx, {
      rpId: input.adminRpId,
      now: input.now,
      credentialId: input.credentialId,
      clientDataJSON: input.clientDataJSON,
      authenticatorData: input.authenticatorData,
      signature: input.signature,
      acceptLegacy: false,
      requireUvFlag: true,
      requireUserVerified: true,
      challengeUserId: session.user_id,
      expectedUserId: session.user_id,
    });

    const matched =
      verified !== null &&
      (await isCountingPasskeyRow(tx, verified.credentialRowId, verified.userId, input.adminRpId));

    if (!matched) {
      await appendSecondFactorEvent(tx, session.user_id, "verify_failed", input.now);
      return { outcome: "refused" };
    }

    const nowIso = input.now.toISOString();
    await tx`
      update identity.sessions
      set fresh_factor_at = ${nowIso}::timestamptz
      where id = ${session.id}
        and revoked_at is null
    `;
    return { outcome: "fresh" };
  });
}

export async function signInWithPasskey(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: SignInWithPasskeyInput,
): Promise<SignInWithPasskeyResult> {
  if (!input.adminRpId) {
    return { outcome: "refused" };
  }
  const tokens = await finishPasskeyAuthentication(sql, kms, keyArn, {
    rpId: input.adminRpId,
    now: input.now,
    credentialId: input.credentialId,
    clientDataJSON: input.clientDataJSON,
    authenticatorData: input.authenticatorData,
    signature: input.signature,
    tenant: { adminRpId: input.adminRpId },
  });
  return tokens === null ? { outcome: "refused" } : { outcome: "signed_in", tokens };
}
