# Spec: Identity OTP and passkeys

Slug: identity-otp
Status: draft
Architecture refs: §6.3, §7.1, §11.1, §11.2, §12.1, §12.2, §12.2.1, §20, D9, D13. Implements the `identity-otp` row. Depends on `packages-crypto`, `packages-db`, `kernel-runtime`, and `regional-service`, all on `main`. Staging stays parked.

## Problem

The `identity` schema exists and has no tables. A person cannot receive an email one-time code, register a passkey, or hold a session on the regional service. Architecture already stores users in that schema, encrypts `identity.users.email`, and looks the address up through a region-scoped blind index. Question Q3 is open, so this chunk has no library to adopt.

## Scope

**In**

- `modules/core/identity`, package `@community-hub/identity`. `pnpm-workspace.yaml` gains the line `modules/core/identity`. No other workspace glob.
- `module.manifest.ts` calls `defineModule` with `key` `core.identity`, `version` 1, empty `requires`, `publishes`, `subscribes`, and `ports`. No `entitlement`, `features`, `permissions`, or `website`. `dataClasses` lists every column below.
- `packages/contracts`, package `@community-hub/contracts`. It depends on `zod` at `4.6.5`, the version already used in this repo. It exports the request and response schemas named under Contracts. No OpenAPI file. The generator does not exist yet.
- Tables in the `identity` schema, contributed from `modules/core/identity/db/schema.ts` as `identityTables(identity)`. That function does not call `pgSchema`. `packages/db` keeps the only product journal. `packages/db/drizzle.schema.ts` imports `identity` from `packages/db/src/namespaces.ts` and calls `identityTables`. `packages/db/src` does not import `@community-hub/identity`.
- One new product journal entry after `0003_complex_leech`. Drizzle Kit generates it. No `org_id`. No row level security. No `FORCE ROW LEVEL SECURITY`. No policy. `schema-rls` is not changed. It still checks `app` tables only. The identity-schema ownership scan stays omitted, as it did for the first `platform` tables.
- Ids are minted with `newId()` from `@community-hub/db`. The SQL has no `DEFAULT` for `id`.
- Grants stay the default privileges from `0000_schemas.sql`. The `identity` login receives select, insert, update, and delete. This migration does not grant these tables to `app`, `platform`, or `PUBLIC`.
- One region identity key. The first operation that needs it inserts one row when none exists for `region = 'au'`. The wrapped value is the blob from `generateKmsRoot`. The KMS context is `{ key_kind: "identity", region: "au", key_version: "1" }`. `keyId` is `ENVELOPE_KEY_ARN`. A unique constraint on `region` makes a concurrent insert lose; the loser reads the winner and does not write a second root. The unwrapped root is derived for that operation and then dropped. This chunk does not keep a process cache of it, and it does not unwrap an organisation key.
- `identity.users.email` is `confidential-blind`. The clear address is encrypted with `encrypt` and AAD `{ tag: "chub/field-identity/v1", label: "identity.users.email", rowId, region: "au" }`. The blind index is `blindIndex` with purpose `identity.users.email` over the UTF-8 normalised address. SQL filters that index by equality. SQL does not filter, sort, or aggregate the ciphertext.
- Email one-time code, passkey registration, passkey authentication, and sessions, implemented in this module with `@community-hub/crypto` and WebCrypto. No identity library. No WebAuthn library. No CBOR library.
- An `OtpMail` port. This chunk ships two implementations: one that resolves, for tests, and one that rejects with `email_unavailable`, used when the process boots. Neither writes a log. Neither calls a network host. The vendor stays Q9.
- Routes on the regional service, on the auth hostname. The server forwards a POST body. `GET /health` is unchanged and still opens no database and calls no KMS.
- Pooled checkout of `createAppSql`, `createIdentitySql`, and `createPlatformSql`, and the password re-read below. This is the first chunk that checks out those factories to serve a request.
- Startup does not prove the database or KMS. A route that needs them fails that request.
- ADR `docs/adr/0011-in-house-identity.md`. Architecture D9 loses the sentence that the library remains Q3, and §26 Q3 is closed as this ADR states. The catalogue commit updates `docs/roadmap.md` and the repository-state sentence in `AGENTS.md`.

**Out**

- An OIDC provider, relying-party tokens, and claims `org`, `community`, and role. When that later chunk is built, it is in-house as well. It does not add a library.
- Staff required to use a passkey or TOTP. SSO and SCIM. Operator sign-in, the two-passkey rule, and lost-passkey recovery.
- A live email vendor, a new subprocessor, SES, and any HTTP call that carries an address or a code. Q9 stays open.
- `app.audit_events`. A sign-in has no organisation, and that table requires `org_id`. This chunk does not call `appendAuditEvent` and does not register an audit name.
- The outbox, and caller-scoped `Idempotency-Key`. This chunk writes no outbox row. That scoping lands in the first chunk that writes one for a signed-in user.
- People, households, `is_minor`, roles, and entitlements.
- A cache of unwrapped organisation keys. This chunk unwraps no organisation key. That open item stays.
- Unparking staging. `enable_database` stays false, `desired_count` stays 0, and no committed var file gains `service_image`. No Terraform change. The image is not run on Fargate. The Fargate re-check stays an open item.
- Cookies, the mobile app, and `expo-secure-store`.
- The identity-schema ownership CI scan.

## Behaviour

The public functions take `sql: Sql` from `postgres` first. The caller passes a connection that is already the `identity` login. The functions do not open a connection, do not call `set_config`, and do not set `app.org_id`.

`now` is an argument. The functions do not read the clock themselves, except `newId()`, which already embeds the current time.

### Normalised email

Trim leading and trailing ASCII spaces, then lowercase the whole string. Accept only `local@domain` where `local` is 1 to 64 characters from `a-z`, `0-9`, and `.`, `_`, `%`, `+`, `-`, and `domain` is 1 to 253 characters, labels separated by `.`, each label 1 to 63 characters from `a-z`, `0-9`, and `-`, not starting or ending with `-`. The stored and indexed value is that string. `Ada@Example.com` is `ada@example.com`. `ada@example.com` is accepted. A space in the middle, a second `@`, a newline, an empty string, and a missing dot in the domain are `invalid_email`, and nothing is written.

### Identity key

`ensureIdentityKey(sql, kms, keyArn)` returns the existing `au` row or inserts one. The insert calls `generateKmsRoot` once. The row stores the blob, `region` `au`, and `key_version` `1`. A second caller that loses the unique insert uses the stored blob and calls `unwrapKmsRoot`. The plaintext root is not stored, not logged, and not returned.

### Email one-time code

`startEmailOtp(sql, kms, mail, { email, now })` normalises the address. An invalid address throws `IdentityError` with `code` `invalid_email` and does not call `mail`. A valid address ensures the identity key, computes the blind index, and inserts one challenge. Any earlier unconsumed challenge for that index has `consumed_at` set to `now` in the same transaction. The code is eight digits from `crypto.getRandomValues`, with leading zeros kept. The row stores HMAC-SHA-256 under the identity `bidx` key with purpose `identity.otp` over the UTF-8 code. It does not store the code. `expires_at` is `now` plus 10 minutes. `attempts` is 0. After the transaction commits, `mail.send({ to, code })` is called. `to` is the normalised address. If `send` rejects, the challenge row is deleted and the rejection propagates. `OtpMailUnavailable` has `code` `email_unavailable`.

`verifyEmailOtp(sql, kms, { email, code, now })` returns `null` when the address is invalid, the code is not eight digits, no unconsumed unexpired challenge matches that index, the HMAC does not match, or `attempts` is already 5. A mismatch increments `attempts`. The fifth mismatch sets `consumed_at`. A match sets `consumed_at`, creates the user when the blind index is new, and returns session tokens. The new user's ciphertext uses that user's id as `rowId`. An existing user is not re-encrypted. `null` and a match are the only outcomes. The function does not report which check failed.

The boot mail implementation rejects before any I/O. Tests pass a mail implementation that keeps `{ to, code }` in memory.

### Passkeys

ES256 only (`alg` `-7`, P-256, SHA-256). `attestation` is `none`. Any other algorithm or attestation is rejected. The relying party id is the auth hostname the route passes in. The origin checked in client data is `https://` plus that hostname. The challenge is 32 bytes from `crypto.getRandomValues`, stored on `identity.passkey_challenges`, and expires 5 minutes after `now`.

`beginPasskeyRegistration` requires an existing user id. The options name and display name are that id, not the email. `user.id` is the 16-byte id. `pubKeyCredParams` is only `{ type: "public-key", alg: -7 }`. `authenticatorSelection.userVerification` is `preferred`. `residentKey` is `discouraged`.

`finishPasskeyRegistration` consumes the matching unconsumed challenge, checks the origin, the type `webauthn.create`, the challenge, the rpId hash, and the user-present flag. It stores the COSE public key bytes, the credential id, and `sign_count`. A second registration of the same credential id throws `IdentityError` with `code` `invalid_ceremony` and inserts nothing.

`beginPasskeyAuthentication` inserts a challenge with a null user id and `kind` `authenticate`.

`finishPasskeyAuthentication` looks up the credential id, consumes the challenge, checks type `webauthn.get`, origin, challenge, rpId hash, and the signature over `authenticatorData || SHA-256(clientDataJSON)`. When the stored `sign_count` is 0, a new count of 0 is accepted. When the stored count is greater than 0, a new count less than or equal to the stored count returns `null` and does not rotate the session. Success updates `sign_count` and returns session tokens. Any failed check returns `null`.

The ceremony parser accepts the CBOR it needs for this subset: unsigned integers, byte strings, text strings, arrays, and maps, and the COSE EC2 key with `kty` 2, `alg` `-7`, `crv` 1. Any other major type or key shape is `invalid_ceremony`. There is no general CBOR library and no attestation certificate check.

### Sessions

A session row stores HMAC-SHA-256 of the access token and of the refresh token under the identity `bidx` key, purposes `identity.access` and `identity.refresh`. The clear tokens are 32 bytes, base64url without padding, and are not stored. Access expires 15 minutes after `now`. Refresh expires 30 days after `now`. Rows in one rotation share `refresh_family`.

`refreshSession` finds the refresh hash. A missing, expired, or revoked row returns `null`. A row whose `replaced_by` is set revokes every row in that `refresh_family` and returns `null`. A live row inserts the successor, sets `replaced_by` and `revoked_at` on the presented row, and returns the new tokens.

`readSession` returns `{ userId }` when the access hash matches a row whose access expiry is after `now` and whose `revoked_at` is null. Otherwise it returns `null`.

### HTTP

The auth routes are `surface: "tenant"`. The handler returns 404 with an empty body when `x-community-hub-hostname` is not the configured auth hostname. Paths:

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/v1/auth/email-otp/start` | 204, or 400, or 503 |
| `POST` | `/v1/auth/email-otp/verify` | 200 with tokens, or 400, or 401 |
| `POST` | `/v1/auth/passkey/register/options` | 200 with options, or 401 |
| `POST` | `/v1/auth/passkey/register/verify` | 204, or 400, or 401 |
| `POST` | `/v1/auth/passkey/authenticate/options` | 200 with options, or 400 |
| `POST` | `/v1/auth/passkey/authenticate/verify` | 200 with tokens, or 400, or 401 |
| `POST` | `/v1/auth/session/refresh` | 200 with tokens, or 401 |

`Content-Type` must be `application/json`. The body is at most 4096 bytes. A larger body, a non-JSON body, or a schema failure is 400 with an empty body. `startServer` copies that POST body onto the `Request`. It does not copy a GET body. The body is not logged.

`start` returns 204 for a valid email, including one that has no user yet. It returns 503 with an empty body when mail rejects. It does not return the address. `verify` returns 401 with an empty body for every `null` result. A 200 body is `{ userId, accessToken, refreshToken, expiresIn }` with `expiresIn` 900. Register options require `Authorization: Bearer` and a live access token, and 401 otherwise. The token response and the ceremony JSON are the only success bodies. Error bodies are empty.

The boot path registers these routes next to `GET /health` and passes the rejecting mail implementation. Tests pass the in-memory mail implementation. Listen and `GET /health` still call no factory and no KMS `send`.

### Password re-read

`apps/api` gains `checkout(role, run)` for `app`, `identity`, and `platform`. The first checkout for a role opens that role's factory with the password already in the environment. The pool stays for later checkouts.

A query that fails with SQLSTATE `28P01` reads the role's secret ARN twice, `VersionStage` `AWSCURRENT` and then `AWSPREVIOUS`. The reader is injected. Production uses `@aws-sdk/client-secrets-manager`, added to `apps/api`. The secret string is the password only. It is passed only as the factory password. It is not written into an error, a log, or a URL.

One retry: if a returned stage differs from the password the failed pool used, open one new pool with that string and run the query once. Prefer `AWSCURRENT` when it differs, otherwise `AWSPREVIOUS`. If neither differs, or the retry also fails `28P01`, the checkout rejects. The failed pool is not ended. A later checkout uses the replacement pool when the retry succeeded, and the old pool when it did not. Any error whose SQLSTATE is not `28P01` does not read secrets and does not open a second pool.

The auth routes check out `identity` only. The `app` and `platform` checkout paths exist and are tested. No auth route uses them.

### Catalogue

The last commit marks the Phase 1 row done and links this spec. The snapshot stays on Phase `1 — Core platform`. Last shipped becomes `identity-otp`. Next chunk becomes `people-households`. The Phase 0 count stays `24 rows: 23 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stays `not started`. The sentence under the Phase 0 table names `people-households`. The Next spec section names `people-households`.

The password re-read paragraph is removed. In its place, one sentence: startup does not prove the database or KMS, `GET /health` opens neither, and a route that needs them fails that request, decided in `identity-otp`. The organisation-key cache sentence stays. The Fargate sentence stays.

The Q3 row in the roadmap open-question table says closed, with ADR 0011. In `AGENTS.md`, the repository-state cell names `people-households` as next. The Phase 0 counts in that cell stay as they are. That is the only `AGENTS.md` edit.

### ADR 0011

`docs/adr/0011-in-house-identity.md` is accepted, dated with the commit, and points at this spec. The decision is: there is no third-party identity library. Email one-time codes, passkeys, and the later OIDC provider are implemented in `core/identity` on WebCrypto and `@community-hub/crypto`. This chunk does not build the OIDC provider. Alternatives rejected: a hosted identity vendor, and an auth framework that owns the user table.

D9's rationale replaces `The library remains Q3.` with `There is no identity library. ADR 0011.` §26 Q3 notes say it is closed by ADR 0011, that OTP and passkeys are in `core/identity`, and that the OIDC provider is a later in-house chunk.

## Data

| Table | Column | Classification | Notes |
| --- | --- | --- | --- |
| `identity.users` | `id` | `internal` | UUIDv7 primary key. Not encrypted. |
| `identity.users` | `region` | `internal` | Clear. Only `au`. |
| `identity.users` | `email` | `confidential-blind` | Ciphertext. Label `identity.users.email`. Not filtered. |
| `identity.users` | `email_bidx` | `confidential-blind` | 32-byte blind index. Unique. Equality only. |
| `identity.identity_keys` | `id` | `internal` | UUIDv7. Also the field `key_id`. |
| `identity.identity_keys` | `region` | `internal` | Unique. Only `au`. |
| `identity.identity_keys` | `wrapped` | `internal` | KMS blob. Not a personal field. |
| `identity.identity_keys` | `key_version` | `internal` | The text `1`. |
| `identity.otp_challenges` | `id` | `internal` | UUIDv7 primary key. |
| `identity.otp_challenges` | `email_bidx` | `confidential-blind` | Equality lookup. Not unique. |
| `identity.otp_challenges` | `code_hash` | `internal` | HMAC of the code. The code is not stored. |
| `identity.otp_challenges` | `attempts` | `internal` | Integer, check `>= 0` and `<= 5`. |
| `identity.otp_challenges` | `expires_at` | `internal` | Clear timestamptz. |
| `identity.otp_challenges` | `consumed_at` | `internal` | Null until used or replaced. |
| `identity.passkey_credentials` | `id` | `internal` | UUIDv7 primary key. |
| `identity.passkey_credentials` | `user_id` | `internal` | References `identity.users`. Not unique. |
| `identity.passkey_credentials` | `credential_id` | `internal` | Unique bytea. |
| `identity.passkey_credentials` | `cose_key` | `internal` | Public key bytes. |
| `identity.passkey_credentials` | `sign_count` | `internal` | Bigint, check `>= 0`. |
| `identity.passkey_challenges` | `id` | `internal` | UUIDv7 primary key. |
| `identity.passkey_challenges` | `user_id` | `internal` | Null for authentication. |
| `identity.passkey_challenges` | `kind` | `internal` | `register` or `authenticate`. |
| `identity.passkey_challenges` | `challenge` | `internal` | 32 bytes. Unique. |
| `identity.passkey_challenges` | `expires_at` | `internal` | Clear timestamptz. |
| `identity.passkey_challenges` | `consumed_at` | `internal` | Null until used. |
| `identity.sessions` | `id` | `internal` | UUIDv7 primary key. |
| `identity.sessions` | `user_id` | `internal` | References `identity.users`. |
| `identity.sessions` | `refresh_family` | `internal` | UUIDv7. Not a foreign key. |
| `identity.sessions` | `access_hash` | `internal` | Unique HMAC. |
| `identity.sessions` | `refresh_hash` | `internal` | Unique HMAC. |
| `identity.sessions` | `access_expires_at` | `internal` | Clear timestamptz. |
| `identity.sessions` | `refresh_expires_at` | `internal` | Clear timestamptz. |
| `identity.sessions` | `replaced_by` | `internal` | Null, or another session id. |
| `identity.sessions` | `revoked_at` | `internal` | Null until rotation or reuse. |

No `org_id`. No minor columns. No clear email column.

## Rules touched

Tenancy. These rows are region-scoped `identity` tables. They have no `org_id`. Callers use the `identity` login and do not set `app.org_id`. The `app` and `platform` logins have no privilege on them.

Residency. The rows and the envelope key stay in `ap-southeast-2`. The clear address and the one-time code are handled in the regional service. This chunk's mail port does not transmit them. A later vendor is Q9 and is not added here.

Children. This chunk does not create a person and does not read `is_minor`. A child is not given a user here.

Authentication. Attempt limit 5. Refresh rotation revokes the presented row and detects reuse of a replaced token by revoking the family. Platform roles are not issued. Email one-time codes therefore cannot start a platform session, because this chunk issues no role.

Money, consent, retention, and analytics. No payment fields, no consent rows, and no analytics.

## Contracts

| Contract | Value |
| --- | --- |
| Package | `@community-hub/identity`. Public exports are the functions under Behaviour, `IdentityError`, `OtpMail`, and `OtpMailUnavailable`. |
| Schemas | `@community-hub/contracts` exports Zod schemas for each JSON body in the HTTP table. |
| Module | `core.identity`, version 1, no events and no entitlement. |
| Mail | `send(input: { to: string; code: string }): Promise<void>`. Boot rejects. Tests keep the pair in memory. |
| Journal | One additive entry in `packages/db/drizzle` after `0003`. |
| Roles | `identity` can read and write. `app` and `platform` cannot. |
| Secrets | `@aws-sdk/client-secrets-manager` in `apps/api` only. It replaces no package. It is the client for a secret the task already reads. |
| Staging | Parked. No apply. |

`IdentityError` extends `Error`. Its `code` is `invalid_email`, `email_unavailable`, or `invalid_ceremony`.

## Dependencies

`@community-hub/identity` depends on `@community-hub/db`, `@community-hub/kernel`, and `@community-hub/crypto`. It does not depend on an AWS SDK. `@community-hub/db` does not depend on identity. `apps/api` depends on identity and on `@aws-sdk/client-secrets-manager`. `@community-hub/contracts` depends on `zod` `4.6.5`. No other new package.

## Cost

No new resource billed by the hour or the month. No NAT gateway, load balancer, or interface endpoint. `GetSecretValue` runs only after SQLSTATE `28P01`, on secrets that already exist. Staging stays parked, so this chunk adds no database charge and no task charge.

## Risks

| Risk | Mitigation |
| --- | --- |
| A clear email is stored or filtered in SQL | The column is ciphertext. Lookup uses `email_bidx`. A test decrypts with the identity AAD and fails if the SQL filters the ciphertext column. |
| The code or the address is logged | The gate log stays method, path, and status. A test posts `ada@example.com` and a known code and fails if either string appears in a log call. |
| The password or the secret string is logged | The checkout test uses a marker password and fails if that marker appears in a log or an error message. |
| An auth failure opens pools without limit | One retry, then reject. The failed pool is not ended and not replaced unless the retry succeeds. |
| A replaced refresh token stays valid | Reuse sets `revoked_at` on every row in the family. A test presents the old token twice and the second result is `null`, as is the successor. |
| OTP verifies whether or not the user existed by a different status | Unknown and wrong codes are both `null` and HTTP 401. Start is 204 for every valid address. |
| The `app` login reads identity rows | A test as `app` and as `platform` is denied. |
| Mail leaves the process | The boot port rejects with no I/O. The test port keeps the message in memory. |
| Staging is unparked to try sign-in | The proof is the existing Docker Postgres. Staging flags stay parked. |

## Tests

- Domain tests, no database. The accepted and rejected emails under Behaviour. HMAC verify, the fifth failure, expiry, and refresh reuse, with a test KMS port from `@community-hub/crypto/testing`.
- Integration in the existing `@community-hub/db` Docker Postgres, one database. The identity login inserts and selects. The `app` and `platform` logins cannot. The generated SQL has no `org_id`, no `ENABLE ROW LEVEL SECURITY`, and no `FORCE ROW LEVEL SECURITY`.
- Start then verify creates one user, one session, and a decryptable email. A second start consumes the first challenge. The boot mail port deletes the challenge and sends nothing.
- Passkey registration stores an ES256 key. A bad origin, a bad challenge, and a non-zero sign count that does not increase return `null` or `invalid_ceremony` as Behaviour states.
- HTTP tests hit the routes through `startServer`. Health still does not check out a factory. A body over 4096 bytes is 400. The auth hostname is required.
- Checkout tests: `28P01` reads both stages and retries once; a second `28P01` rejects; the first pool is not ended; a non-auth error does not read secrets.

## Out-of-band

- Legal: none. New subprocessor: none. Q9 is not chosen.
- Architecture: D9, §26 Q3, and ADR 0011, as this spec states. No other architecture section is edited.
- Authentication and encryption are a sensitive chunk. The second fresh-context review starts when the pull request opens. The pull request is not merged until that line is closed.
- The human does not apply. The agent does not apply. Staging stays parked.

## Rollback

Drop `identity.sessions`, `identity.passkey_challenges`, `identity.passkey_credentials`, `identity.otp_challenges`, `identity.users`, then `identity.identity_keys`. No other table references them in this chunk. The journal entry is not edited after it ships. A drop is a later contract migration. The service commit that added checkout reverts with that commit. No Terraform change to undo.

## Chunk shape

Seven commits, in this order. The plan names the test for each one. The commits are not merged.

1. Schema, grants, identity key, encrypted email, and the blind index.
2. Email one-time code and the mail port.
3. Passkeys.
4. Sessions, refresh rotation, and reuse detection.
5. HTTP routes, the POST body, and the auth hostname.
6. Pooled checkout and the password re-read.
7. ADR 0011, the architecture edits, `docs/roadmap.md`, and the `AGENTS.md` sentence.

## Next spec after this lands

`people-households`, unless the human picks another Phase 1 row.
