import { encodeLengthPrefixed } from "./aad.js";
import { IV_LENGTH } from "./envelope.js";
import type { KmsContext, KmsPort } from "./kms-port.js";
import { aes256GcmDecrypt, aes256GcmEncrypt, sealWith as productionSealWith } from "./seal.js";

export type { KmsContext, KmsPort };

const ROOT_LENGTH = 32;
const TAG_LENGTH = 16;
const MIN_BLOB_LENGTH = IV_LENGTH + TAG_LENGTH;
const ORG_KEYS = new Set(["key_kind", "org_id", "key_version"]);
const IDENTITY_KEYS = new Set(["key_kind", "region", "key_version"]);

const utf8 = (value: string) => new TextEncoder().encode(value);

function invalidContext(): never {
  throw new Error("invalid KMS context");
}

function decryptFailed(): never {
  throw new DOMException("decryption failed", "OperationError");
}

type CanonicalKmsContext =
  | { key_kind: "org"; org_id: string; key_version: string }
  | { key_kind: "identity"; region: string; key_version: string };

function assertKmsContext(context: KmsContext): CanonicalKmsContext {
  if (context === null || typeof context !== "object") {
    invalidContext();
  }
  const rec = context as Record<string, unknown>;
  const keys = Object.keys(rec);
  const hasOrgId = Object.hasOwn(rec, "org_id");
  const hasRegion = Object.hasOwn(rec, "region");
  if (hasOrgId && hasRegion) {
    invalidContext();
  }
  if (!hasOrgId && !hasRegion) {
    invalidContext();
  }
  if (typeof rec.key_version !== "string") {
    invalidContext();
  }
  if (rec.key_kind === "org") {
    if (!hasOrgId || hasRegion || typeof rec.org_id !== "string") {
      invalidContext();
    }
    for (const key of keys) {
      if (!ORG_KEYS.has(key)) {
        invalidContext();
      }
    }
    return { key_kind: "org", org_id: rec.org_id, key_version: rec.key_version };
  }
  if (rec.key_kind === "identity") {
    if (!hasRegion || hasOrgId || typeof rec.region !== "string") {
      invalidContext();
    }
    for (const key of keys) {
      if (!IDENTITY_KEYS.has(key)) {
        invalidContext();
      }
    }
    return { key_kind: "identity", region: rec.region, key_version: rec.key_version };
  }
  invalidContext();
}

function encodeKmsAad(keyId: string, context: CanonicalKmsContext): Uint8Array {
  const scope = context.key_kind === "org" ? context.org_id : context.region;
  return encodeLengthPrefixed([
    utf8(keyId),
    utf8(context.key_kind),
    utf8(scope),
    utf8(context.key_version),
  ]);
}

export function createLocalKmsPort(): KmsPort {
  const kekBytes = crypto.getRandomValues(new Uint8Array(32));
  let kek: Promise<CryptoKey> | undefined;
  const getKek = (): Promise<CryptoKey> => {
    kek ??= crypto.subtle
      .importKey("raw", kekBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
      .then((key) => {
        kekBytes.fill(0);
        return key;
      });
    return kek;
  };

  return {
    async generateDataKey(keyId, context) {
      const canonical = assertKmsContext(context);
      const key = await getKek();
      const plaintext = crypto.getRandomValues(new Uint8Array(ROOT_LENGTH));
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const sealed = await aes256GcmEncrypt(key, iv, plaintext, encodeKmsAad(keyId, canonical));
      const blob = new Uint8Array(iv.byteLength + sealed.byteLength);
      blob.set(iv, 0);
      blob.set(sealed, iv.byteLength);
      return { plaintext, blob };
    },
    async decrypt(keyId, blob, context) {
      const canonical = assertKmsContext(context);
      if (blob.byteLength < MIN_BLOB_LENGTH) {
        decryptFailed();
      }
      const key = await getKek();
      const iv = blob.subarray(0, IV_LENGTH);
      const ciphertextAndTag = blob.subarray(IV_LENGTH);
      return aes256GcmDecrypt(key, iv, ciphertextAndTag, encodeKmsAad(keyId, canonical));
    },
  };
}

export async function sealWith(opts: {
  key: CryptoKey;
  plaintext: Uint8Array;
  keyId: Uint8Array;
  iv: Uint8Array;
  boundFields: Uint8Array;
}): Promise<Uint8Array> {
  return productionSealWith(opts);
}
