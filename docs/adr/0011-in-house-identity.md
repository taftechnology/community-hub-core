# ADR 0011: In-house identity

- Status: accepted
- Date: 2026-10-11
- Spec: `docs/specs/2026-10-11-identity-otp.md`

## Context

D9 is an identity service on the regional service: email one-time codes, passkeys, and an OIDC provider, with users in the regional database. Q3 asked which library would provide them.

## Decision

There is no third-party identity library. Email one-time codes, passkeys, and the later OIDC provider are implemented in `core/identity` on WebCrypto and `@community-hub/crypto`. This chunk does not build the OIDC provider.

## Consequences

OTP and passkeys ship in `core/identity`. The OIDC provider is a later in-house chunk in the same module. D9's rationale records that there is no identity library.

## Alternatives rejected

- **A hosted identity vendor.** The user table and the ceremonies would leave this service.
- **An auth framework that owns the user table.** The users, keys, and sessions stay in the identity schema on the existing crypto.
