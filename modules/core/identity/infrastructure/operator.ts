import type { KmsPort } from "@community-hub/crypto";
import { newId } from "@community-hub/db";
import type { Sql, TransactionSql } from "postgres";

import { eightDigitsFrom } from "../domain/digits.js";
import { normaliseEmail } from "../domain/email.js";
import { normaliseEnrolmentCode } from "../domain/enrolment-code.js";
import { IdentityError } from "../domain/error.js";
import type { OtpMail } from "../domain/otp-mail.js";
import { isPlatformRoleKey, type PlatformRoleKey } from "../domain/platform-roles.js";
import { deriveIdentityEmailKeys, emailBlindIndex } from "./email-lookup.js";
import { CODES_PER_HOUR, HOUR_MS, TEN_MINUTES_MS } from "./email-otp.js";
import { hmac } from "./hmac.js";
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyRegistration,
  verifyPasskeyAssertion,
  type PasskeyAuthenticationOptions,
  type PasskeyRegistrationOptions,
} from "./passkey.js";
import {
  createSessionInTransaction,
  readSessionWithKind,
  refreshSession,
  sessionAccessHash,
  type SessionTokens,
} from "./session.js";

const ENROLMENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeRequestId(requestId?: string | null): string | null {
  if (requestId && UUID_REGEX.test(requestId)) {
    return requestId;
  }
  return null;
}

export type OperatorAction =
  | "granted"
  | "revoked"
  | "recovery_regrant"
  | "enrolment_started"
  | "passkey_registered"
  | "activated"
  | "signed_in"
  | "sign_in_refused"
  | "signed_out";

/**
 * Internal to identity; exported only so identity's own tests can take the real lock and write events; never re-export from public/.
 */
export async function lockOperatorUser(tx: TransactionSql, userId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('operator:' || ${userId}::text, 0))`;
}

/**
 * Internal to identity; exported only so identity's own tests can take the real lock and write events; never re-export from public/.
 */
export async function appendOperatorEvent(
  tx: TransactionSql,
  input: {
    userId: string;
    action: OperatorAction;
    roleKey?: PlatformRoleKey | null | undefined;
    requestId?: string | null | undefined;
    now: Date;
  },
): Promise<void> {
  const eventId = newId();
  const requestId = sanitizeRequestId(input.requestId);
  const roleKey =
    input.action === "granted" || input.action === "revoked" || input.action === "activated"
      ? (input.roleKey ?? null)
      : null;

  await tx`
    insert into identity.operator_events (
      id, user_id, action, role_key, request_id, occurred_at
    ) values (
      ${eventId}, ${input.userId}, ${input.action}, ${roleKey}, ${requestId}, ${input.now}
    )
  `;
}

function validateGrantInput(
  roleKeys: readonly string[],
  enrolmentCode: string,
): { validatedRoles: PlatformRoleKey[]; normalisedCode: string } {
  if (roleKeys.length === 0) {
    throw new IdentityError("invalid_grant");
  }
  const seen = new Set<string>();
  const validatedRoles: PlatformRoleKey[] = [];
  for (const r of roleKeys) {
    if (seen.has(r) || !isPlatformRoleKey(r)) {
      throw new IdentityError("invalid_grant");
    }
    seen.add(r);
    validatedRoles.push(r);
  }
  const normalisedCode = normaliseEnrolmentCode(enrolmentCode);
  if (normalisedCode === null) {
    throw new IdentityError("invalid_grant");
  }
  return { validatedRoles, normalisedCode };
}

async function grantInTransaction(
  tx: TransactionSql,
  input: {
    userId: string;
    roleKeys: readonly PlatformRoleKey[];
    codeHash: Uint8Array;
    opsRpId: string;
    now: Date;
    requestId?: string | undefined;
  },
): Promise<{ grantIds: string[] }> {
  const [user] = await tx<{ id: string }[]>`
    select id from identity.users where id = ${input.userId}
  `;
  if (!user) {
    throw new IdentityError("invalid_grant");
  }

  const expiredGrants = await tx<{ id: string; role_key: PlatformRoleKey }[]>`
    update identity.operator_grants
    set revoked_at = ${input.now}
    where user_id = ${input.userId}
      and revoked_at is null
      and activated_at is null
      and enrolment_expires_at <= ${input.now}
    returning id, role_key
  `;
  for (const grant of expiredGrants) {
    await appendOperatorEvent(tx, {
      userId: input.userId,
      action: "revoked",
      roleKey: grant.role_key,
      requestId: input.requestId,
      now: input.now,
    });
  }

  const [activeCount] = await tx<{ count: string }[]>`
    select count(*)::text as count
    from identity.operator_grants
    where user_id = ${input.userId}
      and revoked_at is null
      and activated_at is not null
  `;
  if (Number(activeCount?.count ?? 0) === 0) {
    await tx`
      delete from identity.passkey_credentials
      where user_id = ${input.userId}
        and rp_id = ${input.opsRpId}
    `;
  }

  const [conflict] = await tx<{ role_key: string }[]>`
    select role_key
    from identity.operator_grants
    where user_id = ${input.userId}
      and revoked_at is null
      and role_key = any(${tx.array([...input.roleKeys])})
    limit 1
  `;
  if (conflict !== undefined) {
    throw new IdentityError("invalid_grant");
  }

  const expiresAt = new Date(input.now.getTime() + ENROLMENT_WINDOW_MS);
  const grantIds: string[] = [];
  for (const roleKey of input.roleKeys) {
    const grantId = newId();
    await tx`
      insert into identity.operator_grants (
        id, user_id, role_key, enrolment_code_hash, granted_at, enrolment_expires_at
      ) values (
        ${grantId}, ${input.userId}, ${roleKey}, ${input.codeHash}, ${input.now}, ${expiresAt}
      )
    `;
    await appendOperatorEvent(tx, {
      userId: input.userId,
      action: "granted",
      roleKey,
      requestId: input.requestId,
      now: input.now,
    });
    grantIds.push(grantId);
  }

  return { grantIds };
}

async function revokeInTransaction(
  tx: TransactionSql,
  input: {
    userId: string;
    opsRpId: string;
    now: Date;
    requestId?: string | undefined;
  },
): Promise<void> {
  const revokedGrants = await tx<{ id: string; role_key: PlatformRoleKey }[]>`
    update identity.operator_grants
    set revoked_at = ${input.now}
    where user_id = ${input.userId}
      and revoked_at is null
    returning id, role_key
  `;
  for (const grant of revokedGrants) {
    await appendOperatorEvent(tx, {
      userId: input.userId,
      action: "revoked",
      roleKey: grant.role_key,
      requestId: input.requestId,
      now: input.now,
    });
  }

  await tx`
    update identity.sessions
    set revoked_at = ${input.now}
    where user_id = ${input.userId}
      and revoked_at is null
      and kind in ('operator', 'enrolment')
  `;

  await tx`
    delete from identity.passkey_credentials
    where user_id = ${input.userId}
      and rp_id = ${input.opsRpId}
  `;
}

export type GrantOperatorInput = {
  userId: string;
  roleKeys: readonly string[];
  enrolmentCode: string;
  opsRpId: string;
  now: Date;
  requestId?: string | undefined;
};

export type RevokeOperatorInput = {
  userId: string;
  opsRpId: string;
  now: Date;
  requestId?: string | undefined;
};

export type RecoverOperatorInput = {
  userId: string;
  roleKeys: readonly string[];
  enrolmentCode: string;
  opsRpId: string;
  now: Date;
  requestId?: string | undefined;
};

export async function grantOperator(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: GrantOperatorInput,
): Promise<{ grantIds: string[] }> {
  const { validatedRoles, normalisedCode } = validateGrantInput(
    input.roleKeys,
    input.enrolmentCode,
  );
  const { bidx } = await deriveIdentityEmailKeys(sql, kms, keyArn);
  const codeHash = await hmac(
    bidx,
    "identity.operator_enrolment_code",
    new TextEncoder().encode(normalisedCode),
  );
  return sql.begin(async (tx) => {
    await lockOperatorUser(tx, input.userId);
    return grantInTransaction(tx, {
      userId: input.userId,
      roleKeys: validatedRoles,
      codeHash,
      opsRpId: input.opsRpId,
      now: input.now,
      requestId: input.requestId,
    });
  });
}

export async function revokeOperator(sql: Sql, input: RevokeOperatorInput): Promise<void> {
  await sql.begin(async (tx) => {
    await lockOperatorUser(tx, input.userId);
    await revokeInTransaction(tx, input);
  });
}

export async function recoverOperator(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: RecoverOperatorInput,
): Promise<{ grantIds: string[] }> {
  const { validatedRoles, normalisedCode } = validateGrantInput(
    input.roleKeys,
    input.enrolmentCode,
  );
  const { bidx } = await deriveIdentityEmailKeys(sql, kms, keyArn);
  const codeHash = await hmac(
    bidx,
    "identity.operator_enrolment_code",
    new TextEncoder().encode(normalisedCode),
  );
  return sql.begin(async (tx) => {
    await lockOperatorUser(tx, input.userId);
    await revokeInTransaction(tx, {
      userId: input.userId,
      opsRpId: input.opsRpId,
      now: input.now,
      requestId: input.requestId,
    });
    await appendOperatorEvent(tx, {
      userId: input.userId,
      action: "recovery_regrant",
      requestId: input.requestId,
      now: input.now,
    });
    return grantInTransaction(tx, {
      userId: input.userId,
      roleKeys: validatedRoles,
      codeHash,
      opsRpId: input.opsRpId,
      now: input.now,
      requestId: input.requestId,
    });
  });
}

export type StartOperatorEnrolmentInput = {
  email: string;
  now: Date;
  requestId?: string | undefined;
};

export type VerifyOperatorEnrolmentInput = {
  email: string;
  emailCode: string;
  enrolmentCode: string;
  opsRpId: string;
  now: Date;
  requestId?: string | undefined;
};

export type VerifyOperatorEnrolmentResult =
  { kind: "enrolment"; session: SessionTokens } | { kind: "activated" } | null;

function eightDigits(): string {
  return eightDigitsFrom((bytes) => {
    crypto.getRandomValues(bytes);
  });
}

export async function startOperatorEnrolment(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  mail: OtpMail,
  input: StartOperatorEnrolmentInput,
): Promise<void> {
  let email: string;
  try {
    email = normaliseEmail(input.email);
  } catch (error) {
    if (error instanceof IdentityError && error.code === "invalid_email") {
      return;
    }
    throw error;
  }

  const { bidx } = await deriveIdentityEmailKeys(sql, kms, keyArn);
  const emailBidx = await emailBlindIndex(bidx, email);
  const windowStart = new Date(input.now.getTime() - HOUR_MS + TEN_MINUTES_MS).toISOString();
  const code = eightDigits();
  const codeHash = await hmac(bidx, "identity.otp", new TextEncoder().encode(code));
  const challengeId = newId();
  const expiresAt = new Date(input.now.getTime() + TEN_MINUTES_MS).toISOString();
  const nowIso = input.now.toISOString();

  const result = await sql.begin(async (tx) => {
    await tx`
      select pg_advisory_xact_lock(hashtextextended('otp:' || encode(${emailBidx}, 'hex'), 0))
    `;
    const recent = await tx<{ n: number }[]>`
      select count(*)::int as n
      from identity.otp_challenges
      where email_bidx = ${emailBidx}
        and purpose = 'operator_enrolment'
        and expires_at > ${windowStart}::timestamptz
    `;
    if ((recent[0]?.n ?? 0) >= CODES_PER_HOUR) {
      return { inserted: false, shouldSend: false, userId: null };
    }
    await tx`
      update identity.otp_challenges
      set consumed_at = ${nowIso}::timestamptz
      where email_bidx = ${emailBidx}
        and purpose = 'operator_enrolment'
        and consumed_at is null
    `;
    await tx`
      insert into identity.otp_challenges (id, email_bidx, code_hash, attempts, expires_at, purpose)
      values (${challengeId}, ${emailBidx}, ${codeHash}, 0, ${expiresAt}::timestamptz, 'operator_enrolment')
    `;

    const [openGrant] = await tx<{ user_id: string }[]>`
      select g.user_id
      from identity.users u
      join identity.operator_grants g on g.user_id = u.id
      where u.email_bidx = ${emailBidx}
        and g.revoked_at is null
        and g.activated_at is null
        and g.enrolment_expires_at > ${input.now}
      limit 1
    `;

    return {
      inserted: true,
      shouldSend: openGrant !== undefined,
      userId: openGrant?.user_id ?? null,
    };
  });

  if (!result.inserted || !result.shouldSend || !result.userId) {
    return;
  }

  try {
    await mail.send({ to: email, code });
  } catch (error) {
    await sql`delete from identity.otp_challenges where id = ${challengeId}`;
    throw error;
  }

  await sql.begin(async (tx) => {
    await appendOperatorEvent(tx, {
      userId: result.userId!,
      action: "enrolment_started",
      requestId: input.requestId,
      now: input.now,
    });
  });
}

async function activateOpenGrants(
  tx: TransactionSql,
  input: {
    userId: string;
    now: Date;
    requestId?: string | undefined;
  },
): Promise<number> {
  const activatedGrants = await tx<{ id: string; role_key: PlatformRoleKey }[]>`
    update identity.operator_grants
    set activated_at = ${input.now}
    where user_id = ${input.userId}
      and revoked_at is null
      and activated_at is null
      and enrolment_expires_at > ${input.now}
    returning id, role_key
  `;
  for (const grant of activatedGrants) {
    await appendOperatorEvent(tx, {
      userId: input.userId,
      action: "activated",
      roleKey: grant.role_key,
      requestId: input.requestId,
      now: input.now,
    });
  }
  if (activatedGrants.length > 0) {
    await tx`
      update identity.sessions
      set revoked_at = ${input.now}
      where user_id = ${input.userId}
        and revoked_at is null
        and kind = 'enrolment'
    `;
  }
  return activatedGrants.length;
}

export async function verifyOperatorEnrolment(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: VerifyOperatorEnrolmentInput,
): Promise<VerifyOperatorEnrolmentResult> {
  let email: string;
  try {
    email = normaliseEmail(input.email);
  } catch (error) {
    if (error instanceof IdentityError && error.code === "invalid_email") {
      return null;
    }
    throw error;
  }
  if (!/^\d{8}$/.test(input.emailCode)) {
    return null;
  }

  const { bidx } = await deriveIdentityEmailKeys(sql, kms, keyArn);
  const emailBidx = await emailBlindIndex(bidx, email);

  const [user] = await sql<{ id: string }[]>`
    select id from identity.users where email_bidx = ${emailBidx}
  `;

  // O13's equal-statement rule applies to startOperatorEnrolment; verify may skip the HMAC/grant select for an unknown user.
  const normalisedCode = normaliseEnrolmentCode(input.enrolmentCode);
  let enrolmentOk = false;
  let enrolmentCodeHash: Uint8Array | null = null;
  if (normalisedCode !== null && user !== undefined) {
    enrolmentCodeHash = await hmac(
      bidx,
      "identity.operator_enrolment_code",
      new TextEncoder().encode(normalisedCode),
    );
    const [matchingGrant] = await sql<{ id: string }[]>`
      select id
      from identity.operator_grants
      where user_id = ${user.id}
        and enrolment_code_hash = ${enrolmentCodeHash}
        and revoked_at is null
        and activated_at is null
        and enrolment_expires_at > ${input.now}
      limit 1
    `;
    enrolmentOk = matchingGrant !== undefined;
  }

  const emailHash = await hmac(bidx, "identity.otp", new TextEncoder().encode(input.emailCode));
  const nowIso = input.now.toISOString();

  const decided = await sql<{ matched: boolean }[]>`
    update identity.otp_challenges
    set
      attempts = case
        when code_hash = ${emailHash} and ${enrolmentOk}::boolean then attempts
        else attempts + 1
      end,
      consumed_at = case
        when code_hash = ${emailHash} and ${enrolmentOk}::boolean then ${nowIso}::timestamptz
        when attempts + 1 >= 5 then ${nowIso}::timestamptz
        else consumed_at
      end
    where id = (
      select id
      from identity.otp_challenges
      where email_bidx = ${emailBidx}
        and purpose = 'operator_enrolment'
        and consumed_at is null
        and expires_at >= ${nowIso}::timestamptz
        and attempts < 5
      limit 1
      for update
    )
    returning (code_hash = ${emailHash} and ${enrolmentOk}::boolean) as matched
  `;

  if (decided[0]?.matched !== true || user === undefined || enrolmentCodeHash === null) {
    return null;
  }

  return sql.begin(async (tx) => {
    await lockOperatorUser(tx, user.id);
    const [stillOpen] = await tx<{ id: string }[]>`
      select id
      from identity.operator_grants
      where user_id = ${user.id}
        and enrolment_code_hash = ${enrolmentCodeHash}
        and revoked_at is null
        and activated_at is null
        and enrolment_expires_at > ${input.now}
      limit 1
    `;
    if (!stillOpen) {
      return null;
    }

    const [opsCredCount] = await tx<{ count: string }[]>`
      select count(*)::text as count
      from identity.passkey_credentials
      where user_id = ${user.id}
        and rp_id = ${input.opsRpId}
    `;
    const hasTwoOrMoreOpsCreds = Number(opsCredCount?.count ?? 0) >= 2;

    if (hasTwoOrMoreOpsCreds) {
      await activateOpenGrants(tx, {
        userId: user.id,
        now: input.now,
        requestId: input.requestId,
      });
      return { kind: "activated" as const };
    }

    const session = await createSessionInTransaction(tx, bidx, {
      userId: user.id,
      now: input.now,
      kind: "enrolment",
    });
    return { kind: "enrolment" as const, session };
  });
}

export type BeginOperatorPasskeyRegistrationInput = {
  accessToken: string;
  opsRpId: string;
  now: Date;
};

export type FinishOperatorPasskeyRegistrationInput = {
  accessToken: string;
  opsRpId: string;
  now: Date;
  clientDataJSON: Uint8Array;
  attestationObject: Uint8Array;
  requestId?: string | undefined;
};

class RegistrationSentinelError extends Error {
  constructor() {
    super("registration_precondition_failed");
  }
}

export async function beginOperatorPasskeyRegistration(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: BeginOperatorPasskeyRegistrationInput,
): Promise<PasskeyRegistrationOptions | null> {
  const session = await readSessionWithKind(sql, kms, keyArn, {
    accessToken: input.accessToken,
    now: input.now,
    kinds: ["enrolment", "operator"],
  });
  if (session === null) {
    return null;
  }

  if (session.kind === "enrolment") {
    const [openGrant] = await sql<{ id: string }[]>`
      select id from identity.operator_grants
      where user_id = ${session.userId}
        and revoked_at is null
        and activated_at is null
        and enrolment_expires_at > ${input.now}
      limit 1
    `;
    if (!openGrant) {
      return null;
    }
  } else if (session.kind === "operator") {
    const [activeGrant] = await sql<{ id: string }[]>`
      select id from identity.operator_grants
      where user_id = ${session.userId}
        and revoked_at is null
        and activated_at is not null
      limit 1
    `;
    if (!activeGrant) {
      return null;
    }
  } else {
    return null;
  }

  return beginPasskeyRegistration(sql, {
    userId: session.userId,
    rpId: input.opsRpId,
    now: input.now,
    userVerification: "required",
    excludeExisting: true,
  });
}

export async function finishOperatorPasskeyRegistration(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: FinishOperatorPasskeyRegistrationInput,
): Promise<boolean> {
  const session = await readSessionWithKind(sql, kms, keyArn, {
    accessToken: input.accessToken,
    now: input.now,
    kinds: ["enrolment", "operator"],
  });
  if (session === null) {
    return false;
  }

  const accessHash = await sessionAccessHash(sql, kms, keyArn, input.accessToken);
  if (accessHash === null) {
    return false;
  }

  try {
    await finishPasskeyRegistration(sql, {
      userId: session.userId,
      rpId: input.opsRpId,
      now: input.now,
      clientDataJSON: input.clientDataJSON,
      attestationObject: input.attestationObject,
      acceptLegacy: false,
      beforeStore: async (tx) => {
        await lockOperatorUser(tx, session.userId);

        const [sessionRow] = await tx<{ id: string; kind: string }[]>`
          select id, kind
          from identity.sessions
          where access_hash = ${accessHash}
            and user_id = ${session.userId}
            and revoked_at is null
            and access_expires_at > ${input.now}
            and kind in ('enrolment', 'operator')
          limit 1
        `;
        if (!sessionRow) {
          throw new RegistrationSentinelError();
        }

        if (sessionRow.kind === "enrolment") {
          const [openGrant] = await tx<{ id: string }[]>`
            select id
            from identity.operator_grants
            where user_id = ${session.userId}
              and revoked_at is null
              and activated_at is null
              and enrolment_expires_at > ${input.now}
            limit 1
          `;
          if (!openGrant) {
            throw new RegistrationSentinelError();
          }
        } else if (sessionRow.kind === "operator") {
          const [activeGrant] = await tx<{ id: string }[]>`
            select id
            from identity.operator_grants
            where user_id = ${session.userId}
              and revoked_at is null
              and activated_at is not null
            limit 1
          `;
          if (!activeGrant) {
            throw new RegistrationSentinelError();
          }
        } else {
          throw new RegistrationSentinelError();
        }
      },
      onStored: async (tx) => {
        await appendOperatorEvent(tx, {
          userId: session.userId,
          action: "passkey_registered",
          requestId: input.requestId,
          now: input.now,
        });

        const [opsCredCount] = await tx<{ count: string }[]>`
          select count(*)::text as count
          from identity.passkey_credentials
          where user_id = ${session.userId}
            and rp_id = ${input.opsRpId}
        `;
        const count = Number(opsCredCount?.count ?? 0);

        if (count >= 2) {
          await activateOpenGrants(tx, {
            userId: session.userId,
            now: input.now,
            requestId: input.requestId,
          });
        }
      },
    });
    return true;
  } catch (error) {
    if (error instanceof RegistrationSentinelError) {
      return false;
    }
    if (error instanceof IdentityError && error.code === "invalid_ceremony") {
      return false;
    }
    throw error;
  }
}

export type BeginOperatorAuthenticationInput = {
  opsRpId: string;
  now: Date;
};

export type FinishOperatorAuthenticationInput = {
  opsRpId: string;
  now: Date;
  credentialId: Uint8Array;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
  requestId?: string | undefined;
};

export async function beginOperatorAuthentication(
  sql: Sql,
  input: BeginOperatorAuthenticationInput,
): Promise<PasskeyAuthenticationOptions> {
  return beginPasskeyAuthentication(sql, {
    rpId: input.opsRpId,
    now: input.now,
    userVerification: "required",
  });
}

export async function finishOperatorAuthentication(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: FinishOperatorAuthenticationInput,
): Promise<SessionTokens | null> {
  const verified = await verifyPasskeyAssertion(sql, {
    rpId: input.opsRpId,
    acceptLegacy: false,
    now: input.now,
    credentialId: input.credentialId,
    clientDataJSON: input.clientDataJSON,
    authenticatorData: input.authenticatorData,
    signature: input.signature,
  });

  if (verified === null) {
    return null;
  }

  const { bidx } = await deriveIdentityEmailKeys(sql, kms, keyArn);

  return sql.begin(async (tx) => {
    await lockOperatorUser(tx, verified.userId);

    const [activeGrant] = await tx<{ id: string }[]>`
      select id
      from identity.operator_grants
      where user_id = ${verified.userId}
        and revoked_at is null
        and activated_at is not null
      limit 1
    `;

    if (activeGrant !== undefined) {
      const absoluteExpiresAt = new Date(input.now.getTime() + 8 * 60 * 60 * 1000);
      const session = await createSessionInTransaction(tx, bidx, {
        userId: verified.userId,
        now: input.now,
        kind: "operator",
        absoluteExpiresAt,
      });

      await appendOperatorEvent(tx, {
        userId: verified.userId,
        action: "signed_in",
        requestId: input.requestId,
        now: input.now,
      });

      return session;
    } else {
      await appendOperatorEvent(tx, {
        userId: verified.userId,
        action: "sign_in_refused",
        requestId: input.requestId,
        now: input.now,
      });

      return null;
    }
  });
}

export type ReadOperatorSessionInput = {
  accessToken: string;
  now: Date;
};

export async function readOperatorSession(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: ReadOperatorSessionInput,
): Promise<{ userId: string; roles: PlatformRoleKey[] } | null> {
  const session = await readSessionWithKind(sql, kms, keyArn, {
    accessToken: input.accessToken,
    now: input.now,
    kinds: ["operator"],
  });
  if (session === null) {
    return null;
  }

  const activeGrants = await sql<{ role_key: PlatformRoleKey }[]>`
    select role_key
    from identity.operator_grants
    where user_id = ${session.userId}
      and revoked_at is null
      and activated_at is not null
    order by role_key asc
  `;

  if (activeGrants.length === 0) {
    return null;
  }

  return {
    userId: session.userId,
    roles: activeGrants.map((g) => g.role_key),
  };
}

export type RefreshOperatorSessionInput = {
  refreshToken: string;
  now: Date;
};

export async function refreshOperatorSession(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: RefreshOperatorSessionInput,
): Promise<SessionTokens | null> {
  return refreshSession(sql, kms, keyArn, {
    refreshToken: input.refreshToken,
    now: input.now,
    kinds: ["operator"],
    check: async (tx, row) => {
      if (
        row.absoluteExpiresAt === null ||
        input.now.getTime() >= row.absoluteExpiresAt.getTime()
      ) {
        return false;
      }
      await lockOperatorUser(tx, row.userId);
      const [activeGrant] = await tx<{ id: string }[]>`
        select id
        from identity.operator_grants
        where user_id = ${row.userId}
          and revoked_at is null
          and activated_at is not null
        limit 1
      `;
      return activeGrant !== undefined;
    },
  });
}

export type EndOperatorSessionInput = {
  accessToken: string;
  now: Date;
  requestId?: string | undefined;
};

export async function endOperatorSession(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: EndOperatorSessionInput,
): Promise<void> {
  const accessHash = await sessionAccessHash(sql, kms, keyArn, input.accessToken);
  if (accessHash === null) {
    return;
  }

  const rows = await sql<{ id: string; user_id: string; refresh_family: string }[]>`
    select id, user_id, refresh_family
    from identity.sessions
    where access_hash = ${accessHash}
      and kind = 'operator'
    limit 1
  `;
  const row = rows[0];
  if (row === undefined) {
    return;
  }

  const nowIso = input.now.toISOString();
  await sql.begin(async (tx) => {
    await tx`
      select pg_advisory_xact_lock(hashtextextended('family:' || ${row.refresh_family}::text, 0))
    `;
    const revoked = await tx<{ id: string }[]>`
      update identity.sessions
      set revoked_at = ${nowIso}::timestamptz
      where refresh_family = ${row.refresh_family}
        and revoked_at is null
      returning id
    `;
    if (revoked.length > 0) {
      await appendOperatorEvent(tx, {
        userId: row.user_id,
        action: "signed_out",
        requestId: input.requestId,
        now: input.now,
      });
    }
  });
}
