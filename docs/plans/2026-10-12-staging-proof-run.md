Spec: docs/specs/2026-10-12-staging-proof-run.md

# Staging proof run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unpark staging long enough to apply product migrations and record the ten proofs from the spec, then re-park before the pull request opens.

**Architecture:** Six agent commits (four documents, two `staging.tfvars` flag changes). No product code. The human runs every apply, every ECS one-off, and `put-secret-value`. The owner's assistant is read-only and records evidence. Nothing in an agent task calls AWS.

Slug: staging-proof-run
Status: approved (2026-10-12, Abdus)

**Branch:** `feat/2026-10-12-staging-proof-run` · one PR · six agent commits after the approved spec

## Who does what

| Actor                         | Writes repo commits                             | Runs `terraform apply`                | Runs `aws ecs run-task` / `put-secret-value` | Applies or merges |
| ----------------------------- | ----------------------------------------------- | ------------------------------------- | -------------------------------------------- | ----------------- |
| Authoring / implementer agent | Yes — runbook, tfvars, evidence, catalogue only | Never                                 | Never                                        | Never             |
| Human owner (Abdus)           | Never during the run                            | Yes — apply 1, apply 2, re-park apply | Yes — all one-offs and rotation              | Merges the PR     |
| Owner's assistant             | Never                                           | Never                                 | Never — read-only AWS, HTTP, browser         | Never             |

The assistant describes resources, reads CloudTrail and CloudWatch Logs, calls the staging hostnames over HTTP, and runs the signed-out browser pass. It writes no repo file.

## Global constraints

- The spec is approved and is not edited by any task.
- The agent does not run `terraform apply`, `terraform init` with a live backend, `aws`, `docker push`, or any command in a **Human** section.
- `service_image` is never committed. The digest URI lives only in the gitignored `infra/regions/au/env/staging.local.tfvars`.
- No real account id, hosted zone id, alarm email, key ARN, secret ARN, password, registry host, hostname, task id, or synthetic email address in commits, the plan, or runbook evidence.
- The branch is already rebased on `origin/main` and pushed. From apply 1 onward: no rebase, no amend, no force-push. If `origin/main` moves, bring it in with a merge commit. The pull request opens only after the re-park commit, the re-park apply, the empty plan, the runbook apply records, and the catalogue commit — with `staging.tfvars` parked and the full gate green (turbo cache bypassed after re-park — see Tasks 4–6). The PR merges with a merge commit, not squash. This follows AGENTS.md §5 and §9: after the first apply there is no rebase, amend or force-push; `origin/main` comes in by a merge commit; the pull request merges with a merge commit so recorded apply SHAs stay valid.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Second fresh-context review is required before merge. Leave that line open in the PR. The assistant starts it when the PR opens.
- Image comes from the `publish` and `admin-publish` jobs on `main` for the chosen SHA. Nobody builds or pushes by hand.

**Migration wave:** None. Existing migrations apply to a database destroyed at re-park.

**Terraform asserts added by this chunk:** None. `staging_unpark`, `staging_image_null`, and `database_off` in `infra/regions/au/tests/cell.tftest.hcl` already pin unpark, apply-1-only, and re-park plan shapes (spec Contracts). No new `tftest` assert is required; a scratch probe is not run for this plan.

## CI and local gate while unparked

| Check                                                                                   | Reads committed `staging.tfvars`?                                                                                                                             | On unpark commit (Task 2) and evidence commit (Task 3) while still unparked | After re-park commit (Task 4) |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------- |
| `pnpm format`, `lint`, `typecheck`, `check:boundaries`                                  | No                                                                                                                                                            | Pass when run                                                               | Pass                          |
| `pnpm test` — `modules/core/entitlements/db/parked.test.ts`                             | Yes — expects `enable_database = false`, `desired_count = 0`                                                                                                  | **Fail**                                                                    | Pass                          |
| `pnpm test` — `modules/core/people/domain/boundaries.test.ts` (`leaves staging parked`) | Yes                                                                                                                                                           | **Fail**                                                                    | Pass                          |
| `pnpm test` — `modules/core/access/domain/boundaries.test.ts` (`leaves staging parked`) | Yes                                                                                                                                                           | **Fail**                                                                    | Pass                          |
| `terraform test` in `infra/regions/au` (`database_off`, `staging_happy`, …)             | `database_off` uses explicit `enable_database = false` in the run block; file assert only forbids `service_image` and `enable_kms_endpoint` lines in the file | **Pass**                                                                    | Pass                          |
| GitHub Actions `test` job on a pull request                                             | Same as `pnpm test`                                                                                                                                           | Would **fail** if a PR were open while unparked                             | Pass                          |

**What `first-running-task` did:** That plan ran the full pnpm gate on the unpark commit and relied on the same three parked tests not existing yet (they were added with entitlements and access chunks). **What this plan does:** Accept that Task 2 and Task 3 commits fail `pnpm test` on the three parked tests. Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, and `pnpm check:boundaries` before those commits. Run `terraform -chdir=infra/regions/au test` on Task 2 and Task 4. Run the full gate with turbo cache bypassed only after Task 4 (re-park) before Task 5–6 and before opening the PR (`staging.tfvars` is outside those packages and is not in turbo `globalDependencies` or those test tasks' `inputs`). Do not open the PR until the tree is parked and the gate is green.

## Security pins

| Setting (spec)                                         | Pin                                                                                          | What would make it fail                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `enable_database` true only while unparked (Contracts) | Live proof 10 re-park plan destroys eight `module.rds[0]` resources; `database_off` tftest   | Committed file stays true after re-park; parked tests fail        |
| `desired_count` 1 only while unparked                  | Proof 1 `runningCount` 1; `staging_unpark` assert `ecs_service_desired_count == 1`           | Re-park leaves `desired_count = 0` in tfvars                      |
| `service_image` only in gitignored file                | `database_off` file assert; parked tests `not.toContain("service_image")`; pre-commit review | A line in committed `staging.tfvars`                              |
| `enable_kms_endpoint` stays false                      | Proof 2e probe + proof 5 KMS without endpoint; `staging_unpark` assert `endpoint_id == null` | Committed `enable_kms_endpoint = true`                            |
| Residency — personal data in AU (Rules touched)        | Assistant confirms region on described resources; proof 5 synthetic address never stored     | N/A in repo — live proof only                                     |
| No personal data in logs (rule 5)                      | Proof 9 log searches                                                                         | Any hit outside allowed `errorClass` / `errorCode` fields         |
| No secrets in repo (rule 8)                            | Gitleaks in CI; evidence rules in runbook                                                    | Pasting a secret into evidence                                    |
| Gateway CORS — admin origin only (proof 4)             | HTTP preflight vs `cors_configuration` in `infra/modules/aws-ingress/main.tf`                | Live proof — wrong `access-control-allow-origin` for admin origin |
| Admin CSP `connect-src` (proof 8)                      | HTTP + bundle read — "both origins present"                                                  | Live proof only                                                   |
| Pooled checkout `28P01` + `GetSecretValue` (proof 7b)  | OTP 503 after rotation; CloudTrail two `GetSecretValue` events                               | 500 on repeat OTP or wrong trail count                            |
| Task role Secrets Manager read (proof 7a)              | One-off stdout `pass`; or IAM simulate / redacted policy table                               | Non-zero exit or denied simulate                                  |
| Production refuses `enable_database = false`           | `prod_database_off_fails` tftest                                                             | N/A for staging chunk                                             |
| Image without database fails                           | `image_without_database_fails` tftest                                                        | N/A while following apply order                                   |

## Rollback

| Point                                               | Rollback                                                                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before apply 1                                      | Revert or supersede the unpark commit on a new commit (no amend if apply 1 already happened). No AWS spend if apply 1 never ran.                                     |
| Apply 1 plan not clean (unexpected CSP/CORS change) | Do not apply. Fix Terraform state or code in a separate chunk. Staging stays parked in AWS.                                                                          |
| After apply 1, before apply 2                       | New commit: `enable_database = false`, `desired_count = 0`. Apply with null `service_image`. Destroys RDS only.                                                      |
| After apply 2, proof failure                        | Stop proofs. Clear `service_image` in gitignored file. Commit re-park flags (Task 4) if not already committed. Apply re-park. Empty plan. Record failure in runbook. |
| Failed re-park apply                                | Do not open PR. Human fixes state, re-applies Task 4 SHA until plan is empty. Staging must show RDS 0 and ECS services 0 before catalogue.                           |
| After successful re-park                            | Committed rollback is the re-park SHA. AWS matches parked cell.                                                                                                      |

Every rollback ends in parked committed values and no billable database or service.

## Stop and ask (AGENTS.md section 12)

**Authoring agent:** rule in section 1 blocks the task; spec/plan ambiguity; need to change a module or product file to "make proof pass"; two failed attempts at the same plan step.

**Day of run (human):** critical ECR finding; apply plan not matching spec counts; migration stderr not resolved by bootstrap re-run; proof fails twice; 48-hour hard stop reached with proofs incomplete; `SimulatePrincipalPolicy` refused and human policy paste disagrees with code; unexpected webhooks CORS allowing admin origin (record, do not fix here); a one-off that prints anything other than its fixed success form or the single fixed failure word on stderr (no host, port, secret name, ARN, error object, message or stack).

---

### Task 1: Operator runbook — everything before spend

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Change:** Add a section **Staging proof run** (after **Apply product migrations**). It must include, in order:

1. **Pre-checks (assistant, read-only)** — Steps matching spec Order step 1: resolve deploy SHA on `main` (must contain `db-migrate-command`, `fix/2026-10-12-request-error-log`, `entitlements-plans`); confirm `publish` and `admin-publish` succeeded; record digest only; confirm repo variables for admin origins (record "both origins present", "no placeholder"); read journal tags on that SHA from `packages/db/drizzle/meta/_journal.json` for proof 3 expectations.
2. **Cost anchor** — Owner records UTC time when apply 1 completes; 24h target and 48h hard stop from that instant.
3. **Before each apply** — Pointer to existing runbook checks (clean tree, SHA on origin, both var files, gitignored last).
4. **Apply 1 and apply 2** — Expected resource counts (eight RDS, ten ECS-related); stop if admin CSP or gateway tenant API changes; wait RDS available; set digest in gitignored file only; wait service stable and VPC link AVAILABLE.
5. **Retrospective record** — Subsection for the 2026-10-12 CSP and CORS apply (owner applied before merge). Placeholder for applied commit SHA (owner confirms, believed `836a3f9` in spec — owner fills actual SHA in evidence commit). Record plan was 0 add, 2 change, 0 destroy; no ARNs.
6. **One-off network** — Shell variables only: `${AWS_PROFILE}`, `${CLUSTER}`, `${SERVICE_TASK_DEFINITION}`, `${OPS_TASK_DEFINITION}` (`ch-staging-db-ops`), `${SUBNET}`, `${TASK_SECURITY_GROUP}`, `${LOG_GROUP}` (`/community-hub/ch-staging/service`). Same pattern as **Apply product migrations**. zsh: `${VAR}:text`, not `$VAR:text`. No inline `#` inside a command string.
7. **Proof 2a–2e command overrides** — Exact `aws ecs run-task` … `--overrides` JSON (command only, no `entryPoint`):
   - 2a service container: write one file under `/tmp`, exit 0.
   - 2b service: print uid and gid `1000 1000`.
   - 2c service: try write under `/app`, exit 0 only if refused.
   - 2d ops: `["node","/app/db-bootstrap.js"]`.
   - 2e service: `["node","/app/probe.js"]` after 2d succeeds.
8. **Proof 3** — Pointer to **Apply product migrations**; second migrate run for idempotency.
9. **Row-count one-offs (proof 5)** — Subsection **Row counts (counts only)**. Family `${OPS_TASK_DEFINITION}`, same network as 2d. Login `identity` / env `PGPASSWORD_IDENTITY`; tables in order: `identity_keys`, `otp_challenges`, `users`, `sessions`, `passkey_challenges`, `passkey_credentials`. Login `platform` / env `PGPASSWORD_PLATFORM`; tables: `organisations`, `communities`, `plans`, `plan_entitlements`, `add_ons`, `add_on_entitlements`, `organisation_plans`, `organisation_add_ons`, `community_allocations`, `community_toggles`, `entitlement_overrides`, `feature_flags`. Each override runs Node with `@community-hub/db` `createDirectSql` (parameters `host`, `port`, `database`, `user`, `password`, `ca`, optional `servername`; returns a postgres `Sql`; when `host` is an IP address, `servername` is required — ops env uses DNS in `PGHOST` / `PGPORT` / `PGDATABASE` from `apps/api/src/db-ops-env.ts`, so omit `servername` the same way `apps/api/src/probe.ts` does). CA file `/app/certs/rds-ap-southeast-2-bundle.pem`, loops fixed table names. **Quiet output rule (every one-off the runbook defines — 2a, 2b, 2c, both row-count commands, and the Secrets Manager read in 7a):** on success print only that command's fixed stdout; on **any** failure print exactly one fixed word `fail` to stderr, exit 1, and never print the error object, its message, a stack, a host, a port, a secret name or an ARN. Wrap the whole body in `try`/`catch`. Example shape for identity (single `-e` string, no shell):

   `["node","--input-type=module","-e","import{createDirectSql}from'@community-hub/db';import{readFileSync}from'node:fs';try{const pem=readFileSync('/app/certs/rds-ap-southeast-2-bundle.pem','utf8');const e=process.env;const sql=createDirectSql({host:e.PGHOST,port:Number(e.PGPORT),database:e.PGDATABASE,user:'identity',password:e.PGPASSWORD_IDENTITY,ca:pem});const t=['identity_keys','otp_challenges','users','sessions','passkey_challenges','passkey_credentials'];const o=[];for(const n of t){const r=await sql.unsafe('select count(*)::int c from identity.'+n);o.push(r[0].c);}console.log(o.join(' '));await sql.end({timeout:1});}catch{console.error('fail');process.exit(1);}"]`

   Platform variant: same with `user:'platform'`, `PGPASSWORD_PLATFORM`, and the twelve platform table names in spec order.

10. **HTTP proofs (assistant)** — Shapes only, no hostnames in git:
    - Proof 4: `OPTIONS` to `/v1/access/grants/list` on api and auth hostnames; headers `Origin`, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: authorization,content-type`; repeat with non-admin origin; control on ops hostname `/health` → expect 404.
    - Proof 5: `POST /v1/auth/email-otp/start` on auth hostname, `content-type: application/json`, body `{"email":"<synthetic>"}` twice; malformed email control; CloudTrail filters for `GenerateDataKey` and `Decrypt`; log filter for `kms` lines.
    - Proof 6: POST bodies and paths from spec; placeholder slug e.g. `proof-run-no-community`; bearer 43 random base64url chars where specified.
11. **Proof 7a** — Assistant tries `iam:SimulatePrincipalPolicy` once for task role on three secrets read + secrets key decrypt; fallback table for human paste. Human one-off on **service** task definition (task role): Node `-e` using `@aws-sdk/client-secrets-manager`, `GetSecretValue` with `VersionStage` `AWSCURRENT`, secret id from `${IDENTITY_SECRET_ID}` set via describe task definition (never recorded). Stdout `pass` only on success; on any failure stdout empty, stderr exactly `fail`, exit 1 (same quiet rule as item 9).
12. **Proof 7b** — Order: force new deployment, wait stable, `put-secret-value` in one pipeline (no echo), re-run 2d, assistant repeats proof 5 POST once.
13. **Proof 8–9** — Assistant: admin `GET /`, script bundle check, browser pass steps; log search strings from spec over service and api-access groups.
14. **Proof 10** — Pointer to re-park apply; eighteen destroys; live RDS/ECS/KMS endpoint counts.
15. **Evidence rules** — Copy the spec's allowed fields; use "the api hostname", "the auth hostname", "the admin origin".

**Proves:** Operator can run the chunk without reading the spec. Before the commit, each one-off command (2a, 2b, 2c, both row-count commands, 7a) was tried in the local service image built from the deploy commit (`docker run --rm --entrypoint "" <local image tag> node …`, same pattern as `apps/api/src/image.test.ts`): 2a–2c for real with expected output; row-count and 7a against an unreachable database host / no AWS credentials so they print only `fail` to stderr, exit 1, and print no host, port, secret name or stack. No AWS call; nothing pushed. Trial results go in the task report.

**Rule this must not break:** No identifier in the runbook text. Historical sections unchanged. Quiet failure on every named one-off.

**Commit subject:** `docs(runbooks): add the staging proof run operator section`

- [ ] Write the section (quiet-failure requirement on every one-off named above).
- [ ] Try each one-off in the local image as in **Proves**; record results in the task report (not in the commit).
- [ ] `pnpm exec prettier --write docs/runbooks/apply-staging-au.md`
- [ ] `pnpm exec prettier --check docs/runbooks/apply-staging-au.md`
- [ ] Commit this file only. Push before apply 1.

---

### Task 2: Unpark commit

**Files:**

- Modify: `infra/regions/au/env/staging.tfvars`

**Change:** `enable_database = true`, `desired_count = 1`. No `service_image`. No `enable_kms_endpoint`. Other lines unchanged.

**Proves:** Apply 1 SHA matches commit on origin.

**Rule this must not break:** No `service_image` in committed file.

**Commit subject:** `feat(infra): unpark staging for the proof run`

- [ ] Edit and `terraform fmt` the file.
- [ ] `terraform -chdir=infra/regions/au init -backend=false -lockfile=readonly`
- [ ] `terraform -chdir=infra/regions/au test`
- [ ] `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm check:boundaries` (expect `pnpm test` red on parked tests — do not run full gate).
- [ ] Commit and **push** before apply 1.

## Human: pre-checks through proofs

Stop after any failed proof or second failure on the same step (AGENTS.md section 12). Then re-park (Task 4) before more attempts.

Profile `${AWS_PROFILE}` default `ch-admin`. Region `ap-southeast-2`. From `infra/regions/au`.

### H1. Pre-checks (assistant)

1. Confirm deploy SHA on `main` and CI `publish` / `admin-publish` green, ECR scan COMPLETE, CRITICAL 0. Record digest only.
2. Record journal tag list from that SHA for expected `applied <tag>` lines in proof 3.
3. Record admin bundle check for deploy SHA (proof 8b precursor).

**Stop if:** publish failed or CRITICAL > 0.

### H2. Apply 1 (owner) — Task 2 SHA, no `service_image`

1. Run before-each-apply checks from runbook.
2. `terraform init -backend-config=backend/staging.hcl -lockfile=readonly`
3. `terraform plan -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars` — paste add/change/destroy counts and resource addresses with actions only. **Stop** if anything changes `module.admin_static[0].aws_cloudfront_response_headers_policy.admin` or `module.ingress.aws_apigatewayv2_api.tenant`, or counts differ from eight RDS creates.
4. `terraform apply` with same var files.
5. Record UTC completion time in scratch for cost window.
6. Wait until RDS instance status is `available`.

**Evidence:** Plan summary and wait done (Task 3).

### H3. Apply 2 (owner) — digest in gitignored file only

1. Set `service_image` to `<registry>/ch-staging/service@sha256:<digest>` in `staging.local.tfvars` only.
2. Plan and apply. **Stop** if not exactly ten new ECS-related resources from 2026-10-06 list.
3. Wait `aws ecs wait services-stable` for `ch-staging` and VPC link name `ch-staging-link` status `AVAILABLE`.

### H4. Proofs 1–2 (assistant reads; owner runs one-offs)

**Proof 1:** `describe-services`, `list-tasks` STOPPED, five `GET /health` on api hostname → 200; digest matches pre-check.

**Proof 2:** Run 2a–2e from runbook; record exit codes and stdout/stderr per evidence rules.

**Stop if:** proof 1 or 2 fails — go to rollback.

### H5. Proof 3 (owner migrate, assistant reads)

Run **Apply product migrations** twice. Record exit, stdout, stderr. First run: one `applied <tag>` per journal entry, then `done applied=<n> total=<m>`. Second: `done applied=0 total=<m>` only.

**Stop if:** exit 1.

### H6. Proofs 4–6 (assistant HTTP)

Run proof 4, 5, 6 in spec order. For proof 5, run row-count one-offs before 7b. Record CloudTrail names and counts, kms log fields, HTTP statuses only.

**Stop if:** proof 5 returns 500 or 204; record `errorClass` / `errorCode` at once.

### H7. Proof 7 (owner one-offs; assistant reads)

7a simulate or policy table + secrets one-off. 7b rotation sequence from runbook.

**Stop if:** 7a non-zero or 7b OTP not 503.

### H8. Proofs 8–9 (assistant)

8a–8c and log searches. Record findings (e.g. CloudFront 403 on deep links) without fixing.

### H9. Retrospective CSP/CORS

Owner confirms applied commit SHA; assistant/human fill subsection from Task 1 in evidence commit.

---

### Task 3: Record proof evidence

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Change:** Under **Staging proof run**, add **Evidence** with apply 1 and apply 2 SHAs, digest, proofs 1–9 results, retrospective CSP/CORS SHA, cost anchor UTC, and "no 500" or 500 log fields if any.

**Proves:** Spec behaviour is recorded redacted.

**Rule this must not break:** Evidence rules; do not edit proof 10 until after re-park apply.

**Commit subject:** `docs(runbooks): record the staging proof run evidence`

- [ ] Write from human/assistant paste only.
- [ ] Prettier check on runbook.
- [ ] `pnpm format`, `lint`, `typecheck`, `check:boundaries` (tests still red until Task 4).
- [ ] Commit runbook only. Push before Task 4 (evidence commit on origin before the re-park commit).

---

### Task 4: Re-park commit

**Files:**

- Modify: `infra/regions/au/env/staging.tfvars`

**Change:** `enable_database = false`, `desired_count = 0`.

**Proves:** Committed cell matches parked tests and CI.

**Rule this must not break:** `prod_database_off_fails`, `image_without_database_fails`, `database_off`.

**Commit subject:** `feat(infra): park staging after the proof run`

- [ ] `terraform fmt` and `terraform -chdir=infra/regions/au test`
- [ ] Full gate with turbo cache bypassed before commit (`pnpm format`, `pnpm lint --force`, `pnpm typecheck --force`, `pnpm test --force`, `pnpm check:boundaries` — the gate script does not forward `--force`; `staging.tfvars` is not hashed in turbo `globalDependencies` or those packages' test `inputs`, so a cached parked-test result can otherwise outlive the var-file change).
- [ ] Commit. **Push before the re-park apply in H10** (runbook requires the applied commit on origin).

---

## Human: re-park apply

### H10. Re-park (owner)

Task 4 SHA must already be on origin before this apply.

1. Remove or null `service_image` in gitignored file.
2. On Task 4 SHA: plan — eighteen destroys, nothing else. Paste counts and addresses.
3. Apply. Plan again → no changes, exit 0.
4. Read-only: RDS instances 0; ECS services in cluster 0; KMS VPC endpoints 0; topic, subscription, hostname alarm, budget remain.

**Stop if:** plan not empty after apply.

---

### Task 5: Record re-park and apply history

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Change:** Complete proof 10 evidence; record both unpark applies (Task 2 SHA apply 1, apply 2 with image) and re-park apply (Task 4 SHA); update any "do not unpark" pointer so the next reader uses this section.

**Commit subject:** `docs(runbooks): record the proof run re-park`

- [ ] Full gate with turbo cache bypassed before commit (same form as Task 4 — parked tests read `staging.tfvars` outside their packages).
- [ ] Commit and push.

---

### Task 6: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md` (repository-state table row only)

**Change:** Add Phase 0 row `staging-proof-run` **done** with spec link. Snapshot: last shipped `staging-proof-run`, next `stripe-billing` (from `main` at this commit if unchanged). Counts rule: one more row and one more done than `main` at that time (worked example today: `main` is 25 rows, 24 done, 1 superseded, 0 not started → after this row, 26 rows, 25 done, 1 superseded, 0 not started). Recompute from `main` plus this row if `main` moved. Replace open-item sentence about Fargate with proof outcome; add open items for findings (CloudFront 403, etc.).

**Commit subject:** `docs(roadmap): mark the staging proof run done`

- [ ] `pnpm exec prettier --write docs/roadmap.md AGENTS.md`
- [ ] Full gate with turbo cache bypassed (same form as Task 4).
- [ ] Commit both files only. Push. Open PR only after this commit.

---

## Definition of done (AGENTS.md section 8)

**Per task:** test or check named in the task; no section 1 breach; commit message conventional; commit contains only task files; no session scratch staged.

**Per chunk:**

- [ ] All six tasks and human steps done or consciously dropped with note
- [ ] Full CI green on the PR (Stages 1–3)
- [ ] Spec behaviour verified on the staging hostnames during the run (this chunk is that verification)
- [ ] `docs/roadmap.md` and AGENTS.md repository-state updated in Task 6
- [ ] Runbook records both applies and SHAs; staging re-parked in AWS and in git
- [ ] Reviewer sign-off and second fresh-context review line closed before human merge
- [ ] Session scratch cleaned (§5)

---

## Plan approval

The owner approved this plan on 2026-10-12.
