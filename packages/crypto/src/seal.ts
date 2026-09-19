import {
  buildEnvelope,
  encodeGcmAad,
  ENVELOPE_VERSION,
  IV_LENGTH,
  KEY_ID_LENGTH,
} from "./envelope.js";

export async function aes256GcmEncrypt(
  key: CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      plaintext,
    ),
  );
}

export async function aes256GcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertextAndTag: Uint8Array,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData, tagLength: 128 },
        key,
        ciphertextAndTag,
      ),
    );
  } catch {
    throw new DOMException("decryption failed", "OperationError");
  }
}

export async function sealWith(opts: {
  key: CryptoKey;
  plaintext: Uint8Array;
  keyId: Uint8Array;
  iv: Uint8Array;
  boundFields: Uint8Array;
}): Promise<Uint8Array> {
  if (opts.keyId.byteLength !== KEY_ID_LENGTH) {
    throw new Error("key id must be 16 bytes");
  }
  if (opts.iv.byteLength !== IV_LENGTH) {
    throw new Error("iv must be 12 bytes");
  }
  const additionalData = encodeGcmAad(ENVELOPE_VERSION, opts.keyId, opts.boundFields);
  const sealed = await aes256GcmEncrypt(opts.key, opts.iv, opts.plaintext, additionalData);
  return buildEnvelope(opts.keyId, opts.iv, sealed);
}
