# Spec: packages/crypto foundations

Slug: `packages-crypto`
Status: draft
Architecture refs: §6.3–6.4, §8.1, §12.1–12.2.1; D8; D12; ADR 0005 (this PR); AGENTS.md §1 (4, 7, 10), §8, §10
Supersedes: —

## Problem

Field encryption, KMS wrapping and blind indexes are decided (D8, D12, §12.2) but there is no library, no persisted envelope, and no compile-time block on querying ciphertext. `encrypted-query` still scans SQL files nobody writes and prints a zero-files **notice**. The first real tables (`people-households`, `identity-otp`) must not invent crypto.

## Scope

**In**

- `@community-hub/crypto`: WebCrypto only. No Drizzle. No AWS SDK. AES-256-GCM field encrypt/decrypt; application `wrapKey` / `unwrapKey` (org → community, community → household); `KmsPort` for the organisation key and the region identity key; HMAC-SHA-256 blind indexes; HKDF split of each wrapped root into **enc, bidx, and wrap** keys (`chub/v1/enc`, `chub/v1/bidx`, `chub/v1/wrap`).
- Local `KmsPort` adapter and frozen-vector helpers live behind the TypeScript path `@community-hub/crypto/testing`. That path is **not** in `package.json` `exports` and is **not** emitted to `dist` (test tsconfig only). Configure the same alias in every package that uses it: `packages/crypto` (Node + workerd vitest), and `packages/db` vitest plus `tsconfig.test.json` for the round-trip (no relative imports into crypto `src`). Production never constructs a `KmsPort`; the caller injects one. Must-fail: `/testing` is absent from `dist` and is not imported by any non-test file.
- `@community-hub/db`: Drizzle column types over branded `Ciphertext` and `BlindIndex<'purpose'>` from crypto. No Drizzle dependency in crypto.
- Type-aware ESLint rule (allow-list) over `packages/*/src`, `apps/*/src`, `modules/**`. Own fixture tree + tsconfig. Delete `encrypted-query` in the same change as the live rule (or after it, never before).
- `@ts-expect-error` compile tests under `tsconfig.test.json`, in paths the companion scan treats as tests (`**/*.test.ts` or `**/test/**`). The scan would otherwise flag the directives.
- One PgBouncer round-trip of ciphertext + blind index through existing Docker Compose.
- Known-answer and frozen-vector suites on **Node and workerd** (`@cloudflare/vitest-pool-workers`). If the pool cannot be added this chunk, **stop and report**.
- ADR 0005. Architecture §8.1, §12.2 (summary + ADR link). AGENTS §10. Roadmap: add `terraform-envelope-kms` after `api-au-skeleton`; last commit of this branch marks `packages-crypto` **done**.

**Out** (explicitly)

- Live KMS adapter and the envelope wrapping key in Terraform. Those are `terraform-envelope-kms`. No `infra/` in this PR.
- Keyring / “`is_minor` → household key” resolver. That is `people-households`.
- Persisted key rows. Those are `tenancy-implicit-org` / `identity-otp`.
- Product people, identity, or donation tables.
- Organisation-level encrypted fields (app tables with `org_id` and no `community_id`). They need a later AAD tag (e.g. `chub/field-org/v1`), not `chub/field/v1`.
- Import-ban of Drizzle operators (does not see `.orderBy(col)`).
- Keeping `encrypted-query` as a provisional notice.
- AWS credentials in CI. Live KMS tests.

## Behaviour

### Packages and injection

`@community-hub/crypto` exports encrypt/decrypt, `wrapKey`/`unwrapKey`, `blindIndex`, `KmsPort` (type only), and branded types. It does not pick an adapter.

`@community-hub/crypto/testing` is a test-only TypeScript path (vitest / `tsconfig.test.json` alias), not a published export — same idea as `packages/db` keeping `migrate-test` out of `dist`. It exposes the local KMS adapter and frozen-vector helpers (fixed IV and key). A checker must-fail fixture imports that path from a non-test `src` file.

Callers pass a `KmsPort` in. There is no environment sniff and no “refuse the test adapter outside tests.”

### Key material

Each wrapped key is a **32-byte root secret**. Unwrap imports it as a non-extractable HKDF `CryptoKey`. Three keys are derived, each with exactly one use:

| Label          | Use                                    |
| -------------- | -------------------------------------- |
| `chub/v1/enc`  | AES-256-GCM field encrypt/decrypt      |
| `chub/v1/bidx` | HMAC-SHA-256 blind index               |
| `chub/v1/wrap` | AES-256-GCM wrap/unwrap of child roots |

One wrapped blob per organisation, community, household, or identity. Field encryption and household wrapping must not share a key or the 2³² IV budget.

`generateAndWrap(parent, aad)` uses the parent's **wrap** key, mints the child root inside the function, and never returns raw key bytes. `exportKey` on every unwrapped or derived key throws.

`KmsPort` matches AWS `GenerateDataKey` / `Decrypt` so the later live adapter is a thin mapping:

```
generateDataKey(keyId, context) → { plaintext, blob }
decrypt(keyId, blob, context) → plaintext
```

There is no `wrap(bytes)`: callers cannot pass in a root they already hold. Allowed context keys **only**: `key_kind` (`org` | `identity`), `org_id` **xor** `region` (exactly one of those two), `key_version`. The local adapter rejects any other key, a context with **both** `org_id` and `region`, and a context with **neither**. Context is identifiers only — AWS CloudTrail would otherwise log personal data.

Only crypto internals call `generateDataKey` / `decrypt`. They import the plaintext as HKDF and drop the bytes. The public API returns blobs and `CryptoKey`s, never root bytes.

Unwrap with a different context, different key id, or a tampered blob fails. Tests assert those failures.

### Field ciphertext (version `0x01`)

Stored as `bytea`:

`version (1) || key_id (16-byte UUIDv7) || iv (12 random) || ciphertext || tag (16)`

Decrypt refuses an unknown version.

**GCM AAD** is `version || key_id || encoded bound fields`. Tampering with the header fails GCM authentication, not “wrong key loaded.” Tamper tests use a resolver that returns the **correct** key for **any** `key_id` and assert `OperationError`.

**Bound fields:** every field is `uint32be length || bytes`, including the context tag (first field). Field order is fixed per tag. UUIDs are still length-prefixed (`length = 16`).

| Tag (first field)        | Remaining fields (order)                                                               | Used for                           |
| ------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------- |
| `chub/field/v1`          | stable label, `row_id`, `community_id`                                                 | Community-scoped `app` rows only   |
| `chub/field-identity/v1` | stable label, `row_id`, `region` (UTF-8, e.g. `au`)                                    | `identity` rows (no org/community) |
| `chub/wrap/v1`           | `child_kind` (`community` \| `household`), `child_id`, `child_key_id`, `parent_key_id` | Application key wraps              |

Stable label is the schema classification key (e.g. `people.email`), **not** the physical table or column name. The Drizzle column type carries that literal. A SQL rename does not change the label; existing ciphertext still decrypts. The same literal is the `BlindIndex` purpose.

Field AAD binds **`community_id`, not `org_id`**. Architecture §6.4: a community move rewrites `org_id` and does **not** re-encrypt fields. Binding `org_id` would make every ciphertext in the moved community undecryptable. Wrap AAD binds key ids, not “the organisation as parent”: a move re-wraps the community key under the destination org key.

**`chub/field/v1` requires `community_id`.** Encrypt refuses that tag if `community_id` is missing. Organisation-level `app` tables (`org_id` only) must **not** use this tag. Encrypted fields on those rows need a later tag (reserved name: `chub/field-org/v1`) in a later spec; this chunk does not define its bytes.

`row_id` in AAD requires the application to mint the id with `newId()` **before** insert. The encrypted-row insert helper (or table helper that emits encrypted columns) **requires `id` in the values**; omitting it is a type error. The test-only table has **no** `DEFAULT` on `id`. A test proves a default-less insert of an encrypted row without `id` is rejected, so the app cannot encrypt under one id and persist another.

Random 12-byte IVs make reuse unlikely, not impossible. **NIST limit: 2³² encryptions per key.** Key rotation is how a large community stays under it (ADR 0005).

Decrypt/unwrap errors are generic. They carry no plaintext and no key bytes.

### Application wrap

Same `0x01` envelope, encrypted under the parent's **`chub/v1/wrap`** key. GCM AAD includes header + `chub/wrap/v1` fields. Wrong parent or wrong AAD fails like `KmsPort`. `unwrapKey` takes the expected `child_key_id` and `parent_key_id` from the caller's stored key record; those values go into the AAD. A blob wrapped under a different pair is rejected (rollback).

### Blind indexes

HMAC-SHA-256 over `purpose || 0x00 || normalised_bytes`. **No truncation: 32-byte `bytea`.** The caller normalises (e.g. lower-case email) **before** the call. Purpose must not contain `0x00` (branded type + runtime throw). Type is `BlindIndex<'people.email'>`; the column type uses the same literal so email-index vs phone-index `eq` does not compile.

Never derive the HMAC or wrap key from the field-encryption key. HKDF labels above.

### Column types (`@community-hub/db`)

- Encrypted column: value type branded `Ciphertext`. `eq(col, 'plain text')` fails to compile.
- Blind-index column: `eq(col, BlindIndex<same>)` and `inArray(col, BlindIndex<same>[])` compile. `.orderBy(bidx)` still compiles in TypeScript; the ESLint rule flags it. Do not write an `@ts-expect-error` for `orderBy`.

TypeScript cannot block `.orderBy(col)`, `groupBy`, aggregates, column-vs-column `eq`, or `` sql`${col}` ``. The ESLint rule does.

### ESLint rule (allow-list, type-aware)

Registered in the existing typed ESLint setup (`projectService: true`). It flags any expression whose **value type** is `Ciphertext` or `BlindIndex<…>`, looking through `| null` and unions — including subquery/CTE/`.as()` aliases, `SQL<T>`, and spreads from `getTableColumns`. It does **not** key off the column object type alone.

**Allow**

| Use                                       | Ciphertext                       | BlindIndex         |
| ----------------------------------------- | -------------------------------- | ------------------ |
| `select({…})` projection                  | yes                              | yes                |
| `.returning({…})`                         | yes                              | yes                |
| `insert` / `update` values                | yes (`Ciphertext`)               | yes (`BlindIndex`) |
| decrypt helper in `@community-hub/crypto` | yes                              | n/a                |
| `eq(col, BlindIndex<same>)`               | no                               | yes                |
| `inArray(col, BlindIndex<same>[])`        | no                               | yes (batch lookup) |
| `index()` / `uniqueIndex().on(bidx)`      | **no** (flag ciphertext indexes) | yes                |
| `onConflict…({ target: bidx })`           | no                               | yes                |

**Flag** (must-fail fixture each): `.where` on ciphertext; `.orderBy` / `.groupBy` / `asc` / `desc`; `count` / `max` / `min`; `eq`/`ne`/`inArray`/`like`/`ilike`/`gt`/`lt` on ciphertext or against plaintext; column-to-column `eq` of two blind-index columns **even with the same purpose** (keys are per community, or per household for minors — a join across scopes returns nothing instead of failing); `` sql`${col}` ``; `sql.raw(…)` and `db.execute` with a string (banned everywhere except files the checker names; nothing needs them today); `as` / angle-bracket casts whose operand is branded; ciphertext `index()`.

Also must-fail: subquery ordered by an aliased encrypted field; CTE; `.as()`; `getTableColumns` spread; nullable `Ciphertext | null`.

Must-pass: each allowed row in the table.

Self-test loads the **fixture tsconfig programmatically** (root ESLint ignores `fixtures/**`). A must-fail fixture is green only if **this rule’s id** fires the expected number of times — not “any ESLint error.” Must-pass fixtures must have **zero** reports from this rule.

Live scan: `packages/*/src`, `apps/*/src`, `modules/**` (skip `test`/`tests`/`dist`).

Companion scan (must-fail fixtures): `eslint-disable` for this rule; `@ts-ignore` and `@ts-expect-error` in non-test source; import of `@community-hub/crypto/testing` from non-test files.

**Stop-and-report** if the rule cannot see builder methods (`.orderBy(col)` with no extra import) or if `parserOptions.project` / `projectService` cannot be used. Do not fall back to an import ban.

### `encrypted-query`

Delete the package once the ESLint rule is live in the same PR (rule commit ≤ delete commit). Update `tooling/checks/run.ts`, `pnpm-lock.yaml`, AGENTS §10, architecture §8.1 and the directory-layout block. Merged specs and plans are history — do not edit them.

### Tests (must exist)

**Crypto, Node and workerd**

- NIST AES-256-GCM; RFC 4231 HMAC-SHA-256; RFC 5869 HKDF. Enc, bidx, and wrap keys from the same root **all differ**.
- Frozen `0x01` field and wrap vectors. Fixed IV and key exist **only** on the `/testing` entry.
- Tamper: flip version, key id, IV, tag, and each AAD field. Key resolver ignores `key_id` and still returns the right key. Failure is `OperationError`.
- Rollback: `unwrapKey` with the current stored `child_key_id` / `parent_key_id` rejects a blob wrapped under an older pair.
- AAD: `("ab","c")` vs `("a","bc")` differ; community-row tag vs identity tag with equivalent remaining bytes differ.
- Rename: changing the SQL column name leaves the bound label unchanged (type-level / helper test).
- Errors: decrypt/unwrap messages contain neither plaintext nor key bytes.
- `exportKey` throws on unwrapped and derived keys; each derived key has exactly one use.
- Local `KmsPort`: wrong key, wrong context, extra context keys, tampered blob, context with **both** `org_id` and `region`, context with **neither**.
- `wrapKey` same fail-closed contract.
- Purpose containing `0x00` throws.
- Encrypt with `chub/field/v1` and no `community_id` throws.
- Insert helper: encrypted row without `id` is a type error; test table has no `DEFAULT` on `id`.

**Lint / gates**

- Fixture matrix above, including `/testing` import, disable comments, `@ts-ignore`, `sql.raw`, string `execute`.

**Database (existing Compose, PgBouncer, `prepare: true`)**

- Test-only table in `drizzle-test` (not the product journal): `org_id`, `community_id`, `id` (app-minted, **no DEFAULT**), ciphertext `bytea`, blind-index `bytea`, RLS + FORCE RLS.
- Insert through the helper that requires `id`; read back **byte for byte**; `eq(bidx, value)` finds the row.

## Data

No product tables. Test-only `app` table as above. Columns: `org_id` / `community_id` / `id` (`internal` identifiers); payload `confidential` (encrypted, never queried); bidx `confidential-blind` (equality only). Synthetic UUIDs and bytes only.

Migration wave: expand in `drizzle-test` only. No product journal change required unless column helpers need an export. No contract wave.

## Rules touched

- D8 / D12 / §12.2: implemented. Minors’ household-key **policy** is not; the primitive supports household-scoped indexes when `people-households` passes the household root in.
- Non-negotiable 4: typed columns + lint, not SQL-file scanning.
- Non-negotiable 7: decrypt errors and KMS context carry no personal data. CloudTrail-safe context on the local adapter already.
- Residency: no live KMS; no personal data in CI.

## Contracts

- `KmsPort`: `{ generateDataKey(keyId, context), decrypt(keyId, blob, context) }`. No `wrap(bytes)`. Context schema as above. Blob opaque and versioned. Application code never holds `plaintext`; only crypto internals import it as HKDF.
- Crypto production exports vs `/testing`.
- Drizzle column helpers in `@community-hub/db`. Encrypted-row insert helper requires `id`.
- ESLint rule id (named in AGENTS §10 and the checker README).
- No API routes, events, or widgets.

## Risks

| Risk                                                           | Mitigation                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| AAD binds `org_id`; community move bricks ciphertext           | Bind `community_id`; ADR 0005; §6.4 named in the spec           |
| Header (`version`, `key_id`) unauthenticated                   | Header is part of GCM AAD; tamper tests with fixed key resolver |
| Physical table/column in AAD; rename bricks data               | Stable label on the column type                                 |
| Wrap AAD omits key version; old blob swapped back              | Bind `child_key_id` and `parent_key_id`; rollback test          |
| Same AES key for fields and wrapping (shared IV budget)        | Third HKDF label `chub/v1/wrap`; enc ≠ bidx ≠ wrap test         |
| `KmsPort.wrap(bytes)` lets callers supply a root               | `GenerateDataKey` shape; no wrap-in                             |
| `chub/field/v1` used on org-level rows (no `community_id`)     | Encrypt refuses missing `community_id`; org-level tag later     |
| Insert omits `id`; DB default disagrees with AAD               | Helper requires `id`; test table has no `DEFAULT`               |
| Personal data in KMS context / CloudTrail                      | Allow-listed context keys; local adapter rejects others         |
| Test KMS adapter ships in production                           | `/testing` entry; dist + import must-fail                       |
| Factory sniffs env and is spoofed                              | No factory; inject `KmsPort`                                    |
| Lint keys off column object; subquery `.orderBy` slips through | Flag value type through aliases, CTEs, null, unions             |
| Cast / `@ts-ignore` strips the brand                           | Flag branded casts; ban ignore comments in non-test src         |
| Fixture “any ESLint error” is skip-green                       | Assert rule id and fire count                                   |
| Deleting `encrypted-query` before the rule is live             | Same PR; rule ≤ delete                                          |
| `sql.raw` / string `execute` bypass types                      | Banned except named files                                       |
| Node WebCrypto ≠ workerd                                       | Dual pool; stop and report if workerd pool cannot be added      |
| postgres.js `Buffer` vs `bytea` custom type                    | PgBouncer round-trip, byte-for-byte                             |
| 2³² GCM limit ignored                                          | ADR 0005; rotation is the remedy (implemented in a later chunk) |
| Typed lint too slow or cannot see `.orderBy`                   | Stop and report; no import-ban fallback                         |

## Out-of-band

- **`terraform-envelope-kms`**: wrapping key in `ap-southeast-2`, key policy, live `KmsPort` adapter, CI identity if tests need it. Not this PR. Roadmap Phase 0 row after `api-au-skeleton`.
- **`people-households`**: resolver (adult community key vs minor household key), persisted household keys, first real encrypted columns.
- **`identity-otp`**: persisted identity key, `identity.users.email` encrypt + blind index.
- **`tenancy-implicit-org`**: persisted organisation and community keys. Organisation-level encrypted columns, if any, get `chub/field-org/v1` (bytes not defined here).
- Legal: none. New subprocessor: none. Architecture: §8.1, §12.2 summary + ADR 0005.

## Next spec after this lands

`kernel-runtime`, unless the human picks another remaining Phase 0 row (`terraform-envelope-kms` is catalogued, not next by default).
