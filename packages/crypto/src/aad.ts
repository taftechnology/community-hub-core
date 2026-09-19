export type CommunityFieldAad = {
  tag: "chub/field/v1";
  label: string;
  rowId: Uint8Array;
  communityId: Uint8Array;
};

export type IdentityFieldAad = {
  tag: "chub/field-identity/v1";
  label: string;
  rowId: Uint8Array;
  region: string;
};

export type WrapAad = {
  tag: "chub/wrap/v1";
  childKind: "community" | "household";
  childId: Uint8Array;
  childKeyId: Uint8Array;
  parentKeyId: Uint8Array;
};

const ROW_ID_LENGTH = 16;
const COMMUNITY_ID_LENGTH = 16;

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

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function u32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, value, false);
  return bytes;
}

export function encodeLengthPrefixed(fields: readonly Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const field of fields) {
    parts.push(u32be(field.byteLength), field);
  }
  return concat(parts);
}

function assertNoNul(label: string): void {
  if (label.includes("\0")) {
    throw new Error("label must not contain NUL");
  }
}

function assertRowId(rowId: Uint8Array): void {
  if (rowId.byteLength !== ROW_ID_LENGTH) {
    throw new Error("row id must be 16 bytes");
  }
}

export function encodeAad(aad: CommunityFieldAad | IdentityFieldAad | WrapAad): Uint8Array {
  if (aad.tag === "chub/wrap/v1") {
    assertRowId(aad.childId);
    assertRowId(aad.childKeyId);
    assertRowId(aad.parentKeyId);
    return encodeLengthPrefixed([
      utf8(aad.tag),
      utf8(aad.childKind),
      aad.childId,
      aad.childKeyId,
      aad.parentKeyId,
    ]);
  }
  assertNoNul(aad.label);
  assertRowId(aad.rowId);
  if (aad.tag === "chub/field/v1") {
    if (aad.communityId?.byteLength !== COMMUNITY_ID_LENGTH) {
      throw new Error("community id must be 16 bytes");
    }
    return encodeLengthPrefixed([utf8(aad.tag), utf8(aad.label), aad.rowId, aad.communityId]);
  }
  return encodeLengthPrefixed([utf8(aad.tag), utf8(aad.label), aad.rowId, utf8(aad.region)]);
}
