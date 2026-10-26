const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  LOOKUP[ALPHABET.charCodeAt(i)] = i;
}

export function encode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let result = "";
  const len = u8.length;
  let i = 0;

  for (; i + 2 < len; i += 3) {
    const b0 = u8[i]!;
    const b1 = u8[i + 1]!;
    const b2 = u8[i + 2]!;
    result +=
      ALPHABET[b0 >> 2]! +
      ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]! +
      ALPHABET[((b1 & 15) << 2) | (b2 >> 6)]! +
      ALPHABET[b2 & 63]!;
  }

  if (i < len) {
    const b0 = u8[i]!;
    result += ALPHABET[b0 >> 2]!;
    if (i + 1 < len) {
      const b1 = u8[i + 1]!;
      result += ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]! + ALPHABET[(b1 & 15) << 2]!;
    } else {
      result += ALPHABET[(b0 & 3) << 4]!;
    }
  }

  return result;
}

export function decode(text: string): Uint8Array<ArrayBuffer> {
  let end = text.length;
  while (end > 0 && text[end - 1] === "=") {
    end--;
  }

  const padLen = text.length - end;
  if (padLen > 2) {
    throw new Error("Invalid base64url padding");
  }

  for (let i = 0; i < end; i++) {
    if (text[i] === "=") {
      throw new Error("Invalid base64url character: '=' inside payload");
    }
  }

  const unpadded = text.slice(0, end);
  const len = unpadded.length;
  if (len % 4 === 1) {
    throw new Error("Invalid base64url length");
  }

  for (let i = 0; i < len; i++) {
    const code = unpadded.charCodeAt(i);
    if (code > 255 || LOOKUP[code] === -1) {
      throw new Error(`Invalid base64url character: ${unpadded[i]}`);
    }
  }

  const byteLength = Math.floor((len * 3) / 4);
  const buffer = new ArrayBuffer(byteLength);
  const out = new Uint8Array(buffer);

  let outIdx = 0;
  let i = 0;
  for (; i + 3 < len; i += 4) {
    const c0 = LOOKUP[unpadded.charCodeAt(i)]!;
    const c1 = LOOKUP[unpadded.charCodeAt(i + 1)]!;
    const c2 = LOOKUP[unpadded.charCodeAt(i + 2)]!;
    const c3 = LOOKUP[unpadded.charCodeAt(i + 3)]!;

    out[outIdx++] = (c0 << 2) | (c1 >> 4);
    out[outIdx++] = ((c1 & 15) << 4) | (c2 >> 2);
    out[outIdx++] = ((c2 & 3) << 6) | c3;
  }

  const rem = len - i;
  if (rem === 2) {
    const c0 = LOOKUP[unpadded.charCodeAt(i)]!;
    const c1 = LOOKUP[unpadded.charCodeAt(i + 1)]!;
    out[outIdx++] = (c0 << 2) | (c1 >> 4);
  } else if (rem === 3) {
    const c0 = LOOKUP[unpadded.charCodeAt(i)]!;
    const c1 = LOOKUP[unpadded.charCodeAt(i + 1)]!;
    const c2 = LOOKUP[unpadded.charCodeAt(i + 2)]!;
    out[outIdx++] = (c0 << 2) | (c1 >> 4);
    out[outIdx++] = ((c1 & 15) << 4) | (c2 >> 2);
  }

  return out;
}
