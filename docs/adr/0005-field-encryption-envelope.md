# ADR 0005: Field-encryption envelope

- Status: accepted
- Date: 2026-09-18
- Spec: `docs/specs/2026-09-18-packages-crypto.md`

## Context

Application-layer AES-256-GCM is decided (architecture §12.2, D8, D12) but there was no persisted envelope, no frozen KDF, and no compile-time block on querying ciphertext. A community move rewrites `org_id` and does not re-encrypt fields (§6.4). SQL names change. Querying ciphertext in SQL is a classification error, not a scanner problem.

## Decision

- Envelope version `0x01`, stored as `bytea`: `version || key_id (16) || iv (12) || ciphertext || tag (16)`.
- GCM AAD is `version || key_id || length-prefixed bound fields`. The context tag is the first bound field. Bound fields come from the caller, not the blob. `decrypt` / `unwrapKey` take that AAD from the caller.
- Field AAD binds `community_id`, not `org_id`. Labels are stable classification keys (`people.email`), not physical table or column names.
- Each wrapped 32-byte root is imported as a non-extractable HKDF key and split into three single-use keys. Frozen HKDF parameters:
  - hash SHA-256
  - empty salt (RFC 5869: 32 zero bytes)
  - info UTF-8 `chub/v1/enc`, `chub/v1/bidx`, `chub/v1/wrap`
  - 256-bit output
  - HMAC import `{ name: "HMAC", hash: "SHA-256", length: 256 }`
- NIST 2³² GCM encryptions per key. Rotation (later chunk) is the remedy.
- `KmsPort` is AWS `GenerateDataKey` / `Decrypt` only. Production callers inject a port into `generateKmsRoot` / `unwrapKmsRoot`. Application code never holds root bytes.
- Queryability is branded `Ciphertext` / `BlindIndex<…>` plus ESLint `@community-hub/no-encrypted-column-query` and `@community-hub/no-kms-port-outside-crypto`.

## Consequences

- A community move does not brick field ciphertext. Wrap AAD binds key ids; a move re-wraps the community key under the destination org key.
- A SQL rename does not change the bound label; existing ciphertext still decrypts.
- Field encryption and wrapping do not share an IV budget.
- Live KMS and the envelope wrapping key are `terraform-envelope-kms`, not this chunk.
- Organisation-level encrypted fields (no `community_id`) need a later AAD tag; `chub/field/v1` refuses a missing community id.

## Alternatives rejected

- **Bind `org_id`.** A community move would make every ciphertext in the moved community undecryptable.
- **JSON AAD.** Canonicalisation and key order would be part of the permanent format. Length-prefixed fields have a fixed order per tag.
- **Truncate HMAC.** Blind indexes are 32-byte `bytea`. Truncation is a later, explicit decision.
- **Share enc for wrap.** Field encryption and wrapping would share the 2³² IV budget.
- **`wrap(bytes)` on the port.** Callers could supply a root they already hold. `GenerateDataKey` mints the root inside KMS.
