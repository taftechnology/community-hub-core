/** Type stand-in for `@community-hub/crypto/testing`. Vitest aliases the import to crypto src. */
import type { KmsContext, KmsPort } from "@community-hub/crypto";

export type { KmsContext, KmsPort };

export declare function createLocalKmsPort(): KmsPort;

export declare function sealWith(opts: {
  key: CryptoKey;
  plaintext: Uint8Array;
  keyId: Uint8Array;
  iv: Uint8Array;
  boundFields: Uint8Array;
}): Promise<Uint8Array>;
