import {
  blindIndex,
  decrypt,
  deriveKeys,
  encrypt,
  unwrapKmsRoot,
  type KmsPort,
} from "@community-hub/crypto";
import type { Sql } from "postgres";

import { normaliseEmail } from "../domain/email.js";
import { IdentityError } from "../domain/error.js";
import { emailBlindIndex } from "./email-lookup.js";

const CONTEXT = { key_kind: "identity", region: "au", key_version: "1" } as const;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function isDedupeConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === "invitation_emails_dedupe_key_unique"
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

async function loadIdentityKeys(sql: Sql, kms: KmsPort, keyArn: string) {
  const keys = await sql<{ id: string; wrapped: Uint8Array }[]>`
    select id, wrapped from identity.identity_keys where region = 'au' limit 1
  `;
  const key = keys[0];
  if (key === undefined) {
    throw new Error("identity key is missing");
  }

  const hkdfKey = await unwrapKmsRoot(kms, keyArn, key.wrapped, CONTEXT);
  const { enc, bidx } = await deriveKeys(hkdfKey);
  return { keyId: key.id, enc, bidx };
}

export async function createInvitationEmail(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  input: {
    invitationId: string;
    communityId: string;
    address: string;
    expiresAt: Date;
  },
): Promise<{ ok: true } | { ok: false; reason: "already_invited" }> {
  const normalised = normaliseEmail(input.address);
  if (!UUID_REGEX.test(input.invitationId) || !UUID_REGEX.test(input.communityId)) {
    throw new IdentityError("invalid_input");
  }

  const { keyId, enc, bidx } = await loadIdentityKeys(sql, kms, keyArn);

  const ciphertext = await encrypt(enc, new TextEncoder().encode(normalised), uuidToBytes(keyId), {
    tag: "chub/field-identity/v1",
    label: "identity.invitation_emails.email",
    rowId: uuidToBytes(input.invitationId),
    region: "au",
  });
  const emailBytes: Uint8Array = ciphertext;

  const emailBidx = await emailBlindIndex(bidx, normalised);

  const dedupePayload = new TextEncoder().encode(
    `${input.communityId.toLowerCase()}\n${normalised}`,
  );
  const dedupeIndex = await blindIndex(bidx, "identity.invitation_emails.dedupe", dedupePayload);
  const dedupeKey: Uint8Array = dedupeIndex;

  try {
    await sql.begin(async (tx) => {
      await tx`
        update identity.invitation_emails
        set email = null, email_bidx = null, dedupe_key = null
        where dedupe_key = ${dedupeKey}
          and (expires_at <= now() or closed_at is not null)
      `;
      await tx`
        insert into identity.invitation_emails (
          invitation_id, region, email, email_bidx, dedupe_key, expires_at, created_at
        )
        values (
          ${input.invitationId}, 'au', ${emailBytes}, ${emailBidx}, ${dedupeKey}, ${input.expiresAt}, now()
        )
      `;
    });
    return { ok: true };
  } catch (error) {
    if (isDedupeConflict(error)) {
      return { ok: false, reason: "already_invited" };
    }
    throw error;
  }
}

export async function refreshInvitationEmail(
  sql: Sql,
  input: { invitationId: string; expiresAt: Date },
): Promise<boolean> {
  const result = await sql`
    update identity.invitation_emails
    set expires_at = ${input.expiresAt}
    where invitation_id = ${input.invitationId}
      and closed_at is null
      and expires_at > now()
      and email is not null
  `;
  return result.count > 0;
}

export async function openInvitationEmails(
  sql: Sql,
  kms: KmsPort,
  keyArn: string,
  invitationIds: readonly string[],
): Promise<Map<string, string>> {
  if (invitationIds.length > 100) {
    throw new IdentityError("invalid_input");
  }

  if (invitationIds.length === 0) {
    return new Map();
  }

  for (const id of invitationIds) {
    if (typeof id !== "string" || !UUID_REGEX.test(id)) {
      throw new IdentityError("invalid_input");
    }
  }

  const { enc } = await loadIdentityKeys(sql, kms, keyArn);

  const rows = await sql<{ invitation_id: string; email: Uint8Array }[]>`
    select invitation_id, email
    from identity.invitation_emails
    where invitation_id = any(${invitationIds}::uuid[])
      and closed_at is null
      and expires_at > now()
      and email is not null
  `;

  const result = new Map<string, string>();
  for (const row of rows) {
    const plaintext = await decrypt(row.email as never, () => enc, {
      tag: "chub/field-identity/v1",
      label: "identity.invitation_emails.email",
      rowId: uuidToBytes(row.invitation_id),
      region: "au",
    });
    result.set(row.invitation_id, new TextDecoder().decode(plaintext));
  }

  return result;
}

export async function invitationAddressMatches(
  sql: Sql,
  input: { invitationId: string; userId: string },
): Promise<boolean> {
  if (!UUID_REGEX.test(input.invitationId) || !UUID_REGEX.test(input.userId)) {
    return false;
  }

  const rows = await sql<{ matches: boolean }[]>`
    select exists (
      select 1
      from identity.invitation_emails ie
      join identity.users u on u.id = ${input.userId}::uuid
      where ie.invitation_id = ${input.invitationId}::uuid
        and ie.closed_at is null
        and ie.expires_at > now()
        and ie.email_bidx is not null
        and ie.email_bidx = u.email_bidx
    ) as matches
  `;

  return Boolean(rows[0]?.matches);
}

export async function closeInvitationEmail(sql: Sql, invitationId: string): Promise<void> {
  if (!UUID_REGEX.test(invitationId)) {
    throw new IdentityError("invalid_input");
  }

  await sql`
    update identity.invitation_emails
    set email = null,
        email_bidx = null,
        dedupe_key = null,
        closed_at = coalesce(closed_at, now())
    where invitation_id = ${invitationId}::uuid
  `;
}

export async function sweepInvitationEmails(
  sql: Sql,
  now: Date,
): Promise<{ erased: number; deleted: number }> {
  const rows = await sql<{ erased: number; deleted: number }[]>`
    with to_delete as (
      select invitation_id
      from identity.invitation_emails
      where coalesce(closed_at, expires_at) < ${now}::timestamptz - interval '30 days'
      order by coalesce(closed_at, expires_at) asc
      limit 500
      for update skip locked
    ),
    deleted as (
      delete from identity.invitation_emails
      where invitation_id in (select invitation_id from to_delete)
      returning 1
    ),
    to_erase as (
      select invitation_id
      from identity.invitation_emails
      where expires_at <= ${now}
        and email is not null
        and invitation_id not in (select invitation_id from to_delete)
      order by expires_at asc
      limit 500
      for update skip locked
    ),
    erased as (
      update identity.invitation_emails
      set email = null, email_bidx = null, dedupe_key = null
      where invitation_id in (select invitation_id from to_erase)
      returning 1
    )
    select
      (select count(*)::int from erased) as erased,
      (select count(*)::int from deleted) as deleted
  `;

  return {
    erased: Number(rows[0]?.erased ?? 0),
    deleted: Number(rows[0]?.deleted ?? 0),
  };
}
