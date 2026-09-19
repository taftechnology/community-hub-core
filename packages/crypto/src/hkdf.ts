const HASH = "SHA-256";
const SALT_EMPTY = new Uint8Array(0);
const INFO_ENC = new TextEncoder().encode("chub/v1/enc");
const INFO_BIDX = new TextEncoder().encode("chub/v1/bidx");
const INFO_WRAP = new TextEncoder().encode("chub/v1/wrap");

function hkdfParams(
  info: Uint8Array,
  salt: Uint8Array = SALT_EMPTY,
): SubtleCryptoDeriveKeyAlgorithm {
  return {
    name: "HKDF",
    hash: HASH,
    salt,
    info,
  };
}

export async function importHkdfKey(ikm: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
}

export async function hkdfRaw(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(hkdfParams(info, salt), key, lengthBytes * 8),
  );
}

export async function deriveKeys(
  hkdfKey: CryptoKey,
): Promise<{ enc: CryptoKey; bidx: CryptoKey; wrap: CryptoKey }> {
  const hmacImport: SubtleCryptoImportKeyAlgorithm = {
    name: "HMAC",
    hash: HASH,
    length: 256,
  };
  const aesImport: SubtleCryptoImportKeyAlgorithm = { name: "AES-GCM", length: 256 };
  const [enc, bidx, wrap] = await Promise.all([
    crypto.subtle.deriveKey(hkdfParams(INFO_ENC), hkdfKey, aesImport, false, [
      "encrypt",
      "decrypt",
    ]),
    crypto.subtle.deriveKey(hkdfParams(INFO_BIDX), hkdfKey, hmacImport, false, ["sign"]),
    crypto.subtle.deriveKey(hkdfParams(INFO_WRAP), hkdfKey, aesImport, false, [
      "encrypt",
      "decrypt",
    ]),
  ]);
  return { enc, bidx, wrap };
}
