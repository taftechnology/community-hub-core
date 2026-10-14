# Spec: Sign-in codes by Amazon SES

Slug: email-provider
Status: approved (2026-10-14, Adnan Bin Hossen)
Architecture refs: D13, §7.2 (Transactional email row), §11.1, §21.1 (APP 8), §26 Q9; ADR 0009 (rule 1 (c)), ADR 0011; AGENTS.md §1 rules 1, 5, 6, 8; §6 Cost; §12

## Problem

Nobody can sign in anywhere outside a test. `POST /v1/auth/email-otp/start` creates a challenge and then calls the mail port, and the only port wired in the service is `rejectingOtpMail` (`apps/api/src/index.ts:155`), so every request answers an empty 503 (`apps/api/src/auth-routes.ts:109-120`) and the challenge row is deleted (`modules/core/identity/infrastructure/email-otp.ts:86-91`). `first-owner` can now create an owner, but that owner cannot receive a code, so no signed-in proof of anything has been possible on staging (roadmap, Open items).

## Decisions

| #   | Decision                  | Answer                                                                                                                                                                                                                                                                                                                                                                      | Source                                                                    |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| O1  | Vendor                    | Amazon SES in `ap-southeast-2`. Recorded as ADR 0013; Q9 closed as "provider chosen: SES".                                                                                                                                                                                                                                                                                  | Owner, 2026-10-13 (`docs/roadmap.md:25,122,281`, `AGENTS.md:9`)           |
| O2  | Sending domain and sender | `no-reply@mail.<zone name>`. The root derives the mail subdomain from one zone-name local that replaces the two literals at `infra/regions/au/main.tf:230` and `:456`; records go in `var.staging_zone_id`. All SES resources are staging only (`count = var.environment == "staging" ? 1 : 0`); prod plans none.                                                           | Developer, 2026-10-14                                                     |
| O3  | SPF alignment and DMARC   | Custom MAIL FROM `bounces.mail.<zone name>` with MX `10 feedback-smtp.ap-southeast-2.amazonses.com` and TXT `v=spf1 include:amazonses.com ~all`. DMARC TXT at `_dmarc.mail.<zone name>`: `v=DMARC1; p=none;` with no `rua`, so no address is committed.                                                                                                                     | Developer, 2026-10-14                                                     |
| O4  | Sandbox recipients        | Verified by hand by the owner, outside Terraform: one CLI command per address, then the owner opens the verification message and confirms it. No address in any committed file; the system sender in O2 is a role mailbox and is committed by design.                                                                                                                       | AGENTS.md §1 rule 8; `first-owner` takes the address at run time          |
| O5  | Production access         | Out of scope. Recommended precondition for when it is requested: a per-source limit on code requests and a bounce/complaint alarm (Risks, first row).                                                                                                                                                                                                                       | `docs/roadmap.md:122`                                                     |
| O6  | Unpark for the live proof | Approved: USD 0.0468 an hour, 24-hour target, 48-hour hard stop measured from the completion of Apply 1 (the unpark). The owner runs both applies. Re-parked (`enable_database = false`, `desired_count = 0`, `service_image` removed from the local var file) before the pull request merges. Both applies and their SHAs recorded in `docs/runbooks/apply-staging-au.md`. | Owner, 2026-10-14; `first-owner` spec Cost; `staging-proof-run` spec Cost |
| O7  | Port and adapter location | `OtpMail` stays the port; the SES adapter goes in `apps/api/src/mail/`, beside `apps/api/src/kms/`. D13 is amended to say sign-in codes use `OtpMail` until the general `EmailProvider` lands with Broadcast Messages (Phase 2).                                                                                                                                            | `docs/specs/2026-10-11-identity-otp.md:25`                                |
| O8  | AWS accounts              | Staging and production are separate AWS accounts. `docs/specs/2026-10-06-image-publish.md:28` superseded `docs/specs/2026-10-03-foundations.md:126`; the state backends are separate (`infra/regions/au/backend/staging.hcl`, `prod.hcl`). SES sandbox and production access here concern the staging account only.                                                         | Owner, 2026-10-14                                                         |

## Scope

In:

- An SES v2 adapter implementing `OtpMail` in `apps/api/src/mail/`, wired in `bindServices` when the two mail variables are set; `rejectingOtpMail` stays the wiring when they are not.
- Two optional service variables, `MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET`, as optional fields on `ServiceEnv` (keys omitted when unset; `exactOptionalPropertyTypes` is on). Both or neither; one without the other fails startup. Values are validated at startup: the address as a single `local@domain` with no whitespace or angle brackets; the configuration set name against `^[A-Za-z0-9_-]{1,64}$`. A malformed value fails startup with the existing opaque `env` error.
- Terraform in the AU root, **staging only** (`count = var.environment == "staging" ? 1 : 0` or equivalent), so prod plans none:
  - one root local for the zone name, replacing the two literals;
  - SES domain identity for the mail subdomain with Easy DKIM, and its three DKIM CNAMEs with `count = 3` by index (tokens are unknown at plan time);
  - custom MAIL FROM (MX and SPF TXT) and the DMARC TXT record (O3);
  - a configuration set with suppression options BOUNCE and COMPLAINT, `tls_policy = REQUIRE`, reputation metrics on, and no event destination, no `vdm_options`, no `tracking_options`;
  - a root `aws_iam_role_policy` on `module.envelope.task_role_name` (keeps SES out of the KMS module) allowing `ses:SendEmail` only, on the region's identities and on that configuration set, with condition `ses:FromAddress` equal to the sender. The identity resource is the region's identities rather than one identity because, in sandbox, SES also checks the call against the recipient's verified identity; the sender is still pinned by the condition.
  - the two variables passed into the container environment through two new optional variables on `infra/modules/aws-ingress` (default null, emitted only when set).
- Terraform tests: `cell.tftest.hcl` (new mock defaults for the SES identity's three tokens; a prod run asserting no SES resource; staging assertions for the settings below), `modules/aws-ingress/tests/ingress.tftest.hcl` (variables emitted only when set). No change to `tooling/checks/terraform-invariants`: SES resources use `var.aws_region` and Route 53 records have no region argument; no VPC endpoint is added.
- New dependency `@aws-sdk/client-sesv2` in `apps/api` only, `^3.758.0` like the other AWS clients. The PR gives the AGENTS.md §14 justification. Dockerfile and `image.test.ts` unchanged.
- ADR 0013; `architecture.md` system-owners row (`:65`), D13 (`:122`), the diagram node (`:154`), §7.2 row (`:270`), §8 tree (`:370`, `:380`), Q9 (`:1397`).
- A runbook section for the live proof: unpark, provision the first owner, sign in by code, re-park.
- Last commit: `docs/roadmap.md` (snapshot, the `email-provider` row, the Q9 row, Open items, Next spec) and `AGENTS.md:9` Repository state row.

Out:

- Any other mail (invitations, receipts, broadcasts), HTML templates, per-tenant sender settings (Settings → Email Settings), and the general `EmailProvider` port.
- Bounce and complaint notifications to SNS or the database, and DMARC reporting.
- A per-source limit on code requests (a later chunk, before O5).
- SES in prod, and the SES production access request (O5).
- A subprocessor register file. None exists; ADR 0013 records SES as an AWS service.
- A VPC endpoint or NAT for SES. The task runs in a public subnet with a public IP (`infra/regions/au/main.tf:238`, `infra/modules/aws-ingress/main.tf:569`) and egress on 443 (`infra/modules/aws-network/main.tf:137-145`).

## Behaviour

- `POST /v1/auth/email-otp/start` with mail configured: the challenge is created as today, then one SES `SendEmail` call to the normalised address, and the route answers 204 as today. The message is plain text only, from `MAIL_FROM_ADDRESS`, with a fixed subject that does not contain the code, and a body with the eight-digit code, its ten-minute lifetime, and a line saying to ignore the message if the reader did not ask for it. No link, no image, no tracking.
- One attempt (`maxAttempts: 1`), with a 5-second abort deadline, as the KMS client does with its own deadline. A retry after a lost response could deliver two messages.
- SES rejects, throttles, times out, or the client throws anything (including a non-`Error` value or a construction or credential failure): the adapter throws `OtpMailUnavailable`. The existing code deletes the challenge and the route answers an empty 503. Any other thrown type would escape `statusFor` (`auth-routes.ts:110-112`) as an unhandled error, so this mapping is required. The adapter logs one line with a fixed operation name and the SDK error's class name only. Never the address, code, subject, body, message id or SDK message.
- In sandbox, sending to an unverified address is an SES rejection, so it is the 503 above.
- Mail not configured: unchanged, empty 503.
- The per-address limit (five codes an hour) and replacement of an earlier code are unchanged (`email-otp.ts:53-81`).

## Data

No new table or column. No migration.

The address and the code leave the service only in the SES request, to SES in `ap-southeast-2`; SES then delivers to the recipient's own mail provider, wherever that is, which is the purpose of the call. The code is never stored in clear (`otp_challenges.code_hash` as today). `identity.users.email` stays `confidential-blind`.

## Rules touched

- Rule 1: the address goes to SES in `ap-southeast-2` with only the fields needed (recipient and code): ADR 0009 (c), AWS as the named provider.
- Rule 5: no address or code in logs, traces or errors; no personal data in any URL (the message has no link).
- Rule 6 and D17: no engagement tracking. A Terraform test pins it.
- Rule 8: no credentials; the task role signs the call. No secret is added.
- AGENTS.md §12: a new AWS service (O1). §14: a new dependency.

Security-relevant settings the plan must pin with a test and a weakening change:

1. The task-role statement allows only `ses:SendEmail`, only on the region's identities and that configuration set, with `ses:FromAddress` fixed to the sender.
2. The configuration set has no event destination, no `vdm_options` and no `tracking_options`; `tls_policy` is `REQUIRE`.
3. The adapter's log line carries no address, code or SDK message.
4. Any adapter failure, including non-`Error` throws, becomes `OtpMailUnavailable`.
5. The adapter makes one attempt.
6. Startup fails when only one mail variable is set, or a value is malformed.
7. Prod plans no SES resource.
8. Staging stays parked in committed files at merge.

## Contracts

No route, request or response change. No event. Two optional environment variables. One task-role policy.

## Cost

| Line                                  | Monthly USD                     | Method                                                                                                                         |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| SES identity, DKIM, configuration set | 0                               | No standing charge                                                                                                             |
| Route 53 records in the existing zone | 0                               | Not billed per record                                                                                                          |
| SES sending                           | under 0.01                      | USD 0.10 per 1,000 messages; staging sends a handful                                                                           |
| VPC endpoint or NAT                   | 0                               | None added                                                                                                                     |
| **Live proof unpark (O6)**            | **USD 0.0468 an hour while up** | The `staging-proof-run` Cost table (USD 34.20 a month if left up)                                                              |
| Outside the totals                    | cents                           | One-off Fargate tasks, billed per second; the first-owner provisioning secret, USD 0.40 a month prorated, deleted the same day |

The window has a 24-hour target and a 48-hour hard stop, measured from the completion of Apply 1, the unpark (see Order), recorded in the runbook in UTC: about USD 1.12 and USD 2.25. The owner re-parks at the hard stop even if proofs remain. The same branch re-parks before its pull request merges.

## Order of applies (owner runs every apply)

0. Apply 0, while parked: the SES identity, DNS records, configuration set and task-role policy. The owner verifies the sandbox recipients by hand (O4) and waits for the domain identity to show DKIM verified.
1. Apply 1, the unpark, with `service_image` in the gitignored local var file only, as in `staging-proof-run`. The cost clock starts when Apply 1 completes.
2. One-off tasks: `db-bootstrap`, `db-migrate` (the unpark creates a fresh database), then the first-owner command with a verified address.
3. Proof: request a code for that address, read it from the inbox, sign in, call one route that needs a session and see 200. Request a code for an unverified address and see 503, and confirm from CloudTrail that the SES call was rejected for the recipient, not denied by IAM. Read the service logs for the window and confirm no address or code appears.
4. Apply 2, the re-park, before the pull request merges.

## Risks

- **Mail-bombing and sender reputation.** The start route is unauthenticated (`auth-routes.ts:136-160`); the only limit is five codes per address per hour, and the gateway throttle (10 a second, burst 20) is shared by all tenant writes (`aws-ingress/main.tf:287-291`, `:313-314`). With production access anyone could send tens of thousands of codes an hour to third-party addresses, and the bounces and complaints put the SES account at risk. Sandbox contains it today. Mitigation: O5 gates production access on a per-source limit and a bounce/complaint alarm.
- A timeout after SES accepted the message deletes the challenge, and the mail still arrives with a code that no longer works. Low: the person asks again.
- In sandbox, an IAM denial and an unverified recipient both answer 503. Mitigation: the identity resource is the region's identities, and proof step 4 reads the reason from CloudTrail.
- Mail from a new domain goes to spam. Mitigation: DKIM, MAIL FROM and DMARC (O3); the proof uses addresses the owner controls.
- Tests that fake the SDK pass while the real request is wrong. Mitigation: the adapter test asserts the command input field by field, and the live proof sends a real message.
- Fargate Spot interruptions during the proof (`apply-staging-au.md:784`). Mitigation: rerun the step; the window is hours.

## Out-of-band

- Architecture change: yes, ADR 0013 and the `architecture.md` rows listed in Scope (O1, O7).
- New vendor: no. New AWS service: yes (O1).
- Legal: none expected. Spam Act: sign-in codes are transactional, sent on the person's own request.
- Second fresh-context review: required (authentication).
- Rollback: unset the two variables and the service falls back to 503; the Terraform resources are additive and the owner can destroy them.
