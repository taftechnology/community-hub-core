import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RAW_BASE32 = /^[A-Z2-7]+$/;
const ASCII_SIX_DIGITS = /^[0-9]{6}$/;
const TOTP_KEY_BYTES = 20;
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const OTPAUTH_ISSUER_AND_LABEL = "Community%20Hub";

/**
 * Generates a fresh 20-byte (160-bit) TOTP secret key.
 */
export function newTotpKey(): Uint8Array {
  return new Uint8Array(randomBytes(TOTP_KEY_BYTES));
}

/**
 * Encodes bytes as unpadded upper-case RFC 4648 base32.
 */
export function base32Encode(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    return "";
  }
  let buffer = 0;
  let bitsLeft = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      encoded += BASE32_ALPHABET.charAt((buffer >>> bitsLeft) & 0x1f);
    }
  }
  if (bitsLeft > 0) {
    encoded += BASE32_ALPHABET.charAt((buffer << (5 - bitsLeft)) & 0x1f);
  }
  return encoded;
}

/**
 * Decodes unpadded upper-case RFC 4648 base32; returns null on invalid input.
 */
export function base32Decode(text: string): Uint8Array | null {
  if (text.length === 0) {
    return new Uint8Array(0);
  }
  if (!RAW_BASE32.test(text)) {
    return null;
  }
  const remainder = text.length % 8;
  if (remainder === 1 || remainder === 3 || remainder === 6) {
    return null;
  }
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bitsLeft = 0;
  let outIndex = 0;
  for (let i = 0; i < text.length; i += 1) {
    const value = BASE32_ALPHABET.indexOf(text.charAt(i));
    buffer = (buffer << 5) | value;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      out[outIndex] = (buffer >>> bitsLeft) & 0xff;
      outIndex += 1;
    }
  }
  if ((buffer & ((1 << bitsLeft) - 1)) !== 0) {
    return null;
  }
  return out;
}

/**
 * Computes the 30-second TOTP counter step for a timestamp.
 */
export function stepAt(now: Date): number {
  const ms = now.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError("Timestamp must be a valid Date");
  }
  const epochSeconds = Math.floor(ms / 1000);
  return Math.floor(epochSeconds / TOTP_STEP_SECONDS);
}

/**
 * Computes the 6-digit zero-padded RFC 6238 HMAC-SHA1 code for a given counter step.
 */
export function totpCode(key: Uint8Array, step: number): string {
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new RangeError("TOTP step must be a non-negative safe integer");
  }
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step), false);
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  const otp = binary % 10 ** TOTP_DIGITS;
  return String(otp).padStart(TOTP_DIGITS, "0");
}

/**
 * Verifies a 6-digit TOTP code against steps t-1, t, and t+1 using constant-time comparison.
 * Returns the matched step or null.
 */
export function verifyTotp(key: Uint8Array, code: string, now: Date): number | null {
  if (!ASCII_SIX_DIGITS.test(code)) {
    return null;
  }
  const step = stepAt(now);
  const input = new TextEncoder().encode(code);
  const windowSteps = 1;
  let matched: number | null = null;
  for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
    const candidateStep = step + offset;
    if (candidateStep < 0) {
      continue;
    }
    const expected = new TextEncoder().encode(totpCode(key, candidateStep));
    if (
      expected.byteLength === input.byteLength &&
      timingSafeEqual(expected, input) &&
      matched === null
    ) {
      matched = candidateStep;
    }
  }
  return matched;
}

/**
 * Builds the otpauth:// provisioning URI with label and issuer fixed to "Community Hub".
 */
export function otpauthUri(key: Uint8Array): string {
  const secret = base32Encode(key);
  const params = [
    `secret=${secret}`,
    `issuer=${OTPAUTH_ISSUER_AND_LABEL}`,
    "algorithm=SHA1",
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_STEP_SECONDS}`,
  ].join("&");
  return `otpauth://totp/${OTPAUTH_ISSUER_AND_LABEL}?${params}`;
}
