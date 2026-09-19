import { encodeAad, type CommunityFieldAad, type IdentityFieldAad } from "./aad.js";
import {
  encodeGcmAad,
  ENVELOPE_VERSION,
  IV_LENGTH,
  KEY_ID_LENGTH,
  parseEnvelope,
} from "./envelope.js";
import { aes256GcmDecrypt, sealWith } from "./seal.js";

export type Ciphertext = Uint8Array & { readonly __ciphertext: unique symbol };

function decryptFailed(): never {
  throw new DOMException("decryption failed", "OperationError");
}

export async function encrypt(
  encKey: CryptoKey,
  plaintext: Uint8Array,
  keyId: Uint8Array,
  aad: CommunityFieldAad | IdentityFieldAad,
): Promise<Ciphertext> {
  if (keyId.byteLength !== KEY_ID_LENGTH) {
    throw new Error("key id must be 16 bytes");
  }
  const boundFields = encodeAad(aad);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const blob = await sealWith({
    key: encKey,
    plaintext,
    keyId,
    iv,
    boundFields,
  });
  return blob as Ciphertext;
}

export async function decrypt(
  blob: Ciphertext,
  resolveEncKey: (keyId: Uint8Array) => CryptoKey | Promise<CryptoKey>,
  aad: CommunityFieldAad | IdentityFieldAad,
): Promise<Uint8Array> {
  const parsed = parseEnvelope(blob);
  if (parsed.version !== ENVELOPE_VERSION) {
    decryptFailed();
  }
  const boundFields = encodeAad(aad);
  const additionalData = encodeGcmAad(parsed.version, parsed.keyId, boundFields);
  const key = await resolveEncKey(parsed.keyId);
  return aes256GcmDecrypt(key, parsed.iv, parsed.ciphertextAndTag, additionalData);
}
