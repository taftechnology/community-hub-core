import { encodeAad, type WrapAad } from "./aad.js";
import {
  encodeGcmAad,
  ENVELOPE_VERSION,
  IV_LENGTH,
  KEY_ID_LENGTH,
  parseEnvelope,
} from "./envelope.js";
import { importHkdfKey } from "./hkdf.js";
import { aes256GcmDecrypt, sealWith } from "./seal.js";

export type { WrapAad };

const ROOT_LENGTH = 32;

function unwrapFailed(): never {
  throw new DOMException("decryption failed", "OperationError");
}

export async function generateAndWrap(
  parentWrapKey: CryptoKey,
  aad: WrapAad,
): Promise<{ blob: Uint8Array; childHkdfKey: CryptoKey }> {
  if (aad.childKeyId.byteLength !== KEY_ID_LENGTH) {
    throw new Error("key id must be 16 bytes");
  }
  const root = crypto.getRandomValues(new Uint8Array(ROOT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const blob = await sealWith({
    key: parentWrapKey,
    plaintext: root,
    keyId: aad.childKeyId,
    iv,
    boundFields: encodeAad(aad),
  });
  const childHkdfKey = await importHkdfKey(root);
  root.fill(0);
  return { blob, childHkdfKey };
}

export async function unwrapKey(
  blob: Uint8Array,
  parentWrapKey: CryptoKey,
  aad: WrapAad,
): Promise<CryptoKey> {
  const parsed = parseEnvelope(blob);
  if (parsed.version !== ENVELOPE_VERSION) {
    unwrapFailed();
  }
  const boundFields = encodeAad(aad);
  const additionalData = encodeGcmAad(parsed.version, parsed.keyId, boundFields);
  const root = await aes256GcmDecrypt(
    parentWrapKey,
    parsed.iv,
    parsed.ciphertextAndTag,
    additionalData,
  );
  const childHkdfKey = await importHkdfKey(root);
  root.fill(0);
  return childHkdfKey;
}
