import type { webcrypto } from "node:crypto";

export async function hmac(
  key: webcrypto.CryptoKey,
  label: string,
  message: Uint8Array,
): Promise<Uint8Array> {
  if (label.includes("\0")) {
    throw new Error("label must not contain NUL");
  }
  const labelBytes = new TextEncoder().encode(label);
  const input = new Uint8Array(labelBytes.byteLength + 1 + message.byteLength);
  input.set(labelBytes, 0);
  input[labelBytes.byteLength] = 0x00;
  input.set(message, labelBytes.byteLength + 1);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
}
