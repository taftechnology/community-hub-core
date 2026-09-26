import { getRequestContext } from "@community-hub/kernel";
import { isAuditAction, isAuditPurpose } from "@community-hub/kernel/module";

import type { AuditActorKind } from "./audit-hash.js";
import { newId } from "./ids.js";
import type { OrgTransaction } from "./tx.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEQ_UNIQUE = "audit_events_org_id_seq_unique";
const MAX_ATTEMPTS = 5;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isSeqUniqueConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const err = error as { code?: string; constraint_name?: string };
  return err.code === "23505" && err.constraint_name === SEQ_UNIQUE;
}

export async function insertWithSeqRetry(
  attempt: () => Promise<{ id: string; seq: string }>,
): Promise<{ id: string; seq: string }> {
  let lastError: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isSeqUniqueConflict(error)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

function assertActorPair(actorKind: AuditActorKind, actorId: string | null): void {
  if (actorKind === "system") {
    if (actorId !== null) {
      throw new Error("system actor must have a null actorId");
    }
    return;
  }
  if (actorId === null || !isUuid(actorId)) {
    throw new Error(`${actorKind} actor requires a UUID actorId`);
  }
}

function assertTargetIds(targetIds: readonly string[]): void {
  for (let i = 0; i < targetIds.length; i += 1) {
    const id = targetIds[i];
    if (id == null || !isUuid(id)) {
      throw new Error("targetIds must be UUIDs with no null entries");
    }
  }
}

export async function appendAuditEvent(
  tx: OrgTransaction,
  input: {
    actorKind: AuditActorKind;
    actorId: string | null;
    action: string;
    purpose: string;
    targetIds: readonly string[];
  },
  hooks?: { onAttempt?: () => void },
): Promise<{ id: string; seq: string }> {
  const { requestId } = getRequestContext();
  if (!isUuid(requestId)) {
    throw new Error("requestId must be a UUID");
  }
  if (!isAuditAction(input.action)) {
    throw new Error(`unregistered audit action: ${input.action}`);
  }
  if (!isAuditPurpose(input.purpose)) {
    throw new Error(`unregistered audit purpose: ${input.purpose}`);
  }
  assertActorPair(input.actorKind, input.actorId);
  assertTargetIds(input.targetIds);

  const isolationRows = await tx<{ isolation: string }[]>`
    select current_setting('transaction_isolation') as isolation
  `;
  const isolation = isolationRows[0]?.isolation;
  if (isolation !== "read committed") {
    throw new Error(`audit append requires read committed, got ${isolation ?? "unknown"}`);
  }

  const targetIds = [...input.targetIds];

  // Use postgres.js savepoint() so a 23505 is scoped to an inner handler.
  // Raw SAVEPOINT SQL still sets the outer transaction's uncaughtError, and
  // begin() rethrows it after a successful retry (poisoning the commit).
  return insertWithSeqRetry(async () => {
    return tx.savepoint("audit_append", async (sp) => {
      hooks?.onAttempt?.();
      const id = newId();
      const rows = await sp<{ id: string; seq: string }[]>`
        insert into app.audit_events (
          id, actor_kind, actor_id, action, target_ids, purpose, request_id
        ) values (
          ${id}::uuid,
          ${input.actorKind},
          ${input.actorId},
          ${input.action},
          ${targetIds}::uuid[],
          ${input.purpose},
          ${requestId}::uuid
        )
        returning id::text, seq::text
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new Error("audit append returned no row");
      }
      return { id: row.id, seq: row.seq };
    });
  });
}
