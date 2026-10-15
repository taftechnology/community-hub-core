Spec: docs/specs/2026-10-15-ses-sign-in-proof.md

# SES sign-in proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unpark staging on the image published for the `email-provider` merge. Provision the first owner, prove a real sign-in through SES (P1–P5), and re-park before the pull request opens.

**Architecture:** Six agent commits: four documents and two `staging.tfvars` flag flips. There is no product code, Terraform, lock file or dependency change. The owner runs every apply, ECS one-off and secret step, and the P1, P2, P3 and P5 commands that hold a personal value. The owner's assistant is read-only. Nothing in an agent task calls AWS.

Slug: ses-sign-in-proof
Status: approved (2026-10-15, Adnan Bin Hossen)

**Branch:** `feat/2026-10-15-ses-sign-in-proof` · one PR · six agent commits after the approved spec

## Who does what

| Actor               | Writes repo commits                                                       | Runs `terraform apply` | Runs `aws ecs run-task`, the secret steps, and the P1–P3 and P5 commands  | Merges |
| ------------------- | ------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------- | ------ |
| Implementer agent   | Yes: runbook, tfvars, evidence, catalogue only. Works in its own worktree | Never                  | Never                                                                     | Never  |
| Reviewer agent      | Never. Accepts each task diff before it is pushed                         | Never                  | Never                                                                     | Never  |
| Human owner (Abdus) | Never during the run                                                      | Yes: Apply 1 and 2     | Yes                                                                       | Yes    |
| Owner's assistant   | Never                                                                     | Never                  | Never. Read-only AWS (describe, list, logs) and calls that need no secret | Never  |

## Global constraints

- The spec is approved. No task edits it.
- The agent never runs `terraform apply`, `terraform init` against a live backend, `aws`, `docker push`, or any command in a **Human** section. It runs with no AWS credentials.
- `service_image` is never committed. The digest URI lives only in the gitignored `infra/regions/au/env/staging.local.tfvars`. That file lives in the owner's checkout, never in the implementer's worktree.
- **Forbidden in commits, the plan, and runbook evidence:** account ids, hosted zone ids, ARNs, secret names, key ids, task ids, subnet and security-group ids, IP addresses, real hostnames, registry hosts, email addresses, slug values, codes and tokens. The one exception is the reserved `example.com` placeholder from spec S4.
- **Allowed:** placeholders, SHAs, image digests, Terraform resource addresses, and resource names already in committed Terraform.
- Evidence is transcribed as counts, statuses, SHAs, digests and resource addresses only. Never paste a raw CLI output line.
- Every commit's staged diff gets the identifier scan (pin 3) before `git commit`. From Task 3 on, a task's commit is pushed only after the reviewer agent has accepted its diff, because after Apply 1 a pushed value can never be removed.
- From Apply 1 onward: no rebase, no amend, no force-push. If `origin/main` moves, bring it in with a merge commit. The pull request opens only after the catalogue commit, with the tree parked and `pnpm gate` green. It merges with a merge commit.
- Task 2 and Task 4 commits contain `staging.tfvars` only. Confirm with `git diff --cached --name-only`. Never commit `infra/regions/au/.terraform.lock.hcl`.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- The second fresh-context review (a different tool and a different model family, AGENTS.md §2) is required before merge. It starts when the pull request opens.

**Migration wave:** none. The ten existing migrations apply to a database that the re-park destroys.

**Terraform asserts added by this chunk:** none. `staging_unpark` (`infra/regions/au/tests/cell.tftest.hcl:943`), `database_off` (`:798`), `prod_database_off_fails` (`:892`) and `image_without_database_fails` (`:914`) already pin the plan shapes. No scratch probe is needed.

## CI and local gate while unparked

| Check                                                                                                                                                        | On the unpark (Task 2) and evidence (Task 3) commits | After the re-park (Task 4) |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------- |
| `pnpm format`, `lint`, `typecheck`, `check:boundaries`                                                                                                       | Pass                                                 | Pass                       |
| `pnpm test`: `modules/core/entitlements/db/parked.test.ts`, `modules/core/people/domain/boundaries.test.ts`, `modules/core/access/domain/boundaries.test.ts` | **Fail** (expected)                                  | Pass                       |
| Terraform half of `pnpm gate` (`init`, `fmt -check`, `validate`, `tflint`, `terraform test` for `infra/regions/au`)                                          | Pass                                                 | Pass                       |

**Full gate** in this plan means:

1. `pnpm test --force`. Turbo does not hash `staging.tfvars`, so this refreshes the cache with the current tree.
2. Then `pnpm gate`, which also runs the Terraform checks for touched `infra/` directories (`tooling/checks/gate/cli.ts:16-48`).

Before each commit while unparked, run `pnpm format`, `lint`, `typecheck` and `check:boundaries`. Run the Terraform checks too.

Run Terraform on Linux, macOS or WSL. On native Windows, `init -lockfile=readonly` fails a checksum match because the lock file holds CI-platform hashes only. Do not "fix" that with `terraform providers lock`.

`boundaries.test.ts:39-44` scans every file in `infra/regions/au/env/`, including the gitignored local file. In the implementer's worktree that file does not exist. In the owner's checkout it fails until `service_image` is removed (H7.1).

## Security pins

Each pin is weakened once in a scratch copy and its test is seen to fail. Then the source is restored. The weakened tree is never committed. Results go in the task report, not in a file under `docs/plans/`.

| Setting (spec, Rules touched)                    | Test that pins it                                                                                                                                                                                                                                                                                                                                                                   | Weakening change, and the expected failure                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a. `enable_database = false` committed at merge | `parked.test.ts:11-16`, `access/domain/boundaries.test.ts:36-38`, `people/domain/boundaries.test.ts` (`leaves staging parked`). **Known gap:** these are presence regexes, so a comment holding the parked values passes them while the tree is unparked. Task 4 closes this for this chunk with a byte-equality check against `origin/main`. No test change belongs in this chunk. | Seen naturally on Task 2: `pnpm test --force` fails on all three. Record the failing test names                                                             |
| 1b. `desired_count = 0` committed at merge       | Same three files, same gap                                                                                                                                                                                                                                                                                                                                                          | Same as 1a                                                                                                                                                  |
| 1c. No `service_image` in any file under `env/`  | Committed file: `parked.test.ts:16`, `access/domain/boundaries.test.ts:39-44`, `people/domain/boundaries.test.ts:39-44`, `cell.tftest.hcl:883-888`. Gitignored local file: the two `boundaries` tests only                                                                                                                                                                          | In Task 4's scratch copy, add `service_image = "x"` to `staging.tfvars`. All three vitest files fail, and `terraform test` fails on `database_off`. Restore |
| 2. Production refuses `enable_database = false`  | `prod_database_off_fails` (`cell.tftest.hcl:892`)                                                                                                                                                                                                                                                                                                                                   | Existing test, unchanged by this chunk. Run explicitly in Task 4 (the gate skips Terraform when `staging.tfvars` equals `main`)                             |
| 3. No identifier in any added line               | The implementer scans each staged file's added lines with file and line numbers (`git diff --cached -U0` read hunk by hunk, or `git grep -n -E '<pattern>' --cached -- <file>` limited to lines the hunk headers say were added). Then the reviewer does the same over `origin/main...HEAD`. The pattern is below                                                                   | In a scratch file, plant a fake IAM role ARN and a 32-hex task id. The scan must report both                                                                |
| Rule 5 (live)                                    | P5 counts with mandatory positive controls                                                                                                                                                                                                                                                                                                                                          | Live only                                                                                                                                                   |

**Pin 3 pattern** (`grep -n -E`, one alternation):

```
[0-9]{12}|arn:|@|\bZ[0-9A-Z]{10,}\b|\.amazonaws\.com|communityhub-staging|\b([0-9]{1,3}\.){3}[0-9]{1,3}\b|\b[0-9a-f]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(subnet|sg|vpc|eni)-[0-9a-f]{8,17}\b|eyJ[A-Za-z0-9_-]{10,}|\b(AKIA|ASIA)[0-9A-Z]{16}\b|\b[0-9]{8}\b
```

**Allowed hits** (each still listed by file:line in the task report):

- the `example.com` placeholder;
- the runbook line that greps the literal `@`;
- the existing sender row (`no-reply@mail.<zone>`) and the zone-name row, if prettier re-pads them;
- `sha256:` digests, and decimal runs inside a digest;
- the approved spec file.

Every other hit is a stop. Two classes cannot be pattern-scanned: slug values, and hostnames outside the staging zone and `amazonaws.com`. Both are entered only at prompts or held in variables and never pasted, and the reviewer reads every added line of evidence by eye for them.

## Rollback

| Point                            | Rollback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Before Apply 1                   | A new commit reverts the unpark. No spend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Apply 1 plan not as expected     | Do not apply. Staging stays parked. Reconcile in a separate chunk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| After Apply 1, any proof failure | Stop the proofs. Remove `service_image` from the local file. Make the Task 4 commit and push it after review. Apply the re-park; the plan then shows no changes. Record the failure in the runbook (Task 3, then Task 5). A code failure goes to **Resume after a fix**. Any other cause (inbox unavailable, the hard stop reached, an AWS-side fault): stop and ask the developer and the owner, who decide whether to rerun under **Resume after a fix** steps 2–6 (no merge needed) or close the chunk with the failure recorded. |
| Failed re-park apply             | Do not open the pull request. The owner fixes state and re-applies the Task 4 SHA until the plan is empty.                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Resume after a fix

This applies when a proof failed because of code. The fix lands on `main` through its own `fix/` branch and publishes an image. Do not open this chunk's pull request between runs.

1. Merge `origin/main` into this branch with a merge commit. Never rebase after Apply 1.
2. Repeat Task 2 as a new unpark commit.
3. Repeat H1–H6, with the new `${DEPLOY_SHA}` and digest.
4. Append the evidence as "Run 2" (Task 3 again).
5. Repeat Task 4, H7 and Task 5.
6. Task 6 records both runs.

## Stop and ask (AGENTS.md §12)

**Implementer:**

- the spec or plan is wrong or ambiguous;
- a product, Terraform, lock file, Dockerfile, workflow or dependency change seems needed;
- an identifier scan hit that is not on the allowed list;
- the same step fails twice.

**Day of run:**

- any pre-check fails;
- the plan does not match the 18 addresses;
- a one-off prints anything but its fixed success form;
- P1 returns 204 with no new `mail` line;
- P2 answers 401 or 403;
- a P5 log pull fails or returns 0 lines;
- any P5 count above 0;
- the 48-hour hard stop is reached.

---

### Task 1: Runbook amendments before spend

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`, section **SES sign-in proof** only (from `## SES sign-in proof` to just before `## Staging proof run`).

**Change:**

0. **General rules.** Add near the top of the section:
   - A Spot interruption is not a failure. Wait for the replacement task and rerun that step once. A rerun of P1 counts toward its cap.
   - Stream-scoped `get-log-events` calls for one-offs are exempt from `--start-time`, because each stream is unique to its task. Every `filter-log-events` call carries `--start-time`.
1. **Prerequisites.**
   - `${DEPLOY_SHA}` is `81f4960` or a later `main` commit that contains it.
   - Add the read-only pre-checks, each with its command:
     - Domain identity and DKIM are `SUCCESS`. Existing command.
     - Production access is off. `aws sesv2 get-account --profile ${AWS_PROFILE} --region ap-southeast-2 --query 'ProductionAccessEnabled' --output text` prints `False`. Stop if `True`.
     - The owner address is verified. The owner checks, in his own shell at a silent prompt, that the lowercase owner address shows `VerificationStatus` `SUCCESS`, then unsets it. Record the status only.
2. **Shell variables.** Add `${API_ACCESS_LOG_GROUP}` (`/community-hub/ch-staging/api-access`), `${WINDOW_START_MS}` and `${WINDOW_END_MS}`. Keep the table's current column widths so that existing rows are not rewritten.
3. **Apply 1.** Replace "8 database resources under `module.rds[0]`, 10 ECS resources under `module.ingress`" with the 18 addresses exactly as `terraform show -json | jq` prints them. These are the ones recorded at runbook "Staging proof run → Evidence" for its two applies:
   - `module.rds[0].aws_cloudwatch_metric_alarm.cpu_credit_balance`
   - `module.rds[0].aws_cloudwatch_metric_alarm.database_connections`
   - `module.rds[0].aws_cloudwatch_metric_alarm.free_storage_space`
   - `module.rds[0].aws_cloudwatch_metric_alarm.freeable_memory`
   - `module.rds[0].aws_db_instance.this`
   - `module.rds[0].aws_db_parameter_group.this`
   - `module.rds[0].aws_db_subnet_group.this`
   - `module.rds[0].terraform_data.prod_protection`
   - `aws_ecs_task_definition.db_ops[0]`
   - `aws_iam_role.db_ops_execution[0]`
   - `aws_iam_role.db_ops_task[0]`
   - `aws_iam_role_policy.db_ops_execution[0]`
   - `module.ingress.aws_ecs_cluster.this[0]`
   - `module.ingress.aws_ecs_cluster_capacity_providers.this[0]`
   - `module.ingress.aws_ecs_service.this[0]`
   - `module.ingress.aws_ecs_task_definition.this[0]`
   - `module.ingress.aws_iam_role_policy.pull[0]`
   - `module.ingress.aws_vpc_security_group_ingress_rule.task_api[0]`

   Any other address is a stop before apply.

4. **One-offs.**
   - `db-migrate` expected output: ten `applied <tag>` lines for 0000–0009, then `done applied=10 total=10`, with stderr empty.
   - The first-owner step uses the same lowercase verified address.
   - It uses synthetic slugs with a random suffix, for example `proof-` plus 8 hex characters, so that P5's substring counts cannot match a route name. The slugs are never recorded.
   - Remove "hold `${COMMUNITY_SLUG}`". The provision procedure unsets it, and P2 prompts.
5. **Running-task check.** Add a subsection before P1, for the assistant, with the commands:
   - `aws ecs list-tasks --cluster ${CLUSTER} --service-name ${SERVICE}`, held in `${SERVICE_TASK_ARN}`. Then `describe-tasks … --query 'tasks[0].containers[0].imageDigest'`. It equals the pre-checked digest.
   - `aws ecs describe-services … --query 'services[0].taskDefinition' --output text`, held in a variable. Then ``aws ecs describe-task-definition --task-definition <that> --query 'taskDefinition.containerDefinitions[?name==`service`].environment[].name' --output text``. It lists both `MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET`.
   - Never run an unqualified describe, because that prints values.
6. **P1.**
   - Before P1: `WINDOW_START_MS=$(( $(date +%s) * 1000 ))`.
   - Prompt for the owner address in lowercase.
   - Cap: at most 3 `start` calls for that address in this run.
   - Rule (a): if no mail arrives within 5 minutes, the assistant counts the `mail` lines by `outcome` since `${WINDOW_START_MS}`, before any further `start`. Give the command (no secret value is needed).
   - Rule (b): a 204 with no new `mail` line is the five-an-hour limit. Stop.
7. **P2.**
   - Verify within 10 minutes of the mail.
   - A 401 or 403 is a stop. Do not retry with a guessed code.
   - Delete the existing `unset ACCESS_TOKEN TOKENS COMMUNITY_SLUG` line. P5 unsets everything.
8. **P3.**
   - Use the fixed placeholder `UNVERIFIED_EMAIL=proof-unverified@example.com` instead of a prompt (spec S4).
   - The `mail` query gains `--start-time ${WINDOW_START_MS}`.
   - Note that `outcome` can also be `timeout`, which is a stop.
9. **P5.** Rewrite per spec S5. The owner runs it, in the same shell.
   - Start with `setopt pipefail`, then set `WINDOW_END_MS`.
   - Pull each group **once** into a shell variable, held in memory and never written to disk:
     - `SERVICE_MSGS=$(aws logs filter-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --start-time ${WINDOW_START_MS} --end-time ${WINDOW_END_MS} --query 'events[].message' --output text | tr '\t' '\n')`
     - `ACCESS_MSGS=…` the same for `${API_ACCESS_LOG_GROUP}`.
     - Do not use `--filter-pattern`.
     - Directly after each pull, `print $?` must print `0` (with `pipefail` set this is the status of the whole pipeline). Anything else is a stop.
   - **Positive controls, mandatory.** Use content counts, not `wc -l` (an empty variable still prints one line):
     - `print -r -- "${SERVICE_MSGS}" | grep -c '"message":"mail"'` is at least the number of `start` calls.
     - `print -r -- "${ACCESS_MSGS}" | grep -c '"routeKey"'` is at least the number of P1–P3 requests.
     - Either control below its minimum is a stop.
   - **Counts.** Use one command per value per group: `print -r -- "${SERVICE_MSGS}" | grep -c -i -F -- "${VALUE}"`. The values are:
     - `OWNER_EMAIL`, `UNVERIFIED_EMAIL`, `OTP_CODE`;
     - `ORG_SLUG` and `COMMUNITY_SLUG`, each prompted again at a silent prompt if unset, because the provision step unsets them;
     - `ACCESS_TOKEN`;
     - the literals `Bearer` and `@`.

     Expected: `0` each. Record the printed integer; a `grep` exit status of 1 on a count of 0 is normal.

   - **Mail lines.** Run `print -r -- "${SERVICE_MSGS}" | jq -cR 'fromjson? | select(.message=="mail")'`. Expect:
     - `outcome` `ok` once per `start` call that sent mail;
     - exactly one `failed` with `errorClass` `MessageRejected`;
     - 0 `timeout`.
   - **Key sets.** `… | jq -cR 'fromjson? | select(.message=="mail") | keys'` prints exactly `["level","message","operation","outcome"]` for each `ok` line, and `["errorClass","level","message","operation","outcome"]` for the failed line.
   - Finish with `unset SERVICE_MSGS ACCESS_MSGS OWNER_EMAIL UNVERIFIED_EMAIL OTP_CODE ORG_SLUG COMMUNITY_SLUG ACCESS_TOKEN TOKENS`.
10. **Apply 2.** Expect the same 18 addresses, each `delete`.
11. **Cost clock and applies.** Leave the placeholders for Apply 1 and Apply 2. Tasks 3 and 5 fill them in.

Keep the section's conventions: one pasteable command per indented block, zsh, `${VAR}` form, and no inline `#` comments.

**Proves:** the operator path matches the approved spec before any spend.

**Rule this must not break:** pin 3. No other runbook section is edited.

**Commit subject:** `docs(runbooks): tighten the SES sign-in proof before the unpark`

- [ ] Edit the section.
- [ ] `pnpm exec prettier --check docs/runbooks/apply-staging-au.md`
- [ ] Full gate. The tree is still parked, so expect green.
- [ ] Pin 3 scan on the staged diff. List every hit with its reason in the report.
- [ ] Commit the runbook only. Push after the reviewer accepts.

---

### Task 2: Unpark commit

**Files:** Modify `infra/regions/au/env/staging.tfvars`.

**Change:** `enable_database = true` and `desired_count = 1`. No `service_image`, no `enable_kms_endpoint`, no comment. Other lines unchanged.

**Proves:** the Apply 1 SHA is on origin.

**Rule this must not break:** no `service_image` in a committed file.

**Commit subject:** `feat(infra): unpark staging for the SES sign-in proof`

- [ ] Edit the file, then `terraform fmt` it.
- [ ] Run the Terraform checks for `infra/regions/au` (Linux, macOS or WSL). Expect a pass.
- [ ] Run `pnpm format`, `lint`, `typecheck` and `check:boundaries`. Then `pnpm test --force`, and record that only the three parked tests fail (pins 1a and 1b).
- [ ] `git diff --cached --name-only` shows `staging.tfvars` only. Run the pin 3 scan.
- [ ] Commit. After the reviewer accepts, push before Apply 1.

---

## Human: pre-checks through proofs

Follow the amended runbook section. For each step, the owner pastes counts, statuses and addresses only.

- **H1. Pre-checks (assistant and owner).** Image, digest, scan, SES identity and DKIM, production access off, owner recipient `SUCCESS`.
- **H2. Apply 1 (owner; the assistant checks the plan).** On the Task 2 SHA, the owner saves the plan; the assistant checks the address list against the 18 addresses; then the owner applies. Record the UTC completion time.
- **H3. One-offs (owner).** `db-bootstrap`, then `db-migrate`, then the first owner (P4), then delete the secret and verify it is gone.
- **H4. Running-task check (assistant).** After `aws ecs wait services-stable`: the digest and the environment names.
- **H5. P1–P3 (owner).** The assistant reads the `mail` lines.
- **H6. P5 (owner).**

---

### Task 3: Record proof evidence

**Files:** Modify `docs/runbooks/apply-staging-au.md`, section **SES sign-in proof → Cost clock and applies** and **Evidence**.

**Change:** record Apply 1's SHA, digest and UTC completion. Record the one-off results and P1–P5 as statuses and counts, including the positive controls. Record any Spot interruptions or reruns. Transcribe from the owner's and assistant's reports; never paste a raw CLI line.

**Commit subject:** `docs(runbooks): record the SES sign-in proof evidence`

- [ ] Prettier check. Run `pnpm format`, `lint`, `typecheck` and `check:boundaries`. Tests are expected red until Task 4.
- [ ] Pin 3 scan on the staged diff.
- [ ] Commit the runbook only. **Do not push until the reviewer has accepted this diff.** Then push, before Task 4.

---

### Task 4: Re-park commit

**Files:** Modify `infra/regions/au/env/staging.tfvars`.

**Change:** `enable_database = false` and `desired_count = 0`.

**Commit subject:** `feat(infra): park staging after the SES sign-in proof`

- [ ] Edit the file, then `terraform fmt` it.
- [ ] `git diff origin/main -- infra/regions/au/env/staging.tfvars` prints nothing. The re-parked file equals `main` byte for byte, which closes the known gap in pins 1a and 1b.
- [ ] Pin 1c, in a scratch copy: add `service_image` and confirm that the three vitest files and `terraform test` fail. Restore.
- [ ] Full gate. Expect green. The gate prints `terraform: none` here, because the re-parked file equals `main` (`tooling/checks/gate/gate.ts:112-129`).
- [ ] Run the Terraform checks for `infra/regions/au` explicitly (Linux, macOS or WSL): `init -backend=false -lockfile=readonly`, `fmt -check`, `validate`, `tflint --init && tflint`, `terraform test`. Expect a pass, including `prod_database_off_fails` (pin 2).
- [ ] `git diff --cached --name-only` shows `staging.tfvars` only. Run the pin 3 scan.
- [ ] Commit. After the reviewer accepts, push before the re-park apply.

---

## Human: re-park apply

### H7. Re-park (owner)

1. Remove `service_image` from the gitignored local file.
2. On the Task 4 SHA, plan. Expect the same 18 addresses, each `delete`.
3. Apply. Plan again. Expect no changes.
4. Read-only checks: 0 RDS instances and 0 ECS services. The SES identity and the configuration set remain.

**Stop if:** the plan is not empty after the apply.

---

### Task 5: Record the re-park

**Files:** Modify `docs/runbooks/apply-staging-au.md`, the same section.

**Change:** record Apply 2's SHA and UTC completion, the total window in hours and its cost at USD 0.0468 an hour, and the empty-plan result.

**Commit subject:** `docs(runbooks): record the SES sign-in proof re-park`

- [ ] Full gate. Pin 3 scan on the staged diff.
- [ ] Commit. After the reviewer accepts, push.

---

### Task 6: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md` (the Repository state row only)

**Change:**

- In the roadmap, mark the Phase 1 row `ses-sign-in-proof` **done**, with its spec link.
- Snapshot: last shipped `ses-sign-in-proof`; next chunk `stripe-billing`, blocked on Q8.
- Replace the open-item paragraph "A signed-in proof on staging still waits for `ses-sign-in-proof`…" with the outcome.
- Add any new open items the run found, including the comment gap in the parked tests (pins 1a and 1b).
- Update Next spec.
- Update `AGENTS.md:9` to match. The Phase 0 counts are unchanged.

**Commit subject:** `docs(roadmap): mark the SES sign-in proof done`

- [ ] `pnpm exec prettier --write docs/roadmap.md AGENTS.md`, then the full gate. Run the pin 3 scan.
- [ ] Commit both files only. After the reviewer accepts, push. Open the pull request only after this commit.

---

## Definition of done (AGENTS.md §8)

- [ ] All six tasks and H1–H7 are done, or dropped with a note.
- [ ] Full CI is green on the pull request.
- [ ] P1–P5 are recorded with their positive controls, and both applies with their SHAs. Staging is parked in AWS and in git.
- [ ] The roadmap and the `AGENTS.md` row were updated in Task 6.
- [ ] The reviewer's sign-off is recorded per task. The second-review line is closed before merge.
- [ ] Session scratch is cleaned (§5).
