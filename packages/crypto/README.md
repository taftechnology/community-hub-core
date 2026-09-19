# `@community-hub/crypto`

WebCrypto AES-256-GCM envelopes, HKDF-split keys, and HMAC-SHA-256 blind indexes. No AWS SDK.

Callers inject `KmsPort` only into `generateKmsRoot` / `unwrapKmsRoot`. There is no environment sniff and no factory.

`@community-hub/crypto/testing` is a vitest / tsconfig alias (local adapter and frozen-vector helpers). It is not a `package.json` export and is not in `dist`.
