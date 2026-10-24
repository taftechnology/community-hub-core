import type { KmsPort } from "@community-hub/crypto";
import { newId } from "@community-hub/db";
import type { Sql, TransactionSql } from "postgres";

import { normaliseEnrolmentCode } from "../domain/enrolment-code.js";
import { IdentityError } from "../domain/error.js";
import { isPlatformRoleKey, type PlatformRoleKey } from "../domain/platform-roles.js";
import { deriveIdentityEmailKeys } from "./email-lookup.js";
import { hmac } from "./hmac.js";

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

export async function lockOperatorUser(tx: TransactionSql, userId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('operator:' || ${userId}::text, 0))`;
}

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
