import { importHkdfKey } from "./hkdf.js";
import type { KmsContext, KmsPort } from "./kms-port.js";

export type { KmsContext, KmsPort };

export async function generateKmsRoot(
  port: KmsPort,
  keyId: string,
  context: KmsContext,
): Promise<{ blob: Uint8Array; hkdfKey: CryptoKey }> {
  const { plaintext, blob } = await port.generateDataKey(keyId, context);
  try {
    const hkdfKey = await importHkdfKey(plaintext);
    return { blob, hkdfKey };
  } finally {
    plaintext.fill(0);
  }
}

export async function unwrapKmsRoot(
  port: KmsPort,
  keyId: string,
  blob: Uint8Array,
  context: KmsContext,
): Promise<CryptoKey> {
  const plaintext = await port.decrypt(keyId, blob, context);
  try {
    return await importHkdfKey(plaintext);
  } finally {
    plaintext.fill(0);
  }
}
