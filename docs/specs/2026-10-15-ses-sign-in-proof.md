# Spec: SES sign-in proof on staging

Slug: ses-sign-in-proof
Status: approved (2026-10-15, Adnan Bin Hossen)
Architecture refs: §7.1, §7.3, §11.1, §23.1, §23.2; ADR 0009 (rule 1 (c)), ADR 0013. Follows `docs/specs/2026-10-14-email-provider.md`, whose decision O6 moved the live proof here. Model: `docs/specs/2026-10-12-staging-proof-run.md` for the unpark, the proofs and the re-park. Operator path: `docs/runbooks/apply-staging-au.md`, sections **SES sign-in proof** and **Provision the first owner**.

## Problem

Nobody has signed in on staging. `email-provider` merged the SES adapter and ran Apply 0 (SES identity, DNS, configuration set, send policy) while staging stayed parked, because no published image held the adapter. `first-owner` merged its operator command without a staging run. So the day-one path for a parish owner has never run end to end on AWS. That path is: an operator provisions the owner, the owner asks for a code, the code arrives by mail, and the owner signs in and reaches a tenant route. `main` at `81f4960` (the `email-provider` merge, pull request 53) has now published an image that contains the adapter: the CI `publish` job for that commit succeeded.

## Decisions

| #   | Decision            | Answer                                                                                                                                                                                                                                                                                                                                                                                         | Source                                                                     |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| S1  | Image               | The image `publish` pushed for `81f4960`, or for a later `main` commit that contains it. The owner names `${DEPLOY_SHA}` at pre-check. Stop if the scan is not `COMPLETE` or shows any CRITICAL finding.                                                                                                                                                                                       | Runbook **SES sign-in proof → Prerequisites**                              |
| S2  | Unpark cost, window | USD 0.0468 an hour. 24-hour target and 48-hour hard stop, measured from Apply 1 completion to the start of the re-park apply. The owner re-parks at the hard stop even if proofs remain.                                                                                                                                                                                                       | Owner, 2026-10-14 (`email-provider` O6); the owner re-confirms on approval |
| S3  | Applies             | Apply 0 is done (`edeaaca`, 2026-10-14). This chunk runs Apply 1 (unpark, with the image in the gitignored local var file) and Apply 2 (re-park). The owner runs both applies, every one-off, and every recipient verification.                                                                                                                                                                | AGENTS.md §6 Cost; runbook                                                 |
| S4  | P3 recipient        | **Chosen:** a synthetic address at the reserved domain `example.com` (RFC 2606). In the sandbox, SES rejects an unverified recipient before sending, so no mail leaves and no real person's address is used. This relies on a pre-check that production access is still off. Rejected: an unverified real address the owner controls, which would put a real address in the request and in P5. | Developer, 2026-10-15                                                      |
| S5  | Log-hygiene search  | **Chosen:** P5 pulls the proof window's log messages and counts matches locally. It never puts an address, code, slug or token in a CloudWatch filter pattern. A filter pattern is a request parameter that CloudTrail may record. That is unconfirmed, and local counting removes the risk either way.                                                                                        | AGENTS.md §1 rule 5; developer, 2026-10-15                                 |

## Scope

In:

- Runbook amendments to **SES sign-in proof**:
  - the Apply 1 and Apply 2 address list (corrected, see Behaviour step 2);
  - the S4 and S5 choices;
  - the added pre-checks, guards and log counts in Behaviour;
  - `--start-time` on every log query;
  - `outcome` `timeout` noted as a possible value (`apps/api/src/mail/ses-otp-mail.ts:100`);
  - the exact P5 key-set check.
- An unpark commit: `enable_database = true` and `desired_count = 1` in `infra/regions/au/env/staging.tfvars`. `service_image` goes only in the gitignored `staging.local.tfvars`.
- Read-only pre-checks, then Apply 1, the one-offs, **Provision the first owner** (its first live run), proofs P1–P5, an evidence commit, a re-park commit, Apply 2, and a plan with no changes.
- Evidence in the runbook (**Cost clock and applies**, **Evidence**): counts, statuses, lengths, SHAs, digests and resource addresses only.
- Last commit: in `docs/roadmap.md`, the snapshot, the `ses-sign-in-proof` row marked done, Open items and Next spec; and the `AGENTS.md:9` Repository state row. Staging is parked in committed files.

Out:

- Any change to application code, Terraform, the Dockerfile, CI or dependencies. If a proof fails because of code, the owner re-parks and the fix goes on a separate `fix/` branch. This chunk resumes with a new unpark after that fix merges and publishes.
- SES production access, a per-source code limit, and a bounce or complaint alarm (`email-provider` O5).
- Open items this run may observe but does not fix: Fargate Spot interruptions, the webhooks CORS preflight, admin deep-link 403s, and the pooled checkout that logs nothing on a secret re-read. New observations go to Open items.
- A browser sign-in through the admin shell. The proof is over HTTP.

## Behaviour

**Who does what**

- **Owner (Abdus):** applies, one-offs, the first-owner secret, the inbox. He also runs P1, P2, P3 and the P5 counts, because only his shell holds the address, the code, the slugs and the token.
- **Owner's assistant (read-only):** image and SES pre-checks, the plan check against the expected addresses, the running-task check, `mail` line reads that need no secret value, and the post-apply read-back.
- **Implementer:** the commits.
- **Developer:** approves the spec and plan, and reports to the owner.

**Order**

1. **Pre-checks.** Any failure here is a stop, and nothing has been spent yet.
   - S1: the image, its digest and its scan.
   - The SES domain identity and DKIM are `SUCCESS`.
   - SES account production access is off: `ProductionAccessEnabled` is false. Record the boolean only.
   - The owner checks, at a silent prompt in his shell, that the lowercase owner address P1 will use shows `VerificationStatus` `SUCCESS`. Record the status only. The same address goes into the provision secret, because the signed-in user must be the provisioned owner.
2. **Apply 1.** Push the unpark commit, then plan against it. The expected plan is exactly 18 to add, 0 to change and 0 to destroy:
   - 8 under `module.rds[0]`;
   - 6 under `module.ingress`: `aws_vpc_security_group_ingress_rule.task_api`, `aws_ecs_cluster.this`, `aws_ecs_cluster_capacity_providers.this`, `aws_ecs_task_definition.this`, `aws_ecs_service.this`, `aws_iam_role_policy.pull`;
   - 4 at the root: `aws_iam_role.db_ops_execution[0]`, `aws_iam_role.db_ops_task[0]`, `aws_iam_role_policy.db_ops_execution[0]`, `aws_ecs_task_definition.db_ops[0]`.
     Any other address or count is a stop before apply. Record the UTC completion time, which starts the cost clock.
3. **One-offs.** Wait for RDS to be `available`.
   - `db-bootstrap`: exit 0, stdout one integer, stderr empty.
   - `db-migrate`: exit 0, ten `applied <tag>` lines for 0000–0009 in journal order, then `done applied=10 total=10`, stderr empty.
4. **First owner (P4).** Provision the first owner with the verified owner address and a synthetic organisation and community slug. Expect exit 0 and stdout `created`. Then delete the secret and verify it is gone.
5. **Running-task check.** Wait for the service to be stable. The running task definition's image digest must equal the pre-checked digest. Its environment variable names must include `MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET` (names only). Otherwise the service uses `rejectingOtpMail` and P1 cannot pass (`apps/api/src/index.ts:151-165`).
6. **Proofs.** Note the window start time, in milliseconds, before P1.
   - **P1.** `POST /v1/auth/email-otp/start` for the owner address answers 204, and exactly one mail arrives from the sender. Its subject is "Your sign-in code" and its body holds an eight-digit code.
     - At most 3 `start` calls for that address in this run.
     - If no mail arrives within 5 minutes, check for a `mail` line with `outcome` `ok` before calling again.
     - A 204 with no new `mail` line is the five-an-hour limit (`modules/core/identity/infrastructure/email-otp.ts:63-71`): stop.
   - **P2.** Within 10 minutes of the mail, `POST /v1/auth/email-otp/verify` with the code returns tokens. Then `POST /v1/access/grants/list` with `{communitySlug}` and the access token answers 200. The route needs `access.roles.view`, which the owner's bootstrapped grants include. A 401 or 403 is a stop. Do not retry with guessed codes.
   - **P3.** `start` for the S4 address answers 503. The `mail` line for it shows `outcome` `failed` and `errorClass` `MessageRejected`, not `AccessDeniedException`.
   - **P5.** All counts run in the owner's shell, over the window, with `--start-time` and no `--filter-pattern`.
     - Pull `events[].message` from the service log group and from the tenant API access log group. Then run `grep -c -i -F --` once for each value in the list below. Record the printed integer, not the exit status, and write nothing to disk.
     - Values that must count 0 in both groups: the owner address, the S4 address, the code, the organisation slug, the community slug, the access token, the literal `Bearer`, and the literal `@`.
     - In the `mail` lines, expect exactly one `outcome` `ok` per `start` call that sent mail, exactly one `failed` with `MessageRejected`, and 0 `timeout`.
     - Each `mail` line's key set (`jq -c 'keys'`) is exactly `["level","message","operation","outcome"]`, or that plus `errorClass` on the failed line.
     - Only after P5, unset the address, code, slug and token variables.
7. **Evidence and re-park.** Make the evidence commit. Push the re-park commit and remove `service_image` from `staging.local.tfvars`. Apply 2 is exactly 18 to destroy, the same 18 addresses. Follow it with a plan that shows no changes. Record the UTC completion time and the total window.
8. **Close.** Make the catalogue commit, run the full gate on the re-parked tree, and open the pull request.

**Failures and history**

- A failed proof, or a second failure on the same step, is a stop. Re-park first (AGENTS.md §12).
- A Spot interruption is not a failure: wait for the replacement task and rerun that step once. A rerun of P1 counts toward its three-call cap.
- After Apply 1, there is no rebase, amend or force-push on this branch. `main` comes in by a merge commit. The pull request merges with a merge commit and its body records the applied SHAs.

## Data

No table, column or migration. Staging holds synthetic data only: one organisation, one community, and one owner whose address is a mailbox the owner controls. The re-park destroys the database. The address, slugs, code and token are entered at silent prompts or held in shell variables only, and appear in no file, commit or evidence line. The provision secret is deleted with `--force-delete-without-recovery` and its absence is verified.

## Rules touched

- Rule 1: everything runs in `ap-southeast-2`. The address goes to SES in Sydney, a named AWS provider (ADR 0009 (c), ADR 0013), and the mail goes to the owner's own inbox.
- Rule 5: P5 is the check (S5). Evidence carries no address, code, slug, hostname, ARN or id.
- Rule 7: no production data exists. Staging is a separate AWS account (`email-provider` O8).
- Rule 8: the provision secret's value never lands in shell history or a file. The address, code, slugs and token stay in shell variables and are unset after P5.
- AGENTS.md §6 Cost: this spec says why staging is unparked, the cost and the window. The chunk re-parks before merge.

Security-relevant settings the plan must pin with a test and a weakening change:

1. **Staging is parked in committed files at merge.**
   - `enable_database = false` and `desired_count = 0` are pinned by `modules/core/access/domain/boundaries.test.ts:36-38`, `modules/core/people/domain/boundaries.test.ts` and `modules/core/entitlements/db/parked.test.ts:11-16`.
   - No `service_image` in any file under `infra/regions/au/env/` is pinned by `boundaries.test.ts:39-44` and `infra/regions/au/tests/cell.tftest.hcl:883-888`.
   - Run all of them with `--force`, because turbo does not hash the var file.
   - The unpark and evidence commits are expected to fail these tests. The full gate runs only on the re-parked tree, with `service_image` removed from the local file. This is the same handling as `docs/plans/2026-10-12-staging-proof-run.md:52`.
2. **Production still refuses `enable_database = false`.** This is an existing test, rerun.
3. **No identifier in any added line.** The plan names the scan pattern the reviewer runs on the diff.

## Contracts

None changed.

## Cost

| Line                          | Monthly USD      | Method                                                                                           |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| Unpark (database, task, IPv4) | 34.20 if left up | USD 0.0468 an hour (`staging-proof-run` Cost table): about USD 1.12 at 24 h and USD 2.25 at 48 h |
| One-off tasks, SES sends      | cents            | Billed per second; USD 0.10 per 1,000 messages. Outside the totals                               |
| Provision secret              | under 0.01       | Exists for minutes                                                                               |

Staging returns to the parked month (about USD 7.30 plus images) at Apply 2. This window alone cannot reach the USD 40 budget alert.

## Risks

- **The owner and the inbox must both be available inside the window.** Mitigation: start Apply 1 only when P1 and P2 can follow within hours. The owner enforces the hard stop.
- **The sandbox state may have changed since Apply 0.** The sandbox allows 200 messages a day and verified recipients only. Mitigation: the pre-checks cover DKIM, the recipient and production access before any spend.
- **The five-an-hour limit and the ten-minute expiry can make a good run look like a fault.** Mitigation: the P1 cap and the guards in P1 and P2.
- **The single Spot task can be interrupted** (open item). Mitigation: rerun the step once; it is not a failure.
- **A code defect found live cannot be fixed on this branch.** Mitigation: re-park and fix on a `fix/` branch. The window cost is the price of finding it.
- **A filter pattern may be recorded by CloudTrail** (S5). Mitigation: count locally.

## Out-of-band

- Legal: none. New vendor or AWS service: none (SES came in with `email-provider`).
- Architecture change: none.
- Second fresh-context review: required (authentication, residency). Under AGENTS.md §2, the owner's assistant must use a different tool and a different model family from both the implementer and the reviewer agent.
- Rollback: Apply 2 is the rollback. The commits are docs plus one var-file flip each way.
