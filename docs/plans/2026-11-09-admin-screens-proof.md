Spec: docs/specs/2026-11-09-admin-screens-proof.md

# Admin screens proof Implementation Plan

Slug: admin-screens-proof
Status: draft

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unpark staging on the image and admin build published for `cfcf3f7`, then prove the restyled admin live from the real publish path (P1–P9) and close the open checks for migrations `0013`–`0018` (M13–M18). Two synthetic users sign in by email code: U1, the first owner, and U2, who lacks `people.restricted.read`. Then re-park before the pull request opens.

**Architecture:** Six agent commits, all on `docs/runbooks/apply-staging-au.md`, `infra/regions/au/env/staging.tfvars`, `docs/roadmap.md` and `AGENTS.md`:

- the runbook section;
- the unpark flag flip;
- the evidence;
- the re-park flag flip;
- the re-park record;
- the catalogue.

There is no product code, Terraform, lock file or dependency change.

The owner runs every apply, ECS one-off, secret step and Stripe dashboard step. The developer types every email address, sign-in code, slug and U2's id into the browser. The reviewer agent drives the browser through playwriter under spec A8 and A9, and is read-only on AWS. Nothing in an agent task calls AWS.

**Branch:** `feat/2026-11-09-admin-screens-proof`. One PR: the approved spec, this plan, then six agent commits, plus any review-fix commits.

## Who does what

| Actor                                | Writes repo commits                                                                    | Runs `terraform apply`   | Runs one-offs, secret and Stripe steps | Browser                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Implementer agent (Antigravity)      | Yes: the runbook, the tfvars, the evidence and the catalogue only, in its own worktree | Never                    | Never                                  | Never                                                                                        |
| Reviewer agent (Claude orchestrator) | Never. It accepts each task's diff before that diff is pushed                          | Never                    | Never                                  | Drives the developer's proof profile; prints only booleans, counts and statuses (spec A9)    |
| Developer (Adnan)                    | Never during the run                                                                   | Never                    | Never                                  | Creates the proof profile; types addresses, codes, the slug, U2's id and the Checkout values |
| Project owner (Abdus)                | Never during the run                                                                   | Yes: Apply 1 and Apply 2 | Yes                                    | Never                                                                                        |

The developer approves this plan after the independent assistant's check (AGENTS.md §2, §4).

## Global constraints

- The spec is approved, and no task edits it.
- **What the agent never runs:** `terraform apply`, `terraform init` against a live backend, `aws`, `docker push`, or any command in a **Human** section. The agent runs with no AWS credentials and with pushes blocked. The developer's session pushes each commit after the reviewer accepts it.
- `service_image` is never committed. The digest URI lives only in the gitignored `infra/regions/au/env/staging.local.tfvars`, in the owner's checkout.
- **Forbidden in commits, this plan and runbook evidence:**
  - account ids, hosted zone ids, ARNs, secret names, key ids, task ids, subnet and security-group ids, IP addresses;
  - real hostnames, registry hosts and email addresses;
  - slug values, user ids, household ids, email codes, tokens and Stripe object ids.
- **Allowed:** placeholders, SHAs, image digests, Terraform resource addresses, resource names already in committed Terraform, and the invented names under **Synthetic data**.
- **Evidence** is transcribed as counts, statuses, HTTP codes, booleans, SHAs, digests and resource addresses only. Never paste a raw CLI output line.
- **Scanning and pushing.** Every commit's staged diff gets the pin 3 scan before `git commit`. From Task 2 on, a commit is pushed only after the reviewer has accepted its diff, because after Apply 1 a pushed value can never be removed.
- **Before Apply 1:** the branch contains `origin/main` with linear history, and nothing pushed is rewritten. If `origin/main` has moved, rebase Task 1 and Task 2 onto it before either is pushed; this is the last rebase.
- **From Apply 1 onward:** no rebase, no amend, no force-push. If `origin/main` moves, bring it in with a merge commit. The pull request opens only after the catalogue commit, with the tree parked and the full gate green, and merges with a merge commit.
- The Task 2 and Task 4 commits contain `staging.tfvars` only. Confirm with `git diff --cached --name-only`. Never commit `infra/regions/au/.terraform.lock.hcl`.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- **Second review.** Required before merge (spec Out-of-band). It starts when the pull request opens, on a model that is neither Gemini 3.8 Flash nor Claude Opus 5.5.

**Deviations from the spec (repeated in the PR body):**

1. **P1's build check.** The spec says the served `index.html` script name "matches the CI artefact". CI uploads no artefact: `admin-publish` builds inside the job and syncs to the bucket (`.github/workflows/ci.yml:394-500`). The plan checks instead that the served `index.html` names exactly the one `assets/index-*.js` in the bucket, which the `--delete` sync makes the only one.
2. **P1's host count runs over B1,** across sign-in and billing, not on the signed-out page, which calls neither the API nor the auth host.

**Migration wave:** none. The nineteen existing migrations (`0000_schemas` to `0018_wise_starfox`) apply to a database that the re-park destroys.

**Terraform asserts added by this chunk:** none. `staging_unpark`, `database_off`, `prod_database_off_fails` and `image_without_database_fails` in `infra/regions/au/tests/cell.tftest.hcl` already pin the plan shapes.

## CI and local gate while unparked

| Check                                                                                                                                                        | On the unpark (Task 2) and evidence (Task 3) commits | After the re-park (Task 4) |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------- |
| `pnpm format`, `lint`, `typecheck`, `check:boundaries`                                                                                                       | Pass                                                 | Pass                       |
| `pnpm test`: `modules/core/entitlements/db/parked.test.ts`, `modules/core/people/domain/boundaries.test.ts`, `modules/core/access/domain/boundaries.test.ts` | **Fail** (expected)                                  | Pass                       |
| Terraform half of `pnpm gate` for `infra/regions/au`                                                                                                         | Pass                                                 | Pass                       |

**The full gate on Windows** is `pnpm turbo run test lint typecheck --force --continue --concurrency=1`, then `pnpm format` and `pnpm check:boundaries`, with Docker running and nothing else using the test database. The known Windows exceptions (`packages/db` drizzle-kit generate ENOENT and the `migrate.integration` 30-second timeout) are recorded, not fixed. If Terraform cannot run on the implementer's machine, the report says so and the reviewer relies on CI's offline Terraform job for `infra/regions/au`. The full gate runs only after the `service_image` line is removed from the owner's local file (Stripe proof finding 7).

The runbook commands are zsh on macOS, in the owner's shell.

## Security pins

Each pin is weakened once in a scratch copy, and its test is seen to fail. Then the source is restored. The weakened tree is never committed. Results go in the task report.

| Setting (spec, Rules touched)                    | Test that pins it                                                                                                        | Weakening change, and the expected failure                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a. `enable_database = false` committed at merge | `parked.test.ts`, `access/domain/boundaries.test.ts`, `people/domain/boundaries.test.ts`                                 | Seen naturally on Task 2: all three fail. Task 4 adds a byte-equality check of `staging.tfvars` against `origin/main`                                                                                |
| 1b. `desired_count = 0` committed at merge       | The same three files (`parked.test.ts:15`, `people/domain/boundaries.test.ts:47`, `access/domain/boundaries.test.ts:38`) | In Task 4's scratch copy, flip only `desired_count = 1`; all three fail                                                                                                                              |
| 1c. No `service_image` in any file under `env/`  | The same three files (`parked.test.ts:16`, `people/domain/boundaries.test.ts:53`, `access/domain/boundaries.test.ts:44`) | In Task 4's scratch copy, add `service_image = "x"` to `staging.tfvars`; all three fail                                                                                                              |
| 2. Production refuses `enable_database = false`  | `prod_database_off_fails` (`cell.tftest.hcl:958`, `expect_failures` at :974-977)                                         | In Task 4's scratch copy, replace the `condition` at `infra/regions/au/main.tf:69` with `true`, run, restore; then the same for `:77`. Each run fails. If Terraform cannot run on Windows, record it |
| 3. No identifier in any added line               | The implementer scans each staged file's added lines; the reviewer then scans `origin/main...HEAD` and the PR body       | In a scratch file, plant each sample listed under the pattern; each must hit                                                                                                                         |
| Live: U2 gets no minor                           | P7's response booleans (spec Behaviour)                                                                                  | Live only. The positive control is P5's minors shown to U1                                                                                                                                           |
| Live: migration grants                           | M13–M18 one-off, `mismatches 0`                                                                                          | Weakened locally before this plan was sent (see **Probe record**): each of three planted grant changes was caught                                                                                    |

**Pin 3 pattern** (`grep -n -E`, one alternation):

```
[0-9]{12}|\barn:|@|\bZ[0-9A-Z]{10,}\b|\.amazonaws\.com|communityhub-staging|\b([0-9]{1,3}\.){3}[0-9]{1,3}\b|\b([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|[0-9a-fA-F:]*::[0-9a-fA-F:]+|\b[0-9a-f]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(subnet|sg|vpc|eni)-[0-9a-f]{8,17}\b|\b(cus|sub|price|prod|in|pi|cs|evt|we)_[A-Za-z0-9]{8,}\b|\b[0-9]{8}\b|\bproof-[0-9a-f]{8}\b|\beyJ[A-Za-z0-9_-]{10,}|(^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43,}
```

**Samples to plant** for the pin 3 weakening, one per line, each of which must hit: `123456789012`, `arn:aws:iam::x`, `name$'\x40'example.test` written with a literal at-sign, `Z0123456789ABC`, `x.amazonaws.com`, `communityhub-staging`, `10.0.0.1`, `fe80::1`, `0123456789abcdef0123456789abcdef`, `0198c3a2-7b1e-7c00-8a00-000000000000`, `subnet-0123456789abcdef0`, `cus_ABCDEFGH12`, `12345678` (an 8-digit sign-in code), `proof-1a2b3c4d` (a slug), `eyJhbGciOiJIUzI1NiJ9`, and a 43-character token `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ`.

**Allowed hits**, each still listed by file and line in the task report:

- Markdown table separator rows.
- The at-sign in `@community-hub/db` inside the one-off commands, in zsh array expansions, in the existing `service@${DIGEST}` image reference, and in existing runbook lines. New prose writes an at-sign as `$'\x40'`.
- The existing `0.0.0.0` CIDR text and `communityhub-staging` in the existing Shell variables table.
- `sha256:` digests and the decimal runs inside them.
- Long Terraform resource names caught by the 43-character run.
- Dates written `YYYY-MM-DD` do not match the 8-digit class; an 8-digit run that is a count or a time stays a stop until the reviewer clears it.
- Terraform resource addresses and `terraform test` run names already in committed Terraform.
- Placeholder hostnames built from variables, such as `admin.${ZONE_NAME}`.
- The approved spec file and this plan file.

Every other hit is a stop. Slug values, user ids and household ids cannot all be pattern-scanned; the reviewer reads every added evidence line by eye for them.

## Synthetic data

Invented names only, fixed here so P7 can test for them by name. No contact gets an email or a phone.

| Household           | Adults                      | Minors                                  | Links and events                                                                                                                                            |
| ------------------- | --------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tolland household` | Mira Tolland, Owen Tolland  | Pip Tolland, date of birth `2016-03-14` | Guardian link Mira Tolland → Pip Tolland (all four rights). Life events: Mira, marriage, `2012-09-08`, place "Riverside chapel"; Pip, baptism, `2016-06-01` |
| `Barrah household`  | Hester Barrah, Ilan Barrah  | Wren Barrah, no date of birth           | —                                                                                                                                                           |
| `Vessey household`  | Corin Vessey, Tamsin Quarle | —                                       | —                                                                                                                                                           |

- Mass Times text: a heading "Sunday" and one line "Mass at 9:00 am".
- Custom role: key `proof_people`, permissions `people.view` and `people.manage` only.
- U2's added adult (P8): Rafe Lindqvist.
- P7's minor-name strings: `Pip Tolland`, `Wren Barrah`, `Pip`, `Wren`, `2016-03-14`.

## Browser sessions

Access tokens last 15 minutes and the admin never refreshes them (spec A12). Each session below starts with a sign-in at `/` and must finish its list within 14 minutes. The reviewer agent scripts each list in advance and runs it as one playwriter call; the developer types only the values. If a list is not finished at 13 minutes, the session stops, and the rest moves to the next session. A code that never arrives means the address hit its cap: wait for the window, never resend.

| #   | User | Work list                                                                                                                                                                                                                                                                                                                                      | Proofs           |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| B0  | —    | Baseline: the developer opens `/` on the admin host in the proof profile. The agent records the console baseline (count of messages, by source host only) and sign-in's axe result (recorded, not required to be 0; spec A10) before sign-in.                                                                                                  | Baseline         |
| B1  | U1   | Sign in; type the slug; open General Settings → Billing; subscribe. The developer types the Stripe test card and the synthetic Checkout values by hand, declining every autofill. Across the whole session the agent records the distinct request hosts other than the admin host (count), the methods used, CSP violations and CORS failures. | P1, P2, P3 (1–2) |
| B2  | U1   | After the webhook check: sign in at `/`; record `state` and `planKey` from the billing status response and stop unless `ok` and `starter`; the three nav items show; add the six adults in All Contacts; create the three households; add each household's adults.                                                                             | P3 (5), P4       |
| B3  | U1   | Add the two minors; link the guardian; add the two life events; save the Mass Times text, navigate away and back.                                                                                                                                                                                                                              | P4, P6           |
| B4  | U1   | The A10 views at 1280px, light; P5 checks and screenshots.                                                                                                                                                                                                                                                                                     | P5               |
| B5  | U1   | The A10 views at 375px, dark; P5 checks and screenshots; Users & Roles role-query assertions (no screenshot).                                                                                                                                                                                                                                  | P5               |
| B6  | U2   | First sign-in only. Check that no people screen shows. Sign out.                                                                                                                                                                                                                                                                               | P7 (1)           |
| —   | —    | The owner runs the A6 one-off (Human H6) and passes U2's id privately to the developer.                                                                                                                                                                                                                                                        | P7 (2)           |
| B7  | U1   | Create the `proof_people` role; the developer pastes U2's id into Grant after checking it is not on the owner's grant line; the Users & Roles assertions below. Sign out; reload at `/` asks for sign-in.                                                                                                                                      | P7 (3), P9       |
| B8  | U2   | P7 checks and screenshots at 1280px light and 375px dark; add Rafe Lindqvist; sign out; reload at `/` asks for sign-in.                                                                                                                                                                                                                        | P7, P8, P9       |

**Code count.** U1 signs in for B1–B5 and B7 (six codes) and U2 for B6 and B8 (two). The developer keeps a list of each code's request time per address. No address requests a fifth code within 60 minutes of its first in a window; B4 or B5 waits if needed.

**Screens.** For U1 (P5): the restyle spec's Screens list, minus sign-in and Users & Roles: General Settings and Billing, Module Toggles, Mass Times, All Contacts (Adults and Minors), Contact Details, Family Records, Family Details, and the forms opened from them. For U2 (P7), spec A10: Contact Details, Family Records and Family Details only, plus All Contacts for the Minors-button check. Every capture first injects the style rule that hides the sidebar Community picker, and, for U2, the Family Records target-household select.

**Users & Roles assertions** (B5 and B7, role queries only, no screenshot): the page has one `h1`; the grant, custom-role, built-in-role and user-link lists render as `listitem`s; Revoke, Delete custom role, Create custom role and Grant buttons are present for U1; after B7's grant, the grant list has one more item than before; 0 axe violations; no sideways scroll at 375px.

**Expected 4xx, not failures** (subtracted from P5 and P7's failed-request count): the browser's own `GET /favicon.ico` on the admin host (the admin ships no icon; Ops console proof finding at runbook :3918); for U2 in B6, the 403 answers to people and household reads before the grant; any 401 after a token expires at a session's end. Every other 4xx or 5xx counts.

## Rollback

| Point                                              | Rollback                                                                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before Apply 1                                     | A new commit reverts the unpark. There is no spend.                                                                                                                                                                               |
| Apply 1 plan not as expected                       | Do not apply. Staging stays parked. Reconcile in a separate chunk.                                                                                                                                                                |
| After Apply 1: any proof failure, or the hard stop | Stop the proofs. If a test subscription exists, cancel it and check its delivery (H9) first. Remove `service_image` from the local file. Make the Task 4 commit and push it after review. Task 4 may come before Task 3. Apply 2. |
| Failed re-park apply                               | Do not open the pull request. The owner fixes state and re-applies the Task 4 SHA until the plan is empty.                                                                                                                        |

### Resume after a fix

When a proof failed because of code, the fix lands on `main` through its own `fix/` branch and publishes. Do not open this chunk's pull request between runs.

1. Merge `origin/main` into this branch with a merge commit.
2. Repeat Task 2 as a new unpark commit.
3. Repeat H1–H9 with the new `${DEPLOY_SHA}` and digest. The database is new, so every one-off, the subscription and the data run again.
4. Append the evidence as "Run 2" (Task 3 again), then Task 4, H10 and Task 5. Task 6 records both runs.

## Stop and ask (AGENTS.md §12)

**Implementer:** the spec or plan is wrong or ambiguous; a product, Terraform, lock file, Dockerfile, workflow or dependency change seems needed; a pin 3 hit not on the allowed list; the same step fails twice.

**Day of run:**

- any pre-check fails;
- the plan does not match the 18 addresses;
- a one-off prints anything but its fixed success output (`done applied=19 total=19`, `created`, `tax_rate `-prefixed, `plan_set`, `seeded`, `none`, `count 2` plus one id, or the M13–M18 lines ending `mismatches 0`);
- `provision-owner` prints `already_bootstrapped`;
- P1, over B1, finds other than two hosts besides the admin host, a CSP violation or a CORS failure;
- the served `index.html` does not name the one `assets/index-*.js` the bucket holds (subsection 3);
- the webhook check in P3 finds an `unlinked` outcome or no `processed` one within 5 minutes;
- `/v1/billing/status` is not `ok` after P3;
- any P5 or P7 check fails, or any U2 view contains a minor-name string;
- a screenshot shows a slug, address, hostname or id and cannot be deleted before it leaves the scratchpad;
- the A6 one-off prints a count other than 2;
- the 48-hour hard stop is reached.

---

### Task 1: Runbook section before spend

**Files:** Modify `docs/runbooks/apply-staging-au.md`. Add a new section `## Admin screens proof` directly after the end of `## Ops console proof` and before the next `##` heading. Edit no other section.

**Change.** Write the section in the runbook's conventions: one pasteable command per indented block; zsh with `${VAR}`; no inline `#` comments; evidence as counts and yes/no only. Refer to **Ops console proof** and **Stripe billing proof** by subsection name where a step is unchanged, substituting `${DEPLOY_SHA}` for any fixed SHA, `cfcf3f7` for `fd59b1e` (runbook :2805, :2870, :2876), 19 tags, and both `publish` and `admin-publish`. Where an Ops step reads `${HELD_EMAIL}` (the SES check at :2930-2934), this section uses `${HELD_U1_EMAIL}` and `${HELD_U2_EMAIL}` instead. Each appendix below is the `--overrides` word only; the runbook wraps each in the full `aws ecs run-task` block from **Row counts (counts only)** (:1170-1177), with `${OPS_TASK_DEFINITION}` and container `db-ops`.

0. **General rules.** Write this section's own rules; do not inherit **Ops console proof → General rules**, which are about passkeys and an 8-hour session. The rules:
   - Browser work runs in the sessions in this plan's **Browser sessions** table, one tab, every reload at `/`.
   - The reviewer agent prints no page text, URL, `sessionStorage`, request target or id.
   - One-offs never overlap. A Spot interruption is not a failure; rerun that step once. Every `filter-log-events` call carries `--start-time`.
   - Start gate: Apply 1 starts only when the owner and the developer can run H1–H9 in one sitting of about 4–8 hours.
1. **Shell variables.** Reuse the whole **Ops console proof → Shell variables** table (including `${PROVISION_SECRET_NAME}`, `${SECRETS_KEY_ARN}`, `${DB_INSTANCE_ID}`, `${PLAN_FILE}`, `${API_HOST}` and `${AUTH_HOST}`) and the whole **Stripe billing proof → Shell variables** table (including `${BILLING_SECRET_ID}`, `${PROOF_EMAIL}`, `${PROOF_NAME}` and `${SERVICE}`). Add:
   - `${ADMIN_HOST}` = `admin.${ZONE_NAME}`;
   - `${HELD_U1_EMAIL}` and `${HELD_U2_EMAIL}`, each entered once at a silent prompt;
   - `${HELD_ORG_SLUG}` and `${HELD_COMMUNITY_SLUG}`, each generated once with `"proof-$(openssl rand -hex 4)"`;
   - `${WINDOW_START_MS}`, set just before B1 with the runbook's `$(( $(date +%s) * 1000 ))` form;
   - `${HARD_STOP_UTC}`.
2. **Before the unpark (owner and developer, parked).** Yes/no, stop on any no:
   - both A4 addresses show `VerificationStatus` `SUCCESS` (owner's shell, status only);
   - the four **Stripe billing proof → Stripe dashboard** checks pass, and **Stripe billing proof → Webhook secret → Owner checks** prints `true` for both the `whsec_` and the `rk_test_` checks (owner);
   - the developer's proof profile exists, with playwriter as its only extension and Shields off for the admin host.
3. **Pre-checks.** As in **Ops console proof → Pre-checks**, plus:
   - **A3 (owner, own shell, never printed).** Each origin must equal its host exactly, with no trailing slash, because the admin builds `${origins.api}${path}` (`apps/admin/src/api.ts:100`) and CORS allows one exact origin (`infra/modules/aws-ingress/main.tf:195-200`):

         [[ "$(gh variable get ADMIN_API_ORIGIN)" == "https://${API_HOST}" ]] && print yes || print no

         [[ "$(gh variable get ADMIN_AUTH_ORIGIN)" == "https://${AUTH_HOST}" ]] && print yes || print no

     Expected: `yes` twice. If either is `no`, the owner sets it and reruns `admin-publish`, and A1 names that run.

   - **Latest build.** `admin-publish` runs on every push to `main`, so `${DEPLOY_SHA}` must be the newest `main` push run, and that run succeeded:

         [[ "$(gh run list --workflow ci.yml --branch main --event push --limit 1 --json headSha,conclusion --jq '.[0].headSha + " " + .[0].conclusion')" == "$(git rev-parse ${DEPLOY_SHA}) success" ]] && print yes || print no

     Expected: `yes`. A successful run means `publish` and `admin-publish` both passed.

   - **Served build (owner).** The served `index.html` names a script that is in the bucket, which the publish sync (`--delete`) holds for the latest build only. This replaces the spec's "matches the CI artefact" (see Deviations):

         ADMIN_BUCKET=$(terraform -chdir=infra/regions/au output -raw admin_bucket)

         SERVED=$(curl -fsS "https://${ADMIN_HOST}/index.html" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | sort -u)

         [[ $(print -r -- "${SERVED}" | wc -l) -eq 1 && -n "${SERVED}" ]] && aws s3 ls --profile ${AWS_PROFILE} "s3://${ADMIN_BUCKET}/${SERVED}" >/dev/null 2>&1 && print yes || print no

         unset ADMIN_BUCKET SERVED

     Expected: `yes`.

   - The journal holds 19 tags. `git log --oneline 57b2d3d..${DEPLOY_SHA} -- infra/` prints nothing.
   - The owner writes `service_image`, and `grep -c '^service_image'` prints 1.
   - A read-only plan without the lock matches the 18 addresses that **Stripe billing proof → Apply 1** lists.
4. **Apply 1.** As in **Ops console proof → Apply 1**. Record the UTC completion and set `HARD_STOP_UTC` to 48 hours later.
5. **One-offs.** In order, each with the three **After a db-ops-container one-off** commands or their `service`-container equivalent:
   1. `db-bootstrap`, then `db-migrate`: `done applied=19 total=19`.
   2. `provision-owner` for U1, as in **Ops console proof → One-offs → Create**, including **Check the name is free** (runbook :3063-3078), with `${HELD_U1_EMAIL}` in place of `${HELD_EMAIL}` everywhere it appears: `created`. The owner then passes `${HELD_COMMUNITY_SLUG}` privately to the developer.
   3. **Stripe billing proof → One-offs** `billing-admin settings` (same values), `plan` with `PLAN_KEY=starter`, `LOOKUP_KEY=starter_monthly`, `TRIAL_ELIGIBLE=true` and `ENTITLEMENTS="module.engagement,module.forms,module.content,module.giving,people.directory,people.households,groups.basic,communications.email,giving.one_off"`, `seed-test-catalogue` once, and `mode ${HELD_ORG_SLUG} self_serve`: `none`.
6. **Running-task check (assistant).** As in **Ops console proof → Running-task check**, with the environment-name check from **Stripe billing proof → Running-task check** (:2170-2178): the `service` container lists all four of `ADMIN_ORIGIN`, `BILLING_SECRET_ARN`, `MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET`, names only.
7. **M13–M18 (owner).** The **Appendix: M13–M18 one-off** command on `${OPS_TASK_DEFINITION}`, container `db-ops`, then the three **After** commands. Expected output, in order:

   ```
   usage_facts_daily 111111
   groups 111111
   group_members 111111
   persons 111111
   households 111111
   household_keys 111111
   life_events 111111
   service_times 111111
   version_columns 2
   trigger 1
   permission_check 1
   mismatches 0
   ```

   Each table line's six digits are, in order: RLS, FORCE, `DELETE`, `TRUNCATE`, table `UPDATE` and the column `UPDATE` set, each `1` when it matches the spec's expected value.

8. **Browser sessions B0–B5.** The plan's table, with the P1–P6 expected results from the spec. Between B1 and B2, the assistant checks the webhook outcomes as in **Stripe billing proof → S4** (counts only). B2 opens with its sign-in at `/`, and the agent records `state` and `planKey` from the page's own `/v1/billing/status` response. The rest of B2 runs only if they are `ok` and `starter`.
9. **U2 (B6, H6, B7, B8).** B6. Then the owner runs the **Appendix: A6 one-off** and alone runs its three **After** commands, reporting the exit code and the `count 2` line only, and passes the id to the developer privately. Before `${TASK_ARN}` is reused, the owner deletes that task's log stream and checks it is gone:

       aws logs delete-log-stream --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --log-stream-name "db-ops/db-ops/${TASK_ARN##*/}"

       aws logs describe-log-streams --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --log-stream-name-prefix "db-ops/db-ops/${TASK_ARN##*/}" --query 'length(logStreams)' --output text

   Expected: the second prints `0`. Record yes. Then B7 and B8.

10. **Close-out.** The owner cancels the test subscription in the Stripe dashboard; within 5 minutes, the assistant counts a `customer.subscription.deleted` webhook with outcome `processed` and a 2xx delivery, as in **Stripe billing proof → S9**. Then Task 3, Task 4, the removal of `service_image` (`grep -c` prints 0), and Apply 2.
11. **Apply 2.** As in **Ops console proof → Apply 2**: 0 to add, 0 to change, 18 to destroy; read back 0 RDS instances and 0 ECS clusters; a plan with no changes.

**Commit subject:** `docs(runbooks): add the admin screens proof`

- [ ] Write the section, including both appendix `--overrides` words copied byte for byte from this plan, each inside its full `run-task` block.
- [ ] Note in the section that U1's bootstrap roles hold every permission the screens need (see **Probe record**), so no role step is needed for U1.
- [ ] Run `pnpm exec prettier --check docs/runbooks/apply-staging-au.md` and `pnpm check:boundaries`.
- [ ] Run the pin 3 scan on the staged added lines and list every hit with its allowed reason.
- [ ] Check that `git diff --cached --name-only` shows only the runbook. Commit.

---

## Human: before the unpark

- **H0. Runbook subsection 2 (owner and developer, parked).** Nothing billable starts.

---

### Task 2: Unpark commit

**Files:** Modify `infra/regions/au/env/staging.tfvars`.

**Change:** set `enable_database = true` and `desired_count = 1`. Add no `service_image` and no comment, and leave the other lines unchanged.

**Proves:** the Apply 1 SHA is on origin.

**Rule this must not break:** no `service_image` in a committed file.

**Commit subject:** `feat(infra): unpark staging for the admin screens proof`

- [ ] Edit the file, then run `terraform fmt` on it.
- [ ] Run the Terraform checks for `infra/regions/au`, or record that Windows cannot.
- [ ] Run `pnpm format`, `lint`, `typecheck` and `check:boundaries`, then `pnpm turbo run test --force --continue --concurrency=1`, and record that only the three parked tests fail (pin 1a), plus the Windows exceptions.
- [ ] Check that `git diff --cached --name-only` shows `staging.tfvars` only. Run the pin 3 scan.
- [ ] Commit. Push only after the reviewer accepts, and before Apply 1.

---

## Human: pre-checks through proofs

- **H1. Pre-checks (assistant and owner).** Runbook subsection 3, including the push of Task 1 and Task 2.
- **H2. Apply 1 (owner; the assistant checks the plan).** On the Task 2 SHA.
- **H3. One-offs (owner).** Runbook subsection 5.
- **H4. Running-task check (assistant).** Runbook subsection 6.
- **H5. M13–M18 (owner).** Runbook subsection 7.
- **H6. Browser B0–B5 (reviewer agent and developer).** Runbook subsection 8.
- **H7. U2 (owner, developer, reviewer agent).** Runbook subsection 9.
- **H8. Screenshot check (reviewer agent).** Every image in the scratchpad `proof/shots/` is checked against spec A11; any that fails is deleted. The developer keeps the passing set for the PR.
- **H9. Cancel and delivery check (owner and assistant).** Runbook subsection 10, first part.

---

### Task 3: Record proof evidence

**Files:** Modify `docs/runbooks/apply-staging-au.md`, inside `## Admin screens proof` only.

**Change:** an **Evidence** subsection with the reviewer's lines from H1–H9: SHAs, digest, scan counts, the 18 addresses as Terraform addresses, each one-off's exit code and fixed output, the M13–M18 lines, P1–P9 as yes/no and counts, the screenshot count kept, the webhook counts, the cost clock start and the hard stop. Then a **Verified on staging** list naming each of `usage-facts`, `Groups`, `All Contacts admin`, `Family Records`, `Life events`, `Mass Times` and `admin-screens-restyle` with the proof that covers it. `usage-facts` and `Groups` have no admin screen, so their lines rest on M13 and M14 only, and say so.

**Commit subject:** `docs(runbooks): record the admin screens proof evidence`

- [ ] Write only the lines the reviewer supplies. Add no value of a forbidden class.
- [ ] Pin 3 scan; reviewer reads every added line by eye.
- [ ] Commit. Push only after the reviewer accepts.

---

### Task 4: Re-park commit

**Files:** Modify `infra/regions/au/env/staging.tfvars`.

**Change:** set `enable_database = false` and `desired_count = 0`. The file must equal `origin/main`'s byte for byte: `git diff origin/main -- infra/regions/au/env/staging.tfvars` prints nothing.

**Commit subject:** `feat(infra): re-park staging after the admin screens proof`

- [ ] Edit, `terraform fmt`, and the byte-equality check.
- [ ] Run pins 1b, 1c and 2 in a scratch copy, each failing as the Security pins table says; restore.
- [ ] Run `terraform test` for `infra/regions/au` explicitly, because the gate skips Terraform when `staging.tfvars` equals `main`'s. If Windows cannot, record it; CI's offline Terraform job covers it.
- [ ] Run the Windows full gate; only the known Windows exceptions fail.
- [ ] Check `git diff --cached --name-only`; pin 3 scan; commit. Push only after the reviewer accepts.

---

## Human: re-park apply

- **H10. Re-park (owner).** Runbook subsection 11 on the Task 4 SHA.

---

### Task 5: Record the re-park

**Files:** Modify `docs/runbooks/apply-staging-au.md`, inside `## Admin screens proof` only.

**Change:** under **Admin screens proof → Evidence**: Apply 2's counts and addresses, the read-back, the no-change plan, and the cost clock end and total.

**Commit subject:** `docs(runbooks): record the admin screens proof re-park`

- [ ] Write the reviewer's lines; pin 3 scan; commit after acceptance.

---

### Task 6: Catalogue

**Files:** Modify `docs/roadmap.md` and `AGENTS.md` (line 9 only).

**Change:**

- `docs/roadmap.md`:
  - the snapshot (:25; last shipped `admin-screens-proof`, next chunk, counts reconciled);
  - the "Next is" line (:99);
  - the `admin-screens-proof` row (:174), marked **done** with what was proven and the spec and plan paths;
  - delete the six open-item paragraphs: the five that start "The next chunk that unparks staging verifies migration" (`0013` :350, `0014` :352, `0015` :364, `0016` :376, `0017` :382) and the one that starts "The first chunk that unparks staging verifies migration `0018`" (:396);
  - Next spec (:408; the chunk owner names it). Line numbers are as at `b5b017d`; match by text.
- `AGENTS.md:9`: add `` `admin-screens-proof` `` to the done list and update "Next is".

**Commit subject:** `docs: mark admin-screens-proof done`

- [ ] Run `rm -f docs/plans/*-report.md` and `git status --short`; nothing under `.superpowers/` is staged.
- [ ] Prettier, `check:boundaries`, pin 3 scan. Commit.

---

## Definition of done (AGENTS.md §8)

- [ ] Tasks 1–6 committed and accepted; H0–H10 done.
- [ ] P1–P9 and M13–M18 pass, with evidence in the runbook.
- [ ] Staging parked in committed files; Apply 2 applied; plan empty.
- [ ] The full gate green after the re-park; CI green.
- [ ] Screenshots attached to the PR; second review recorded.
- [ ] The reviewer runs the pin 3 scan on the PR body before the PR opens.

## Probe record

Run on 2026-11-09 in the developer's machine, before this plan was sent for approval, against a local `postgres:17` from `packages/db/test/docker-compose.yml`, bootstrapped and migrated with `applyProductMigrations` (all 19 tags). The two appendix commands were taken back out of their shell-quoted form with `bash -c 'printf %s …'` and `JSON.parse`, so the quoting was tested too. Only the connection prologue was swapped for a plaintext local identity login.

- A6 with 1, 2 and 3 identity users: exit 1 (`count 1`), exit 0 (`count 2` and the newer id, which matched the second inserted), exit 1 (`count 3`).
- M13–M18 on fresh migrations: exit 0, the twelve expected lines, `mismatches 0`.
- A5's role check, from code: `bootstrapOwner` grants `org_owner` and `community_admin` (`modules/core/access/infrastructure/grants.ts:252-290`), and both map to the full permission catalogue (`packages/policy/src/decide.ts:19,23`), which includes `people.view`, `people.manage`, `people.restricted.read` and `service_times.manage` (`modules/core/access/domain/role.ts:26-36`).
- Weakened, one at a time, then restored: `grant delete on app.persons to app` gave `persons 110111`, `mismatches 1`; `grant update on app.life_events to app` gave `life_events 111100`, `mismatches 2`; `no force row level security` on `service_times` gave `service_times 101111`, `mismatches 1`. After restoring: `mismatches 0`.

## Appendix: A6 one-off

The `--overrides` word for `aws ecs run-task` on `${OPS_TASK_DEFINITION}`, used in place of the Row counts block's word:

```
'{"containerOverrides":[{"name":"db-ops","command":["node","--input-type=module","-e","import{createDirectSql}from'\''@community-hub/db'\'';import{readFileSync}from'\''node:fs'\'';try{const pem=readFileSync('\''/app/certs/rds-ap-southeast-2-bundle.pem'\'','\''utf8'\'');const e=process.env;const sql=createDirectSql({host:e.PGHOST,port:Number(e.PGPORT),database:e.PGDATABASE,user:'\''identity'\'',password:e.PGPASSWORD_IDENTITY,ca:pem});const c=await sql`select count(*)::int c from identity.users`;if(c[0].c!==2){console.log('\''count '\''+c[0].c);await sql.end({timeout:1});process.exit(1);}const r=await sql`select id::text id from identity.users order by id desc limit 1`;console.log('\''count 2'\'');console.log(r[0].id);await sql.end({timeout:1});}catch{console.error('\''fail'\'');process.exit(1);}"]}]}'
```

## Appendix: M13–M18 one-off

The `--overrides` word for `aws ecs run-task` on `${OPS_TASK_DEFINITION}`, used in place of the Row counts block's word:

```
'{"containerOverrides":[{"name":"db-ops","command":["node","--input-type=module","-e","import{createDirectSql}from'\''@community-hub/db'\'';import{readFileSync}from'\''node:fs'\'';try{const pem=readFileSync('\''/app/certs/rds-ap-southeast-2-bundle.pem'\'','\''utf8'\'');const e=process.env;const sql=createDirectSql({host:e.PGHOST,port:Number(e.PGPORT),database:e.PGDATABASE,user:'\''identity'\'',password:e.PGPASSWORD_IDENTITY,ca:pem});const T=[['\''usage_facts_daily'\'',1,1,0,0,1,'\''*'\''],['\''groups'\'',1,1,0,0,1,'\''*'\''],['\''group_members'\'',1,1,1,0,1,'\''*'\''],['\''persons'\'',1,1,0,0,0,'\''age_basis,birthday_md,date_of_birth,email,email_bidx,family_name,given_name,household_id,phone,phone_bidx,version'\''],['\''households'\'',1,1,0,0,0,'\''label,version'\''],['\''household_keys'\'',1,1,0,0,0,'\'''\''],['\''life_events'\'',1,1,0,0,0,'\''event_date,event_type,notes,place,version'\''],['\''service_times'\'',1,1,0,0,0,'\''content_html,updated_at,version'\'']];let bad=0;const out=[];for(const [n,rls,frc,del,trn,upd,cols] of T){const k=await sql`select c.oid::int o,c.relrowsecurity r,c.relforcerowsecurity f from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='\''app'\'' and c.relname=${n} and c.relkind='\''r'\''`;if(k.length!==1){bad++;out.push(n+'\'' exists false'\'');continue;}const o=k[0].o;const p=await sql`select has_table_privilege('\''app'\'',${o}::oid,'\''DELETE'\'') d,has_table_privilege('\''app'\'',${o}::oid,'\''TRUNCATE'\'') t,has_table_privilege('\''app'\'',${o}::oid,'\''UPDATE'\'') u`;const a=await sql`select a.attname::text n,has_column_privilege('\''app'\'',${o}::oid,a.attnum,'\''UPDATE'\'') u from pg_attribute a where a.attrelid=${o}::oid and a.attnum>0 and not a.attisdropped order by a.attname`;const got=a.filter(x=>x.u).map(x=>x.n).join('\'','\'');const want=cols==='\''*'\''?a.map(x=>x.n).join('\'','\''):cols;const ok=[k[0].r===!!rls,k[0].f===!!frc,p[0].d===!!del,p[0].t===!!trn,p[0].u===!!upd,got===want];const m=ok.filter(x=>!x).length;bad+=m;out.push(n+'\'' '\''+ok.map(x=>x?1:0).join('\'''\''));}const v=await sql`select count(*)::int c from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace s on s.oid=c.relnamespace where s.nspname='\''app'\'' and a.attname='\''version'\'' and c.relname in ('\''persons'\'','\''households'\'') and not a.attisdropped`;if(v[0].c!==2)bad++;out.push('\''version_columns '\''+v[0].c);const g=await sql`select count(*)::int c from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace s on s.oid=c.relnamespace where s.nspname='\''app'\'' and c.relname='\''persons'\'' and t.tgname='\''persons_before_update'\'' and not t.tgisinternal`;if(g[0].c!==1)bad++;out.push('\''trigger '\''+g[0].c);const d=await sql`select pg_get_constraintdef(x.oid) d from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace s on s.oid=c.relnamespace where s.nspname='\''app'\'' and c.relname='\''custom_role_permissions'\'' and x.conname='\''custom_role_permissions_permission'\''`;const has=d.length===1&&['\''people.view'\'','\''people.manage'\'','\''service_times.manage'\''].every(w=>d[0].d.includes(w));if(!has)bad++;out.push('\''permission_check '\''+(has?1:0));out.push('\''mismatches '\''+bad);for(const l of out)console.log(l);if(bad!==0){await sql.end({timeout:1});process.exit(1);}await sql.end({timeout:1});}catch{console.error('\''fail'\'');process.exit(1);}"]}]}'
```
