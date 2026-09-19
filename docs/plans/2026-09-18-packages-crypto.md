# Plan: packages/crypto foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `@community-hub/crypto` (WebCrypto envelopes, HKDF-split keys, injected `KmsPort`) plus Drizzle column types and a type-aware ESLint allow-list that replaces `encrypted-query`.

**Architecture:** Crypto is a Workers-safe library with no Drizzle and no AWS SDK. Callers inject `KmsPort`. Field AAD binds `community_id` and a stable label. Each wrapped root derives enc / bidx / wrap keys. Queryability is branded types plus ESLint on value types, not SQL-file scanning.

**Tech Stack:** WebCrypto (Node 24 + workerd via `@cloudflare/vitest-pool-workers`), Vitest, Drizzle 0.45.2 column types in `@community-hub/db`, typescript-eslint type-aware rule, existing Docker Postgres 17 + PgBouncer.

**Spec:** `docs/specs/2026-09-18-packages-crypto.md` (approved 2026-09-18, Abdus Salam)

Status: draft

**Branch:** `feat/2026-09-18-packages-crypto` · one PR · 7 tasks, one commit each

## Global Constraints

- No AWS SDK, no live KMS, no CI credentials, no `infra/`.
- Crypto package: WebCrypto only. No Drizzle dependency.
- `KmsPort` is `generateDataKey` / `decrypt` only. No `wrap(bytes)`.
- HKDF labels exactly `chub/v1/enc`, `chub/v1/bidx`, `chub/v1/wrap`.
- Envelope version `0x01`. GCM AAD is `version || key_id || bound fields`. Bound fields are `uint32be length || bytes`, tag first.
- `chub/field/v1` requires `community_id`. No `chub/field-org/v1` bytes.
- Unwrapped/derived keys are non-extractable. Production API never returns root bytes.
- `@community-hub/crypto/testing` is a test tsconfig / vitest alias, not `package.json` `exports`, not in `dist`. Alias it in crypto (Node + workerd) and db (vitest + `tsconfig.test.json`). No relative imports into crypto `src`.
- ESLint rule is allow-list on **value type** (`Ciphertext` | `BlindIndex<…>` through `| null` and unions). Stop and report if it cannot see `.orderBy(col)`. No import-ban fallback.
- Delete `encrypted-query` only in the same commit as the live rule, or after it — never before.
- Last commit updates `docs/roadmap.md` (`packages-crypto` **done**, add `terraform-envelope-kms` after `api-au-skeleton`).
- Session scratch is never committed. Encryption chunk: second independent review on the final diff.

---

## Tooling decisions this plan makes

| Choice                 | Decision                                                                                                                                                                                                                                                                                                                  | Why                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `KmsPort.decrypt` leak | **Lint, not convention.** Type-aware rule flags `generateDataKey` / `decrypt` calls whose receiver type is `KmsPort` outside `packages/crypto/src`. Must-fail fixture in a non-crypto `src` file.                                                                                                                         | Anyone holding the port can still pull root bytes; the spec left this to the plan.              |
| ESLint plugin          | `tooling/eslint-plugin-community-hub` with rules `@community-hub/no-encrypted-column-query` and `@community-hub/no-kms-port-outside-crypto`. Wired in root `eslint.config.js`. Fixture self-test in `tooling/checks/encrypted-column/` loads ESLint + fixture tsconfig **programmatically** (root ignores `fixtures/**`). | Live scan uses existing `projectService`. Fixtures must assert **this rule id and fire count**. |
| Workerd tests          | Second vitest config `packages/crypto/vitest.worker.config.ts` via `@cloudflare/vitest-pool-workers` (already a gateway dep). Minimal `wrangler.jsonc` in that package. Known-answer + frozen-vector files imported by both Node and worker configs. **If the pool cannot run, stop and report** — do not ship Node-only. | Spec: Node WebCrypto ≠ workerd.                                                                 |
| postgres.js `bytea`    | Custom Drizzle type maps `Uint8Array` ↔ `bytea`. Round-trip through PgBouncer `prepare: true` asserts byte-for-byte equality.                                                                                                                                                                                             | Driver returns `Buffer`; unit tests would miss it.                                              |
| Insert helper          | `insertEncrypted(db, table, values)` TypeScript requires `id: Uuid`. Test table SQL has no `DEFAULT` on `id`.                                                                                                                                                                                                             | Silent AAD/id mismatch.                                                                         |

**Rollback:** revert the PR. Docker data is disposable. Nothing applied to RDS. No KMS keys created.

---

## File map

| Path                                         | Role                                                                |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `packages/crypto/package.json`               | `@community-hub/crypto`                                             |
| `packages/crypto/src/aad.ts`                 | Length-prefixed AAD encode/decode                                   |
| `packages/crypto/src/envelope.ts`            | `0x01` header parse/build                                           |
| `packages/crypto/src/hkdf.ts`                | Derive enc / bidx / wrap                                            |
| `packages/crypto/src/encrypt.ts`             | Field encrypt/decrypt                                               |
| `packages/crypto/src/wrap.ts`                | `generateAndWrap` / `unwrapKey`                                     |
| `packages/crypto/src/blind-index.ts`         | HMAC + `BlindIndex<P>`                                              |
| `packages/crypto/src/kms-port.ts`            | `KmsPort` + `KmsContext` types only                                 |
| `packages/crypto/src/index.ts`               | Production exports                                                  |
| `packages/crypto/src/testing.ts`             | Local adapter + fixed IV/key helpers; **not** in `exports` / `dist` |
| `packages/crypto/test/vectors/`              | NIST / RFC / frozen `0x01` bytes                                    |
| `packages/crypto/vitest.config.ts`           | Node                                                                |
| `packages/crypto/vitest.worker.config.ts`    | workerd                                                             |
| `packages/db/src/columns.ts`                 | `encryptedColumn` / `blindIndexColumn`                              |
| `packages/db/src/insert-encrypted.ts`        | Helper requiring `id`                                               |
| `packages/db/drizzle-test/`                  | New test table (expand)                                             |
| `tooling/eslint-plugin-community-hub/`       | Typed rules                                                         |
| `tooling/checks/encrypted-column/`           | Fixture self-test                                                   |
| `docs/adr/0005-field-encryption-envelope.md` | ADR 0005                                                            |

Do not add an AWS SDK. Do not edit merged specs/plans.

---

## Interfaces (locked for later tasks)

```ts
export type Ciphertext = Uint8Array & { readonly __ciphertext: unique symbol };
export type BlindIndex<P extends string> = Uint8Array & { readonly __blindIndex: P };

export type KmsContext = {
  key_kind: "org" | "identity";
  org_id?: string;
  region?: string;
  key_version: string;
};

export type KmsPort = {
  generateDataKey(
    keyId: string,
    context: KmsContext,
  ): Promise<{ plaintext: Uint8Array; blob: Uint8Array }>;
  decrypt(keyId: string, blob: Uint8Array, context: KmsContext): Promise<Uint8Array>;
};

export type CommunityFieldAad = {
  tag: "chub/field/v1";
  label: string; // no 0x00
  rowId: Uint8Array; // 16
  communityId: Uint8Array; // 16
};
export type IdentityFieldAad = {
  tag: "chub/field-identity/v1";
  label: string;
  rowId: Uint8Array;
  region: string;
};
export type WrapAad = {
  tag: "chub/wrap/v1";
  childKind: "community" | "household";
  childId: Uint8Array;
  childKeyId: Uint8Array;
  parentKeyId: Uint8Array;
};

export declare function encrypt(
  encKey: CryptoKey,
  plaintext: Uint8Array,
  keyId: Uint8Array,
  aad: CommunityFieldAad | IdentityFieldAad,
): Promise<Ciphertext>;

export declare function decrypt(
  blob: Ciphertext,
  resolveEncKey: (keyId: Uint8Array) => CryptoKey | Promise<CryptoKey>,
): Promise<Uint8Array>;

export declare function generateAndWrap(
  parentWrapKey: CryptoKey,
  parentKeyId: Uint8Array,
  aad: WrapAad,
): Promise<{ blob: Uint8Array; childHkdfKey: CryptoKey }>;

export declare function unwrapKey(
  blob: Uint8Array,
  parentWrapKey: CryptoKey,
  expected: { childKeyId: Uint8Array; parentKeyId: Uint8Array },
): Promise<CryptoKey>; // HKDF CryptoKey, non-extractable

export declare function blindIndex<P extends string>(
  bidxKey: CryptoKey,
  purpose: P,
  normalised: Uint8Array,
): Promise<BlindIndex<P>>;
```

`encrypt` with `tag: "chub/field/v1"` and missing/empty `communityId` throws before GCM. `unwrapKey` builds wrap AAD from `expected` plus `child_kind`/`child_id` from the caller; mismatch → GCM `OperationError`.

Generic decrypt/unwrap errors: message has no hex of plaintext or key bytes.

---

## Tasks

Each task is one commit, test-first, independently verifiable, and leaves the tree green.

### T1 — Package, AAD, envelope, HKDF, field encrypt

**Commit:** `feat(crypto): AES-256-GCM field envelopes with authenticated headers`

**Files:** `packages/crypto/**` (package, tsconfigs, Node vitest, `src/{aad,envelope,hkdf,encrypt,index}.ts`, vector tests). Wire `packages/crypto` into `pnpm-workspace` (already `packages/*`), root `tsconfig.json` references, eslint.

**Produces:** `encodeAad`, `encrypt`, `decrypt`, `deriveKeys(hkdfKey)` → `{ enc, bidx, wrap }`.

- [ ] **Step 1: RED** — AAD: `("ab","c")` ≠ `("a","bc")`; community tag ≠ identity tag with the same remaining bytes. HKDF RFC 5869 vector; enc, bidx, wrap from one root all differ; `exportKey` throws; each key `usages` is a single purpose. Encrypt/decrypt round-trip. Missing `communityId` on `chub/field/v1` throws. Tamper each of version, key_id, IV, tag, each AAD field with a resolver that **ignores** `key_id` and still returns the right key — expect `OperationError`. NIST AES-256-GCM vector. Error messages contain neither plaintext nor key hex.

- [ ] **Step 2: GREEN** — Implement AAD, `0x01` envelope, HKDF, GCM with AAD = `version || key_id || bound`. Import HKDF key `extractable: false`. Derive with info bytes `chub/v1/enc` etc.

- [ ] **Step 3: Commit**

**Must not break:** no AWS imports; `src/` has no testing helpers with fixed IV.

---

### T2 — Application wrap + workerd pool

**Commit:** `feat(crypto): wrap child roots under a dedicated HKDF wrap key`

**Files:** `packages/crypto/src/wrap.ts`, wrap tests, `vitest.worker.config.ts`, `wrangler.jsonc`, package.json `test` script runs **both** Node and worker configs (`vitest run --config vitest.config.ts && vitest run --config vitest.worker.config.ts`). Share `test/vectors/*.ts` between them.

**Consumes:** T1 `deriveKeys`, envelope, AAD.

**Produces:** `generateAndWrap`, `unwrapKey`.

- [ ] **Step 1: RED** — wrap then unwrap yields a key that can encrypt. Wrong parent wrap key fails `OperationError`. Rollback: unwrap with current `{ childKeyId, parentKeyId }` rejects a blob made under an older pair. Frozen wrap vector using testing helpers — **those helpers must not exist yet in production `src`**; put a local test-only fixed-IV function in T2 tests, move it to `testing.ts` in T3.

- [ ] **Step 2:** Add workerd config. Re-run known-answer + frozen field vectors from T1 under the worker pool. **If pool fails to boot, stop and report.**

- [ ] **Step 3: GREEN + commit**

**Must not break:** T1 Node tests still pass; wrap uses `chub/v1/wrap`, not `enc`.

---

### T3 — Local `KmsPort` and `/testing` entry

**Commit:** `feat(crypto): local KmsPort as GenerateDataKey behind a test-only path`

**Files:** `packages/crypto/src/kms-port.ts`, `packages/crypto/src/testing.ts` (exclude from `tsconfig.json` `include` / `rootDir` so it is **not** in `dist`). `packages/crypto/tsconfig.test.json` + vitest alias `@community-hub/crypto/testing` → `./src/testing.ts`. Tests that `dist/` has no `testing.js`. Local adapter: AES-GCM with a process-local KEK; same context rules.

- [ ] **Step 1: RED** — `generateDataKey` then `decrypt` round-trip. Wrong key id, extra context key, both `org_id` and `region`, neither, tampered blob all fail. Public `index.ts` does not export the adapter.

- [ ] **Step 2: GREEN** — `createLocalKmsPort()` only from `testing.ts`. Context allow-list: keys ⊆ `{ key_kind, org_id, region, key_version }`; `key_kind` required; exactly one of `org_id` | `region`.

- [ ] **Step 3: Commit**

**Must not break:** production `exports` map is still `"."` only.

---

### T4 — Blind indexes

**Commit:** `feat(crypto): purpose-tagged HMAC-SHA-256 blind indexes`

**Files:** `packages/crypto/src/blind-index.ts`, RFC 4231 tests, purpose `0x00` throw, type test `eq` of two purposes does not compile (`*.test.ts` under `tsconfig.test.json`).

**Produces:** `blindIndex<P>(key, purpose, normalised)`.

- [ ] **Step 1: RED** — RFC 4231 HMAC-SHA-256. Output 32 bytes. Purpose with `0x00` throws. Same key + different purposes differ.

- [ ] **Step 2: GREEN + commit**

**Must not break:** HMAC key is `chub/v1/bidx`, not `enc`.

---

### T5 — Drizzle columns, required `id`, PgBouncer round-trip

**Commit:** `feat(db): encrypted and blind-index columns with a required-id insert`

**Files:** `packages/db/src/columns.ts`, `insert-encrypted.ts`, `index.ts` exports, `tsconfig.test.json` + vitest alias for `@community-hub/crypto/testing`, drizzle-test migration adding `app.synthetic_crypto` (`org_id`, `community_id`, `id` uuid **without DEFAULT**, `payload bytea`, `email_bidx bytea`, RLS + FORCE + policy on `org_id`). Integration test using `createAppSql` + `withAppTransaction` + `hub` (not bleed aliases). `@ts-expect-error` in `packages/db/src/columns.test.ts` for `eq(encryptedCol, "plain")` and cross-purpose bidx — **no** `@ts-expect-error` for `orderBy`.

Rename test: two column helpers with the same `label: "people.email"` and different SQL names still encrypt/decrypt with that label.

- [ ] **Step 1: RED** — type error omitting `id` from insert helper (compile test). Round-trip: insert ciphertext + bidx, `eq(email_bidx, value)` finds the row, `payload` bytes equal.

- [ ] **Step 2: GREEN** — custom `bytea` type; helper `insertEncrypted` generic requires `id`. Apply test migrations in the test (existing `applyTestMigrations`).

- [ ] **Step 3: Commit**

**Must not break:** product journal unchanged; `schema-rls` still `ok` (new table has `org_id`, RLS, FORCE); pooling tests still sequential on `hub_bleed` / `hub_reuse` only.

---

### T6 — Type-aware ESLint rule; delete `encrypted-query`

**Commit:** `feat(tooling): lint encrypted columns by value type and drop encrypted-query`

**Files:** `tooling/eslint-plugin-community-hub/`, `eslint.config.js` (register plugin; enable both rules on `packages/*/src`, `apps/*/src`, `modules/**` excluding tests/dist), `tooling/checks/encrypted-column/{selftest.ts,fixtures/**,tsconfig.fixtures.json}`, `tooling/checks/run.ts` (remove encrypted-query; optionally log encrypted-column self-test is a vitest package instead). Delete `tooling/checks/encrypted-query/**`. `pnpm-lock.yaml`. Companion scans in the plugin or a tiny checker: `eslint-disable` for these rule ids; `@ts-ignore` / `@ts-expect-error` in non-test `src`; `@community-hub/crypto/testing` imported from non-test `src`.

**Rule `@community-hub/no-encrypted-column-query`:** flag expression whose type is `Ciphertext` or `BlindIndex<…>` (unwrap `| null` / unions) unless allow-listed (spec table). Also flag branded `as` / `as unknown as`. Ban `sql.raw` and `db.execute` with a string except files named in the checker (none today).

**Rule `@community-hub/no-kms-port-outside-crypto`:** flag `.generateDataKey(` / `.decrypt(` when the receiver is typed `KmsPort` and the file is not under `packages/crypto/src`.

Must-fail fixtures (assert **rule id + count**): `.orderBy`, `.groupBy`, `asc`/`desc`, `count`/`max`/`min`, `eq` ciphertext, `inArray` ciphertext, `like`, `gt`, `` sql`${col}` ``, `sql.raw`, string `execute`, `eq(bidx, bidx)`, ciphertext `index()`, subquery/CTE/alias/spread/nullable, cast, `port.decrypt` from `packages/db/src` fixture, `/testing` import, disable comment, `@ts-ignore`.

Must-pass: select, returning, insert values, `eq(bidx, BlindIndex)`, `inArray(bidx, BlindIndex[])`, `index().on(bidx)`, `onConflict` target bidx.

Self-test: programmatic ESLint with fixture tsconfig. Zero reports on must-pass. Wrong-rule-only failures do **not** count as green.

- [ ] **Step 1: RED** — selftest fails because the plugin does not exist.

- [ ] **Step 2: GREEN** — rule live in root eslint **before or in this same commit** as the delete. `pnpm check:boundaries` no longer mentions encrypted-query.

- [ ] **Step 3: Commit**

**Must not break:** if `.orderBy(encryptedCol)` is not flagged, **stop and report**. `sql-session-ban` still 20/20.

---

### T7 — ADR, docs, roadmap, full gate

**Commit:** `docs: record the field-encryption envelope and mark packages-crypto done`

**Files:** `docs/adr/0005-field-encryption-envelope.md` (context, decision, consequences, alternatives rejected: bind `org_id`, JSON AAD, truncate HMAC, share enc for wrap, `wrap(bytes)`). `architecture.md` §8.1 layout (drop encrypted-query; name the ESLint rules); §12.2 summary + link ADR 0005 (`community_id` AAD, stable labels, HKDF three labels, 2³² + rotation). `AGENTS.md` §10: replace `encrypted-query` with the two rule ids. `docs/roadmap.md`: `packages-crypto` **done**, Phase 0 **4 / 10** (new row `terraform-envelope-kms` after `api-au-skeleton` makes 10 Phase 0 chunks), last shipped `packages-crypto`, next `kernel-runtime`. `packages/crypto/README.md` short: no AWS, inject `KmsPort`, testing alias.

Phase 0 count: today 9 rows with 3 done. Adding `terraform-envelope-kms` → 10 rows, 4 done after this chunk.

- [ ] **Step 1: Docs**

- [ ] **Step 2: Full local gate (chunk gate)**

```
pnpm format
pnpm lint
pnpm typecheck
pnpm check:boundaries
pnpm test
# every terraform matrix dir still:
#   terraform init -backend=false -lockfile=readonly
#   terraform fmt -check && terraform validate && tflint && terraform test
pnpm exec wrangler deploy --dry-run   # from apps/gateway after pnpm --filter @community-hub/gateway... build
```

Expected: all exit 0. `schema-rls: ok`. **No** `encrypted-query` notice. `sql-session-ban: ok`. Crypto tests pass on Node **and** workerd. Db round-trip green. No AWS/RDS.

- [ ] **Step 3: Commit**

**Must not break:** gateway preview still fail-closed on missing Cloudflare secrets.

---

## Self-review (plan vs spec)

| Spec requirement                                                                                                             | Task    |
| ---------------------------------------------------------------------------------------------------------------------------- | ------- |
| WebCrypto AES-GCM, authenticated header, `community_id` AAD, identity AAD, length-prefixed tags                              | T1      |
| NIST GCM, RFC 5869, tamper with fixed-key resolver, missing `community_id` throws                                            | T1      |
| `chub/v1/wrap`; generateAndWrap / unwrapKey; rollback via stored key ids                                                     | T2      |
| workerd pool; stop if it cannot run                                                                                          | T2      |
| `KmsPort` GenerateDataKey; context allow-list; both/neither; `/testing` not in dist                                          | T3      |
| BlindIndex purpose; RFC 4231; no `0x00`; 32-byte untruncated                                                                 | T4      |
| Column types; insert requires `id`; no DEFAULT; PgBouncer bytea round-trip; rename keeps label                               | T5      |
| ESLint value-type allow-list; sql.raw; casts; subquery/CTE; KmsPort calls outside crypto; delete encrypted-query same commit | T6      |
| `@ts-expect-error` only in test paths; no orderBy expect-error                                                               | T5 + T6 |
| ADR 0005; §8.1 §12.2 AGENTS; roadmap last commit; terraform-envelope-kms row                                                 | T7      |
| Live KMS / infra / keyring / org-level field tag                                                                             | Out     |

No placeholders. No AWS SDK. No import-ban fallback.
