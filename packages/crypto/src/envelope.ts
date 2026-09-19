export const ENVELOPE_VERSION = 0x01;
export const KEY_ID_LENGTH = 16;
export const IV_LENGTH = 12;
export const TAG_LENGTH = 16;

const HEADER_LENGTH = 1 + KEY_ID_LENGTH + IV_LENGTH;
const MIN_ENVELOPE_LENGTH = HEADER_LENGTH + TAG_LENGTH;

export type ParsedEnvelope = {
  version: number;
  keyId: Uint8Array;
  iv: Uint8Array;
  ciphertextAndTag: Uint8Array;
};

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function decryptFailed(): never {
  throw new DOMException("decryption failed", "OperationError");
}

export function encodeGcmAad(
  version: number,
  keyId: Uint8Array,
  boundFields: Uint8Array,
): Uint8Array {
  return concat([new Uint8Array([version]), keyId, boundFields]);
}

export function buildEnvelope(
  keyId: Uint8Array,
  iv: Uint8Array,
  ciphertextAndTag: Uint8Array,
): Uint8Array {
  return concat([new Uint8Array([ENVELOPE_VERSION]), keyId, iv, ciphertextAndTag]);
}

export function parseEnvelope(blob: Uint8Array): ParsedEnvelope {
  if (blob.byteLength < MIN_ENVELOPE_LENGTH) {
    decryptFailed();
  }
  const version = blob[0];
  if (version === undefined) {
    decryptFailed();
  }
  return {
    version,
    keyId: blob.subarray(1, 1 + KEY_ID_LENGTH),
    iv: blob.subarray(1 + KEY_ID_LENGTH, HEADER_LENGTH),
    ciphertextAndTag: blob.subarray(HEADER_LENGTH),
  };
}
