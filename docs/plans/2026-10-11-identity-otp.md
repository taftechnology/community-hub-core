Spec: docs/specs/2026-10-11-identity-otp.md

# Identity OTP and passkeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign a user in on the regional service with an email one-time code or a passkey, and hold a rotating session, with the address encrypted and no identity library.

**Architecture:** Seven commits. The first adds the identity package, every identity table, the region key, and the encrypted email. The next three add the one-time code, passkeys, and sessions. The fifth adds the auth routes. The sixth adds pooled checkout and the password re-read. The seventh records ADR 0011 and the catalogue. No apply.

**Tech Stack:** TypeScript, Drizzle ORM `0.45.2`, `postgres` `3.4.9`, Zod `4.6.5`, Vitest, Node 24, Docker `postgres:17`, `@aws-sdk/client-secrets-manager`. No identity library and no WebAuthn library.

Status: approved (2026-10-11, Adnan Bin Hossen)

**Branch:** `feat/2026-10-11-identity-otp` · one PR · 7 tasks, one commit each

## Global Constraints

- The spec Status line is `approved (2026-10-11, Adnan Bin Hossen)`. Do not edit the spec.
- Do not start Task 1 until this plan's Status line is `approved`. Do not mark this plan approved yourself.
- Do not add a column, a route, a package, or a public function the spec does not name.
- Tasks 2 and 3 return `{ userId: string } | null` from verify and from passkey authentication. Task 4 changes those two returns to the spec's session tokens. The public surface at the end of Task 4 matches the spec.
- `packages/db/src` does not import `@community-hub/identity`. `db/schema.ts` does not import `@community-hub/db` and does not call `pgSchema`.
- `@community-hub/crypto/testing` is a test alias only. No non-test file imports it.
- The identity functions take `sql: Sql` from `postgres` first. They do not open a connection and they do not call `set_config`.
- One journal entry, in Task 1, after `0003_complex_leech`. Later tasks do not add a migration.
- Staging stays parked. Do not change `enable_database`, `desired_count`, or add `service_image`. Do not edit `infra/` or `.github/workflows/ci.yml`.
- Do not call `appendAuditEvent`. Do not write `app.outbox`. Do not add an OIDC route, a TOTP check, or an email vendor.
- Listen and `GET /health` call no `createAppSql`, `createIdentitySql`, `createPlatformSql`, no `checkout`, and no KMS `send`.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- This chunk is authentication and encryption. The second fresh-context review starts when the pull request opens. Leave that line open. Do not write the second review. The agent does not merge and does not apply.
- Every task runs `pnpm gate` before its commit. Format the files in that commit first: `pnpm exec prettier --write` on those paths. A code fence inside a list item is indented so Prettier does not join the list.
- Docker Postgres is started by the `@community-hub/db` test setup. Do not add a second compose file. If Docker is missing, stop and report. Do not skip the integration test.
- There are no Terraform asserts in this plan. No scratch probe.

**Rollback:** A later contract migration drops the identity tables in the spec's order. This journal entry is not edited after it ships. Revert of the PR before merge removes the entry with the branch. No Terraform change. Staging is unchanged.

**Cost:** No new hourly or monthly resource. `GetSecretValue` runs only after SQLSTATE `28P01`. Staging stays parked.

## File map

| File                                              | Responsibility                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm-workspace.yaml`                             | One new workspace member, `modules/core/identity`.                           |
| `modules/core/identity/`                          | Manifest, email rule, schema, key, OTP, passkeys, sessions, and their tests. |
| `packages/db/drizzle.schema.ts`                   | Passes the one `identity` schema into `identityTables`.                      |
| `packages/db/drizzle/`                            | One new journal entry after `0003_complex_leech`.                            |
| `packages/contracts/`                             | Zod bodies for the auth routes.                                              |
| `apps/api/src/`                                   | POST body, auth routes, checkout, and the secrets reader.                    |
| `docs/adr/0011-in-house-identity.md`              | Closes Q3.                                                                   |
| `architecture.md`, `docs/roadmap.md`, `AGENTS.md` | The sentences the spec names.                                                |

## Dependencies

`@community-hub/identity` depends on `@community-hub/db`, `@community-hub/kernel`, and `@community-hub/crypto` at `workspace:*`, plus `drizzle-orm` `0.45.2` and `postgres` `3.4.9`. Dev dependencies match `@community-hub/tenancy`: `typescript` `^5.8.2`, `@types/node` `^22.13.10`, `vitest` `^4.1.11`. `@community-hub/contracts` depends on `zod` `4.6.5` only. `apps/api` gains `@community-hub/identity`, `@community-hub/contracts`, and `@aws-sdk/client-secrets-manager`. No other new package. `@community-hub/db` does not depend on identity.

`turbo.json` task `@community-hub/identity#test` depends on `@community-hub/db#test`. The identity Vitest config uses `packages/db/test/global-setup.ts` and aliases `@community-hub/db/plaintext` and `@community-hub/crypto/testing` the same way `packages/db/vitest.config.ts` aliases the testing path. The alias target for crypto testing is `packages/crypto/src/testing.ts`.

## Security pins

These are the settings named in the spec. For each one, during the task that adds the test, change the source once, see that test fail, restore the source, and report the failure. The report is session scratch. The weakened tree is never committed.

| Setting                                         | Task | Test                                    | Source change that must fail it                                         |
| ----------------------------------------------- | ---- | --------------------------------------- | ----------------------------------------------------------------------- |
| No `org_id`, no RLS                             | 1    | SQL test on the generated journal entry | Add `"org_id"` or `ENABLE ROW LEVEL SECURITY` to that SQL, then restore |
| `app` and `platform` have no privilege          | 1    | Integration test                        | Add `GRANT USAGE ON SCHEMA identity TO app` to the journal SQL          |
| No `set_config`                                 | 1    | Source test                             | Add a `set_config` call in `infrastructure/identity-key.ts`             |
| Ciphertext column is not filtered               | 1    | Source test                             | Add `where email =` in `infrastructure/identity-user.ts`                |
| Wrong code and unknown address are both null    | 2    | Integration test                        | Return a distinct code string for an unknown address                    |
| Fifth mismatch consumes the challenge           | 2    | Integration test                        | Leave `attempts` uncapped                                               |
| Rejecting mail deletes the challenge            | 2    | Integration test                        | Leave the row in place when `send` rejects                              |
| Bad origin is rejected                          | 3    | Passkey test                            | Skip the origin comparison                                              |
| A sign count that does not increase is rejected | 3    | Passkey test                            | Accept a new count lower than the stored count                          |
| Reuse revokes the refresh family                | 4    | Session test                            | Return the successor on the second presentation                         |
| The address and the code are not logged         | 5    | HTTP test                               | `logger.info` the email inside the start handler                        |
| Body over 4096 bytes is 400                     | 5    | Server test                             | Raise the limit to 8192                                                 |
| Auth hostname is required                       | 5    | HTTP test                               | Accept the API hostname                                                 |
| `GET /health` does not check out                | 5    | Server test                             | Call `createIdentitySql` from the health route                          |
| One retry after `28P01`                         | 6    | Checkout test                           | Open a third pool when the retry also fails                             |
| A non-auth error does not read secrets          | 6    | Checkout test                           | Call the reader for every rejection                                     |
| The password is not logged                      | 6    | Checkout test                           | Put the password in the thrown error message                            |

---

### Task 1: Package, schema, identity key, and encrypted email

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `turbo.json`
- Modify: `pnpm-lock.yaml`
- Create: `modules/core/identity/package.json`
- Create: `modules/core/identity/tsconfig.json`
- Create: `modules/core/identity/tsconfig.test.json`
- Create: `modules/core/identity/vitest.config.ts`
- Create: `modules/core/identity/module.manifest.ts`
- Create: `modules/core/identity/domain/error.ts`
- Create: `modules/core/identity/domain/email.ts`
- Create: `modules/core/identity/domain/email.test.ts`
- Create: `modules/core/identity/domain/manifest.test.ts`
- Create: `modules/core/identity/db/schema.ts`
- Create: `modules/core/identity/db/schema.test.ts`
- Create: `modules/core/identity/infrastructure/identity-key.ts`
- Create: `modules/core/identity/infrastructure/identity-user.ts`
- Create: `modules/core/identity/infrastructure/identity-key.test.ts`
- Create: `modules/core/identity/infrastructure/identity.integration.test.ts`
- Create: `modules/core/identity/public/index.ts`
- Modify: `packages/db/drizzle.schema.ts`
- Create: the Kit journal entry under `packages/db/drizzle/` and its `meta` snapshot
- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**

- Produces: `IdentityError extends Error` with `code: "invalid_email" | "email_unavailable" | "invalid_ceremony"`.
- Produces: `ensureIdentityKey(sql, kms, keyArn)` returns `{ keyRowId: string }`. The KMS context is `{ key_kind: "identity", region: "au", key_version: "1" }`.
- Produces: `insertIdentityUser(sql, kms, keyArn, { email })` returns `{ userId: string }`. It is not exported from `public/index.ts`. Task 2 calls it.
- Produces: `defineModule` key `core.identity`, version `1`, empty `requires`, `publishes`, `subscribes`, and `ports`. `dataClasses` has one entry per column in the spec's Data table. `email` and `email_bidx` on users and `otp_challenges.email_bidx` are `"confidential-blind"`. Every other column is `"internal"`. No `entitlement`, `features`, `permissions`, or `website`.

**Rule this must not break:** domain imports no Drizzle and no `postgres`. The package does not depend on an AWS SDK. The journal has no `org_id` and no row level security.

- [ ] **Step 1: Write the failing tests**

`domain/email.test.ts` imports the normaliser. `Ada@Example.com` and `ada@example.com` become `ada@example.com`. `ada@example.com` is unchanged. These throw `IdentityError` with `code` `invalid_email`: `""`, `"ada"`, `"a da@example.com"`, `"ada@@example.com"`, `"ada@example"`, `"ada@-example.com"`, and a string containing a newline. Assert `error instanceof IdentityError` and `error instanceof Error`.

`domain/manifest.test.ts` imports the manifest and expects the key, version, empty arrays, and the `dataClasses` above.

`db/schema.test.ts` reads every `packages/db/drizzle/*.sql` file. It fails until one file contains all of these table names: `"identity"."users"`, `"identity"."identity_keys"`, `"identity"."otp_challenges"`, `"identity"."passkey_credentials"`, `"identity"."passkey_challenges"`, `"identity"."sessions"`. That file must contain `email_bidx`, `code_hash`, `cose_key`, `sign_count`, `access_hash`, `refresh_hash`, `refresh_family`, `replaced_by`, `'au'`, `'register'`, and `'authenticate'`. The same file must not match `\borg_id\b`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, `ON DELETE CASCADE`, or `DEFAULT`.

`infrastructure/identity-key.test.ts` reads `identity-key.ts` and `identity-user.ts` and fails if either matches `set_config` or `\bSET\b`. It fails if `identity-user.ts` matches `where email`.

`infrastructure/identity.integration.test.ts` uses the db harness the way `modules/core/tenancy/infrastructure/implicit-organisation.integration.test.ts` does. Apply product migrations on `productOnlyUrl`. Open `hub_product_only` as `identity` with `createPlaintextIdentitySql`. Use `createLocalKmsPort` from `@community-hub/crypto/testing`. `keyArn` is `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-` plus `ab` repeated 16 times.

`ensureIdentityKey` twice leaves one `identity.identity_keys` row with `region` `au` and `key_version` `1`. `insertIdentityUser` with `ada@example.com` inserts one user. A select of `email_bidx` by that index returns one row. Decrypt `email` with `decrypt` from `@community-hub/crypto`, AAD `{ tag: "chub/field-identity/v1", label: "identity.users.email", rowId, region: "au" }`, and the enc key derived from the unwrapped root. The plaintext is `ada@example.com`. `rowId` is the 16 bytes of the user id. A select `where email =` is not the lookup. The lookup column is `email_bidx`.

As `app` and as `platform`, `select * from identity.users` throws with driver `code` `42501`. As the direct login, `has_schema_privilege` for `USAGE` on `identity` and `has_table_privilege` for `SELECT` on `identity.users` are false for `app` and for `platform`.

The tests fail because the package does not exist.

- [ ] **Step 2: Add the package, the tables, and the key**

`pnpm-workspace.yaml` gains `- "modules/core/identity"`. No other glob.

`package.json` name `@community-hub/identity`, `"type": "module"`, `"private": true`, `"version": "0.0.0"`. Exports `"."` to `./dist/public/index.js` with types `./dist/public/index.d.ts`. Scripts match `@community-hub/tenancy`.

`tsconfig.json` extends `../../../tsconfig.base.json`, `rootDir` `"."`, `outDir` `./dist`. Include the manifest, `domain/**/*.ts`, `public/**/*.ts`, `db/**/*.ts`, and `infrastructure/**/*.ts`. Exclude `**/*.test.ts`. `tsconfig.test.json` extends the base, `noEmit` true, `composite` false, and adds the tests plus the `@community-hub/crypto/testing` path.

`db/schema.ts` exports `identityTables(identity)`. Local `customType` for `bytea`. No import from `@community-hub/db`. Columns and checks are the spec's Data table. Unique `email_bidx` on users. Unique `region` on `identity_keys`. `otp_challenges.attempts` checks `>= 0` and `<= 5`. `sign_count` checks `>= 0`. `passkey_challenges.kind` checks `in ('register', 'authenticate')`. `user_id` on credentials and sessions references `identity.users` with no `onDelete`. `replaced_by` has no foreign key. `passkey_challenges.user_id` is nullable. No `enableRLS` and no `pgPolicy`. Ids are `uuid("id").primaryKey()` with no default. `region` checks `= 'au'` on `users` and on `identity_keys`.

`packages/db/drizzle.schema.ts` imports `identity` from `./src/namespaces.ts` and calls `identityTables(identity)`. It keeps the existing platform exports. Do not export `identity` from `packages/db/src/index.ts`.

From `packages/db`, run `pnpm exec drizzle-kit generate`. Commit the new SQL, the new snapshot, and the journal entry. Do not edit `0000` through `0003`. Do not add `FORCE ROW LEVEL SECURITY`. If the generated SQL contains `ENABLE ROW LEVEL SECURITY`, remove that from the schema and generate again.

`identity-key.ts` inserts with `newId()` inside `sql.begin` when no `au` row exists. The insert calls `generateKmsRoot`. A `23505` on the region unique constraint reads the winner and calls `unwrapKmsRoot`. The plaintext root is not stored and not returned. `identity-user.ts` normalises first, calls `ensureIdentityKey`, derives `enc` and `bidx` with `deriveKeys`, encrypts, computes the blind index with purpose `identity.users.email`, and inserts. The clear address is not written to a column.

`public/index.ts` exports `ensureIdentityKey` and `IdentityError` only.

`pnpm install` so the lockfile records the workspace package. `turbo.json` gains the identity test dependency next to the tenancy one.

- [ ] **Step 3: Pin the identity shape**

Add `"org_id" uuid` to the generated users statement. The SQL test fails. Restore the file. Add `ENABLE ROW LEVEL SECURITY` for `identity.users`. The SQL test fails. Restore the file.

Add `GRANT USAGE ON SCHEMA identity TO app` to the journal SQL. The privilege test fails. Restore the SQL.

Add `set_config("app.org_id", "00000000-0000-0000-0000-000000000000", true)` in `identity-key.ts`. The source test fails. Restore the file.

Add `where email =` in `identity-user.ts`. The source test fails. Restore the file.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the TypeScript in this task. Do not run Prettier on `.sql` or Kit snapshots if it would reflow them. Then `pnpm gate`.

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml turbo.json modules/core/identity packages/db/drizzle.schema.ts packages/db/drizzle
git commit -m "$(cat <<'EOF'
feat(identity): store the region key and an encrypted email

The identity tables have no org_id. Lookup uses the blind index.

Refs: docs/plans/2026-10-11-identity-otp.md task 1
EOF
)"
```

---

### Task 2: Email one-time code and the mail port

**Files:**

- Create: `modules/core/identity/domain/otp-mail.ts`
- Create: `modules/core/identity/infrastructure/email-otp.ts`
- Create: `modules/core/identity/infrastructure/email-otp.integration.test.ts`
- Modify: `modules/core/identity/public/index.ts`

**Interfaces:**

- Consumes: `insertIdentityUser`, `ensureIdentityKey`, and the normaliser.
- Produces:

```ts
startEmailOtp(sql, kms, mail, { email, now }): Promise<void>
verifyEmailOtp(sql, kms, { email, code, now }): Promise<{ userId: string } | null>
type OtpMail = { send(input: { to: string; code: string }): Promise<void> }
class OtpMailUnavailable extends IdentityError
```

`OtpMailUnavailable` uses `code` `email_unavailable`. `public/index.ts` exports `startEmailOtp`, `verifyEmailOtp`, `OtpMail`, `OtpMailUnavailable`, `ensureIdentityKey`, and `IdentityError`. `verifyEmailOtp` does not insert a session.

**Rule this must not break:** the code is stored as an HMAC. The clear code is not a column. A wrong code and an unknown address both return `null`.

- [ ] **Step 1: Write the failing integration test**

`email-otp.integration.test.ts` uses the same harness and the same local KMS port. `now` is a fixed `Date`.

An in-memory mail keeps the last `{ to, code }`. `startEmailOtp` with `ada@example.com` stores `to` `ada@example.com` and an eight-digit `code`. One unconsumed `identity.otp_challenges` row exists. `code_hash` is 32 bytes and is not the UTF-8 code. A second start for the same address sets `consumed_at` on the first row. Only the second code verifies.

`verifyEmailOtp` with that code returns `{ userId }` and creates one user. A second verify of the same code returns `null`. Decrypt the stored email to `ada@example.com`.

Five wrong codes on a fresh challenge: the fifth sets `consumed_at`, and the real code then returns `null`. A code older than 10 minutes returns `null`. `missing@example.com` with any code returns `null`. `""` on start throws `invalid_email` and does not call `send`.

The rejecting mail throws `OtpMailUnavailable`. After that start, the challenge count for that index is unchanged. The test's rejecting implementation performs no I/O.

The test fails because the functions are not exported.

- [ ] **Step 2: Implement the code and the port**

`startEmailOtp` follows the spec: normalise, reject `invalid_email` before `mail`, ensure the key, consume earlier challenges for that index, insert the HMAC with purpose `identity.otp`, commit, then `send`. If `send` rejects, delete that challenge row and rethrow. `expires_at` is `now` plus 10 minutes. `attempts` starts at 0. The code is eight digits from `crypto.getRandomValues`, leading zeros kept.

`verifyEmailOtp` returns `null` for an invalid address, a code that is not eight digits, a missing challenge, an expired challenge, a consumed challenge, a bad HMAC, or `attempts` already 5. A mismatch increments `attempts`. The fifth mismatch sets `consumed_at`. A match sets `consumed_at` and calls `insertIdentityUser` only when the blind index is new. It returns `{ userId }`.

`domain/otp-mail.ts` exports the type and `OtpMailUnavailable`. `rejectingOtpMail` is the boot implementation: `send` returns a rejected `OtpMailUnavailable` and does not read the network. Export it from `public/index.ts` as well, because Task 5's boot uses it.

- [ ] **Step 3: Pin the OTP checks**

Return `{ userId: "missing" }` when the address is unknown. The unknown-address test fails. Restore `null`.

Remove the `attempts` cap so the real code still matches after five failures. The fifth-mismatch test fails. Restore the cap.

When `send` rejects, leave the challenge row. The rejecting-mail test fails. Restore the delete.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the files in this task, then `pnpm gate`.

```bash
git add modules/core/identity
git commit -m "$(cat <<'EOF'
feat(identity): send an email one-time code through the mail port

A wrong code and an unknown address both fail closed. The boot port does not send.

Refs: docs/plans/2026-10-11-identity-otp.md task 2
EOF
)"
```

---

### Task 3: Passkeys

**Files:**

- Create: `modules/core/identity/domain/cbor.ts`
- Create: `modules/core/identity/domain/cbor.test.ts`
- Create: `modules/core/identity/infrastructure/passkey.ts`
- Create: `modules/core/identity/infrastructure/passkey.integration.test.ts`
- Modify: `modules/core/identity/public/index.ts`

**Interfaces:**

- Consumes: the identity key helpers and `newId`.
- Produces: `beginPasskeyRegistration`, `finishPasskeyRegistration`, `beginPasskeyAuthentication`, and `finishPasskeyAuthentication`, with the spec's checks. `finishPasskeyAuthentication` returns `{ userId: string } | null`. It does not insert a session. `finishPasskeyRegistration` returns `void` and throws `invalid_ceremony` for a bad ceremony or a duplicate credential id.

**Rule this must not break:** ES256 only. Attestation `none` only. No certificate check. The email is not placed in the ceremony name.

- [ ] **Step 1: Write the failing tests**

`domain/cbor.test.ts` round-trips an unsigned integer, a byte string, a text string, an array, and a map. A major type outside that set throws `IdentityError` with `code` `invalid_ceremony`.

`passkey.integration.test.ts` builds the ceremony in the test with `node:crypto` `generateKeyPairSync("ec", { namedCurve: "prime256v1" })`. It signs `authenticatorData || SHA-256(clientDataJSON)` with SHA-256 ECDSA. `rpId` is `auth.example.test`. The origin is `https://auth.example.test`.

Registration options use that user's id as `name` and `displayName`, not `ada@example.com`. `alg` is `-7` only. `attestation` is `none`. Finish stores one `identity.passkey_credentials` row. A second finish with the same credential id throws `invalid_ceremony` and leaves one row.

Authentication options insert a challenge with a null `user_id` and `kind` `authenticate`. Finish with a good signature returns `{ userId }` and updates `sign_count`. A wrong origin returns `null` and does not consume a second user. A challenge older than 5 minutes returns `null`. When the stored count is 2, a new count of 2 returns `null`. When the stored count is 0, a new count of 0 returns `{ userId }`.

The test fails because the functions are not exported.

- [ ] **Step 2: Implement the ceremony**

`domain/cbor.ts` decodes only the types the spec names, including the COSE EC2 key with `kty` 2, `alg` `-7`, and `crv` 1. `passkey.ts` stores the 32-byte challenge, checks client data type, origin, rpId hash, and the user-present flag, and verifies the signature with WebCrypto. Follow the spec's sign-count rule. Options put the user id in `name` and `displayName`.

`public/index.ts` exports the four functions.

- [ ] **Step 3: Pin the ceremony checks**

Skip the origin comparison. The bad-origin test fails. Restore it.

Accept a new sign count lower than a stored non-zero count. That test fails. Restore the comparison.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the files in this task, then `pnpm gate`.

```bash
git add modules/core/identity
git commit -m "$(cat <<'EOF'
feat(identity): register and authenticate an ES256 passkey

A bad origin and a sign count that does not increase are rejected.

Refs: docs/plans/2026-10-11-identity-otp.md task 3
EOF
)"
```

---

### Task 4: Sessions, refresh rotation, and reuse

**Files:**

- Create: `modules/core/identity/infrastructure/session.ts`
- Create: `modules/core/identity/infrastructure/session.integration.test.ts`
- Modify: `modules/core/identity/infrastructure/email-otp.ts`
- Modify: `modules/core/identity/infrastructure/passkey.ts`
- Modify: `modules/core/identity/infrastructure/email-otp.integration.test.ts`
- Modify: `modules/core/identity/infrastructure/passkey.integration.test.ts`
- Modify: `modules/core/identity/public/index.ts`

**Interfaces:**

- Consumes: the identity `bidx` key.
- Produces:

```ts
refreshSession(sql, kms, keyArn, { refreshToken, now }): Promise<SessionTokens | null>
readSession(sql, kms, keyArn, { accessToken, now }): Promise<{ userId: string } | null>
type SessionTokens = { userId: string; accessToken: string; refreshToken: string; expiresIn: 900 }
```

`verifyEmailOtp` and `finishPasskeyAuthentication` return `SessionTokens | null`. `expiresIn` is the number `900`. Access expires 15 minutes after `now`. Refresh expires 30 days after `now`.

**Rule this must not break:** the clear tokens are not stored. Reuse of a replaced refresh token revokes the family.

- [ ] **Step 1: Write the failing tests**

Update the OTP and passkey success assertions from `{ userId }` to `SessionTokens`. `expiresIn` is `900`. The clear tokens do not appear in `access_hash` or `refresh_hash`.

`session.integration.test.ts` creates a session through `verifyEmailOtp`. `readSession` returns `{ userId }` before access expiry and `null` after it. `refreshSession` returns a new pair. `readSession` on the old access token returns `null`. A second `refreshSession` of the first refresh token returns `null`, and `readSession` on the successor access token returns `null`.

The new assertions fail because the functions still return `{ userId }` and `refreshSession` does not exist.

- [ ] **Step 2: Implement rotation**

`session.ts` stores HMAC-SHA-256 under purposes `identity.access` and `identity.refresh`. Tokens are 32 bytes, base64url, no padding. `refresh_family` is a new id on the first session and is copied to the successor. Presenting a row with `replaced_by` set revokes every row in that family and returns `null`. A live refresh inserts the successor, then sets `replaced_by` and `revoked_at` on the presented row.

`verifyEmailOtp` and `finishPasskeyAuthentication` call that insert on success. `public/index.ts` exports `refreshSession`, `readSession`, and `SessionTokens`.

- [ ] **Step 3: Pin reuse**

On the second presentation, return the successor tokens instead of revoking the family. The reuse test fails. Restore the revoke.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the files in this task, then `pnpm gate`.

```bash
git add modules/core/identity
git commit -m "$(cat <<'EOF'
feat(identity): rotate refresh tokens and revoke a reused family

A replaced refresh token ends every session in that family.

Refs: docs/plans/2026-10-11-identity-otp.md task 4
EOF
)"
```

---

### Task 5: HTTP auth routes

**Files:**

- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/auth.test.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/api/src/auth-routes.ts`
- Create: `apps/api/src/auth-routes.test.ts`
- Modify: `apps/api/src/server.test.ts`

**Interfaces:**

- Consumes: the identity public functions, `rejectingOtpMail`, and the service env hostnames.
- Produces: the seven routes in the spec's HTTP table, `surface: "tenant"`. `packages/contracts` exports a `z.strictObject` schema for each JSON body. Unknown keys fail. `startServer` copies a POST body of at most 4096 bytes onto the `Request`.

**Rule this must not break:** `GET /health` is unchanged. The boot mail is `rejectingOtpMail`. The body, the address, and the code are not logged.

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/auth.test.ts` accepts `{ email: "ada@example.com" }` for start and rejects `{ email: "ada@example.com", extra: 1 }`. Verify accepts `email` and an eight-digit `code` and rejects a seven-digit code.

`auth-routes.test.ts` calls the handlers with a `Request`. Start on `AUTH_HOSTNAME` with a valid body returns 204 when the identity start resolves. The same call on `API_HOSTNAME` returns 404 with an empty body. Verify maps `null` to 401 with an empty body and a `SessionTokens` value to 200 JSON `{ userId, accessToken, refreshToken, expiresIn }`. Register options without `Authorization: Bearer` return 401. A spy logger that receives the handler's log calls does not contain `ada@example.com` or the code `01234567`. `email_unavailable` from start returns 503 with an empty body.

`server.test.ts` gains a POST whose body is 4097 bytes. The response is 400 and the handler is not called. An existing health request still does not call `createIdentitySql`. The server test mocks `@community-hub/db` as it does today.

The tests fail because the routes and the body copy do not exist.

- [ ] **Step 2: Add the routes and the body**

`packages/contracts` is a private workspace package under `packages/*`. Scripts match the other packages: lint, typecheck, test, build. Export `./dist/src/auth.js` or an `index` that re-exports `auth.ts`. Pin `zod` at `4.6.5`.

`startServer` reads a POST body up to 4096 bytes and passes it to `new Request`. Over that, it responds 400 with an empty body and does not call the gate. GET is unchanged. The body is not logged.

`auth-routes.ts` exports `authRoutes(deps)`. The handlers parse JSON with the contract schemas. They call the identity functions with `deps.sql`, `deps.kms`, `deps.keyArn`, and `deps.mail`. `now` is `deps.now()`. The presented hostname must equal `deps.authHostname`. Boot in `index.ts` registers these routes after health and passes `rejectingOtpMail`. The handler opens `createIdentitySql` when the route runs, not when the process listens. Task 6 replaces that call.

- [ ] **Step 3: Pin the HTTP checks**

Call `logger.info("otp", { email })` in the start handler. The log test fails. Restore the handler.

Raise the body limit to 8192. The 4097-byte test fails. Restore 4096.

Treat the API hostname as allowed. The 404 test fails. Restore the auth hostname check.

Call `createIdentitySql` inside the health route. The health test fails. Restore the health route.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the files in this task, then `pnpm gate`. `pnpm install` if the lockfile changes.

```bash
git add packages/contracts apps/api pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(api): serve OTP and passkey routes on the auth hostname

The POST body is limited, and health still opens no database.

Refs: docs/plans/2026-10-11-identity-otp.md task 5
EOF
)"
```

---

### Task 6: Pooled checkout and password re-read

**Files:**

- Create: `apps/api/src/checkout.ts`
- Create: `apps/api/src/checkout.test.ts`
- Create: `apps/api/src/secrets.ts`
- Modify: `apps/api/src/auth-routes.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `createAppSql`, `createIdentitySql`, `createPlatformSql`, and the three secret ARNs already on `ServiceEnv`.
- Produces:

```ts
checkout<T>(role: "app" | "identity" | "platform", run: (sql: Sql) => Promise<T>): Promise<T>
type SecretReader = (arn: string, stage: "AWSCURRENT" | "AWSPREVIOUS") => Promise<string>
```

The auth routes check out `identity` only. Production `SecretReader` uses `@aws-sdk/client-secrets-manager`. Tests inject the reader.

**Rule this must not break:** one retry, then reject. The failed pool is not ended. SQLSTATE other than `28P01` does not read secrets. The password is not in a log or an error message.

- [ ] **Step 1: Write the failing checkout test**

`checkout.test.ts` uses fake factories and a fake reader. The first checkout opens one pool with the env password and runs the query. A query that rejects with `{ code: "28P01" }` reads `AWSCURRENT` and then `AWSPREVIOUS`. When `AWSCURRENT` differs, one new pool is opened with that string and the query runs once. The first pool's `end` is not called. A second `28P01` from the retry rejects, and the factory has been called twice, not three times. A rejection with `code` `08006` does not call the reader and does not open a second pool. The marker password `marker-secret-value` appears in no error message and in no log spy.

The test fails because `checkout` does not exist.

- [ ] **Step 2: Implement checkout**

`checkout.ts` keeps one live pool per role. Follow the spec's retry rule: prefer a differing `AWSCURRENT`, otherwise a differing `AWSPREVIOUS`, otherwise reject without a second pool. Match `error.code === "28P01"` only. Do not read `error.message` into a log. `secrets.ts` exports `secretsManagerReader(client)` that calls `GetSecretValue` with `SecretId` and `VersionStage`. The returned string is the password only.

`auth-routes.ts` takes `checkout` instead of calling `createIdentitySql`. `index.ts` builds the reader and the checkout from the env. Listen still does not call checkout.

- [ ] **Step 3: Pin the retry**

Open a third pool when the retry fails `28P01`. The test fails. Restore the one retry.

Call the reader when `code` is `08006`. The test fails. Restore the SQLSTATE check.

Throw `new Error(password)`. The marker test fails. Restore the error so it does not contain the password.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the files in this task, then `pnpm gate`.

```bash
git add apps/api pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(api): re-read the database password once after an auth failure

Running pools stay up. The password is not logged.

Refs: docs/plans/2026-10-11-identity-otp.md task 6
EOF
)"
```

---

### Task 7: ADR 0011 and the catalogue

**Files:**

- Create: `docs/adr/0011-in-house-identity.md`
- Modify: `architecture.md`
- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: the six commits above. This task does not change runtime code.
- Produces: Q3 closed, the Phase 1 row done, and the next chunk `people-households`.

**Rule this must not break:** Phase 0 stays `24 rows: 23 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stay `not started`. The organisation-key cache sentence stays. The Fargate sentence stays. The only `AGENTS.md` edit is the repository-state sentence.

- [ ] **Step 1: Record the decision and the catalogue**

`docs/adr/0011-in-house-identity.md` is accepted, dated `2026-10-11`, and points at `docs/specs/2026-10-11-identity-otp.md`. The decision and the rejected alternatives are the spec's ADR 0011 section. This chunk does not build the OIDC provider.

In `architecture.md`, replace `The library remains Q3.` in D9's rationale with `There is no identity library. ADR 0011.` In §26, the Q3 notes say it is closed by ADR 0011, that OTP and passkeys are in `core/identity`, and that the OIDC provider is a later in-house chunk. Edit no other architecture section.

In `docs/roadmap.md`:

- Snapshot last shipped becomes `identity-otp`. Next chunk becomes `people-households`. Phase, Phase 0, and Later phases stay as they are.
- The sentence under the Phase 0 table becomes: Next is `people-households`.
- The Phase 1 row for `identity-otp` becomes `done`. Keep the existing What sentence and append `Spec `docs/specs/2026-10-11-identity-otp.md`.`
- The Next spec section names `people-households`.
- Delete the password re-read paragraph. In its place, one sentence: startup does not prove the database or KMS, `GET /health` opens neither, and a route that needs them fails that request, decided in `identity-otp`.
- The Q3 row says closed, with ADR 0011.

In `AGENTS.md`, in the repository-state cell, replace `identity-otp` with `people-households`. Leave the Phase 0 counts and the rest of that cell unchanged.

- [ ] **Step 2: Gate and commit**

`pnpm exec prettier --write` on the four files, then `pnpm gate`.

```bash
git add docs/adr/0011-in-house-identity.md architecture.md docs/roadmap.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark identity-otp done

Q3 is closed. There is no identity library. The next chunk is people-households.

Refs: docs/plans/2026-10-11-identity-otp.md task 7
EOF
)"
```

## Human

Approve this plan before Task 1. After Task 7, the pull request uses `.github/PULL_REQUEST_TEMPLATE.md`, links this spec and this plan, and leaves the second-review line open. The agent does not merge and does not apply. Staging stays parked.
