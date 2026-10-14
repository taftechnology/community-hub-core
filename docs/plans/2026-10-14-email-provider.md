Spec: docs/specs/2026-10-14-email-provider.md

# Sign-in codes by Amazon SES Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person on staging receives an eight-digit sign-in code by Amazon SES and signs in; the first owner is provisioned live; staging is re-parked before the pull request merges.

**Architecture:** An SES v2 adapter implements the existing `OtpMail` port in `apps/api/src/mail/` and is wired only when two optional variables are set. Terraform adds staging-only SES resources, DNS records and one task-role policy in the AU root, and passes the two variables through the ingress module. The owner runs every apply and one-off; agents commit code, Terraform, documents and the two `staging.tfvars` flag changes only.

Slug: email-provider
Status: draft

**Branch:** `feat/2026-10-14-email-provider` · one PR · ten agent commits after the approved spec

## Who does what

| Actor                  | Writes repo commits                              | Runs `terraform apply`          | Runs AWS one-offs, verifies addresses | Applies or merges |
| ---------------------- | ------------------------------------------------ | ------------------------------- | ------------------------------------- | ----------------- |
| Implementer (agent)    | Yes — Tasks 1–10, only the files each task names | Never                           | Never                                 | Never             |
| Reviewer (fresh agent) | Never                                            | Never                           | Never — read-only AWS, HTTP           | Never             |
| Human owner (Abdus)    | Never during the run                             | Yes — Apply 0, Apply 1, Apply 2 | Yes                                   | Merges the PR     |
| Developer (Adnan)      | Approves this plan                               | Never                           | Never                                 | Never             |

## Global constraints

- The spec is approved and is not edited by any task.
- No agent runs `terraform apply`, `terraform init` against a live backend, `aws`, `docker push`, or any step in a **Human** section. Implementer runs start with no AWS credentials and pushes blocked; the orchestrator pushes the branch before each apply.
- `service_image` is never committed. Staging's committed flags change only in Task 7 (unpark) and Task 8 (re-park).
- No account id, zone id, ARN, hostname, email address, secret name, task id or IP address in any commit, this plan, or runbook evidence. Terraform derives names; tests use the existing synthetic placeholders.
- No hostname literal is added. The zone name is read from the one root local that Task 3 introduces.
- From Apply 0 onward: no rebase, no amend, no force-push. If `origin/main` moves, merge it in. The PR opens only after Task 10, with staging parked in git and in AWS and the full gate green with the turbo cache bypassed.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Second fresh-context review is required (authentication). It starts when the PR opens.
- One run at a time uses the Docker test database.

**Migration wave:** none. No table or column changes.

**New dependency:** `@aws-sdk/client-sesv2` `^3.758.0` in `apps/api` (Task 1). Justified in the PR per AGENTS.md §14. `pnpm audit --audit-level=high` must pass.

**Terraform asserts added by this chunk:** in `infra/regions/au/tests/cell.tftest.hcl` and `infra/modules/aws-ingress/tests/ingress.tftest.hcl` (Tasks 3 and 4). They were run in a scratch probe on 2026-10-14 (Terraform 1.11.4, the committed provider lock, `override_during = plan`, outside the repo, no apply, no real var file): both directories green (16 and 23 runs), and every Terraform pin weakening was caught. This plan carries the probe's corrections. Not probed: tflint and `terraform-invariants` on the new files; Task 3 runs both.

## Security pins

Each row: the implementer weakens the source once as described, sees the named test fail or error, restores the source, and reports the failure output in its task report. A weakened tree is never committed.

| #   | Setting (spec Rules touched)                                                                                                              | Test that pins it                                                                                                                                                                                       | Weakening that must make it fail                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Task-role policy: only `ses:SendEmail`, only region identities and the one configuration set, `ses:FromAddress` fixed                     | `cell.tftest.hcl` run `staging_happy`: the whole decoded statement compared with `==` to a literal (mocked set `arn` default) (Task 3)                                                                  | Add `ses:SendRawEmail`; or change the condition key; or widen a resource to `*`                        |
| 2   | Configuration set: no event destination, no `vdm_options`, no `tracking_options`; `tls_policy = "REQUIRE"`; suppression BOUNCE, COMPLAINT | `cell.tftest.hcl` `staging_happy`: values, `length(...) == 0` on the blocks, and `!strcontains(file("${path.module}/ses.tf"), ...)` for `event_destination`, `vdm_options`, `tracking_options` (Task 3) | Set `tls_policy = "OPTIONAL"`; or add a `tracking_options` block; or add an event destination resource |
| 3   | The identity's default configuration set is that set, so every send is covered                                                            | `cell.tftest.hcl` `staging_happy` (Task 3)                                                                                                                                                              | Remove `configuration_set_name` from the identity                                                      |
| 4   | Prod plans no SES resource and no SES policy                                                                                              | `cell.tftest.hcl` run `prod_tfvars` (Task 3); a gate on a resource others index into fails as an Invalid index error, not the assert message                                                            | Change one SES resource's gate to `count = 1`                                                          |
| 5   | Adapter log line carries only a fixed operation name and the error class name                                                             | `apps/api/src/mail/ses-otp-mail.test.ts` (Task 1)                                                                                                                                                       | Log `error.message`; or log the `to` field                                                             |
| 6   | Any adapter failure, including non-`Error` throws and client construction failure, becomes `OtpMailUnavailable`                           | `ses-otp-mail.test.ts` (Task 1)                                                                                                                                                                         | Rethrow the original error in the catch                                                                |
| 7   | One attempt, 5-second abort deadline                                                                                                      | `ses-otp-mail.test.ts` timeout case under fake timers (Task 1); `index.test.ts` client options (Task 2)                                                                                                 | Construct the client without `maxAttempts: 1`; or drop the race against the timer                      |
| 8   | Subject has no code; body is text only; no link                                                                                           | `ses-otp-mail.test.ts` command-input case (Task 1)                                                                                                                                                      | Put the code in the subject; or add an `Html` body                                                     |
| 9   | Startup fails when exactly one mail variable is set, or a value is malformed                                                              | `apps/api/src/env.test.ts` (Task 2)                                                                                                                                                                     | Accept a lone `MAIL_FROM_ADDRESS`                                                                      |
| 10  | Without both variables the service wires `rejectingOtpMail` (start answers 503)                                                           | `index.test.ts` (Task 2)                                                                                                                                                                                | Wire the SES adapter unconditionally                                                                   |
| 11  | Container gets the two variables only when they are set                                                                                   | `ingress.tftest.hcl` existing `staging_image_set` exact-list assert (`:580`) and the new runs (Task 4)                                                                                                  | Emit them with empty values when null                                                                  |
| 12  | Staging parked in committed files at merge                                                                                                | Existing parked tests (`parked.test.ts`, two `boundaries.test.ts`) and `database_off`                                                                                                                   | Leave Task 7's flags in place                                                                          |
| 13  | No address or code in service logs (rule 5)                                                                                               | Live proof P5 (log search over the window)                                                                                                                                                              | Live only                                                                                              |
| 14  | The `mail` log fields survive the logger's allow-list (operation, outcome, error class)                                                   | `index.test.ts` dropped-count and parsed-line asserts (Task 2)                                                                                                                                          | Log `outcome: "error"`; or remove `send_email` from `OPERATIONS`                                       |

## Rollback

| Point                                 | Rollback                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Before Apply 0                        | Nothing in AWS. Revert commits on new commits.                                                                             |
| After Apply 0                         | SES resources are additive and unused while parked. The owner can destroy them by reverting Tasks 3–4 and applying.        |
| After Apply 1, proof failure          | Stop proofs, Task 8 re-park commit, Apply 2, record the failure in the runbook.                                            |
| Service sending bad mail at any point | Unset the variables (remove from the task definition by re-park, or revert Task 4's root wiring): the service answers 503. |

## Stop and ask (AGENTS.md §12)

Implementer: the plan is wrong or ambiguous; a migration, Dockerfile, workflow or dependency change not named here; a checker or test outside the named files needs changing; the same step fails twice. Day of run: the Apply 0 or Apply 1 plan shows changes outside this plan's resources; DKIM not verified after 72 hours; a proof fails twice; the 48-hour hard stop.

---

### Task 1: SES adapter for `OtpMail`, and its log operation

**Files:**

- Create: `apps/api/src/mail/ses-otp-mail.ts`, `apps/api/src/mail/ses-otp-mail.test.ts`
- Modify: `apps/api/package.json`, `pnpm-lock.yaml` (add `@aws-sdk/client-sesv2` `^3.758.0`)
- Modify: `packages/observability/src/logger.ts`, `logger.test.ts`, `logger.types.test.ts` (add `"send_email"` to `LogOperation` at `:7` and to `OPERATIONS` at `:72`; outcomes unchanged)

**Shape:** `createSesOtpMail({ client, from, configurationSet, deadlineMs?, info })` returning `OtpMail`, where `client` is a **factory** `() => SesClientLike` called inside `send`'s `try`, so a constructor or credential failure is mapped like any other. Model on `apps/api/src/kms/aws-kms-adapter.ts:52-64` (structural client type, injected `info`, `errorClassOf` at `:26-36` for the class name, a `DEFAULT_DEADLINE_MS` constant at 5000). `send` builds one `SendEmailCommand` input: `FromEmailAddress = from`, `Destination.ToAddresses = [to]`, `ConfigurationSetName = configurationSet`, `Content.Simple.Subject.Data` a fixed string without the code, `Content.Simple.Body.Text.Data` containing the code, its ten-minute lifetime and an ignore line; no `Html`, no link. **Deadline:** the adapter races `client.send` against its own `setTimeout(deadlineMs)`; when the timer wins it aborts the `AbortController` whose signal it passed to `send`, and treats the result as a timeout even if the client ignores the signal. Any rejection, throw (including non-`Error` values), factory failure or timeout becomes `throw new OtpMailUnavailable()` after one `info` call with `{ operation: "send_email", outcome: "timeout" | "failed", errorClass }` (`timeout` when the timer won, `failed` otherwise; `errorClass` from `errorClassOf`, omitted on timeout). Success calls `info` with `{ operation: "send_email", outcome: "ok" }`.

**Test first (RED):** observability: `send_email` is kept by the sanitiser and typed; an unknown operation is still dropped. Adapter: command input asserted field by field; subject does not contain the code; no `Html`; SDK rejection → `OtpMailUnavailable` with `failed` and the class name; non-`Error` throw → `OtpMailUnavailable`; factory throws an `Error` and a non-`Error` → `OtpMailUnavailable`, one `info` call with `failed`; a `send` that never resolves and ignores the signal → `OtpMailUnavailable` with `timeout` under fake timers (advance by `deadlineMs`), and the signal passed to `send` is aborted; `info` payloads never contain the address, the code, the SDK message or a message id (serialise and search).

**Rule this must not break:** rule 5 (no address or code in logs); the logger's existing allow-list for KMS.

**Commit subject:** `feat(api): send sign-in codes through Amazon SES`

- [ ] Write the tests; run `pnpm --filter @community-hub/observability test` and `pnpm --filter @community-hub/api exec vitest run src/mail` and see them fail.
- [ ] Add the dependency (`pnpm --filter @community-hub/api add @aws-sdk/client-sesv2@^3.758.0`), implement, `pnpm --filter @community-hub/observability build`, see the tests pass.
- [ ] Security pins 5, 6, 7 (race), 8: weaken, see the test fail, restore.
- [ ] `pnpm audit --audit-level=high`; `pnpm gate`.

### Task 2: Optional mail variables and wiring

**Files:**

- Modify: `apps/api/src/env.ts`, `apps/api/src/env.test.ts`, `apps/api/src/index.ts`, `apps/api/src/index.test.ts`

**Shape:** `ServiceEnv` gains optional `MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET`, keys added only when set (`exactOptionalPropertyTypes`; no optional-field precedent exists in `ServiceEnv`). Both or neither; one alone, an address that is not a single `local@domain` with no whitespace or angle brackets, or a set name not matching `^[A-Za-z0-9_-]{1,64}$` returns the existing opaque failure. In `bindServices` (`apps/api/src/index.ts:100-181`), when both are present, `auth.mail` is `createSesOtpMail` with the factory `() => new SESv2Client({ region: env.AWS_REGION, maxAttempts: 1 })` (memoised after the first successful construction) and an `info` that writes through `logger.info("mail", fields)`; otherwise `rejectingOtpMail` as today.

**Test first (RED):** `env.test.ts`, table-driven: both set → ok with both; neither → ok without the keys; each alone → fail; addresses with a space, `<`, `>`, two `@`, an empty local part, an empty domain, and the empty string → fail; set names of 65 characters and with a dot → fail. `index.test.ts`, after the "api boot wiring of the kms adapter log" block (`:143-212`): `vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => ...)` keeping the real exports and replacing `SESv2Client` with a spy class that records constructor options and a `send`. With both variables, `auth.mail.send(...)` calls the spy `send` once, the constructor received exactly `{ region: <env region>, maxAttempts: 1 }`, and the `mail` log line through the real logger parses to `{ level, message: "mail", operation: "send_email", outcome: "ok" }` with `getDroppedFieldCount() === 0`. With a failing spy `send`, the line has `outcome: "failed"` and `errorClass`, and nothing is dropped. Without the variables, `auth.mail.send(...)` rejects with `OtpMailUnavailable` and the spy constructor was never called. No route request in this file (that needs the database).

**Rule this must not break:** existing required-variable behaviour and `image.test.ts` (which sets no mail variables) unchanged.

**Commit subject:** `feat(api): wire the SES sign-in mail when configured`

- [ ] RED, GREEN.
- [ ] Security pins 7 (client options), 9, 10, 14.
- [ ] `pnpm gate`.

### Task 3: Terraform — SES identity, DNS, configuration set and task-role policy (staging only)

**Files:**

- Modify: `infra/regions/au/main.tf` (one `local.zone_name` replacing the literals at `:230` and `:456`; `local.mail_domain = "mail.${local.zone_name}"`, `local.mail_from = "no-reply@${local.mail_domain}"`, `local.ses_enabled = var.environment == "staging"`)
- Create: `infra/regions/au/ses.tf`
- Modify: `infra/regions/au/outputs.tf` only if a test needs an output; `infra/regions/au/tests/cell.tftest.hcl`

**Resources (each `count = local.ses_enabled ? 1 : 0` unless noted):** `aws_sesv2_configuration_set` (`delivery_options { tls_policy = "REQUIRE" }`, `reputation_options { reputation_metrics_enabled = true }`, `suppression_options { suppressed_reasons = ["BOUNCE", "COMPLAINT"] }`, `sending_options { sending_enabled = true }`, no `tracking_options`, no `vdm_options`; no `aws_sesv2_configuration_set_event_destination` anywhere); `aws_sesv2_email_identity` for `local.mail_domain` with `configuration_set_name` set to that set and `dkim_signing_attributes { next_signing_key_length = "RSA_2048_BIT" }` (the block must be present for the tokens to be readable in plan tests); `aws_sesv2_email_identity_mail_from_attributes` with `mail_from_domain = "bounces.${local.mail_domain}"` and `behavior_on_mx_failure = "USE_DEFAULT_VALUE"`; `aws_route53_record` with `zone_id = coalesce(var.staging_zone_id, "ZUNUSED")` (the precedent at `main.tf:463`; a bare variable breaks `staging_without_zone_id_fails`), each with `ttl = 300`: three DKIM CNAMEs `${token}._domainkey.${local.mail_domain}` → `${token}.dkim.amazonses.com` (`count = local.ses_enabled ? 3 : 0`, by index into `dkim_signing_attributes[0].tokens`), MX at `bounces.${local.mail_domain}` `10 feedback-smtp.ap-southeast-2.amazonses.com`, TXT at `bounces.${local.mail_domain}` `v=spf1 include:amazonses.com ~all`, TXT at `_dmarc.${local.mail_domain}` `v=DMARC1; p=none;`; `aws_iam_role_policy` on `module.envelope.task_role_name` with one statement: `Effect = "Allow"`, `Action = ["ses:SendEmail"]` (one-element list), `Resource` = an ordered two-element list of the region's identities (`arn:aws:ses:${var.aws_region}:${var.aws_account_id}:identity/*`) then the configuration set's ARN, `Condition = { StringEquals = { "ses:FromAddress" = local.mail_from } }`.

**Test first (RED):** in `cell.tftest.hcl`, add `mock_resource` defaults for `aws_sesv2_email_identity` (`dkim_signing_attributes = { tokens = ["tok1", "tok2", "tok3"] }`, an object, not a list) and `aws_sesv2_configuration_set` (`arn`). `staging_happy`: one identity, one configuration set with the settings above (suppression compared as `toset(...) == toset(["BOUNCE", "COMPLAINT"])`; a list `==` is type-strict and false); `length` of `tracking_options` and `vdm_options` is 0; `ses.tf` contains none of `event_destination`, `vdm_options`, `tracking_options` (`file()` as at `:110`); the identity's default set is that set; each record's name, type, TTL and value; and the decoded policy statement compared whole with `==` to a literal built from the mock values (not to the resource's own attribute). `prod_tfvars`: every SES resource, the DNS records and the policy have length 0. Existing runs still pass (the zone-name refactor changes no planned value).

**Rule this must not break:** no new literal hostname; `tooling/checks/terraform-invariants` passes unchanged; no VPC endpoint; existing hostnames identical.

**Commit subject:** `feat(infra): add staging SES identity, DNS and send policy`

- [ ] Write the asserts; `terraform -chdir=infra/regions/au init -backend=false -lockfile=readonly` and `terraform -chdir=infra/regions/au test`; see them fail.
- [ ] Implement; `terraform fmt -recursive`, `validate`, `tflint --init && tflint`, `test`; `pnpm check:boundaries`.
- [ ] Security pins 1, 2, 3, 4.
- [ ] `pnpm gate`.

### Task 4: Terraform — mail variables into the service container

**Files:**

- Modify: `infra/modules/aws-ingress/outputs.tf` (new `service_environment` output: `var.service_image == null ? {} : { for e in jsondecode(aws_ecs_task_definition.this[0].container_definitions)[0].environment : e.name => e.value }`, with a description; module output only, not re-exported at the root; it holds no secret values), `infra/modules/aws-ingress/variables.tf` (each new variable with `type` and `description`; tflint's `recommended` preset is on), `infra/modules/aws-ingress/main.tf` (container `environment`, `:475-494`, new entries added with `concat` only when non-null), `infra/modules/aws-ingress/tests/ingress.tftest.hcl`, `infra/regions/au/main.tf` (pass `mail_from_address = local.ses_enabled ? local.mail_from : null` and `ses_configuration_set` likewise into `module "ingress"`), `infra/regions/au/tests/cell.tftest.hcl`

**Shape:** two optional variables, default `null`, with validation matching Task 2's rules when non-null; "both or neither" as a second `validation` block on `mail_from_address` that references `var.ses_configuration_set`. Each is emitted into the container environment only when non-null. The root passes `aws_sesv2_configuration_set.mail[0].configuration_set_name` (the name) as `ses_configuration_set` in staging.

**Test first (RED):** `ingress.tftest.hcl`: new `run` blocks: with both set, the task definition's environment contains both names with those values; separate failing runs: `mail_address_alone_fails` and `mail_set_alone_fails` (both expect `var.mail_from_address`), `mail_malformed_address_fails` (expect `var.mail_from_address`, valid set), `mail_malformed_set_fails` (expect `var.ses_configuration_set`, valid address). The passing run needs the same `aws_security_group.vpc_link` override as `staging_image_set`. The existing `staging_image_set` run (`:518`) and its exact environment-list assert (`:580`) stay unchanged and are the "neither" case. `cell.tftest.hcl`, through `module.ingress.service_environment`: `staging_image_set` (`:356`) both names present with the derived values; `prod_image_set` (`:562`) has 18 entries and neither name. `prod_image_set` needs the nine `override_resource` blocks `staging_image_set` already has (three secret ARNs, three KMS keys, two db_ops roles, the ECR repository), copied unchanged, or its environment is unknown at plan. (The task definition is planned only when `service_image` is set, `aws-ingress/main.tf:437`, so `prod_tfvars` cannot see it.)

**Rule this must not break:** existing container environment unchanged; no secret in plain environment.

**Commit subject:** `feat(infra): pass the SES sender to the service task`

- [ ] RED, GREEN; `terraform fmt`, `validate`, `tflint`, `test` in both directories.
- [ ] Security pin 11.
- [ ] `pnpm gate`.

### Task 5: ADR 0013 and architecture

**Files:**

- Create: `docs/adr/0013-sign-in-mail-on-ses.md` (context, decision, consequences, alternatives; cites AWS documentation for SES regional processing; records the spec's decisions O1, O5, O7, O8)
- Modify: `architecture.md` lines named in the spec's Scope: system-owners row (`:65`), D13 (`:122`), diagram node (`:154`), §7.2 row (`:270`), §8 tree (`:370`, `:380`), Q9 (`:1397`)

**Proves:** docs match the decision; `pnpm format` passes.

**Commit subject:** `docs(architecture): record SES as the sign-in mail provider`

- [ ] Edit; `pnpm format`; `pnpm gate`.

### Task 6: Runbook — SES and the live proof

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md` (new section after "Provision the first owner")

**Content:** Apply 0 while parked (expected plan: the Task 3 and Task 4 resources only, by address and action); verifying each sandbox recipient (one command each, open the verification message, confirm; the address is held in a shell variable and never written down); waiting for DKIM to show verified (a read-only describe prints only the status); Apply 1 unpark and the cost clock; one-offs `db-bootstrap`, `db-migrate`, first owner; proofs P1–P5 below; Apply 2 re-park and the empty plan; evidence rules (counts, statuses and lengths only). Commands one per block, zsh, `${VAR}` form, no inline comments.

**Proofs:**

- P1: start for the verified owner address answers 204 and one message arrives; the subject has no code.
- P2: verify with that code answers 200 with tokens; one session route answers 200.
- P3: start for an unverified address answers 503, and the cause is an SES recipient rejection, not an IAM denial. Read it from the service's `mail` log line for that request: `errorClass` is the SES rejection class (`MessageRejected`), not `AccessDeniedException`. The spec names CloudTrail for this; SES send calls may not be recorded in CloudTrail, so the runbook first checks AWS's documentation (read-only) and uses CloudTrail only if it records them. The log line is the primary evidence either way.
- P4: the first-owner one-off exits 0 with its fixed success form (deferred from `first-owner`).
- P5: CloudWatch Logs for the window contain no address and no code (searched by variable, counts only); the `mail` lines carry only operation, outcome and error class.

**Commit subject:** `docs(runbooks): add the SES sign-in proof`

- [ ] Edit; `pnpm format`; `pnpm gate`. The orchestrator pushes the branch after this task; the owner runs Apply 0 from this SHA.

## Human: Apply 0 and verification (owner; reviewer reads)

H1. Reviewer: read-only plan against real state without the lock; compare with Task 3–4 addresses. H2. Owner: Apply 0. H3. Owner: verify recipients; wait for DKIM. H4. Reviewer: read back the identity, set, records and policy and compare with the spec.

### Task 7: Unpark commit

**Files:** `infra/regions/au/env/staging.tfvars`: `enable_database = true`, `desired_count = 1`. Nothing else.

**Commit subject:** `feat(infra): unpark staging for the SES sign-in proof`

- [ ] `terraform fmt`; `terraform -chdir=infra/regions/au test`; `pnpm format`, `lint`, `typecheck`, `check:boundaries`. `pnpm test` is expected red on the three parked tests while unparked (as in `staging-proof-run`); do not run the full gate.
- [ ] The orchestrator pushes before Apply 1.

## Human: Apply 1, one-offs and proofs (owner; reviewer reads)

H5. Reviewer: read-only plan. H6. Owner: Apply 1 with `service_image` in the gitignored local file only; records the UTC completion time (cost clock). H7. Owner: `db-bootstrap`, `db-migrate`, first-owner one-off. H8. Proofs P1–P5 per the runbook.

### Task 8: Re-park commit

**Files:** `infra/regions/au/env/staging.tfvars`: `enable_database = false`, `desired_count = 0`.

**Commit subject:** `feat(infra): park staging after the SES sign-in proof`

- [ ] `terraform test`; full gate with the turbo cache bypassed (`pnpm format`, `pnpm lint --force`, `pnpm typecheck --force`, `pnpm test --force`, `pnpm check:boundaries`).
- [ ] The orchestrator pushes before Apply 2.

## Human: Apply 2 (owner)

H9. Owner: remove `service_image` from the local file, re-park apply, then a plan that shows no changes. H10. Reviewer: RDS instances 0 and ECS desired count 0.

### Task 9: Record the proofs and both applies

**Files:** `docs/runbooks/apply-staging-au.md` (evidence for P1–P5; Apply 0, 1, 2 SHAs and UTC times; counts and statuses only).

**Commit subject:** `docs(runbooks): record the SES sign-in proof`

- [ ] Scan added lines for identifiers (12-digit numbers, `arn:`, `@`, hostnames); `pnpm gate --force` form as Task 8.

### Task 10: Catalogue (last task on this branch)

**Files:** `docs/roadmap.md` (snapshot; `email-provider` row done; Q9 row closed by ADR 0013; Open items: signed-in proof and first-owner live run done, add the abuse precondition for production access; Next spec `stripe-billing`), `AGENTS.md:9` repository-state row.

**Commit subject:** `docs(roadmap): mark email-provider done`

- [ ] `pnpm format`; full gate with the cache bypassed; `rm -f docs/plans/*-report.md`; `git status --short` clean.

---

## Definition of done (AGENTS.md §8)

- [ ] Tasks 1–10 and human steps done, or dropped with a note
- [ ] Security pins 1–12 and 14 each seen failing once, reported in the task reports; pin 13 by live proof
- [ ] Full CI green on the PR
- [ ] P1–P5 recorded; staging re-parked in git and in AWS
- [ ] ADR 0013, `architecture.md`, `docs/roadmap.md` and `AGENTS.md:9` updated in this PR
- [ ] Reviewer sign-off and second fresh-context review recorded in the PR
- [ ] Session scratch cleaned
