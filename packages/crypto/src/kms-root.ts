import type { webcrypto } from "node:crypto";

import { importHkdfKey } from "./hkdf.js";
import type { KmsContext, KmsPort } from "./kms-port.js";

export type { KmsContext, KmsPort };

const ROOT_LENGTH = 32;

function assertRootLength(bytes: Uint8Array): void {
  if (bytes.byteLength !== ROOT_LENGTH) {
    throw new Error("root must be 32 bytes");
  }
}

export async function generateKmsRoot(
  port: KmsPort,
  keyId: string,
  context: KmsContext,
): Promise<{ blob: Uint8Array; hkdfKey: webcrypto.CryptoKey }> {
  const { plaintext, blob } = await port.generateDataKey(keyId, context);
  try {
    assertRootLength(plaintext);
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
): Promise<webcrypto.CryptoKey> {
  const plaintext = await port.decrypt(keyId, blob, context);
  try {
    assertRootLength(plaintext);
    return await importHkdfKey(plaintext);
  } finally {
    plaintext.fill(0);
  }
}
