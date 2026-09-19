import type { Ciphertext, KmsContext, KmsPort } from "@community-hub/crypto";

export async function hold(blob: Ciphertext): Promise<Ciphertext> {
  return blob as Ciphertext;
}

export async function unwrap(
  port: KmsPort,
  keyId: string,
  blob: Uint8Array,
  context: KmsContext,
): Promise<Uint8Array> {
  return port.decrypt(keyId, blob, context);
}
