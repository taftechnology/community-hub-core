import type { Ciphertext } from "@community-hub/crypto";

export function run(bytes: Uint8Array): Ciphertext {
  const once = bytes as Ciphertext;
  const twice = bytes as unknown as Ciphertext;
  return twice ?? once;
}
