Spec: docs/specs/2026-10-21-stripe-billing-proof.md

# Stripe billing proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the real webhook signing secret in while parked. Unpark staging on the image published for the `billing-read-only` merge. Prove Stripe billing and the read-only guard live in test mode (S1–S12), and re-park before the pull request opens.

**Architecture:** Six agent commits: three runbook documents, two `staging.tfvars` flag flips, and the catalogue. There is no product code, Terraform, lock file or dependency change. The owner runs every apply, ECS one-off, secret step, Stripe dashboard action, browser step, and every command that holds a personal value or a token. The owner's assistant is read-only. Nothing in an agent task calls AWS or Stripe.

Slug: stripe-billing-proof
Status: approved (2026-10-21, Abdus Salam)

**Branch:** `feat/2026-10-21-stripe-billing-proof` · one PR · six agent commits after the approved spec, plus any review fix commits

## Who does what

| Actor               | Writes repo commits                                                                    | Runs `terraform apply` | Runs one-offs, secret steps, Stripe dashboard, browser, and held-value commands | Merges |
| ------------------- | -------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------- | ------ |
| Implementer agent   | Yes: the runbook, the tfvars, the evidence and the catalogue only, in its own worktree | Never                  | Never                                                                           | Never  |
| Reviewer agent      | Never. It accepts each task's diff before that diff is pushed                          | Never                  | Never                                                                           | Never  |
| Human owner (Abdus) | Never during the run                                                                   | Yes: Apply 1 and 2     | Yes                                                                             | Yes    |
| Owner's assistant   | Never                                                                                  | Never                  | Never. Read-only AWS (describe, list, logs) and HTTP calls that need no session | Never  |

## Global constraints

- The spec is approved. No task edits it.
- **The agent never runs:**
  - `terraform apply`, or `terraform init` against a live backend;
  - `aws`, `stripe`, or `docker push`;
  - any command in a **Human** section.

  It runs with no AWS credentials, no Stripe key, and pushes blocked at the environment level. The developer's session (the orchestrator, which dispatches the implementer and reviewer) pushes each commit after the reviewer accepts it.

- **Branch mechanics.** After the owner approves the spec and this plan, the developer creates `feat/2026-10-21-stripe-billing-proof` from `origin/main` and commits the approved spec (`docs(specs): add the Stripe billing proof spec`) and then this plan (`docs(plans): add the Stripe billing proof plan`). Task 1 starts after those two commits.

- `service_image` is never committed. The digest URI lives only in the gitignored `infra/regions/au/env/staging.local.tfvars`, in the owner's checkout.
- **Forbidden in commits, the plan and runbook evidence:**
  - account ids, hosted zone ids, ARNs, secret names, key ids, task ids, subnet and security-group ids, and IP addresses;
  - real hostnames, registry hosts and email addresses;
  - slug values, email codes and tokens;
  - Stripe object ids (customer, subscription, invoice, price, product, tax rate, event, session and payment ids), Stripe URLs, and Stripe keys or signing secrets.

  The exceptions are the fixed `example.com` placeholder (spec P5), the committed webhook-secret placeholder, and Stripe's public test card numbers.

- **Allowed:** placeholders, SHAs, image digests, Terraform resource addresses, and resource names already in committed Terraform.
- Evidence is transcribed as counts, statuses, key sets, SHAs, digests, yes/no facts and resource addresses only. Never paste a raw CLI output line.
- Every commit's staged diff gets the identifier scan (pin 4) before `git commit`. From Task 2 on, a task's commit is pushed only after the reviewer agent has accepted its diff, because after Apply 1 a pushed value can never be removed.
- **From Apply 1 onward:**
  - no rebase, no amend, no force-push;
  - if `origin/main` moves, bring it in with a merge commit;
  - the pull request opens only after the catalogue commit, with the tree parked and the full gate green;
  - it merges with a merge commit.
- The Task 2 and Task 4 commits contain `staging.tfvars` only. Confirm with `git diff --cached --name-only`. Never commit `infra/regions/au/.terraform.lock.hcl`.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- The second fresh-context review (a different tool and a different model family, AGENTS.md §2) is required before merge. It starts when the pull request opens.

**Migration wave:** none. The eleven existing migrations (`0000_schemas` to `0010_silly_lila_cheney`) apply to a database that the re-park destroys.

**Terraform asserts added by this chunk:** none. `staging_unpark`, `database_off`, `prod_database_off_fails` and `image_without_database_fails` in `infra/regions/au/tests/cell.tftest.hcl` already pin the plan shapes. No scratch probe is needed.

## CI and local gate while unparked

| Check                                                                                                                                                        | On the unpark (Task 2) and evidence (Task 3) commits | After the re-park (Task 4) |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------- |
| `pnpm format`, `lint`, `typecheck`, `check:boundaries`                                                                                                       | Pass                                                 | Pass                       |
| `pnpm test`: `modules/core/entitlements/db/parked.test.ts`, `modules/core/people/domain/boundaries.test.ts`, `modules/core/access/domain/boundaries.test.ts` | **Fail** (expected)                                  | Pass                       |
| Terraform half of `pnpm gate` for `infra/regions/au`                                                                                                         | Pass                                                 | Pass                       |

**Full gate** in this plan means:

1. `pnpm install --frozen-lockfile` and `pnpm build` in a fresh worktree.
2. `pnpm turbo run test --force --continue`. Turbo does not hash `staging.tfvars`, so `--force` refreshes the cache with the current tree. Turbo stops at the first failing task by default, and the test tasks are chained; `--continue` makes every expected failure visible.
3. Then `pnpm gate`.

**On Windows:**

- `pnpm gate` stops at its test step, because `packages/db/src/generate.test.ts` fails with ENOENT (the known exception), so it never reaches `check:boundaries`. On Windows the full gate is therefore three commands:
  - `pnpm turbo run test lint typecheck --force --continue`, which shows that ENOENT as the only failure on a parked tree, or that plus the three parked tests on an unparked tree;
  - `pnpm format`;
  - `pnpm check:boundaries`.
- Terraform `init -lockfile=readonly` fails on Windows against the committed lock's checksums. The Terraform checks run on Linux, macOS or WSL. If they cannot run on the implementer's machine, the report says so, and the reviewer runs them.

The runbook commands are zsh on macOS, in the owner's shell.

## Security pins

Each pin is weakened once in a scratch copy, and its test is seen to fail. Then the source is restored. The weakened tree is never committed. Results go in the task report, not in a file under `docs/plans/`.

| Setting (spec, Rules touched)                    | Test that pins it                                                                                                                                                                                                          | Weakening change, and the expected failure                                                                                                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1a. `enable_database = false` committed at merge | `parked.test.ts`, `access/domain/boundaries.test.ts`, `people/domain/boundaries.test.ts`. **Known gap:** these are presence regexes. Task 4 closes the gap for this chunk with a byte-equality check against `origin/main` | Seen naturally on Task 2: `pnpm turbo run test --force --continue` fails on all three. Record the failing test names. Also, in Task 4's scratch copy, flip `enable_database = true` and `desired_count = 1` and confirm all three fail on the tree that merges. Restore              |
| 1b. `desired_count = 0` committed at merge       | Same three files, same gap                                                                                                                                                                                                 | Same as 1a                                                                                                                                                                                                                                                                           |
| 1c. No `service_image` in any file under `env/`  | The same three vitest files, and `database_off` in `cell.tftest.hcl`                                                                                                                                                       | In Task 4's scratch copy, add `service_image = "x"` to `staging.tfvars`. All three vitest files fail, and `terraform test` fails on `database_off`. Restore                                                                                                                          |
| 2. Production refuses `enable_database = false`  | `prod_database_off_fails` (`cell.tftest.hcl`)                                                                                                                                                                              | In Task 4's scratch copy, replace the production condition at `infra/regions/au/main.tf:69` and `:77` with `true \|\| var.enable_database`. `prod_database_off_fails` fails. Restore. Run explicitly in Task 4, because the gate skips Terraform when `staging.tfvars` equals `main` |
| 3. A live key is refused in staging              | `apps/api/src/billing/secret.test.ts` (the test-mode check in `secret.ts`)                                                                                                                                                 | In Task 1's scratch copy, make the staging branch of the test-mode check accept any key. The test fails. Restore                                                                                                                                                                     |
| 4. No identifier in any added line               | The implementer scans each staged file's added lines with file and line numbers. Then the reviewer does the same over `origin/main...HEAD`. The pattern is below                                                           | In a scratch file, plant a fake customer id (`cus_` plus 14 letters), a fake `whsec_` value of 32 characters, and a 32-hex task id. The scan must report all three                                                                                                                   |
| Rule 5 (live)                                    | S12 counts, with mandatory positive controls                                                                                                                                                                               | Live only                                                                                                                                                                                                                                                                            |

**Pin 4 pattern** (`grep -n -E`, one alternation). It is the `ses-sign-in-proof` pattern plus the Stripe terms:

```
[0-9]{12}|arn:|@|\bZ[0-9A-Z]{10,}\b|\.amazonaws\.com|communityhub-staging|\b([0-9]{1,3}\.){3}[0-9]{1,3}\b|\b[0-9a-f]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(subnet|sg|vpc|eni)-[0-9a-f]{8,17}\b|eyJ[A-Za-z0-9_-]{10,}|\b(AKIA|ASIA)[0-9A-Z]{16}\b|\b[0-9]{8}\b|(cus|sub|cs_test|cs_live|pi|in|ii|il|txr|price|prod|pm|seti|si|evt|we|bps|bpc|ch|py|src|tok|req|acct)_[A-Za-z0-9]{8,}|(rk|sk)_(test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{16,}|stripe\.com/[a-z]
```

The Stripe prefixes have no leading `\b`, so an id glued to a word character (`x_cus_…`) still matches.

**Allowed hits.** Each one is still listed by file and line in the task report.

- The `example.com` placeholder.
- The runbook lines that count the at-sign, and the sender row, if prettier re-pads it.
- `sha256:` digests, and the decimal runs inside a digest.
- Terraform resource addresses and `terraform test` run names already in committed Terraform, for example `terraform_data.prod_protection` and `prod_database_off_fails`.
- Ordinary snake_case words caught by a short prefix such as `in_`, `ch_` or `si_` followed by 8 or more letters. The report names each one.
- The approved spec file and this plan file.

Every other hit is a stop.

Four classes cannot be pattern-scanned. All four are entered only at prompts or held in variables, never pasted, and the reviewer reads every added evidence line by eye for them:

- slug values;
- the synthetic Checkout name;
- the service's access and refresh tokens (43-character base64url, with no prefix);
- hostnames outside the staging zone and `amazonaws.com`.

## Rollback

| Point                                              | Rollback                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before Apply 1                                     | A new commit reverts the unpark. There is no spend. The new secret version and the dashboard endpoint stay, and they are harmless.                                                                                                                                                                                                                                                                                                                                            |
| Apply 1 plan not as expected                       | Do not apply. Staging stays parked. Reconcile in a separate chunk.                                                                                                                                                                                                                                                                                                                                                                                                            |
| After Apply 1, any proof failure, or the hard stop | Stop the proofs. Remove `service_image` from the local file. Make the Task 4 commit and push it after review. Task 4 may come before Task 3: its diff is byte-equal to `main`, so its review is quick, and the evidence commit follows the re-park. Apply the re-park; the plan then shows no changes. Record the failure in the runbook (Task 3, then Task 5). A code failure goes to **Resume after a fix**. For any other cause, stop and ask the developer and the owner. |
| S5 does not run as P7 infers                       | Not a rollback. Record what was observed, and continue at S6. The invoice field and `past_due` go to Open items in Task 6.                                                                                                                                                                                                                                                                                                                                                    |
| Failed re-park apply                               | Do not open the pull request. The owner fixes state and re-applies the Task 4 SHA until the plan is empty.                                                                                                                                                                                                                                                                                                                                                                    |

### Resume after a fix

This applies when a proof failed because of code. The fix lands on `main` through its own `fix/` branch and publishes an image. Do not open this chunk's pull request between runs.

1. Merge `origin/main` into this branch with a merge commit. Never rebase after Apply 1.
2. Repeat Task 2 as a new unpark commit.
3. Repeat H1–H7, with the new `${DEPLOY_SHA}` and digest. The database is new again, so every one-off reruns.
4. Append the evidence as "Run 2" (Task 3 again).
5. Repeat Task 4, H8 and Task 5.
6. Task 6 records both runs.

## Stop and ask (AGENTS.md §12)

**Implementer:**

- the spec or plan is wrong or ambiguous;
- a product, Terraform, lock file, Dockerfile, workflow or dependency change seems needed;
- an identifier scan hit that is not on the allowed list;
- the same step fails twice.

**Day of run:**

- any dashboard check or pre-check fails;
- the plan does not match the 18 addresses;
- a one-off prints anything but its fixed success form;
- a `webhook` line with `outcome` `failed`, or a `processed` line with an `errorCode`;
- S1, S2, S4, S6, S7, S8 or S9 differs from its expected result;
- any `stripe_call` line with `outcome` `failed`;
- a sign-in returns 204 with no new `mail` line, or the `start` cap is reached;
- an S12 log pull fails or returns 0 lines;
- any S12 count above 0, or a positive control below its minimum;
- the 48-hour hard stop is reached.

---

### Task 1: Runbook section before spend

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`. Add a new section `## Stripe billing proof` between the end of `## Stripe billing` (after **Findings from Apply 0**) and `## Restore drill`. Edit no other section.

**Change.** Write the section in the runbook's conventions: one pasteable command per indented block, zsh, `${VAR}` form, no inline `#` comments, and evidence as counts and yes/no only. Refer to **SES sign-in proof** by subsection name where a step is unchanged, rather than copying it. The section holds the following subsections, in this order.

0. **General rules.**
   - The opening paragraph of **Staging proof run** applies: the owner applies, the assistant is read-only, and a failed proof or a second failure on one step is a stop and a re-park.
   - A Spot interruption is not a failure; rerun that step once. A webhook delivery that later succeeds on Stripe's retry is not a failure.
   - Every `filter-log-events` call carries `--start-time`.
   - Before any command that uses a held value, `setopt pipefail`.
1. **Shell variables.** A table in the **SES sign-in proof → Shell variables** form. It adds:
   - `${WEBHOOKS_HOST}`: the webhooks hostname, `webhooks.au.${ZONE_NAME}`;
   - `${BILLING_SECRET_ID}`;
   - `${ORG_SLUG}` and `${COMMUNITY_SLUG}`, generated once with `ORG_SLUG="proof-$(openssl rand -hex 4)"` and `COMMUNITY_SLUG="proof-$(openssl rand -hex 4)"`, and kept set until the final `unset` in subsection 10;
   - `${ACCESS_TOKEN}`, `${REFRESH_TOKEN}` and `${TOKENS}`;
   - `${ACCESS_TOKENS}` and `${REFRESH_TOKENS}`, zsh arrays of every token held, so that S12 counts the earlier tokens too;
   - `${OTP_CODES}`, a zsh array of every code used, in the shell and in the browser;
   - `${PROOF_EMAIL}`, the fixed `proof-billing@example.com`;
   - `${PROOF_NAME}`, set once with `PROOF_NAME="Proof$(openssl rand -hex 4)"`;
   - `${START_CALLS}`, a counter;
   - `${STRIPE_CALLS_FLOOR}`.
2. **Stripe dashboard (owner, test mode, while parked).** A checklist of spec Order step 1, each item answered yes/no. It names the six webhook event types and the endpoint path `/v1/stripe/webhook` on `${WEBHOOKS_HOST}`. It says that a new restricted key, if one is made, is built to **Restricted key permissions**, and that the old key is revoked.
3. **Webhook secret (owner, while parked).** The **Put the test-mode values** method, with two silent prompts (`STRIPE_KEY` and `WEBHOOK_SECRET`) and the JSON piped into `put-secret-value --secret-string file:///dev/stdin`, then `unset`. Then three checks:
   - **Assistant, read-only:**
     - ``aws secretsmanager list-secret-version-ids --profile ${AWS_PROFILE} --region ap-southeast-2 --secret-id ${BILLING_SECRET_ID} --query 'Versions[?contains(VersionStages, `AWSCURRENT`)].CreatedDate' --output text``. Answer yes/no: is it after the Apply 0 completion, 2026-10-18T20:52Z?
     - The same command with `AWSPREVIOUS`. Answer yes/no: is one version present?
     - Print the yes/no answers only.
   - **Owner:** read the value in his shell into a variable, never echoed, and print only yes/no for `webhook_secret` starting with `whsec_` and not equal to the placeholder.
   - **Owner:** the same for `secret_key` starting with `rk_test_`. Then unset the variable.
4. **Pre-checks.** The commands from **Staging proof run → Pre-checks** items 1–4: `publish` and `admin-publish`, the digest, the scan, and the repository variables. Then:
   - the journal tags at `${DEPLOY_SHA}` (item 5): expect the eleven tags;
   - the three SES checks from **SES sign-in proof → Prerequisites**;
   - staging is still parked: 0 RDS instances and 0 ECS clusters (read-only, counts only);
   - the owner writes the `service_image` line into `staging.local.tfvars`, using the **SES sign-in proof → Apply 1** block that does this, and the count check prints 1. Without that line, about 10 of the 18 resources are not planned (`infra/regions/au/main.tf:11`, and the `service_image == null` counts in `infra/modules/aws-ingress/main.tf`);
   - the read-only plan without the lock, compared with the 18 addresses.

   **Stop if** any one of these fails.

5. **Apply 1.** As in **SES sign-in proof → Apply 1**, reusing the `service_image` line from subsection 4, with the same 18 addresses listed exactly. Record the UTC completion time.
6. **One-offs.**
   - `db-bootstrap` and `db-migrate`: as in the SES section. `db-migrate` expects `done applied=11 total=11`.
   - `provision-owner`: as in **Provision the first owner**, with the owner's verified address, with these deliberate deviations from that section (which is not edited):
     - the `jq -n` in **Create** uses `${ORG_SLUG}` and `${COMMUNITY_SLUG}` from subsection 1 instead of its `read -rs` prompts;
     - its closing `unset` is skipped for the two slugs; only `OWNER_EMAIL` is unset, and it is prompted again for the sign-in.

     Then delete the secret and verify it is gone.

   - **Each `billing-admin` command:** the existing **billing-admin commands** block, unedited, followed by `aws ecs wait tasks-stopped`, the exit-code check and the log-stream read. The values are:
     - `settings`: `GST_BPS=1000`, `INCLUSIVE=true`, `TRIAL_DAYS=30`, `GRACE_DAYS=7`, `NOTE=stripe-billing-proof`. That is, the arguments `--gst-bps 1000 --inclusive true --trial-days 30 --grace-days 7 --note "stripe-billing-proof"`. Expect stdout `tax_rate <id>`. Record only that the line starts with `tax_rate `.
     - `plan`, with the literal argument list `"plan","starter","--lookup-key","starter_monthly","--trial-eligible","true","--entitlements","module.engagement,module.forms,module.content,module.giving,people.directory,groups.basic,communications.email,giving.one_off"`. Expect `plan_set`. It uses the existing **billing-admin commands → Plan** block, with `PLAN_KEY=starter`, `LOOKUP_KEY=starter_monthly`, `TRIAL_ELIGIBLE=true` and `ENTITLEMENTS` set to that literal list. The existing block is not edited.
     - `seed-test-catalogue`, twice. Expect `seeded` each time. Then the owner records, in the dashboard, yes/no: each of the 7 lookup keys (`starter_monthly`, `growth_monthly`, `ecommerce_monthly`, `website_monthly`, `mobile_monthly`, `branded_monthly` and `sms_pack_monthly`) is on exactly one active price, and 7 products carry `metadata.lookup_key`. This holds even if the test account has other products.
     - `mode` with `${ORG_SLUG}` and `TARGET_MODE=self_serve`. Expect `none`. The runbook adds a warning in the existing `--note` warning's form: the organisation slug appears in the ECS task overrides and in CloudTrail (in Australia). That is acceptable only because the slug is synthetic.
7. **Running-task check (assistant).** The **SES sign-in proof → Running-task check** commands. The environment-name list must include all four of `ADMIN_ORIGIN`, `BILLING_SECRET_ARN`, `MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET`.
8. **Sign-in and refresh (owner).**
   - The **SES sign-in proof → P1 and P2** commands, with three changes:
     - each `start` increments `${START_CALLS}`;
     - each code is appended to `${OTP_CODES}`, including the codes typed into the browser, at a silent prompt;
     - after verify, `REFRESH_TOKEN=$(print -r -- "${TOKENS}" | jq -r '.refreshToken')`, and both tokens are appended to `${ACCESS_TOKENS}` and `${REFRESH_TOKENS}`.
   - **Cap:** `${START_CALLS}` at most 5 for the run, and at most 5 in any 60 minutes. Browser sign-ins count, and the owner increments the counter for each.
   - **Sign-in budget.** The admin's token lasts 15 minutes and is never refreshed, so the browser steps are grouped into sessions, each started with a fresh browser sign-in:

     | Sign-in | Where   | Steps                                            |
     | ------- | ------- | ------------------------------------------------ |
     | 1       | shell   | S1–S12 (refreshed as below)                      |
     | 2       | browser | S10a → S3 → S4 → S10b                            |
     | 3       | browser | S5: set the card → end trial → S10c → pay        |
     | 4       | browser | S8 (Portal through "Manage billing") → S9 → S10d |
     | 5       | either  | Spare, used only for a session that expired      |

     If a browser session expires mid-group, the spare is used. A sixth sign-in is a stop.

   - **A refresh block,** run before each shell proof group:
     - `TOKENS=$(curl -s -S -X POST "https://${AUTH_HOST}/v1/auth/session/refresh" -H 'content-type: application/json' -d "{\"refreshToken\":\"${REFRESH_TOKEN}\"}")`
     - then re-read both `ACCESS_TOKEN` and `REFRESH_TOKEN` from `${TOKENS}`, and append both to their arrays.
   - A refresh that does not return an access token is a stop.
9. **Proofs, in this order, with the admin checks inline.** Set `WINDOW_START_MS` before S1. Each HTTP call prints only the status, using `-o /dev/null -w '%{http_code}\n'`, or pipes the body to `jq` and prints keys or one field.

   Each admin check below is done in the browser within 15 minutes of a browser sign-in, starting at `/`, and answered yes/no with the exact strings from spec S10. The state changes cannot be undone, so each admin check comes before the proof that moves the state on.

   | Step                           | Who                 | What, and the expected result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
   | ------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | S1                             | owner               | `/v1/billing/status`. `jq -c 'keys'` prints the exact key set; `jq -c '{state,canView,canManage,planKey,quantity}'` prints `none`, `true`, `true`, `null`, `null`                                                                                                                                                                                                                                                                                                                                                                                                                              |
   | S2                             | owner               | Toggle body `{"communitySlug":…,"key":"module.engagement","enabled":false}`. 402 with the token. 401 with no `authorization` header. `/v1/access/grants/list` 200                                                                                                                                                                                                                                                                                                                                                                                                                              |
   | **S10a, admin at `none`**      | owner               | "Choose a plan to start using Community Hub" with the link "Choose a plan"; Module Toggles and Users & Roles show "Read-only until billing is settled"; General Settings → Billing lists Starter with "Includes a free trial"                                                                                                                                                                                                                                                                                                                                                                  |
   | S3                             | owner               | Start the subscription from General Settings. Checkout shows a 30-day trial and GST included. Email `${PROOF_EMAIL}`, name and cardholder `${PROOF_NAME}`, card `4242 4242 4242 4242`, any future expiry, any CVC, and a synthetic postcode if asked. The browser returns to the admin, and "Payment received, your plan will appear shortly" shows once. That message shows only for `billing=done`, which the admin then strips from the address bar (`apps/admin/src/billing-status.tsx:48-56, 83`). The success URL itself is fixed in code (`apps/api/src/billing-routes.ts:254`)         |
   | S4                             | assistant and owner | Within 5 minutes, the assistant prints the outcomes of the `webhook` lines by `stripeEventType` (the command below) and the key sets: `["level","message","operation","organisationId","outcome","stripeEventId","stripeEventType"]` on the `checkout.session.completed` line, and the same set without `organisationId` on every other `webhook` line. The owner answers yes/no that the dashboard shows each delivery answered 2xx (after any retry), then runs status: `ok`, `starter`, `1`, and a `trial_end` about 30 days out (yes/no)                                                   |
   | **S10b, admin at `ok`**        | owner               | No billing banner; write controls shown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
   | S5                             | owner               | Portal: set the test card that attaches but declines charges (`4000 0000 0000 0341`). Dashboard: end the trial now. Expect `invoice.payment_failed` and `customer.subscription.updated` `processed`, and status `retrying`                                                                                                                                                                                                                                                                                                                                                                     |
   | **S10c, admin at `retrying`**  | owner               | "Payment failed, update your card"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
   | S5, continued                  | owner               | Portal: pay the open invoice with `4242 4242 4242 4242`. Expect `invoice.paid` `processed` with no `errorCode`, and status `ok`. If ending the trial does not charge at once, record "S5 not run, observed: …" and go to S6                                                                                                                                                                                                                                                                                                                                                                    |
   | S6                             | owner               | The S2 toggle answers 200; then `enabled: true` answers 200                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
   | S7                             | owner and assistant | Owner: wait until the dashboard shows no pending or failed delivery for 2 minutes and two status reads in a row are equal on `jq -c '{state,planKey,quantity,current_period_end}'`; hold that value. Then resend `checkout.session.completed` from the dashboard, and read status again: equal (yes/no). Assistant: a POST of `{}` to `https://${WEBHOOKS_HOST}/v1/stripe/webhook` with `stripe-signature: t=1,v1=00` answers 400, and its `request` line shows `path` `/v1/stripe/webhook` and `status` 400; the same path on `${API_HOST}` answers 404. Owner: a second checkout answers 409 |
   | S8                             | owner               | Shell: `/v1/billing/portal` answers 200 with a `url` key (print `jq -r 'has("url")'` only). Browser, sign-in 4: open the Portal through "Manage billing" in General Settings. Check update card, invoices, cancel at period end, and no plan switching (yes/no). Do not cancel                                                                                                                                                                                                                                                                                                                 |
   | S9                             | owner               | Dashboard: cancel the subscription immediately. Within 5 minutes `customer.subscription.deleted` is `processed`; status `read_only`; the S2 toggle answers 402; checkout answers 200 with a `url` key (do not open it)                                                                                                                                                                                                                                                                                                                                                                         |
   | **S10d, admin at `read_only`** | owner               | "Subscription ended" with the link "Choose a plan"; "Read-only until billing is settled" in place of the controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

   The `webhook` outcome command needs no held value, so the assistant runs it:

       aws logs filter-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --start-time ${WINDOW_START_MS} --query 'events[].message' --output text | tr '\t' '\n' | jq -rR 'fromjson? | select(.message=="webhook") | "\(.stripeEventType) \(.outcome) \(.errorCode // "-")"' | sort | uniq -c

   The key-set command is the same, with `| keys` in place of the string, then `sort -u`.

10. **S11 and S12 (owner, one shell).**
    - Set `WINDOW_END_MS`. Pull `SERVICE_MSGS` and `ACCESS_MSGS` once each, as in **SES sign-in proof → P5**, then `print $?`, which must print `0`.
    - **S11:**
      - `print -r -- "${SERVICE_MSGS}" | jq -rR 'fromjson? | select(.message=="stripe") | .outcome' | sort | uniq -c` shows 0 `failed`.
      - The number of `ok` lines is at least `${STRIPE_CALLS_FLOOR}`, computed from `SERVICE_MSGS` with no held value. A replayed event logs its stored outcome without calling Stripe, so the floor counts distinct event ids:

            STRIPE_CALLS_FLOOR=$(( $(print -r -- "${SERVICE_MSGS}" | jq -rR 'fromjson? | select(.message=="webhook" and .outcome=="processed" and (.stripeEventType | test("^(customer\\.subscription|invoice)\\."))) | .stripeEventId' | sort -u | grep -c .) + $(print -r -- "${SERVICE_MSGS}" | jq -rR 'fromjson? | select(.message=="request" and .status==200 and (.path=="/v1/billing/checkout" or .path=="/v1/billing/portal")) | .path' | grep -c .) ))

        The `request` lines carry only the fixed route pattern, so no personal value is involved. Print the floor and the `ok` count, as integers.
    - **S12 positive controls:**
      - `"operation":"stripe_webhook"` lines: at least the deliveries the dashboard shows;
      - `billing_write_blocked` lines: equal to the 402s in S2 and S9;
      - `"routeKey"` lines in `ACCESS_MSGS`: at least the HTTP calls made.

      Any control below its minimum is a stop.

    - **S12 counts:** one `grep -c -i -F --` per value per group. Expect 0 for each:
      - the variables `OWNER_EMAIL`, `PROOF_EMAIL`, `PROOF_NAME`, `ORG_SLUG` and `COMMUNITY_SLUG`, and each element of `OTP_CODES`, `ACCESS_TOKENS` and `REFRESH_TOKENS`, in a `for` loop that prints one integer per element;
      - the literals `Bearer`, `$'\x40'`, `stripe.com`, `4242424242` and `4242 4242`;
      - the prefixes `cus_`, `sub_`, `cs_test_`, `pi_`, `in_`, `txr_`, `price_`, `prod_`, `pm_`, `seti_`, `rk_test_`, `rk_live_`, `sk_test_`, `sk_live_` and `whsec_`.

      Record the printed integer.

    - Finish with `unset` of every held value.
11. **Apply 2.** As in **SES sign-in proof → Apply 2**: the same 18 addresses, each `delete`, then a plan with no changes. Note that the webhook endpoint stays, and that deliveries while parked fail at the gateway.
12. **Cost clock and evidence.** Placeholders, for Tasks 3 and 5 to fill in.

**Proves:** the operator path matches the approved spec before any spend.

**Rule this must not break:** pin 4. No other runbook section is edited.

**Commit subject:** `docs(runbooks): add the Stripe billing proof before the unpark`

- [ ] Write the section.
- [ ] Pin 3 weakening in a scratch copy, then restore. Record the failing test name.
- [ ] `pnpm exec prettier --check docs/runbooks/apply-staging-au.md`.
- [ ] Full gate. The tree is still parked, so expect green, apart from the Windows exception.
- [ ] Pin 4 scan on the staged diff, and pin 4's own weakening (the planted values). List every hit with its reason in the report.
- [ ] Commit the runbook only. Push after the reviewer accepts.

---

## Human: before the unpark

- **H0. Stripe dashboard and webhook secret (owner, parked).** Runbook subsections 2 and 3. The assistant runs the read-only version check. Nothing billable starts.

---

### Task 2: Unpark commit

**Files:** Modify `infra/regions/au/env/staging.tfvars`.

**Change:** `enable_database = true` and `desired_count = 1`. No `service_image`, no comment. Other lines unchanged.

**Proves:** the Apply 1 SHA is on origin.

**Rule this must not break:** no `service_image` in a committed file.

**Commit subject:** `feat(infra): unpark staging for the Stripe billing proof`

- [ ] Edit the file, then `terraform fmt` it.
- [ ] Run the Terraform checks for `infra/regions/au`. Expect a pass.
- [ ] Run `pnpm format`, `lint`, `typecheck` and `check:boundaries`. Then `pnpm turbo run test --force --continue`, and record that only the three parked tests fail (pins 1a and 1b), plus the Windows exception.
- [ ] `git diff --cached --name-only` shows `staging.tfvars` only. Run the pin 4 scan.
- [ ] Commit. After the reviewer accepts, push before Apply 1.

---

## Human: pre-checks through proofs

Follow the new runbook section. For each step, the owner pastes counts, statuses, key sets, yes/no facts and addresses only.

- **H1. Pre-checks (assistant and owner).** Subsection 4.
- **H2. Apply 1 (owner; the assistant checks the plan).** On the Task 2 SHA. Record the UTC completion time.
- **H3. One-offs (owner).** Subsection 6, in order.
- **H4. Running-task check (assistant).** Subsection 7.
- **H5. Sign-in (owner).** Subsection 8.
- **H6. S1–S10 (owner, assistant).** Subsection 9, in table order, with the admin checks inline.
- **H7. S11–S12 (owner).** Subsection 10.

---

### Task 3: Record proof evidence

**Files:** Modify `docs/runbooks/apply-staging-au.md`, section **Stripe billing proof → Cost clock and evidence** only.

**Change:**

- Record Apply 1's SHA, the digest length and the UTC completion time.
- Record the H0 yes/no facts and the version count.
- Record the one-off results, S1–S12 as statuses, key sets, counts and yes/no facts (including the positive controls), the `start` call count, and any Spot interruptions, retries or reruns.
- Record S5 as run or not run, with what was observed.

Transcribe from the owner's and the assistant's reports. Never paste a raw CLI line.

**Commit subject:** `docs(runbooks): record the Stripe billing proof evidence`

- [ ] Prettier check. Run `pnpm format`, `lint`, `typecheck` and `check:boundaries`. Tests are expected red until Task 4.
- [ ] Pin 4 scan on the staged diff.
- [ ] Commit the runbook only. **Do not push until the reviewer has accepted this diff.** Then push, before Task 4.

---

### Task 4: Re-park commit

**Files:** Modify `infra/regions/au/env/staging.tfvars`.

**Change:** `enable_database = false` and `desired_count = 0`.

**Commit subject:** `feat(infra): park staging after the Stripe billing proof`

- [ ] Edit the file, then `terraform fmt` it.
- [ ] `git diff origin/main -- infra/regions/au/env/staging.tfvars` prints nothing. That is, the re-parked file equals `main` byte for byte.
- [ ] Pins 1a, 1b and 1c, in a scratch copy: flip the two flags and confirm the three vitest files fail; restore. Then add `service_image` and confirm that the three vitest files and `terraform test` fail. Restore.
- [ ] Pin 2, in a scratch copy: the `main.tf:69` and `:77` weakening from the pins table; `prod_database_off_fails` fails. Restore.
- [ ] Full gate. Expect green, apart from the Windows exception.
- [ ] Run the Terraform checks for `infra/regions/au` explicitly. Expect a pass, including `prod_database_off_fails` (pin 2).
- [ ] `git diff --cached --name-only` shows `staging.tfvars` only. Run the pin 4 scan.
- [ ] Commit. After the reviewer accepts, push before the re-park apply.

---

## Human: re-park apply

### H8. Re-park (owner)

1. Remove `service_image` from the gitignored local file.
2. On the Task 4 SHA, plan. Expect the same 18 addresses, each `delete`.
3. Apply. Plan again. Expect no changes.
4. Read-only checks: 0 RDS instances and 0 ECS services. The billing secret and the SES identity remain.

**Stop if:** the plan is not empty after the apply.

---

### Task 5: Record the re-park

**Files:** Modify `docs/runbooks/apply-staging-au.md`, the same subsection.

**Change:** record:

- Apply 2's SHA and UTC completion time;
- the total window in hours, and its cost at USD 0.0468 an hour;
- the empty-plan result;
- any findings from the run, as a numbered **Findings** list in the runbook's existing form.

**Commit subject:** `docs(runbooks): record the Stripe billing proof re-park`

- [ ] Full gate. Pin 4 scan on the staged diff.
- [ ] Commit. After the reviewer accepts, push.

---

### Task 6: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md` (the Repository state row only)

**Change:**

- In the roadmap, mark the Phase 1 row `stripe-billing-proof` **done**, with its spec link.
- Snapshot: last shipped `stripe-billing-proof`; next chunk `ops-console` or `usage-facts`, as the owner names it.
- Replace the Next spec paragraph. It currently says the next chunk is `stripe-billing-proof` and that it carries `billing-read-only`'s staging verification.
- Add to Open items:
  - `unpaid` and `grace` not proven live;
  - the Portal paying an `incomplete` first invoice not proven (P8);
  - the invoice → subscription field and `past_due`, only if S5 did not run;
  - Subscriptions write and Customers read not exercised;
  - migration `0010`'s plan update being a no-op on a new database, so every new environment needs `billing-admin plan` before Checkout;
  - a missing Stripe permission surfacing only as `STRIPE_API`;
  - anything else the run found.
- Update `AGENTS.md:9` to match. The Phase 0 counts are unchanged.

**Commit subject:** `docs(roadmap): mark the Stripe billing proof done`

- [ ] `pnpm exec prettier --write docs/roadmap.md AGENTS.md`, then the full gate. Run the pin 4 scan.
- [ ] Commit both files only. After the reviewer accepts, push. Open the pull request only after this commit.

---

## Definition of done (AGENTS.md §8)

- [ ] All six tasks and H0–H8 are done, or dropped with a note.
- [ ] Full CI is green on the pull request.
- [ ] S1–S12 are recorded with their positive controls, and both applies with their SHAs. Staging is parked in AWS and in git.
- [ ] `billing-read-only`'s staging verification is recorded (S2, S6, S9, S10).
- [ ] The roadmap and the `AGENTS.md` row were updated in Task 6.
- [ ] The reviewer's sign-off is recorded per task. The second-review line is closed before merge.
- [ ] Session scratch is cleaned (§5).
