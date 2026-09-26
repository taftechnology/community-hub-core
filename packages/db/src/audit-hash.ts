export type AuditActorKind = "user" | "support" | "system";

export type AuditHashInput = {
  hashVersion: 1;
  orgId: string;
  id: string;
  seq: bigint;
  prevHash: Uint8Array; // 32 bytes
  actorKind: AuditActorKind;
  actorId: string | null; // null only for system; encoded as length 0
  action: string;
  targetIds: readonly string[];
  purpose: string;
  requestId: string;
  occurredAtMicros: bigint; // never a Date
};

const textEncoder = new TextEncoder();

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  if (hex.length !== 32) {
    throw new Error(`invalid uuid: ${uuid}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function uint64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let n = value;
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function appendField(chunks: Uint8Array[], bytes: Uint8Array): void {
  const len = new Uint8Array(4);
  const view = new DataView(len.buffer);
  view.setUint32(0, bytes.length, false);
  chunks.push(len, bytes);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function auditEventPreimage(input: AuditHashInput): Uint8Array {
  if (input.hashVersion !== 1) {
    throw new Error(`unsupported hash_version: ${String(input.hashVersion)}`);
  }
  if (input.prevHash.length !== 32) {
    throw new Error("prevHash must be 32 bytes");
  }

  const chunks: Uint8Array[] = [new Uint8Array([0x01])];

  // 1 org_id, 2 id, 3 seq, 4 prev_hash, 5 actor_kind, 6 actor_id,
  // 7 action, 8 target_ids, 9 purpose, 10 request_id, 11 occurred_at
  appendField(chunks, uuidToBytes(input.orgId));
  appendField(chunks, uuidToBytes(input.id));
  appendField(chunks, uint64be(input.seq));
  appendField(chunks, input.prevHash);
  appendField(chunks, textEncoder.encode(input.actorKind));
  appendField(chunks, input.actorId === null ? new Uint8Array(0) : uuidToBytes(input.actorId));
  appendField(chunks, textEncoder.encode(input.action));
  appendField(
    chunks,
    input.targetIds.length === 0
      ? new Uint8Array(0)
      : concat(input.targetIds.map((id) => uuidToBytes(id))),
  );
  appendField(chunks, textEncoder.encode(input.purpose));
  appendField(chunks, uuidToBytes(input.requestId));
  appendField(chunks, uint64be(input.occurredAtMicros));

  return concat(chunks);
}

export async function auditEventHash(input: AuditHashInput): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", auditEventPreimage(input));
  return new Uint8Array(digest);
}
