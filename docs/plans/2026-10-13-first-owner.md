Spec: docs/specs/2026-10-13-first-owner.md
Status: approved (2026-10-13, Adnan Bin Hossen)

# Plan: First organisation owner provisioning

Migration wave: none. No schema change in this chunk.

Cost and parking: this chunk does not unpark staging — the Terraform change (task 5) applies while parked, and the one thing that costs money, the provisioning secret, is USD 0.40/secret/month prorated, in practice a fraction of that since it exists only for the duration of one run.

Rollback: revert the commit. No destructive DDL to undo. If an organisation, community, identity user, or role grant were created in error during manual testing, remove them by hand (role-grant rows, then the community row, then the organisation row, then the identity user). The Terraform change (task 5) is reverted by removing the one added IAM statement and the one added KMS key policy pattern — nothing depends on them until this chunk's code ships, so there is no live-traffic risk to a revert.

Parallelism note: tasks 1, 2, 3, and 5 touch disjoint files (`core/tenancy`, `core/access`, `core/identity`, `infra/modules/*` respectively) and may be dispatched to separate implementers in parallel per AGENTS.md §5. Task 4 depends on 1–3. Task 6 depends on 4 and 5. Task 7 is last, always.

---

## Task 1 — `core/tenancy`: `findOrganisationBySlug`

Files: `modules/core/tenancy/infrastructure/implicit-organisation.ts`, `modules/core/tenancy/infrastructure/implicit-organisation.integration.test.ts`, `modules/core/tenancy/public/index.ts`.

**Test first (RED):** add a case to the existing integration test file asserting `findOrganisationBySlug(sql, slug)` returns `null` for an unknown slug, and `{ id, slug, region, kind }` for a slug created via `createImplicitOrganisation` — mirroring the existing `findCommunityBySlug` test cases in the same file.

**Implementation (GREEN):** add `findOrganisationBySlug`, reading `platform.organisations` by `slug`, same shape and `isSlug` guard as `findCommunityBySlug` (lines 53-76 of the same file). Export it from `modules/core/tenancy/public/index.ts` alongside `findCommunityBySlug`.

**Rule pinned:** §6.3 — the new read stays inside `core/tenancy`'s own infrastructure file and is reached everywhere else only through the module's public barrel.

---

## Task 2 — `core/access`: existing-owner lookup

Files: `modules/core/access/infrastructure/grants.ts`, `modules/core/access/infrastructure/grants.integration.test.ts`, `modules/core/access/public/index.ts`.

**Test first (RED):** add a case asserting the new export returns `null` inside a fresh app transaction with no grants, and returns `{ userId }` matching the `user_id` just granted once `bootstrapOwner` has run in that same org/community — in both directions (organisation-level grant only is unreachable in practice since `bootstrapOwner` always inserts both together, but write the assertion against whichever table actually holds the row, the same way `countSettingRows` checks both).

**Implementation (GREEN):** add a function (e.g. `findOwner(tx: AppTransaction): Promise<{ userId: string } | null>`) that selects `user_id` from `app.organisation_role_grants` scoped by `current_setting('app.org_id')`, falling back to `app.community_role_grants` scoped by `app.org_id` + `app.community_id` if the first has no row. Note: `countSettingRows` (lines 150-168) only counts **one** table per call, parameterized by its `table` argument — it has no built-in two-table check of its own. The OR-of-two-calls logic the new function needs is the shape `bootstrapOwner` builds on top of `countSettingRows` (lines 262-264: `organisationGrants > 0 || communityGrants > 0`), not something `countSettingRows` already does. Write `findOwner` as its own two-query function (it can still call `countSettingRows`-style single-table queries internally, or two bespoke `select user_id from … limit 1` queries), not as a thin wrapper expecting existing OR logic to already be there. Export it from `modules/core/access/public/index.ts`.

**Rule pinned:** Rule 2 — reads through the same `current_setting('app.org_id'/'app.community_id')` pattern every other access-module function already uses inside an app-scoped transaction; no raw pool access.

---

## Task 3 — `core/identity`: `findUserByEmail` and `findOrCreateUserByEmail`

Files: `modules/core/identity/infrastructure/identity-user.ts`, `modules/core/identity/infrastructure/email-otp.ts`, a shared internal helper (new, e.g. `modules/core/identity/infrastructure/email-lookup.ts`), their tests, `modules/core/identity/public/index.ts`.

**Why a shared helper, not a parallel reimplementation:** `verifyEmailOtp` already derives the blind index and looks up `identity.users` by `email_bidx` inline (`email-otp.ts` lines 142-143 and 173-176). The spec requires the new exports to use "the same lookup," not an equivalent one — so this task first extracts that derivation (the `bidxKey` call plus the `hmac(... "identity.users.email" ...)` step) into one internal helper that both `email-otp.ts` and `identity-user.ts` call, closing off any chance of the two paths drifting apart later. This refactor is covered by the existing OTP tests continuing to pass unchanged.

**Test first (RED):**

- Unit/integration test: `findUserByEmail(sql, kms, keyArn, { email })` returns `null` when no row exists, and the existing row's `{ userId }` when one does — asserted with a mixed-case, whitespace-padded variant of an email already inserted via `insertIdentityUser`, to pin the normalisation requirement directly at this layer.
- Unit/integration test: `findOrCreateUserByEmail` creates a new row when absent (same shape `insertIdentityUser` already returns), returns the existing `userId` when present (no duplicate row), and — reusing the existing `isUsersEmailConflict` race handling `verifyEmailOtp` already has (lines 183-194) — resolves to the winning row rather than throwing when two calls race on the same new email.

**Implementation (GREEN):** extract the shared blind-index helper; add `findUserByEmail` (read-only, no insert) and `findOrCreateUserByEmail` (wraps `insertIdentityUser` on the create path) to `identity-user.ts`; refactor `verifyEmailOtp` to call the same shared helper (behaviour-preserving — its own tests must stay green with no changes to their assertions). Export both new functions from `modules/core/identity/public/index.ts`.

**Note on the helper's shape:** `email-otp.ts`'s current `bidxKey()` (lines 59-71) discards the `enc` half of `deriveKeys(hkdfKey)` and returns only `.bidx`, because `verifyEmailOtp` never needs to encrypt anything. `insertIdentityUser` (`identity-user.ts:25-58`) needs **both** `enc` (to encrypt the email) and `bidx` (for the blind index) from that same `deriveKeys` call. If the shared helper is modelled narrowly on `bidxKey()` as a bidx-only extraction, wiring it into the create path would force a second, redundant key-unwrap round trip just to get `enc` back. Design the shared helper to return both `{ enc, bidx }` (i.e. extract the `ensureIdentityKey` → select → `unwrapKmsRoot` → `deriveKeys` chain as one unit), and have `verifyEmailOtp`'s own lookup simply use the `.bidx` half of that same result — not the reverse.

**Rule pinned:** §6.3 — identity-schema reads and writes stay inside `core/identity`.

---

## Task 4 — `apps/api`: the `provision-owner` entrypoint

Files: `apps/api/src/provision-owner.ts`, `apps/api/src/provision-owner.test.ts`, `apps/api/src/provision-owner.integration.test.ts`, `apps/api/src/image.test.ts`.

Follows the `db-bootstrap.ts` / `db-migrate.ts` shape: a `runProvisionOwner(deps)` function returning `{ exitCode, stdout, stderr }`, with the only code touching `process`/`console` at the bottom `if (entry === pathToFileURL(...))` dispatch block. Reads `PROVISION_SECRET_ARN` only — no other env var, no argv.

**Order of operations** (this is the fix for the different-email race described in the spec's Risks and Problem):

1. Validate `PROVISION_SECRET_ARN` names the one fixed secret (`${name}-provision-owner-??????`, matching the Terraform naming from task 5); fetch and parse its JSON. Missing/wrong-name ARN → `env`. Unreadable or missing-field JSON → `secret`.
2. Resolve organisation and community via task 1's `findOrganisationBySlug` and the existing `findCommunityBySlug`. Neither exists → create both via `createImplicitOrganisation`. Both exist and match → proceed. Anything else (mismatch, or one exists without the other) → `organisation`, nothing created.
3. Inside an app-scoped transaction for the resolved org/community (`withAppTransaction` or equivalent — never session-level `SET`), call task 2's existing-owner lookup.
   - No owner: call task 3's `findOrCreateUserByEmail`, then `bootstrapOwner(tx, { now, userId, actorUserId: userId })`. Stdout `created`.
   - An owner exists: call task 3's `findUserByEmail` (read-only — never the create path). Resolves to the same `userId` as the owner → stdout `already_bootstrapped`, nothing created. Resolves to a different `userId`, or to no row at all → stderr `owner`, nothing created.
4. `kms` on an envelope-key failure; `connect` / `connect <SQLSTATE>` on a database connection failure; `fail` for anything else. Never print the secret's contents, the resolved ids, or any part of the email, on either stream, in either outcome.

**Audit trail note (document in the commit, write no new code for it):** `bootstrapOwner`'s own `appendAuditEvent` call already records `actorId: actorUserId`, and `bootstrapOwner` requires `actorUserId === userId` — so the audit log already shows the new owner as the grantor of their own role. This chunk adds no second audit trail. The record of _who ran the provisioning task_ is CloudTrail's `RunTask` event for the one-off, not this application audit log — the same split the staging proof run already relies on for every other ops one-off.

**Test first (RED), unit (mocked dependencies):** one case per stdout/stderr row in the spec's Behaviour tables, including the wrong-secret-name case under `env` and the different-email case under `owner`.

**Test first (RED), integration (real test database):**

- Fresh run: `created`; organisation, community, identity user, and both role grants now exist.
- Second run, same email: `already_bootstrapped`; no new row anywhere (organisation, community, identity, or grants).
- Second run, **different** email: exit 1, `owner`; no new `identity.users` row. **This is the regression pin for the bug this spec's revision fixed** — assert the row count on `identity.users` is unchanged, not just the exit code.
- Mismatched community/organisation slugs: `organisation`; nothing created.
- Mixed-case email: provision with `Ada@Example.com`, then resolve the same address through the existing OTP sign-in integration test path (however `identity-otp`'s own tests already simulate a sign-in) using `ada@example.com`; assert the same `userId` and exactly one `identity.users` row.
- Tenant isolation: provision organisation A's owner; assert the existing tenant-isolation suite's cross-org assertions hold for the new rows (org B's session cannot see or act on org A's grants).

**Also in this task — image test (RED first):** add `it("ships provision-owner", ...)` to `apps/api/src/image.test.ts`. The only standalone "ships" precedent in that file is `it("ships db-migrate and the product migrations", ...)` (line 461), which also checks the journal-tag list and is doing more than this new test needs — the new test should be a simpler single `existsSync("/app/provision-owner.js")` check via the same `docker run ... node -e` probe mechanism, not a literal line-for-line mirror of that larger test. **No Dockerfile change** — `tsc -p tsconfig.emit.json` already compiles every file under `apps/api/src`, so this test is written to fail only because `provision-owner.ts` doesn't exist yet, not because of any build-list wiring; once the entrypoint lands in this same commit, it passes.

---

## Task 5 — Terraform: one fixed secret name

Files: `infra/modules/aws-db-secrets/main.tf`, `infra/modules/aws-db-secrets/tests/secrets.tftest.hcl`, `infra/modules/aws-kms-envelope/main.tf`, `infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl`.

No new Terraform input variable anywhere — both modules already carry `var.name`, `var.aws_region`, and `var.aws_account_id`, which is everything needed to construct the one fixed pattern inline, the same way the three existing patterns are already built inline rather than passed in as a variable.

**Test first (RED):**

- In `envelope.tftest.hcl`'s `run "happy"` block, add an assert mirroring the existing one at lines 353-364: the `task_secrets` policy contains a `secretsmanager:GetSecretValue` statement whose `Resource` is exactly `"arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-??????"` (same mock account id and `name` the file's `run "happy"` block already uses), and that string is neither `"*"` nor equal to any of the three existing role-secret ARNs.
- In `secrets.tftest.hcl`, add an assert that `aws_kms_key.secrets`'s policy contains that same fixed pattern inside the `SecretsManagerUse` statement's `kms:EncryptionContext:SecretARN` `StringLike` list, alongside (not replacing) the three existing patterns.

Run both updated test files and confirm they fail against the current `main.tf` in each module before making any source change.

**Implementation (GREEN):**

- `infra/modules/aws-db-secrets/main.tf`: add one line to the existing `StringLike` list (after the `-platform-??????` entry): `"arn:aws:secretsmanager:ap-southeast-2:${var.aws_account_id}:secret:${var.name}-provision-owner-??????"`.
- `infra/modules/aws-kms-envelope/main.tf`: add one new statement object to `aws_iam_role_policy.task_secrets`'s `Statement` list (not to `execution_secrets` — that policy backs ECS-native `secrets` injection for the three role passwords, unrelated to this app-level fetch):
  ```
  {
    Sid      = "ReadProvisionSecret"
    Effect   = "Allow"
    Action   = ["secretsmanager:GetSecretValue"]
    Resource = "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.name}-provision-owner-??????"
  }
  ```
  **Correction, checked against the real file:** this is _not_ "written the same way as the three existing patterns" in `task_secrets` — those three (`Resource = var.db_secret_arns`, lines 352-372) are a variable holding concrete, already-resolved ARNs populated from `infra/regions/au/main.tf:162-166` (`module.db_secrets.app_secret_arn` etc.), not inline wildcard-pattern strings anywhere in this file. The `-??????` wildcard-pattern style this new statement actually borrows from exists only in the **sibling module**, `aws-db-secrets/main.tf`'s `StringLike` condition. Introducing a literal wildcard string into `task_secrets` is new ground for this specific file — very likely fine (IAM natively matches `?`/`*` wildcards directly in a `Resource` string, no `Condition` block needed, the same mechanism `StringLike` uses), but it is not a line-for-line mirror of an existing statement the way the `aws-db-secrets` change is. Treat this with the same caution as the scratch-probe gap below: confirm it plans cleanly before treating task 5 as low-risk.
- No change to `db_ops` anywhere in `infra/regions/au/main.tf` or its tests.

Run both test files again and confirm they pass.

**Note on the pre-approval scratch probe:** AGENTS.md §4 asks for this plan's proposed Terraform asserts to be run in a scratch probe, with `override_during = plan`, outside the repo, before the plan is sent for approval. I could not do that here — this environment has no `terraform` binary installed. The assert above is a structural mirror of the already-passing assert at `envelope.tftest.hcl:353-364` (same statement, same `mock_provider`/`run "happy"` scaffolding, same string-comparison style), differing only in which `Resource` string it checks, which reduces but does not eliminate the risk that it has a syntax or scoping mistake. **Before this task is marked approved, either run `terraform test` in `infra/modules/aws-kms-envelope` and `infra/modules/aws-db-secrets` yourself and confirm the new asserts fail cleanly (not error) against current `main.tf`, or accept that the implementer's own RED step in this task is the first real execution.** Flagging this rather than claiming a probe that didn't happen.

---

## Task 6 — Runbook: provisioning section

Files: `docs/runbooks/apply-staging-au.md`.

Docs-only; no test. Reviewed for the same redaction rules as the rest of the file: shell variables only, never an account id, ARN, or hostname pasted into the file.

New section, after **Apply product migrations** and modelled on that section's structure, with three steps in order:

1. **Create.** The operator is prompted for each value — never types it as a command-line argument, never has it land in shell history as typed command text:
   ```
   read -r -p "Organisation slug: " ORG_SLUG
   read -r -p "Community slug: " COMMUNITY_SLUG
   read -r -p "Owner email: " OWNER_EMAIL
   jq -n --arg o "${ORG_SLUG}" --arg c "${COMMUNITY_SLUG}" --arg e "${OWNER_EMAIL}" \
     '{organisationSlug: $o, communitySlug: $c, email: $e}' \
     | aws secretsmanager create-secret --profile ${AWS_PROFILE} \
       --name ${PROVISION_SECRET_NAME} --secret-string file:///dev/stdin
   unset ORG_SLUG COMMUNITY_SLUG OWNER_EMAIL
   ```
   The JSON is built and piped straight into `create-secret`, not `put-secret-value` — this secret is never Terraform-managed and is fully destroyed by step 3's `--force-delete-without-recovery` every cycle, so it does not exist when Create runs again; `put-secret-value` only writes a new version to an _existing_ secret and would fail with `ResourceNotFoundException`. (Proof 7b's own `put-secret-value` usage is a different, Terraform-managed secret that already exists — not a precedent here.) Nothing is echoed, printed, or assigned to a variable that gets printed. `${PROVISION_SECRET_NAME}` is the one fixed name from task 5.
2. **Run.** `aws ecs run-task` on the service task definition (same network pattern as the existing proof one-offs: task security group, staging public subnet, public address), command override `["node", "/app/provision-owner.js"]`, environment override `PROVISION_SECRET_ARN=<arn>`, `entryPoint` not set. Then the existing **After a service-container one-off** triad (`wait tasks-stopped`, `describe-tasks` for exit code, `get-log-events` for stdout/stderr).
3. **Delete and verify.**
   ```
   aws secretsmanager delete-secret --profile ${AWS_PROFILE} \
     --secret-id ${PROVISION_SECRET_NAME} --force-delete-without-recovery
   aws secretsmanager describe-secret --profile ${AWS_PROFILE} \
     --secret-id ${PROVISION_SECRET_NAME}
   ```
   The `describe-secret` call is expected to fail (secret not found) — that failure is the confirmation the secret is gone, so this and only this one-off's "success" is an error from AWS, not a clean result. Record that it failed as expected; do not record the error body.

Note in this section, matching the spec's Definition of done: this runbook section is written and reviewed in this chunk, but its first live execution on `staging-au` is deferred to the email chunk's own staging run.

---

## Task 7 — Catalogue (last task on this branch)

Files: `docs/roadmap.md`.

Add a `first-owner` row under Phase 1 (status **done**), and update the "Where we are" snapshot's next-chunk line to read first-owner → email (SES) → stripe-billing. One commit, no test — this is the catalogue commit the lifecycle requires before a PR can open.

**PR body reminder:** AGENTS.md §8's definition of done lists "Spec's behaviour verified on the staging hostname, not just tests" as a per-chunk requirement. This chunk deliberately defers that live run to the email chunk (spec Definition of Done). That is not a silent gap — the spec names it with its own rationale — but the PR body must say so explicitly (the same way the spec's precedence note requires departures to be stated), not leave it implicit.

---

## Security pins (carried from the spec's Tests section)

| Setting                                                                                   | Test                                                                | Source change that must make the test fail                                | Task |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---- |
| A second run naming a different email than the existing owner refuses and creates nothing | Integration test, task 4                                            | Checking only grant existence, not whether it matches the named email     | 4    |
| A second run with the same email is a no-op                                               | Integration test, task 4                                            | Removing the existing-owner check or the organisation/community pre-check | 4    |
| Command refuses when the community belongs to a different organisation                    | Integration test, task 4                                            | Comparing community existence only, not its resolved `organisationId`     | 4    |
| Email matching uses the same normalisation and lookup as OTP                              | Integration test, task 4 (depends on the shared helper from task 3) | Using a different normalisation or a separate lookup path                 | 3, 4 |
| Email never reaches a command/env override or stdout/stderr                               | Unit test, task 4                                                   | Adding an email-bearing CLI arg or env var                                | 4    |
| Tenant isolation                                                                          | Integration test, task 4                                            | Removing `org_id` scoping on the new writes                               | 4    |
| The new IAM statement's resource is exactly one fixed secret name                         | Terraform test, task 5                                              | Widening the statement's `Resource`                                       | 5    |
| The compiled entrypoint ships in the image                                                | Image test, task 4                                                  | Removing the file from build output without failing a test                | 4    |
