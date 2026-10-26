Spec: docs/specs/2026-10-26-ops-operator-oneoff.md

# Ops operator one-off Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can grant, revoke and recover an operator in a deployed environment by running `node /app/ops-operator.js` as an ECS one-off over the one fixed provision secret, following a new runbook that includes recovery. `provision-owner` and `ops-operator` refuse each other's payloads. Two PR #62 follow-ups land in identity. No route, Terraform, Dockerfile, migration or live run.

**Architecture:** The one-off failure classification and ARN pattern move from `provision-owner.ts` into a shared `one-off-failure.ts`. `provision-owner` gains a three-way parse with a `shape` refusal. A new `ops-operator.ts` mirrors `provision-owner`'s structure (`runOpsOperator(deps)`, a `Main` backstop, an entry point) and opens only the identity connection. Identity's `endOperatorSession` writes `signed_out` only when it revoked a row, and two internal helpers are documented and pinned as test-only. A new runbook documents every step.

Slug: ops-operator-oneoff
Status: approved (2026-10-26, Abdus Salam)

## Who does what

| Actor                     | Writes repo commits                             | Runs `terraform apply` | Puts secret values, runs AWS one-offs   | Applies or merges |
| ------------------------- | ----------------------------------------------- | ---------------------- | --------------------------------------- | ----------------- |
| Implementer (Antigravity) | Yes — Tasks 1–7, only the files each task names | Never                  | Never                                   | Never             |
| Reviewer (fresh Claude)   | Never                                           | Never                  | Never                                   | Never             |
| Human owner (Abdus)       | Never during the run                            | Not needed             | Not in this chunk (`ops-console-proof`) | Merges the PR     |
| Developer (Adnan)         | Never during the run                            | Never                  | Never                                   | Never             |

The owner approves this plan after the independent assistant's check (AGENTS.md §2, §4).

## Global constraints

- The spec is approved and no task edits it. Refinements are listed in **Deviations from the spec** and repeated in the PR body.
- Work only in the worktree `C:\Recovered\Taftech\wt-ops-operator-oneoff` on branch `feat/2026-10-26-ops-operator-oneoff`. Commit locally; never push.
- No agent runs `terraform`, `aws`, `docker push`, or the one-off against any deployed environment. Runs start with no AWS credentials and pushes blocked.
- Staging stays parked. No task touches `infra/`, a Dockerfile, a workflow, `turbo.json`, any `package.json`, a `tsconfig*.json`, an ESLint config, a checker, a migration, or `modules/core/identity/public/index.ts` (the one exception: pin 10's weakening edits it temporarily and restores it exactly). No new dependency.
- No account id, ARN, real hostname, email address, secret name, secret value, enrolment code, token or IP address in any commit. Tests use synthetic UUIDs, `example.test` addresses, `ops.example.test`, synthetic ARNs of the existing test form (`arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-ab12CD`, as `provision-owner.test.ts:48` already uses), and synthetic base32 codes built in the test.
- **Existing tests:** no existing assertion is changed or removed. `provision-owner.test.ts` and `provision-owner.integration.test.ts` must pass unchanged after Tasks 1 and 2. The reviewer checks `git diff origin/main -- '*.test.ts'` shows only added lines.
- **Fixtures vs secret scanners:** no fixture string may look like a real AWS key, Stripe key or webhook secret; synthetic ARNs follow the existing test files' form only.
- **Identity key and operator rows in integration tests:** one `createLocalKmsPort()` per file and `delete from identity.identity_keys` in `beforeAll`; operator rows (`identity.operator_events`, `identity.operator_grants`) are deleted over the owner connection (`createPlaintextDirectSql(runtime.productOnlyUrl)`) in `beforeAll` and `afterAll` without swallowing errors, before any `delete from identity.users`.
- Only one run at a time uses the Docker test database. `apps/api` tests run against the built `@community-hub/identity` dist; run `pnpm --filter @community-hub/identity build` before `apps/api` tests whenever identity has changed (Task 5), and once at the start of Task 3 so `IdentityError` in the test and in `ops-operator.ts` is the same class.
- **Known Windows exceptions:** `packages/db/src/generate.test.ts` (ENOENT spawning `drizzle-kit`) and occasional Windows-only timeouts in `migrate.integration`, `plaintext-dist` and identity "forty parallel wrong guesses". They pass on Linux CI. `image.test.ts` image cases run only with `RUN_IMAGE_TESTS=1` (CI Stage 3 sets it); locally they are skipped, which is expected.
- Before the PR: `pnpm turbo run test --force --continue`, then `pnpm gate`, with only the exceptions above. LF line endings.
- **Implementer runs have a hard time limit:** append each weakening's result to the task report as you see it, and commit as soon as the gate passes.
- Second fresh-context review is required (secrets and operator access). The owner's assistant starts it when the PR opens.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed. Reports go to `.superpowers/sdd/task-N-report.md`.

## Deviations from the spec (repeated in the PR body)

1. **Pin 11 is verified in CI only.** The image-presence test runs with `RUN_IMAGE_TESTS=1` (CI Stage 3, `.github/workflows/ci.yml:161`, `:283`); locally it is skipped, so its weakening is reasoned, not run, and the reviewer confirms it in CI.
2. **The entry point's wiring is tested through a small pure helper.** `opsRpIdFrom(env)` (lower-cases `OPS_HOSTNAME`) is unit-tested; that the entry point opens only the identity connection and ends it in `finally` is checked by the reviewer by reading, as for `provision-owner` (which has the same gap).
3. **Task 4 is test-only.** Its tests pass against Task 3's code on arrival; each pin's weaken-fail-restore run is the RED step.

## Security pins

The implementer weakens the source once as described, sees the named test fail, restores the source, and reports the failure output in the task report. A weakened tree is never committed. Spec pin numbers in brackets.

| #   | Setting (spec pin)                                   | Test that pins it (Task)                                                                                                                                                                                                                                                                                                                                                                                                      | Weakening that must make it fail                                                                        |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `ops-operator` shape refusal before any query (1)    | `ops-operator.test.ts` "refuses malformed payloads with shape before any query" (T3): each malformed payload in the spec's pin 1 → stderr `shape`, and the mocked identity functions and the `identity` connection fake record no call                                                                                                                                                                                        | Accept an unknown key inside `opsOperator`                                                              |
| 2   | `provision-owner` refuses `opsOperator` payloads (2) | `provision-owner.test.ts` \"refuses a payload carrying opsOperator with shape\" (T2): `{opsOperator: {...}}` alone, and valid owner fields plus `opsOperator`, each → `shape`, with `findOrganisationBySlug`, `findOrCreateUserByEmail` and `bootstrapOwner` `not.toHaveBeenCalled`                                                                                                                                           | Remove the `Object.hasOwn(value, "opsOperator")` check                                                  |
| 3   | Only fixed words on every outcome (3)                | `ops-operator.test.ts` "prints only fixed words" (T3): injected `IdentityError`, a database error whose message contains the test address, and an `Error` whose message contains the test code; stdout and stderr equal the expected word, and contain neither value                                                                                                                                                          | In `runOpsOperatorMain`'s catch, write `String(error)` to stderr instead of `fail`                      |
| 4   | Wrong ARN → `env`, secret never read (4)             | `ops-operator.test.ts` "refuses a non-provision ARN without reading the secret" (T3): `readSecret` spy not called                                                                                                                                                                                                                                                                                                             | Read the secret before checking the ARN                                                                 |
| 5   | `revoke` / `recover` never create a user (5)         | `ops-operator.integration.test.ts` "revoke and recover for an unknown address print user and create no user" (T4): `count(*)` of `identity.users` over the owner connection is the same before and after                                                                                                                                                                                                                      | Use `findOrCreateUserByEmail` for `revoke`                                                              |
| 6   | Pre-check prevents a stray user (6)                  | `ops-operator.integration.test.ts` "grant with a bad role key, a duplicate or a bad code prints refused and creates no user" (T4): `count(*)` of `identity.users` over the owner connection is the same before and after                                                                                                                                                                                                      | Skip the B3a pre-check                                                                                  |
| 6b  | Pre-check matches identity (B3a)                     | `ops-operator.integration.test.ts` "the pre-check agrees with grantOperator" (T4): samples `A`×26, `A`×25, `A`×128, `A`×129, lower-case `a`×26, hyphenated and spaced 26-character codes, a code with `=`, one with `0`, one with `ß`; role lists `[platform_admin]`, `[]`, a duplicate, an unknown key; each gives the same accept/refuse result through the pre-check and through `grantOperator` (a fresh user per sample) | Lower the pre-check's code floor to 25                                                                  |
| 7   | Any `IdentityError` → `refused` (7)                  | `ops-operator.test.ts` "maps every IdentityError code to refused" (T3): each of `invalid_email`, `email_unavailable`, `invalid_ceremony`, `invalid_grant`                                                                                                                                                                                                                                                                     | Map only `invalid_grant` to `refused`                                                                   |
| 8   | Conflicting grant → `refused`, nothing changed (8)   | `ops-operator.integration.test.ts` "a second grant for an open role prints refused and changes nothing" (T4): grant and event counts unchanged                                                                                                                                                                                                                                                                                | Treat `invalid_grant` from `grantOperator` as success                                                   |
| 9   | One `signed_out` per ended session (9)               | `operator.integration.test.ts` "ending a session twice writes one signed_out" (T5), beside the existing `:4032` test                                                                                                                                                                                                                                                                                                          | Append `signed_out` without checking the update's returned rows                                         |
| 10  | Helpers never exported from `public/` (10)           | `modules/core/identity/infrastructure/operator-exports.test.ts` "does not export the internal operator helpers" (T5): `import * as ns from "../public/index.js"`, asserts `Object.keys(ns)` contains neither name (the identity vitest config includes only `domain/`, `db/` and `infrastructure/` tests)                                                                                                                     | Re-export `lockOperatorUser` from `public/index.ts` (restored at once; the file is otherwise untouched) |
| 11  | The image ships `/app/ops-operator.js` (11)          | `image.test.ts` "ships ops-operator" (T3), runs in CI only (deviation 1)                                                                                                                                                                                                                                                                                                                                                      | Reasoned only: removing `ops-operator.ts` would make the `existsSync` check exit 1                      |

Regression (not a weakening): `provision-owner`'s unit and integration suites pass unchanged after Tasks 1 and 2.

## Rollback

| Point        | Rollback                                                                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before merge | Revert with new commits.                                                                                                                                                                                                          |
| After merge  | Revert the merge. No migration, no infrastructure or secret change. The one-off is run only by the owner, by hand; until then nothing calls it. `provision-owner` behaviour is unchanged for every payload without `opsOperator`. |

## Stop and ask (AGENTS.md §12)

Implementer, stop and report if:

- the plan or spec is wrong or ambiguous, or a test cannot be written as described;
- a change is needed in a forbidden file (Global constraints), including `modules/core/identity/public/index.ts`;
- an existing test assertion needs changing;
- the same step fails twice; or a command fails to start (process creation error): report which steps remain, retry at most once.

---

### Task 1: Move the one-off failure classification to a shared module

**Files:** Create `apps/api/src/one-off-failure.ts`, `apps/api/src/one-off-failure.test.ts`. Modify `apps/api/src/provision-owner.ts` (import instead of define).

**Shape (spec Scope, B1, B5):** move unchanged `PROVISION_SECRET_ARN` (`provision-owner.ts:34-36`), `CONNECT_CODES` (`:37-51`), `isKmsFailure`, `isConnectionError` and `classify` (`:85-122`) into `one-off-failure.ts`, exported, with the `sqlstate` import from `./db-ops-error.js` that `classify` needs; `provision-owner.ts` imports them. No behaviour change.

**Test first (RED):** `one-off-failure.test.ts`: `classify` returns `kms\n` for `Error("kms_failed")`, `connect 08006\n` for an error with that SQLSTATE, `connect\n` for `ECONNREFUSED` (also one level down in `cause`), `fail\n` otherwise; `PROVISION_SECRET_ARN` accepts the test ARN form and rejects a different suffix, a wrong service and a trailing space. Fails until the module exists.

**Rule this must not break:** `provision-owner.test.ts` and `provision-owner.integration.test.ts` pass unchanged.

**Commit subject:** `refactor(api): share the one-off failure classification`

- [ ] RED, GREEN (pure move).
- [ ] `pnpm --filter @community-hub/api test`, `pnpm gate`.

### Task 2: `provision-owner` refuses `opsOperator` payloads

**Files:** Modify `apps/api/src/provision-owner.ts`, `apps/api/src/provision-owner.test.ts`.

**Shape (spec B3):** `parseSecret` becomes three-way: not JSON, `null`, an array or another non-object → `secret`; an object with an own `opsOperator` key → `shape` (checked with `Object.hasOwn`); then the existing field checks → `secret` or the input. `runProvisionOwner` returns `failed("shape\n")` for the second case, before any lookup. `ProvisionOwnerResult` stays as is (`stderr: string`).

**Test first (RED):** pin 2; plus `null`, `[]` and `"text"` secrets still give `secret`.

**Rule this must not break:** every existing `provision-owner` assertion.

**Commit subject:** `feat(api): refuse ops-operator payloads in provision-owner`

- [ ] RED, GREEN. Pin 2.
- [ ] `pnpm --filter @community-hub/api test`, `pnpm gate`.

### Task 3: `ops-operator` — parsing, pre-check, actions and output

**Files:** Create `apps/api/src/ops-operator.ts`, `apps/api/src/ops-operator.test.ts`. Modify `apps/api/src/image.test.ts` (add "ships ops-operator" beside "ships provision-owner", same form).

**Shape (spec B1–B5):**

- `export type OpsOperatorDeps = { source: NodeJS.ProcessEnv; readSecret: (arn: string) => Promise<string>; identity: Sql; kms: KmsPort; keyArn: string; opsRpId: string; now: () => Date; newId: () => string }` (`Sql` taken from a db export as `provision-owner.ts` does).
- `export type OpsOperatorResult = { exitCode: 0 | 1; stdout: "" | "granted\n" | "revoked\n" | "recovered\n"; stderr: string }`.
- `runOpsOperator(deps)`, in order: ARN check (`env`; `readSecret` not called) → read and JSON-parse (`secret`, including `null`, arrays and non-objects) → structure check per B2 (`shape`) → for `grant` / `recover` the B3a pre-check (`refused`) → the action per B4 (`findOrCreateUserByEmail` + `grantOperator`; `findUserByEmail` → `user` or `revokeOperator` / `recoverOperator`), each identity call given `requestId: deps.newId()`, `opsRpId: deps.opsRpId`, `now: deps.now()` → success word. Errors: any `IdentityError` → `refused`; otherwise `classify(error)` from `one-off-failure.ts`.
- `runOpsOperatorMain(deps & { run? })`: any throw → `fail\n`.
- B3a pre-check: the three role keys written literally (`platform_admin`, `platform_support`, `platform_security`), no duplicates, non-empty; the code `replace(/[ -]/g, "")` then `^[A-Za-z2-7]{26,128}$` (no `\s`, matching `modules/core/identity/domain/enrolment-code.ts`).
- `export function opsRpIdFrom(env: { OPS_HOSTNAME: string }): string` returns it lower-cased (deviation 2).
- Entry point (guarded as `provision-owner.ts:251-252`): read `IMAGE_CERT_PATH` (`env` on failure), `readServiceEnv` (`env` if not ok), create **only** the identity connection and the AWS KMS port, `opsRpId = opsRpIdFrom(env)`, run `runOpsOperatorMain`, `finally` end the identity connection, write stdout and stderr, exit with the code.

**Test first (RED):** first `pnpm --filter @community-hub/identity build`. `ops-operator.test.ts` mocks `@community-hub/identity` with `vi.mock(..., async (importOriginal) => ({ ...(await importOriginal()), findUserByEmail: vi.fn(), findOrCreateUserByEmail: vi.fn(), grantOperator: vi.fn(), revokeOperator: vi.fn(), recoverOperator: vi.fn() }))`, so `IdentityError` stays the real class and tests throw `new IdentityError(code)` from it; it passes an `identity` connection fake that records any call. Tests: pins 1, 3, 4, 7; plus each action's success word with the right identity function called once with the right inputs (`opsRpId`, a `requestId` from `newId`, roles, code); `revoke` with `roleKeys` → `shape`; unknown user on `revoke` and `recover` → `user`; B3a refusals (unknown role, duplicate, 25-character code, a code with `=`) → `refused` with no identity call; the backstop maps a throwing `run` to `fail`; `opsRpIdFrom` lower-cases.

**Rule this must not break:** nothing else in `apps/api` changes; no address, code, user id or role key ever reaches stdout or stderr.

**Commit subject:** `feat(api): add the ops-operator one-off`

- [ ] RED, GREEN. Pins 1, 3, 4, 7 (and 11 added, CI only).
- [ ] `pnpm --filter @community-hub/api test`, `pnpm gate`.

### Task 4: `ops-operator` against the test database

**Files:** Create `apps/api/src/ops-operator.integration.test.ts`.

**Shape:** real identity functions, the identity-role connection to the test database, the local KMS port, a fixed `opsRpId` `ops.example.test`. Follow Global constraints for key reset and operator-row cleanup.

**Test first (deviation 3: test-only task; each weakening is the RED step):** pins 5, 6, 6b, 8 (pin 8: grant a role, then grant the same role again → `refused`, grant and event counts unchanged); plus: `grant` for a new address → `granted`, one `identity.users` row for its blind index, open grants for the named roles, `granted` events carrying the run's `requestId`; `revoke` → `revoked` and the grants revoked; `recover` → `recovered`, a `recovery_regrant` event and new open grants; a malformed address → `refused` (`invalid_email`) and no user. These pass against Task 3's code; the weakenings prove each pins its setting.

**Rule this must not break:** other integration suites in `apps/api` (shared database per run; assert only on this file's rows).

**Commit subject:** `test(api): exercise ops-operator against the database`

- [ ] Write, run, weaken (pins 5, 6, 6b, 8), restore.
- [ ] `pnpm --filter @community-hub/api test` (unit and integration), `pnpm gate`.

### Task 5: Identity follow-ups from PR #62 (last code task)

**Files:** Modify `modules/core/identity/infrastructure/operator.ts`, `modules/core/identity/infrastructure/operator.integration.test.ts`. Create `modules/core/identity/infrastructure/operator-exports.test.ts`.

**Shape (spec B8, B9):**

- `endOperatorSession`: keep the family advisory lock; the family update becomes `… returning id`; append `signed_out` only when it returned at least one row.
- `lockOperatorUser` and `appendOperatorEvent`: a doc comment on each: internal to identity, exported only for tests, never re-exported from `public/`.
- `operator-exports.test.ts`: `import * as ns from "../public/index.js"`; assert `Object.keys(ns)` includes neither name.

**Test first (RED):** pin 9 (fails on today's code: ending twice writes two `signed_out`); pin 10 (passes today; the weakening proves it). The existing `:4032` test passes unchanged.

**Rule this must not break:** every identity suite; `public/index.ts` unchanged.

**Commit subject:** `fix(identity): write signed_out once and document test-only helpers`

- [ ] RED, GREEN. Pins 9, 10.
- [ ] `pnpm --filter @community-hub/identity build`, identity tests, `apps/api` tests, `pnpm gate`.

### Task 6: The operator runbook

**Files:** Create `docs/runbooks/ops-operator.md`. Modify `docs/runbooks/apply-staging-au.md` (one link sentence at the start of the "Provision the first owner" section, `:179`, pointing to the new runbook and stating the two tools share one secret name and never run at the same time).

**Shape (spec B6, B7):** model on `apply-staging-au.md:179-281` (zsh; shell variables and placeholders only; never an account id, ARN, hostname, resolved secret name, address or code). Sections:

1. **Purpose and safety**: owner only; one fixed secret name shared with `provision-owner`; never run the two at the same time; the secret is deleted after every run whatever the outcome; no live value is ever pasted into evidence.
2. **Prerequisites**: the service image with `ops-operator.js` deployed; a working database with migrations applied; `aws`, `jq`, and `python3` (on macOS from the Command Line Tools); the shell variables the provision-owner section uses.
3. **Check the name is free**: `aws secretsmanager describe-secret … 2>&1 >/dev/null | grep -q ResourceNotFoundException` must succeed (nothing printed); if the secret exists, or the error is anything else (credentials, profile, region), stop.
4. **Generate the enrolment code** (grant and recover only): `ENROLMENT_CODE=$(python3 -c 'import base64,os;print(base64.b32encode(os.urandom(20)).decode())')`; `print -r -- "${ENROLMENT_CODE}"` once so the owner can pass it to the operator through their own channel; then clear the screen and scrollback in the same tab (Cmd-K in Terminal.app and iTerm, or `printf 'c'` plus the terminal's own clear-scrollback command), so `ENROLMENT_CODE` stays set for **Create**. The code goes to the operator out of band only and is never pasted into evidence.
5. **Create**: prompt with `read -rs` followed by `print` (as the provision-owner section does) for the address and, for grant and recover, the role keys as a comma-separated list. Write out three `jq -n` variants: grant and recover `--arg a grant|recover --arg e "${OPERATOR_EMAIL}" --arg r "${ROLE_KEYS}" --arg c "${ENROLMENT_CODE}" '{opsOperator: {action: $a, email: $e, roleKeys: ($r | gsub("\\s"; "") | split(",")), enrolmentCode: $c}}'`; revoke `'{opsOperator: {action: "revoke", email: $e}}'`. Pipe to `aws secretsmanager create-secret --kms-key-id ${SECRETS_KEY_ARN} --secret-string file:///dev/stdin >/dev/null`. A failed `create-secret` is **stop**, not retry, and still `unset` the variables. Always end with `unset OPERATOR_EMAIL ROLE_KEYS ENROLMENT_CODE`.
6. **Run**: hold the ARN from a read-only describe; `aws ecs run-task` override of the service task definition with `command: ["node","/app/ops-operator.js"]` and `PROVISION_SECRET_ARN`; wait; read the exit code and stopped reason; read the one log stream (same commands as the provision-owner section).
7. **Results**: a table with every stdout and stderr word from spec B5, what it means and what to do, including: `revoked` does not prove a grant existed; `recover` for a user with no earlier grant acts as a grant plus `recovery_regrant`; `refused` covers a bad role key or code, a conflicting grant, and a malformed address; a `grant` refused after creating a user leaves that user, and re-running the same `grant` reuses it; the task-never-started row.
8. **Delete and verify**: force-delete without recovery; then the same `grep -q ResourceNotFoundException` check as step 3 must succeed (any other error: stop and check); unset the ARN.
9. **Grant an operator**, **Revoke an operator**, **Recover an operator**: each a short ordered list referencing the sections above, and what the operator does next (enrol on the ops host with an email code and the enrolment code within 24 hours; register two passkeys). **Recover** states ADR 0015: the owner alone; the old ops passkeys are deleted and the operator enrols two new ones; a `recovery_regrant` event is recorded; review by 2027-04-30 or when a second `platform_security` person joins.

**Test first:** none (docs). `pnpm gate` (format).

**Commit subject:** `docs(runbook): add the ops-operator runbook with recovery`

- [ ] Write; `pnpm exec prettier --write` the two files; `pnpm gate`.

### Task 7: Catalogue (last task on this branch)

**Files:** Modify `docs/roadmap.md` (the `ops-operator-oneoff` row **done** with the spec path; snapshot last shipped `ops-operator-oneoff`, next `ops-console-ui`; the "Next is" line and the Next spec sentence name `ops-console-ui`; Phase 0 counts unchanged) and `AGENTS.md` Repository state row (add `ops-operator-oneoff` to the done list; "Next is `ops-console-ui`.").

**Test first:** none (docs).

**Commit subject:** `docs: mark ops-operator-oneoff done`

- [ ] `rm -f docs/plans/*-report.md`; `git status --short` shows only this task's files.
- [ ] `pnpm turbo run test --force --continue`, then `pnpm gate` (Windows exceptions only).

## Definition of done (AGENTS.md §8)

- All seven tasks committed, each reviewed by diff with its security pins reported.
- Local full test run and `pnpm gate` green apart from the Windows exceptions; CI green on the PR, including the image tests (pin 11).
- No file under `infra/`, `.github/`, any Dockerfile, or `modules/core/identity/public/index.ts` changed; no existing assertion changed.
- Staging parked. Staging verification: none in this chunk; `ops-console-proof` runs the runbook on staging. Stated in the PR body.
- Runbook, roadmap and `AGENTS.md` updated in this PR; roadmap last.
- The PR body lists the implementer and reviewer configurations, the owner's check, the second-review line, the deviations, and the changed-line count (estimate about 1,000–1,250 including tests and the runbook; the owner accepted the overrun).
- No `docs/plans/*-report.md` on disk, and nothing under `.superpowers/` staged.

## Probe record

No Terraform in this chunk; no probe needed (AGENTS.md §4 Phase 2).
