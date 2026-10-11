import { IdentityError } from "./error.js";

export type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

export function encodeCbor(value: Cbor): Uint8Array {
  return encode(value);
}

export function decodeCbor(bytes: Uint8Array): Cbor {
  const read = readValue(bytes, 0, 1);
  if (read.offset !== bytes.byteLength) {
    throw new IdentityError("invalid_ceremony");
  }
  return read.value;
}

export function decodeCoseEc2(bytes: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  const value = decodeCbor(bytes);
  if (!(value instanceof Map)) {
    throw new IdentityError("invalid_ceremony");
  }
  const kty = value.get(1);
  const alg = value.get(3);
  const crv = value.get(-1);
  const x = value.get(-2);
  const y = value.get(-3);
  if (value.size !== 5 || kty !== 2 || alg !== -7 || crv !== 1) {
    throw new IdentityError("invalid_ceremony");
  }
  if (!(x instanceof Uint8Array) || x.byteLength !== 32) {
    throw new IdentityError("invalid_ceremony");
  }
  if (!(y instanceof Uint8Array) || y.byteLength !== 32) {
    throw new IdentityError("invalid_ceremony");
  }
  return { x, y };
}

function encode(value: Cbor): Uint8Array {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new IdentityError("invalid_ceremony");
    }
    if (value >= 0) {
      return header(0, value);
    }
    return header(1, -1 - value);
  }
  if (typeof value === "string") {
    const data = new TextEncoder().encode(value);
    return concat([header(3, data.byteLength), data]);
  }
  if (value instanceof Uint8Array) {
    return concat([header(2, value.byteLength), value]);
  }
  if (Array.isArray(value)) {
    return concat([header(4, value.length), ...value.map((item) => encode(item))]);
  }
  if (value instanceof Map) {
    const parts = [header(5, value.size)];
    for (const [key, item] of value) {
      parts.push(encode(key), encode(item));
    }
    return concat(parts);
  }
  throw new IdentityError("invalid_ceremony");
}

function header(major: number, value: number): Uint8Array {
  if (value < 24) {
    return Uint8Array.of((major << 5) | value);
  }
  if (value < 256) {
    return Uint8Array.of((major << 5) | 24, value);
  }
  if (value < 65536) {
    return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  }
  if (value < 2 ** 32) {
    const out = new Uint8Array(5);
    out[0] = (major << 5) | 26;
    new DataView(out.buffer).setUint32(1, value);
    return out;
  }
  throw new IdentityError("invalid_ceremony");
}

function readValue(
  bytes: Uint8Array,
  offset: number,
  depth: number,
): { value: Cbor; offset: number } {
  const initial = bytes[offset];
  if (initial === undefined) {
    throw new IdentityError("invalid_ceremony");
  }
  const major = initial >> 5;
  const info = initial & 0x1f;
  const argument = readArgument(bytes, info, offset + 1);
  if (major === 0) {
    return { value: argument.value, offset: argument.offset };
  }
  if (major === 1) {
    return { value: -1 - argument.value, offset: argument.offset };
  }
  if (major === 2) {
    const end = argument.offset + argument.value;
    if (end > bytes.byteLength) {
      throw new IdentityError("invalid_ceremony");
    }
    return { value: bytes.slice(argument.offset, end), offset: end };
  }
  if (major === 3) {
    const end = argument.offset + argument.value;
    if (end > bytes.byteLength) {
      throw new IdentityError("invalid_ceremony");
    }
    const data = bytes.slice(argument.offset, end);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new IdentityError("invalid_ceremony");
    }
    return { value: text, offset: end };
  }
  if (major === 4 || major === 5) {
    if (depth > 4) {
      throw new IdentityError("invalid_ceremony");
    }
  }
  if (major === 4) {
    const items: Cbor[] = [];
    let cursor = argument.offset;
    for (let index = 0; index < argument.value; index += 1) {
      const item = readValue(bytes, cursor, depth + 1);
      items.push(item.value);
      cursor = item.offset;
    }
    return { value: items, offset: cursor };
  }
  if (major === 5) {
    const map = new Map<Cbor, Cbor>();
    let cursor = argument.offset;
    for (let index = 0; index < argument.value; index += 1) {
      const key = readValue(bytes, cursor, depth + 1);
      const item = readValue(bytes, key.offset, depth + 1);
      map.set(key.value, item.value);
      cursor = item.offset;
    }
    return { value: map, offset: cursor };
  }
  throw new IdentityError("invalid_ceremony");
}

function readArgument(
  bytes: Uint8Array,
  info: number,
  offset: number,
): { value: number; offset: number } {
  if (info < 24) {
    return { value: info, offset };
  }
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (size === 0 || offset + size > bytes.byteLength) {
    throw new IdentityError("invalid_ceremony");
  }
  let value = 0;
  for (let index = 0; index < size; index += 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  if (!Number.isSafeInteger(value)) {
    throw new IdentityError("invalid_ceremony");
  }
  return { value, offset: offset + size };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
