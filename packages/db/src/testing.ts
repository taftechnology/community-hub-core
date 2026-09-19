/**
 * Type stand-in for `@community-hub/crypto/testing`.
 *
 * `tsconfig.test.json` cannot path-map to `../crypto/src/testing.ts`: that
 * file and its imports sit outside this package's `rootDir`, and Node's
 * `BufferSource` (`types: ["node"]` here) rejects the `Uint8Array` /
 * `ArrayBufferLike` used by crypto's WebCrypto calls. Vitest aliases the
 * import to crypto src at runtime.
 */
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
