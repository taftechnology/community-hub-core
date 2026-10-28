Spec: docs/specs/2026-10-27-ops-console-proof.md

# Ops console proof Implementation Plan

Slug: ops-console-proof
Status: approved (2026-10-27, Abdus Salam)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unpark staging on the image published for the `ops-console-ui` merge, then prove the ops console live (O1–O14). That covers:

- an operator grant;
- enrolment with two passkeys from different providers;
- sign-in in Chrome and Safari;
- refresh across tabs;
- accessibility by hand;
- ADR 0015's Recover, and Revoke;
- log hygiene.

Then re-park before the pull request opens.

**Architecture:** Six agent commits, all on `docs/runbooks/apply-staging-au.md`, `infra/regions/au/env/staging.tfvars`, `docs/roadmap.md` and `AGENTS.md`:

- three runbook commits;
- two flag flips;
- the catalogue.

There is no product code, Terraform, lock file or dependency change.

The owner runs every apply, ECS one-off, secret step and browser step, and every command that holds a personal value or a code. The owner's assistant is read-only. Nothing in an agent task calls AWS.

**Branch:** `feat/2026-10-27-ops-console-proof`. One PR: six agent commits after the approved spec and this plan, plus any review-fix commits.

## Who does what

| Actor                                | Writes repo commits                                                                    | Runs `terraform apply`   | Runs one-offs, secret steps, browser steps and held-value commands                                  | Merges |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- | ------ |
| Implementer agent (Antigravity)      | Yes: the runbook, the tfvars, the evidence and the catalogue only, in its own worktree | Never                    | Never                                                                                               | Never  |
| Reviewer agent (Claude orchestrator) | Never. It accepts each task's diff before that diff is pushed                          | Never                    | Never                                                                                               | Never  |
| Human owner (Abdus)                  | Never during the run                                                                   | Yes: Apply 1 and Apply 2 | Yes                                                                                                 | Yes    |
| Owner's assistant                    | Never                                                                                  | Never                    | Never. Read-only AWS (describe, list) and HTTP calls that need no session. It reads no raw log line | Never  |

The owner approves this plan after the independent assistant's check (AGENTS.md §2, §4).

## Global constraints

- The spec is approved, and no task edits it.
- **What the agent never runs:**
  - `terraform apply`, or `terraform init` against a live backend;
  - `aws` or `docker push`;
  - any command in a **Human** section.

  The agent runs with no AWS credentials and with pushes blocked. The developer's session pushes each commit after the reviewer accepts it, with the developer's OK.

- `service_image` is never committed. The digest URI lives only in the gitignored `infra/regions/au/env/staging.local.tfvars`, in the owner's checkout.
- **Forbidden in commits, the plan and runbook evidence:**
  - account ids, hosted zone ids, ARNs, secret names, key ids, task ids, subnet and security-group ids, and IP addresses;
  - real hostnames, registry hosts and email addresses;
  - slug values, email codes, enrolment codes, cookie values, credential ids and tokens.
- **Allowed:** placeholders, SHAs, image digests, Terraform resource addresses, and resource names that are already in committed Terraform.
- **Evidence** is transcribed as counts, statuses, HTTP codes, key sets, SHAs, digests, yes/no facts and resource addresses only. Never paste a raw CLI output line.
- **Scanning and pushing.** Every commit's staged diff gets the identifier scan (pin 3) before `git commit`. From Task 2 on, a commit is pushed only after the reviewer has accepted its diff, because after Apply 1 a pushed value can never be removed.
- **Before Apply 1:** the branch must contain `origin/main` with linear history, and nothing already pushed is rewritten. **H1** checks `git merge-base --is-ancestor origin/main HEAD`. If that passes, no rebase is needed. If `origin/main` has moved, Task 1 and later commits are not pushed yet. They are rebased locally onto `origin/main`, and only the commits up to the plan approval are already on origin. If a pushed commit would have to be rewritten, stop and ask the owner. The choice is a force-push with lease before Apply 1, or a merge commit.
- **From Apply 1 onward:**
  - no rebase, no amend and no force-push;
  - if `origin/main` moves, bring it in with a merge commit;
  - the pull request opens only after the catalogue commit, with the tree parked and the full gate green;
  - it merges with a merge commit.
- The Task 2 and Task 4 commits contain `staging.tfvars` only. Confirm with `git diff --cached --name-only`. Never commit `infra/regions/au/.terraform.lock.hcl`.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- **Second review.** A second fresh-context review is required before merge, in a different tool and on a different model family (AGENTS.md §2). It starts when the pull request opens.

**Deviations from the spec (repeated in the PR body):**

1. **O13 positive-control floors are corrected.**
   - `/v1/ops/passkey/authenticate/verify` 200 is at least **3**: O5, O6 and O10. The spec's 4 counted a sign-in that no step guarantees.
   - `/v1/ops/passkey/authenticate/verify` 401 is at least **3**, because O11 tries **both** authenticators, not "either". That gives O10's one refusal plus O11's two.
2. **O7's log facts are checked straight after O7,** over a bounded window (`O7_START_MS` to `O7_END_MS`). Later steps (O9, O10, O11) legitimately produce refresh 401s, so a whole-run check would fail falsely.
3. **`provision-owner` printing `already_bootstrapped` is a stop.** On a new database it cannot happen.

**Migration wave:** none. The thirteen existing migrations (`0000_schemas` to `0012_polite_bloodstrike`) apply to a database that the re-park destroys.

**Terraform asserts added by this chunk:** none. `staging_unpark`, `database_off`, `prod_database_off_fails` and `image_without_database_fails` in `infra/regions/au/tests/cell.tftest.hcl` already pin the plan shapes. No scratch probe is needed.

## CI and local gate while unparked

| Check                                                                                                                                                        | On the unpark (Task 2) and evidence (Task 3) commits | After the re-park (Task 4) |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------- |
| `pnpm format`, `lint`, `typecheck`, `check:boundaries`                                                                                                       | Pass                                                 | Pass                       |
| `pnpm test`: `modules/core/entitlements/db/parked.test.ts`, `modules/core/people/domain/boundaries.test.ts`, `modules/core/access/domain/boundaries.test.ts` | **Fail** (expected)                                  | Pass                       |
| Terraform half of `pnpm gate` for `infra/regions/au`                                                                                                         | Pass                                                 | Pass                       |

**The full gate** is:

1. `pnpm install --frozen-lockfile` and `pnpm build` in the worktree;
2. `pnpm turbo run test --force --continue`;
3. `pnpm gate`.

**On Windows**, `pnpm gate` stops at its test step on the known `packages/db/src/generate.test.ts` ENOENT. The full gate is therefore:

- `pnpm turbo run test lint typecheck --force --continue`;
- `pnpm format`;
- `pnpm check:boundaries`.

Terraform `init -lockfile=readonly` fails on Windows against the committed lock's checksums. If the Terraform checks cannot run on the implementer's machine, the report says so, and the reviewer relies on CI's offline Terraform job for `infra/regions/au`.

The runbook commands are zsh on macOS, in the owner's shell.

## Security pins

Each pin is weakened once in a scratch copy, and its test is seen to fail. Then the source is restored. The weakened tree is never committed. Results go in the task report, not in a file under `docs/plans/`.

| Setting (spec, Rules touched)                    | Test that pins it                                                                                                                                                                           | Weakening change, and the expected failure                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a. `enable_database = false` committed at merge | `parked.test.ts`, `access/domain/boundaries.test.ts`, `people/domain/boundaries.test.ts`. They are presence regexes; Task 4 closes the gap with a byte-equality check against `origin/main` | Seen naturally on Task 2 (`pnpm turbo run test --force --continue` fails all three; record the names). In Task 4's scratch copy, flip **only** `enable_database = true` and confirm all three fail; restore                                                                                                                                                                                             |
| 1b. `desired_count = 0` committed at merge       | The same three files                                                                                                                                                                        | In Task 4's scratch copy, flip **only** `desired_count = 1` and confirm all three fail; restore                                                                                                                                                                                                                                                                                                         |
| 1c. No `service_image` in any file under `env/`  | The same three files, and `database_off` in `cell.tftest.hcl`                                                                                                                               | In Task 4's scratch copy, add `service_image = "x"` to `staging.tfvars`. All three fail, and `terraform test` fails on `database_off`. Restore                                                                                                                                                                                                                                                          |
| 2. Production refuses `enable_database = false`  | `prod_database_off_fails` (`cell.tftest.hcl`)                                                                                                                                               | In Task 4's scratch copy, replace only the `condition` expression at `infra/regions/au/main.tf:69` and `:77` with `true \|\| var.enable_database`, leaving each block's `error_message` as is. `prod_database_off_fails` fails on its unmet `expect_failures`. Restore. Run it explicitly in Task 4, because the gate skips Terraform when `staging.tfvars` equals `main`                               |
| 3. No identifier in any added line               | The implementer scans each staged file's added lines, with file and line numbers, and the reviewer then scans `origin/main...HEAD` the same way. The pattern is below                       | In a scratch file, plant each of these, and the scan must report every one: a 12-digit number; `arn:aws:x`; an address with an at-sign; a dotted IPv4 address; the IPv6 addresses `2001:db8:85a3:0:0:8a2e:370:7334` and `fe80::1`; a UUID; `ABCDEFGHIJKLMNOPQRSTUVWXYZ234567`; a 43-character base64url run; `-provision-owner-ab12CD`; an 8-digit number; `communityhub-staging.net`; `ops.au.example` |
| Rule 5 (live)                                    | O13: value counts, structural key-set checks, and positive controls                                                                                                                         | Live only                                                                                                                                                                                                                                                                                                                                                                                               |

**Pin 3 pattern** (`grep -n -E`, one alternation). It is the `stripe-billing-proof` pattern without the Stripe terms, plus the ops terms:

```
[0-9]{12}|\barn:|@|\bZ[0-9A-Z]{10,}\b|\.amazonaws\.com|communityhub-staging|\b([0-9]{1,3}\.){3}[0-9]{1,3}\b|\b([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|[0-9a-fA-F:]*::[0-9a-fA-F:]+|\b[0-9a-f]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(subnet|sg|vpc|eni)-[0-9a-f]{8,17}\b|eyJ[A-Za-z0-9_-]{10,}|\b(AKIA|ASIA)[0-9A-Z]{16}\b|\b[0-9]{8}\b|\b[A-Z2-7]{26,}\b|[A-Za-z0-9_-]{43,}|-provision-owner-[A-Za-z0-9]{6}|ops\.au\.|api\.au\.|auth\.au\.
```

**Allowed hits.** Each one is still listed by file and line in the task report.

- Markdown table separator rows: lines made only of `|`, `-`, `:` and spaces.
- The at-sign in zsh array expansions (`[@]`), in the existing `service@${DIGEST}` image reference and `@aws-sdk` package names, and in the existing Stripe-section count lines. New lines in this chunk write the at-sign as `$'\x40'`, including the local-part expansion `${HELD_EMAIL%%$'\x40'*}`, so they do not hit.
- The existing `0.0.0.0` CIDR text, and `communityhub-staging` in the existing Shell variables table.
- Long Terraform resource names caught by the 43-character run, such as `aws_sesv2_email_identity_mail_from_attributes`.
- The lowercase base32 case is not covered; enrolment codes are upper-case only.
- `sha256:` digests, and the decimal runs inside a digest.
- Terraform resource addresses and `terraform test` run names already in committed Terraform.
- Placeholder hostnames built from variables, such as `ops.au.${ZONE_NAME}`, and the existing runbook text that uses the same form.
- The approved spec file and this plan file.

Every other hit is a stop.

**Classes that cannot be pattern-scanned.** These are entered only at prompts or held in variables, never pasted, and the reviewer reads every added evidence line by eye for them:

- slug values;
- hostnames outside the staging zone;
- authenticator store names beyond the generic ones (for example "iCloud Keychain", "security key", "Chrome profile").

## Rollback

| Point                                                   | Rollback                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before Apply 1                                          | A new commit reverts the unpark. There is no spend.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Apply 1 plan not as expected                            | Do not apply. Staging stays parked. Reconcile in a separate chunk.                                                                                                                                                                                                                                                                                                                                                                                   |
| After Apply 1: any proof failure, or the hard stop      | Stop the proofs and run O13 for what exists, so held values are counted before they are unset. Remove `service_image` from the local file. Make the Task 4 commit and push it after review. Task 4 may come before Task 3. Apply the re-park; the plan then shows no changes. Record the failure in the runbook (Task 3, then Task 5). A code failure goes to **Resume after a fix**. For any other cause, stop and ask the developer and the owner. |
| O4 or O6 behaves as the spec's "not failures" list says | Not a rollback. Record it and continue.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Failed re-park apply                                    | Do not open the pull request. The owner fixes state and re-applies the Task 4 SHA until the plan is empty.                                                                                                                                                                                                                                                                                                                                           |

### Resume after a fix

This applies when a proof failed because of code. The fix lands on `main` through its own `fix/` branch and publishes an image. Do not open this chunk's pull request between runs.

1. Merge `origin/main` into this branch with a merge commit. Never rebase after Apply 1.
2. Repeat Task 2 as a new unpark commit.
3. Repeat H1–H8 with the new `${DEPLOY_SHA}` and digest. The database is new, so every one-off and the Grant run again, and the owner deletes the ops-site passkey entries first.
4. Append the evidence as "Run 2" (Task 3 again).
5. Repeat Task 4, H9 and Task 5.
6. Task 6 records both runs.

## Stop and ask (AGENTS.md §12)

**Implementer:**

- the spec or plan is wrong or ambiguous;
- a product, Terraform, lock file, Dockerfile, workflow or dependency change seems needed;
- an identifier-scan hit that is not on the allowed list;
- the same step fails twice.

**Day of run:**

- C5 is not met: no qualifying second authenticator;
- any pre-check fails;
- the plan does not match the 18 addresses;
- a one-off or Grant/Recover/Revoke prints anything but its fixed success word;
- a Delete and verify does not confirm the secret is gone;
- O1, O3 (other than O4), O5, O7, O8's keyboard check, O9, O10, O11 or O12 differs from its expected result;
- a `/v1/ops/session/refresh` 401 in O7;
- the C10 code budget would need a fourth code inside one hour;
- an O13 log pull fails or returns 0 lines;
- any O13 value count above 0 that triage cannot clear;
- any key outside the allow-list;
- any non-JSON line outside the fixed-word list;
- any positive control below its minimum;
- the 48-hour hard stop is reached.

---

### Task 1: Runbook section before spend

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`. Add a new section `## Ops console proof` between the end of `## Stripe billing proof` (after its **Findings from the Stripe billing proof run**) and `## Restore drill`. Edit no other section, and do not edit `docs/runbooks/ops-operator.md`.

**Change.** Write the section in the runbook's conventions:

- one pasteable command per indented block;
- zsh, using the `${VAR}` form;
- no inline `#` comments;
- evidence as counts and yes/no only.

New lines write the at-sign as `$'\x40'`. Arrays are iterated as unquoted `${ARRAY}` (zsh does not split them), so `[@]` is not needed. Every millisecond timestamp uses the runbook's existing form, `$(( $(date +%s) * 1000 ))`, because macOS `date` has no `%3N`.

Refer to **Stripe billing proof** by subsection name where a step is unchanged, substituting `fd59b1e` for `5709fa1`, 13 tags for eleven, and `publish` alone for the two publish jobs. Refer to `ops-operator.md` by section name for Grant, Recover and Revoke.

0. **General rules.**
   - The opening rules of **Stripe billing proof → General rules** apply.
   - A Spot interruption is not a failure; rerun that step once.
   - Every `filter-log-events` call carries `--start-time`.
   - Before any command that uses a held value, run `setopt pipefail`.
   - One-offs never overlap. Every Grant, Recover and Revoke starts with `ops-operator.md` **Check the name is free** and ends with **Delete and verify**.
   - **Shell loss.** If the proof shell is lost before O13, the held values are gone. Stop the proofs and re-park. Record O13 as "not countable for the lost values", which is a finding. Do not reconstruct a value from memory.
   - **Start gate.** Apply 1 starts only when the owner can run O1–O13 in one sitting of about 3–6 hours.
1. **Shell variables.** A table in the **Stripe billing proof → Shell variables** form. It reuses that table's AWS and log-group variables, including `${PROVISION_SECRET_NAME}`, `${SECRETS_KEY_ARN}`, `${CLUSTER}`, `${SERVICE_TASK_DEFINITION}`, `${SUBNET}`, `${TASK_SECURITY_GROUP}` and `${LOG_GROUP}`. It adds:
   - **Hosts and log groups:**
     - `${OPS_HOST}`, the ops hostname: `ops.au.${ZONE_NAME}`;
     - `${API_HOST}`, the existing API hostname variable;
     - `${OPS_ACCESS_LOG_GROUP}`, the ops access log group: `/community-hub/<name>/ops-access` (`infra/modules/aws-ingress/main.tf`);
     - `${API_ACCESS_LOG_GROUP}`, as in the Stripe section.
   - **Held values:**
     - `${HELD_EMAIL}`, entered once at a silent prompt;
     - `${HELD_ORG_SLUG}` and `${HELD_COMMUNITY_SLUG}`, each generated once with `"proof-$(openssl rand -hex 4)"`;
     - `${HELD_ENROLMENT_CODES}` and `${HELD_EMAIL_CODES}`, both zsh arrays.
   - **Budget and timing:**
     - `${EMAIL_CODE_TIMES}`, a zsh array of epoch seconds, one for each email code requested;
     - `${PRIVACY_START_MS}`, `${PROOF_START_MS}`, `${O7_START_MS}`, `${O7_END_MS}` and `${PROOF_END_MS}`;
     - `${HARD_STOP_UTC}`, Apply 1 completion plus 48 hours.

   Every held variable stays set until the final `unset` in subsection 10.

2. **Before the unpark (owner, parked).** Answer yes/no. **Stop if** any answer is no.
   - **C5:** two authenticators from different providers. If (b) is a security key, it supports discoverable credentials and has a PIN set. Record the generic kind of each, for example "Mac passkey store" or "FIDO2 key".
   - **C6:** a Chrome profile with no extensions exists.
   - Neither authenticator holds a passkey for the ops site.
   - **Universal Clipboard:** it is off for the run (System Settings → General → AirDrop & Handoff), so the clipboard does not reach a paired phone.
3. **Pre-checks.** **Stop if** any one fails.
   - **Image:** **Stripe billing proof → Pre-checks** for `publish`, the digest and the scan, with the substitutions above.
   - **Migrations:** the journal at `${DEPLOY_SHA}` holds 13 tags, from `0000_schemas` to `0012_polite_bloodstrike`.
   - **SES (assistant, no address):**
     - the domain identity, DKIM and MAIL FROM are `SUCCESS`;
     - production access is `False`, so SES is still in the sandbox.
   - **SES address (owner):** the address check runs in the owner's own shell. It reads `${HELD_EMAIL}` and prints the status only. The address is never shown to the assistant.
   - **Still parked:** 0 RDS instances and 0 ECS clusters.
   - **Infra unchanged:** `git log --oneline 57b2d3d..${DEPLOY_SHA} -- infra/` prints nothing.
   - **Branch:** `git merge-base --is-ancestor origin/main HEAD` and `git merge-base --is-ancestor ${DEPLOY_SHA} HEAD` both succeed. If `origin/main` has moved, follow the Global constraints rule. Then the Task 2 commit is pushed.
   - **Service image:** the owner writes the `service_image` line, and `grep -c '^service_image'` prints 1.
   - **Plan:** a read-only plan without the lock, compared with the 18 addresses that **Stripe billing proof → Apply 1** lists.
4. **Apply 1.** As in **Stripe billing proof → Apply 1**, with the same 18 addresses.
   - Record the UTC completion time and set `HARD_STOP_UTC` to 48 hours later. The Task 3 cost clock records both.
   - Then set `PRIVACY_START_MS`.
5. **One-offs.**
   - **`db-bootstrap` and `db-migrate`:** as in the Stripe section. Expect `done applied=13 total=13`.
   - **`provision-owner`:** as in the Stripe section's deviation. **Create** uses `${HELD_ORG_SLUG}`, `${HELD_COMMUNITY_SLUG}` and `${HELD_EMAIL}` instead of its prompts, and its closing `unset` is skipped for the held values.
     - Expect `created`. `already_bootstrapped` is a stop (deviation 3).
     - Then delete the secret and verify that it is gone.
6. **Running-task check (assistant).** The **Stripe billing proof → Running-task check** commands.
   - The environment-name list must include `OPS_HOSTNAME`, `MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET`. Other names are expected too.
   - `OPS_STATIC_DIR` is not checked here; O1 checks it.
7. **Grant, Recover, Revoke (owner).** Each uses `ops-operator.md`'s section, with these deviations. `ops-operator.md` itself is not edited.
   - **The address.** Before each **Create**, `OPERATOR_EMAIL=${HELD_EMAIL}` replaces the `read -rs "OPERATOR_EMAIL?…"` prompt.
   - **The role.** Grant and Recover set `ROLE_KEYS=platform_admin` in place of the `ROLE_KEYS` prompt.
   - **The code.** Grant and Recover run the **Generate the enrolment code** line `ENROLMENT_CODE=$(python3 …)` and then `HELD_ENROLMENT_CODES+=("${ENROLMENT_CODE}")`. They skip the `print` line, because the owner is the operator and the code reaches the browser through the clipboard (subsection 8).
   - **Create's closing `unset`** runs as written. It clears only the runbook's own variables; the held values are separate.
   - **Expect:**
     - Grant prints `granted`;
     - Recover prints `recovered`;
     - Revoke prints `revoked`.

     Each is followed by **Delete and verify**.
8. **Email codes and the clipboard.** Used in O3 and O10.
   - **Budget (C10).** Run this before submitting step 1 in the browser:

         now=$(date +%s); n=0; for t in ${EMAIL_CODE_TIMES}; do (( now - t < 3600 )) && n=$(( n + 1 )); done; print ${n}

     If it prints 3 or more, stop and wait. A new code would be the fourth within the hour. Otherwise run `EMAIL_CODE_TIMES+=(${now})`.

   - **The email code.** The owner reads it from the mailbox, enters it at a silent prompt, and runs `HELD_EMAIL_CODES+=("${CODE}")`. Then `unset CODE`.
   - **The enrolment code.** Run `print -rn -- "${HELD_ENROLMENT_CODES[-1]}" | pbcopy`, paste the code into the field, then run `pbcopy < /dev/null`.
   - **The 15-minute limit (C11).** Steps 2–4 of each enrolment finish within 15 minutes of verifying the codes.
9. **Proofs O1–O12.** Set `PROOF_START_MS` before O1. Each spec proof becomes a numbered checklist. It gives the exact expected strings from `apps/ops/src/messages.ts` and its yes/no answers, in the spec's order, with the browser and the authenticator named.
   - **O1.** Use `curl -sS --path-as-is -o /dev/null -D - -w '%{http_code}\n'` for each request. Print the status code, and print `grep -c -i` counts of header names only. Each `/assets/…` path comes from `index.html` through a `grep -o` command that the runbook writes out.
   - **O7.**
     - Set `O7_START_MS` just before the two reloads, and `O7_END_MS` once both tabs show the directory.
     - Straight after, the owner pulls the service group over that window, projected to `path` and `status` only. The pull must show:
       - `/v1/ops/me` 401 at least 2;
       - `/v1/ops/session/refresh` 200 at least 1;
       - `/v1/ops/session/refresh` 401 exactly 0.
     - Anything else is a stop (deviation 2).
   - **O11.** Sign-in is tried with **both** authenticators, and each gives "That passkey was not accepted." (deviation 1).
   - **O12.** Two `curl` calls; print the status codes only.
10. **O13 (owner, one shell).**
    - **Pull the logs.** Set `PROOF_END_MS`. Pull `SERVICE_MSGS`, `OPS_ACCESS_MSGS` and `API_ACCESS_MSGS` once each, over `PRIVACY_START_MS` to `PROOF_END_MS`, as **Stripe billing proof → S11 and S12** does:

          filter-log-events … --query 'events[].message' --output text | tr '\t' '\n'

      Use no `--filter-pattern`. After each pull, `print $?` must print `0`. Print each pull's line count; none may be 0.

    - **Value counts.** One `grep -c -i -F --` per value per group. Each must print 0.
      - `${HELD_EMAIL}`.
      - Its local part, `${HELD_EMAIL%%$'\x40'*}`. Count it only if it is at least 6 characters long; otherwise record "too short to count" as a finding.
      - `${HELD_ORG_SLUG}` and `${HELD_COMMUNITY_SLUG}`.
      - Each element of `${HELD_ENROLMENT_CODES}` and `${HELD_EMAIL_CODES}`, in a `for` loop that prints one integer per element.
      - The literals `$'\x40'`, `Bearer`, `__Host-ops` and `Set-Cookie`.
    - **Triage, for an email-code count that is not 0.** For each matching JSON line, print only the names of the fields whose value contains the code:

          print -r -- "${SERVICE_MSGS}" | jq -rR --arg c "${C}" 'fromjson? | select(tostring | contains($c)) | [to_entries[] | select(.value | tostring | contains($c)) | .key] | join(",")' | sort | uniq -c

      A match in `requestId` or `gatewayRequestId` only is cleared. Anything else is a stop.

    - **Structural check, service group.** Run these four checks in order.
      1. Remove the fixed one-off lines first: an integer, `applied <tag>`, `done applied=13 total=13`, `created`, `granted`, `recovered` and `revoked`. Use `grep -v -x -E '[0-9]+|applied [0-9]{4}_[a-z_]+|done applied=13 total=13|created|granted|recovered|revoked'`.
      2. Of what remains, print the count of lines that do not parse: `jq -rR 'fromjson? // "BAD"' | grep -c -x BAD`. It must be 0.
      3. Print the count of parsed lines with any key outside the allow-list. The allow-list is `level`, `message`, `status`, `duration`, `method`, `path`, `requestId`, `gatewayRequestId`, `hostname`, `reason`, `operation`, `key_kind`, `outcome`, `errorClass`, `errorCode`, `organisationId`, `stripeEventId` and `stripeEventType` (`packages/observability/src/logger.ts`). The runbook writes the `jq` with that list as a literal array. The count must be 0.
      4. Print the distinct key sets with `jq -c 'keys' | sort -u`.
    - **Structural check, ops access group.** Print the count of lines whose `keys` are not exactly the nine `access_log_format` keys. It must be 0.
    - **Positive controls.** Make a second service pull with `--start-time ${PROOF_START_MS}`, then:

          jq -rR 'fromjson? | select(.message=="request") | "\(.path) \(.status) \(.reason // "")"' | sort | uniq -c

      The runbook writes out this table, with the plan's corrected floors (deviation 1). Each row must be met.

      | Route                                                                                 | Status | At least |
      | ------------------------------------------------------------------------------------- | ------ | -------- |
      | `/v1/ops/enrolment/start`                                                             | 204    | 2        |
      | `/v1/ops/enrolment/verify`                                                            | 200    | 2        |
      | `/v1/ops/enrolment/verify`                                                            | 401    | 1        |
      | `/v1/ops/passkey/register/verify`                                                     | 200    | 4        |
      | `/v1/ops/passkey/authenticate/verify`                                                 | 200    | 3        |
      | `/v1/ops/passkey/authenticate/verify`                                                 | 401    | 3        |
      | `/v1/ops/session/refresh`                                                             | 200    | 1        |
      | `/v1/ops/session/end`                                                                 | 204    | 1        |
      | `/v1/ops/enrolment/start`                                                             | 403    | 2        |
      | any path with `reason` `ops_route_on_other_hostname` or `other_route_on_ops_hostname` | 404    | 3 (O1)   |

    - **Finish** with `unset` of every held value and every runbook variable.
11. **Apply 2.** As in **Stripe billing proof → Apply 2**:
    - the same 18 addresses, each `delete`;
    - then a plan that shows no changes;
    - then 0 RDS instances and 0 ECS clusters.
12. **Close-out (owner).** Answer yes/no:
    - the ops-site passkey entries are deleted from both authenticators;
    - the Chrome proof profile is removed, or kept with no ops-site data;
    - Universal Clipboard is restored if the owner uses it.
13. **Cost clock and evidence.** Placeholders, for Tasks 3 and 5 to fill in:
    - Apply 1 SHA, completion and hard stop;
    - the C5 kinds;
    - the one-off and operator results;
    - O1–O13;
    - the email-code count;
    - the O14 verified-on-staging lines;
    - Apply 2 SHA and completion;
    - the total window and cost;
    - close-out;
    - **Findings**.

**Proves:** the operator path matches the approved spec before any spend.

**Rule this must not break:** pin 3. No other runbook section is edited, and `ops-operator.md` is not edited.

**Commit subject:** `docs(runbooks): add the ops console proof before the unpark`

- [ ] Write the section.
- [ ] `pnpm exec prettier --check docs/runbooks/apply-staging-au.md`.
- [ ] Full gate. The tree is still parked, so expect green apart from the Windows exception.
- [ ] Pin 3 scan on the staged diff, and pin 3's own weakening with the planted values. List every hit, with its reason, in the report.
- [ ] Commit the runbook only. Keep it local until the H1 branch check passes. Push it with the Task 2 commit after the reviewer accepts both.

---

## Human: before the unpark

- **H0. C5, C6, stale entries and Universal Clipboard (owner, parked).** Runbook subsection 2. Nothing billable starts.

---

### Task 2: Unpark commit

**Files:** Modify `infra/regions/au/env/staging.tfvars`.

**Change:** set `enable_database = true` and `desired_count = 1`. Add no `service_image` and no comment, and leave the other lines unchanged.

**Proves:** the Apply 1 SHA is on origin.

**Rule this must not break:** no `service_image` in a committed file.

**Commit subject:** `feat(infra): unpark staging for the ops console proof`

- [ ] Edit the file, then run `terraform fmt` on it.
- [ ] Run the Terraform checks for `infra/regions/au`, or record that Windows cannot. Expect a pass.
- [ ] Run `pnpm format`, `lint`, `typecheck` and `check:boundaries`. Then run `pnpm turbo run test --force --continue`, and record that only the three parked tests fail (pins 1a and 1b), plus the Windows exception.
- [ ] Check that `git diff --cached --name-only` shows `staging.tfvars` only. Run the pin 3 scan.
- [ ] Commit. Push only after the reviewer accepts, and before Apply 1.

---

## Human: pre-checks through proofs

Follow the new runbook section. For each step, the owner reports counts, statuses, key sets, yes/no facts and addresses only.

- **H1. Pre-checks (assistant and owner).** Runbook subsection 3, including the branch check and the push of the Task 1 and Task 2 commits.
- **H2. Apply 1 (owner; the assistant checks the plan).** On the Task 2 SHA. Record the UTC completion time and `PRIVACY_START_MS`.
- **H3. One-offs (owner).** Runbook subsection 5, in order.
- **H4. Running-task check (assistant).** Runbook subsection 6.
- **H5. Grant (owner).** Runbook subsection 7.
- **H6. O1–O12 (owner, and the assistant for O1).** Runbook subsection 9, in the spec's order.
- **H7. O13 (owner).** Runbook subsection 10.
- **H8. O14.** The developer drafts the verified-on-staging lines from H6 and H7 for Task 3.

---

### Task 3: Record proof evidence

**Files:** Modify `docs/runbooks/apply-staging-au.md`, section **Ops console proof → Cost clock and evidence** only.

**Change.** Transcribe from the owner's and the assistant's reports. Never paste a raw CLI line. Record:

- Apply 1's SHA, the digest length and the UTC completion time;
- the H0 yes/no facts and the generic kinds of the two authenticators;
- the one-off and Grant results;
- O1–O13 as statuses, HTTP codes, key sets, counts and yes/no facts, including the positive controls and the structural counts;
- the number of email codes used;
- any Spot interruptions, retries or reruns;
- the O14 verified-on-staging lines.

**Commit subject:** `docs(runbooks): record the ops console proof evidence`

- [ ] Run the prettier check. Run `pnpm format`, `lint`, `typecheck` and `check:boundaries`. Tests are expected red until Task 4.
- [ ] Run the pin 3 scan on the staged diff, and read every added evidence line by eye for the unscannable classes.
- [ ] Commit the runbook only. **Do not push until the reviewer has accepted this diff.** Then push, before Task 4.

---

### Task 4: Re-park commit

**Files:** Modify `infra/regions/au/env/staging.tfvars`.

**Change:** `enable_database = false` and `desired_count = 0`.

**Commit subject:** `feat(infra): park staging after the ops console proof`

- [ ] Edit the file, then run `terraform fmt` on it.
- [ ] Check that `git diff origin/main -- infra/regions/au/env/staging.tfvars` prints nothing. The re-parked file must equal `main` byte for byte.
- [ ] Pins 1a, 1b and 1c, each in a scratch copy:
  - flip the two flags, and confirm the three vitest files fail;
  - restore, add `service_image`, and confirm the three vitest files and `terraform test` fail;
  - restore.
- [ ] Pin 2, in a scratch copy: apply the `main.tf:69` and `:77` weakening from the pins table, and confirm `prod_database_off_fails` fails. Restore.
- [ ] Run the full gate. Expect green, apart from the Windows exception.
- [ ] Run the Terraform checks for `infra/regions/au` explicitly. Expect a pass, including `prod_database_off_fails` (pin 2). If Windows cannot run them, record that, and the reviewer checks CI.
- [ ] Check that `git diff --cached --name-only` shows `staging.tfvars` only. Run the pin 3 scan.
- [ ] Commit. Push only after the reviewer accepts, and before the re-park apply.

---

## Human: re-park apply

### H9. Re-park (owner)

1. Remove `service_image` from the gitignored local file. `grep -c` prints 0.
2. On the Task 4 SHA, plan. Expect the same 18 addresses, each `delete`.
3. Apply, then plan again. Expect no changes.
4. Run the read-only checks: 0 RDS instances and 0 ECS clusters.
5. Close-out, runbook subsection 12: the passkey entries are deleted, and the Chrome proof profile is cleared.

**Stop if:** the plan is not empty after the apply.

---

### Task 5: Record the re-park

**Files:** Modify `docs/runbooks/apply-staging-au.md`, the same subsection.

**Change:** record:

- Apply 2's SHA and UTC completion time;
- the total window in hours, and its cost at USD 0.0468 an hour;
- the empty-plan result;
- the close-out yes/no answers;
- any findings from the run, as a numbered **Findings** list in the runbook's existing form.

**Commit subject:** `docs(runbooks): record the ops console proof re-park`

- [ ] Run the full gate. Run the pin 3 scan on the staged diff.
- [ ] Commit. Push after the reviewer accepts.

---

### Task 6: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md` (the Repository state row only)

**Change:**

- **Roadmap:**
  - Mark the `ops-console-proof` row (now `not started`) **done**, with its spec link.
  - In the snapshot, set Last shipped to `ops-console-proof` and Next chunk to the one the owner names.
  - Update "Next is" and "The next chunk is" to match.
  - Reconcile the Phase 0 counts line with the rows, and quote it before and after in the report.
  - Add to Open items:
    - the 8-hour cap is not proven live (spec C8);
    - the ops access log format is not pinned exactly;
    - anything else the run found, such as O4 or O6 observations.
- **AGENTS.md:9:** match the roadmap. List `ops-console-proof` as done, and set the next chunk.

**Commit subject:** `docs(roadmap): mark the ops console proof done`

- [ ] Run `pnpm exec prettier --write docs/roadmap.md AGENTS.md`, then `rm -f docs/plans/*-report.md`, then the full gate. Run the pin 3 scan. Confirm with `git status --short` that only these two files are staged and nothing under `.superpowers/` is.
- [ ] Commit both files only. Push after the reviewer accepts. Open the pull request only after this commit. Its body records the applied SHAs, the review record and the second-review line.

---

## Definition of done (AGENTS.md §8)

- [ ] All six tasks and H0–H9 are done, or dropped with a note.
- [ ] Full CI is green on the pull request.
- [ ] Every proof from O1 to O14 is recorded, with the positive controls and structural counts. Both applies are recorded with their SHAs. Staging is parked in AWS and in git.
- [ ] The verified-on-staging lines for the five ops-console chunks are recorded (O14).
- [ ] The roadmap and the `AGENTS.md` row are updated in Task 6.
- [ ] The reviewer's sign-off is recorded per task. The second-review line is closed before merge.
- [ ] Session scratch is cleaned (§5).

## Probe record

This plan adds no Terraform asserts, so no scratch probe is run (AGENTS.md §4). It relies on these facts, read on `origin/main` at `fd59b1e`:

- `infra/` has no commit after `57b2d3d`.
- The journal holds 13 tags.
- The ops access log format has nine keys, and its route key is `$default`.
- The service logger's allow-list is the 16 keys named in subsection 10, plus `level` and `message`.
- `session/end` answers 204, and `provision-owner` can print `already_bootstrapped` (`apps/api/src/provision-owner.ts:46`), which this plan treats as a stop.
- `infra/regions/au/main.tf:69` and `:77` hold the production database conditions.
- The three parked tests and the four `cell.tftest.hcl` runs exist.
