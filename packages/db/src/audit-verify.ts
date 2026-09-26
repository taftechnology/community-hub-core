import { auditEventHash, type AuditActorKind } from "./audit-hash.js";
import type { OrgTransaction } from "./tx.js";

type AuditRow = {
  id: string;
  org_id: string;
  seq: string;
  hash_version: number;
  prev_hash: Uint8Array | Buffer | string;
  hash: Uint8Array | Buffer | string;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  target_ids: string[] | null;
  purpose: string;
  request_id: string;
  occurred_at_micros: string;
};

function asBytes(value: Uint8Array | Buffer | string): Uint8Array {
  if (typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function chainBroken(seq: string): Error {
  return new Error(`audit.chain.broken seq ${seq}`);
}

export async function verifyAuditChain(tx: OrgTransaction): Promise<void> {
  const rows = await tx<AuditRow[]>`
    select
      id::text,
      org_id::text,
      seq::text,
      hash_version,
      prev_hash,
      hash,
      actor_kind,
      actor_id::text,
      action,
      coalesce(target_ids::text[], '{}'::text[]) as target_ids,
      purpose,
      request_id::text,
      trunc(extract(epoch from occurred_at) * 1000000)::bigint::text as occurred_at_micros
    from app.audit_events
    order by seq
  `;

  const zeroPrev = new Uint8Array(32);
  let previousHash: Uint8Array | null = null;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const expectedSeq = String(i + 1);
    if (row.seq !== expectedSeq) {
      throw chainBroken(row.seq);
    }

    const prevHash = asBytes(row.prev_hash);
    const hash = asBytes(row.hash);

    if (i === 0) {
      if (!equalBytes(prevHash, zeroPrev)) {
        throw chainBroken(row.seq);
      }
    } else if (previousHash === null || !equalBytes(prevHash, previousHash)) {
      throw chainBroken(row.seq);
    }

    if (row.hash_version !== 1) {
      throw chainBroken(row.seq);
    }

    const expected = await auditEventHash({
      hashVersion: 1,
      orgId: row.org_id,
      id: row.id,
      seq: BigInt(row.seq),
      prevHash,
      actorKind: row.actor_kind as AuditActorKind,
      actorId: row.actor_id,
      action: row.action,
      targetIds: row.target_ids ?? [],
      purpose: row.purpose,
      requestId: row.request_id,
      occurredAtMicros: BigInt(row.occurred_at_micros),
    });

    if (!equalBytes(hash, expected)) {
      throw chainBroken(row.seq);
    }

    previousHash = hash;
  }
}
