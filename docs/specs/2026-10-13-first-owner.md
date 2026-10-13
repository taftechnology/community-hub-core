# Spec: First organisation owner provisioning

Slug: first-owner
Status: approved (2026-10-13, Abdus Salam)
Architecture refs: §6.3 (identity/platform/app schema ownership), §12.1, §12.2.1, AGENTS.md §1 rules 2, 5, 8

## Problem

Nothing in production creates an organisation or a community today. `createImplicitOrganisation` (`modules/core/tenancy/infrastructure/implicit-organisation.ts`) is called only from its own integration test and from other modules' test fixtures — no application code path calls it. After `db-migrate` runs, staging has zero rows in `platform.organisations` and `platform.communities`. Separately, `identity-otp` lets a person sign in by email once an `identity.users` row exists and is tied to an organisation, but nothing creates that tie, and `access-roles`' `bootstrapOwner` — a guarded, one-time grant of `org_owner` + `community_admin` — has no caller outside its own tests. There is no operator path, today, to stand up a tenant and its first owner. That blocks real sign-in for any new tenant even once email delivery works.

## Scope

**In**

- A new operator-run one-off command, following the `db-bootstrap` / `db-migrate` ops-command convention: no HTTP route, run via `aws ecs run-task` with a command override, `entryPoint` never set, a fixed success shape on stdout, a fixed vocabulary of single words on stderr for failure classes, nothing personal or secret ever printed.
- Given an organisation slug, a community slug, and an email address, the command, in this order:
  1. Resolves the organisation and community. Both slugs are required inputs (never just one, and the command never assumes "the implicit org's one community").
     - If neither the organisation slug nor the community slug exists: creates both together via the existing `createImplicitOrganisation`.
     - If both already exist and the community belongs to that organisation: proceeds with their ids — this makes a second run of the whole command idempotent, not just the owner-grant step.
     - If the community slug exists but belongs to a **different** organisation than the one named, or the organisation slug exists without a matching community (an implicit org's own invariant broken): refuses. Reports `organisation` on stderr; creates nothing.
     - This needs one new, small, read-only public export on `core/tenancy` — `findOrganisationBySlug`, mirroring the existing `findCommunityBySlug` shape — so the command can resolve the organisation independently of the community and compare the two, the same way `findCommunityBySlug` already lets the access routes derive both ids from one lookup without trusting a caller-supplied pair.
  2. **Checks for an existing owner before creating anything else.** A new, small, read-only public export on `core/access` (mirroring the existing-grant check `bootstrapOwner` already runs internally against `organisation_role_grants`/`community_role_grants`) reports whether this organisation/community already has an owner, and if so, which `user_id` holds it.
     - If an owner already exists: looks up (read-only, no insert) the `identity.users` row for the named email, using the same `normaliseEmail` and the same `email_bidx` blind-index lookup `verifyEmailOtp` already uses (`modules/core/identity/infrastructure/email-otp.ts`, its find-before-create step) — never the find-**or-create** path, so a second run with a different email cannot create a stray `identity.users` row.
       - If that lookup resolves to the **same** `user_id` as the existing owner: exits 0 with `already_bootstrapped`. Nothing is created or changed.
       - Otherwise (no `identity.users` row for that email, or a different user): refuses. Exits 1 with its own stderr word (`owner`, see Behaviour). Creates nothing — in particular, no new `identity.users` row.
     - If no owner exists yet: finds or creates the `identity.users` row for that email (creating only now that it is known to be safe), through a **new public export** on `core/identity` using the same `normaliseEmail` and blind-index lookup as above (today `insertIdentityUser` exists but is internal to `core/identity`'s own OTP flow and is not exported from its `public/` barrel). Then calls the existing `bootstrapOwner(tx, { now, userId, actorUserId: userId })` to grant `org_owner` + `community_admin`. Exits 0 with `created`.
- This chunk does **not** create an `app.user_links` row. `app.user_links.person_id` is `NOT NULL`, unique, and has a foreign key to `app.persons` — there is no person yet to link to, and `bootstrapOwner` itself never touches `user_links`. Role grants are keyed only on `user_id`, so the new owner can sign in and hold `org_owner`/`community_admin` with no person record at all. The later claim-link chunk is what will call the existing `linkUser` once a real person exists for this user.
- The organisation slug, the community slug, and the email address are delivered to the task through a short-lived AWS Secrets Manager secret (JSON `{organisationSlug, communitySlug, email}`), stored under **one fixed secret name**, e.g. `${var.name}-provision-owner`:
  - The operator creates it with the same stdin-pipe technique the proof run already uses for the identity database password (`docs/runbooks/apply-staging-au.md` proof 7b) — nothing echoed, nothing typed into a command line or an environment override.
  - The task reads it once, by ARN, passed as an environment override (`PROVISION_SECRET_ARN`) — an ARN is a resource identifier, not personal data, the same class of value as `IDENTITY_SECRET_ARN` already in the service task's environment. The command refuses (stderr `env`) if `PROVISION_SECRET_ARN` does not name that one fixed secret.
  - The operator deletes the secret immediately after a successful run, with `aws secretsmanager delete-secret --force-delete-without-recovery`, and confirms it is gone. Using `--force-delete-without-recovery` (rather than the default recovery window) is what makes the one fixed name reusable on every future run — a normal delete would leave the name reserved for the recovery window.
  - `docs/runbooks/apply-staging-au.md` gains a new section with all three steps in order (create via stdin pipe, run the command, delete-without-recovery) plus a describe-secret check that confirms the secret no longer exists.
- A Terraform change, named here and applied by Abdus, not by this command:
  - The service task role gets a new, narrowly-scoped IAM statement granting `secretsmanager:GetSecretValue` on exactly **one fixed secret name** (not a pattern covering a range of names, not the three existing role-secret ARNs), written the same way as the three existing patterns: the fixed name (`${var.name}-provision-owner`) followed by the six-character random-suffix placeholder (`-??????`). This lives alongside the existing `task_secrets` policy in `infra/modules/aws-kms-envelope/main.tf` (or an equivalent additional statement), without touching the `db_ops` role.
  - The secrets KMS key's policy (`aws_kms_key.secrets` in `infra/modules/aws-db-secrets/main.tf`) has its `SecretsManagerUse` statement's `StringLike` condition extended with one more fixed pattern, written identically (`${var.name}-provision-owner-??????`), so the existing `kms:Decrypt`/`kms:GenerateDataKey` grant (already scoped by `kms:EncryptionContext:SecretARN`, never `Resource: "*"`) covers this one new secret name without widening to anything else.
  - This secret itself is **not** Terraform-managed — the operator creates and deletes it per run under the one fixed name, the same way the identity/app/platform secrets' _values_ are rotated by hand today, just with Terraform only granting permission on that one name, not creating the secret resource.
- Runs as a one-off override of the **existing service task definition**, not the `db_ops` task definition — `db_ops`'s task role keeps its deliberate zero-policy state; no permission is added to it.
- A new compiled entrypoint, `apps/api/src/provision-owner.ts` → `/app/provision-owner.js`.

**Out**

- No HTTP route, no admin UI (`ops-console` is still not started).
- No emailed claim link or invite flow — Abdus deferred this explicitly.
- No `app.user_links` row and no `app.persons` row — person linkage (via the existing `linkUser`) is entirely the job of the later claim-link chunk, once a real person exists for the owner. Until then the owner holds fully active role grants but has no entry in the Users & Roles directory view (`access-routes.ts`'s `userLinks`), so their name does not show there yet. That is expected, not a defect this chunk needs to fix.
- Any change to the `db_ops` task definition, its IAM, or its environment.
- Any plan or entitlement assignment for the organisation (confirmed empty today regardless; not this chunk's job).
- Granting any role other than the exact owner bootstrap `bootstrapOwner` performs; no second-owner, demotion, or custom-role support.
- Any change to the existing OTP or passkey flows, beyond the two new `core/identity` public exports.
- Handling the anomalous case of an organisation slug that already exists with no matching community (implicit orgs are always created as a pair) — the command detects and refuses this rather than trying to repair it.
- Repairing or replacing an existing owner. If one already exists and is not the named email, the command refuses outright — it never reassigns, demotes, or adds a second owner.
- A live run of the command against `staging-au` (see Cost and Definition of done) — this chunk does not unpark staging.
- The owner's email address itself. Abdus supplies it out of band for the staging run (a shared team mailbox, not a personal address); it is never written into this spec, the plan, a commit, or any other repo file.

## Behaviour

**Invocation.** Operator creates the provisioning secret under the one fixed name, then runs the service task definition as a one-off with command `["node", "/app/provision-owner.js"]` and an environment override `PROVISION_SECRET_ARN=<arn>`. No other input path for the organisation slug, community slug, or email exists in the script — there is nothing else for an operator to mistakenly pass in plaintext.

**Stdout on success** (exit 0, stderr empty), one line, exactly one of:

| Line                   | Meaning                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `created`              | No owner existed yet. The organisation and community were created if they were both absent; the `identity.users` row was created if it did not already exist; the owner grants were created. |
| `already_bootstrapped` | An owner already existed for this organisation/community, and it is the same user as the named email. Nothing was created or changed.                                                        |

**Stderr on failure** (stdout empty, exit 1), one line, exactly one of:

| Word                             | Meaning                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`                            | `PROVISION_SECRET_ARN` is missing, malformed, or does not name the one fixed secret this command reads.                                                                               |
| `secret`                         | The secret could not be read, or its JSON is missing `organisationSlug`, `communitySlug`, or `email`.                                                                                 |
| `organisation`                   | The slug pair does not resolve to a consistent organisation/community — either one exists without the other, or the community belongs to a different organisation than the one named. |
| `owner`                          | An owner already exists for this organisation/community and it is not the user for the named email. Nothing was created — in particular, no new `identity.users` row.                 |
| `kms`                            | The envelope-key `GenerateDataKey` or `Decrypt` call failed.                                                                                                                          |
| `connect` / `connect <SQLSTATE>` | The database connection failed, with or without a database error code — same convention as `db-migrate`.                                                                              |
| `fail`                           | Anything else.                                                                                                                                                                        |

The command never echoes the secret's contents, the resolved ids, or any part of the email, on either stdout or stderr, in either outcome.

## Data

No new column. One existing table pair gains rows only when absent; two existing tables gain rows via existing or newly-exported public functions, and only once it is known safe to do so (see Behaviour step 2):

| Table                                                        | Column(s) touched                                                                                                  | Classification                                           | Notes                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform.organisations` / `platform.communities`            | insert via existing `createImplicitOrganisation`, only when the pair does not already exist                        | unchanged (already classified in `tenancy-implicit-org`) | No `org_id`, no RLS — platform-scoped, owned by `core/tenancy` only (§6.3).                                                                                                                                                                                      |
| `identity.users`                                             | insert via new `core/identity` public export wrapping existing `insertIdentityUser`, only when no owner exists yet | unchanged (already classified in `identity-otp`)         | Encrypted via `unwrapKmsRoot`, same as the OTP sign-up path. Lookup uses the same `normaliseEmail` and `email_bidx` blind index as `verifyEmailOtp`, so a mixed-case or whitespace-padded address matches the same row the OTP sign-in path would later resolve. |
| `app.organisation_role_grants` / `app.community_role_grants` | insert via existing `bootstrapOwner`                                                                               | unchanged                                                | No new role_key value; uses `org_owner` / `community_admin`, which already exist.                                                                                                                                                                                |

`app.user_links` is explicitly **not** touched by this chunk — see Scope/Out.

The provisioning secret itself (Secrets Manager, JSON `{organisationSlug, communitySlug, email}`) is new but is not a database column — it is `confidential` (carries an email address), encrypted by the existing secrets KMS key, and is operator-deleted right after the run. The runbook documents that deletion as a required step, not an optional one, with a check that confirms it is gone.

## Rules touched

- **Rule 2 (tenancy/RLS):** the new code writes the role-grant tables through the existing `withAppTransaction` helper that every other `app`-schema write already uses; no raw pool access, no session-level `SET`.
- **§6.3 (schema ownership):** the organisation/community writes stay inside `core/tenancy`'s own public functions; this command composes `core/tenancy`, `core/identity`, and `core/access` through their public exports only, never reaching into another module's schema directly.
- **Rule 5 (no personal data in logs):** the email never appears in a command override, an environment override, CloudTrail, or the task's own stdout/stderr — it travels only inside the Secrets Manager secret value, which Secrets Manager itself excludes from CloudTrail request-parameter logging.
- **Rule 8 (secrets):** the provisioning secret is short-lived, reachable only via one fixed-name IAM grant, and operator-deleted with `--force-delete-without-recovery`; a security-pin test (below) asserts the script has no code path that would print it.

## Contracts

No API route. No event. No website collection/island/block key. Three new public exports:

- `core/tenancy`: `findOrganisationBySlug(sql, slug) → { id, slug, region, kind } | null`, mirroring the existing `findCommunityBySlug`.
- `core/access`: a read-only existing-owner check (name to be finalised by the implementer), exposing the same existing-grant signal `bootstrapOwner` checks internally, plus the owning `user_id` when one exists.
- `core/identity`: a read-only find-by-email lookup and a find-or-create-by-email export (names to be finalised by the implementer, e.g. `findUserByEmail` and `findOrCreateUserByEmail`), both using the same `normaliseEmail` and `email_bidx` blind-index lookup `verifyEmailOtp` already uses, with `findOrCreateUserByEmail` wrapping the existing internal `insertIdentityUser` only on the create path.

No Dockerfile change — `apps/api`'s existing build already compiles every file under `apps/api/src`, so the new entrypoint ships automatically; see the plan for the image test that pins this.

## Infra

One Terraform change, applied by Abdus, not by this command or any agent:

- A new IAM statement on the service task role, granting `secretsmanager:GetSecretValue` on exactly **one fixed secret name** (not a range of names, not the existing three role-secret ARNs), written the same way as the three existing patterns.
- One more fixed pattern added to the secrets KMS key's existing `StringLike` encryption-context condition, written identically to that one fixed name, so `kms:Decrypt`/`kms:GenerateDataKey` covers this one new secret name without widening beyond named patterns.
- No change to the `db_ops` task role, which keeps its zero-policy state.
- The provisioning secret resource itself is not Terraform-managed; the operator creates and deletes it per run under that one fixed name.
- This Terraform change can be, and is, applied while staging is **parked** — it only adds IAM/KMS policy statements to roles and keys that already exist independent of `enable_database` or `desired_count`. It does not require an unpark.

## Cost

Not billed by the hour or month as a standing resource. The provisioning secret costs USD 0.40 per secret per month, prorated daily by AWS Secrets Manager's own pricing — in practice a small fraction of that, since the operator deletes it the same day it is created, and the secret exists only while a provisioning run is in progress. The one-off Fargate task run, when it eventually happens, costs cents, the same shape as the existing proof-run one-offs. **This chunk does not unpark staging.** The Terraform change above is applied while parked. The live run of `provision-owner.js` — actually exercising the command against a real database — is deferred to the email chunk's own staging run, which needs a working owner anyway to prove sign-in end to end. This mirrors how `db-migrate-command` shipped its command and image change before `staging-proof-run` was the chunk that actually ran it.

## Risks

| Risk                                                                                                                                                                                             | Mitigation                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A second run with a different email than the existing owner silently creates a stray `identity.users` row while reporting success                                                                | Fixed by ordering: the existing-owner check runs before any create, and a non-matching email refuses with `owner` rather than creating anything. A pinned test provisions with email A, re-runs with email B, and asserts the refusal plus no new `identity.users` row.                                                                             |
| Operator accidentally puts the email in a command/env override instead of the secret                                                                                                             | The script has no alternative input path; a security-pin test asserts this.                                                                                                                                                                                                                                                                         |
| Two concurrent provisioning runs for the same org/community                                                                                                                                      | `bootstrapOwner`'s existing advisory lock and `already_bootstrapped` guard for the owner grant; a transactional insert for the organisation/community pair relies on the existing unique-slug constraints and `createImplicitOrganisation`'s own duplicate-code handling. A pinned test exercises two sequential runs.                              |
| Community slug resolves under a different organisation than the one named                                                                                                                        | Both ids are compared via the new `findOrganisationBySlug` plus the existing `findCommunityBySlug`, never trusting a caller-supplied pair; refuses with `organisation`.                                                                                                                                                                             |
| An implicit organisation exists with no matching community (should never happen given `createImplicitOrganisation`'s one transaction, but not provably impossible after manual intervention)     | Detected and refused, not repaired, per Scope/Out.                                                                                                                                                                                                                                                                                                  |
| A mixed-case or padded email is treated as a different person than an identical address already in the OTP system                                                                                | Both the owner-check lookup and the create path use the exact same `normaliseEmail` and blind-index derivation as `verifyEmailOtp`; a pinned test provisions with a mixed-case address, then signs in by OTP with a differently-cased version of the same address, and asserts they resolve to the same user with exactly one `identity.users` row. |
| Secret lingers after the run and is read later by someone else                                                                                                                                   | Documented operator cleanup step with a describe-secret check that it is gone; not automated in this chunk.                                                                                                                                                                                                                                         |
| The new IAM statement is a standing permission change, even though narrowly scoped                                                                                                               | Limited to one fixed secret name via `StringLike`, never `Resource: "*"`, reviewed under AGENTS.md §2 the same as every other IAM change in this stack.                                                                                                                                                                                             |
| This is a sensitive chunk (touches authentication, tenancy, and role grants)                                                                                                                     | Needs the second fresh-context review per AGENTS.md §2, started when the PR opens.                                                                                                                                                                                                                                                                  |
| The new owner has no `app.persons` row, so they're invisible in the Users & Roles directory view and `assertGrantSubjectAdult`-style minor checks silently skip them (no linked person to check) | Accepted for this chunk — it's the same no-link state `linkUser`/`unlinkUser` already produce between a person's removal and re-link; the later claim-link chunk closes it by linking a real person, which is also the first point a minor check could apply.                                                                                       |

## Out-of-band

No new subprocessor. No legal review. No ADR — no module boundary or documented architecture decision changes; this chunk composes `core/tenancy`, `core/identity`, and `core/access`'s existing or newly-exported public functions, which is exactly what §6.3 already allows. Needs the second review under AGENTS.md §2 (authentication + tenancy). The Terraform change in Infra needs Abdus's apply, as with every apply in this repository.

## Decisions

Abdus, 2026-10-13:

- Overall shape approved: operator-run provisioning step, no HTTP route, emailed claim link deferred.
- Scope expanded from "owner only" to "provision the tenant (organisation and community, if absent) and the first owner in one run" — closes the gap that nothing today creates an organisation in production.
- Service task definition, not `db_ops`: approved; no permission added to the `db_ops` role.
- Secrets Manager delivery for the inputs: approved, conditional on — the Terraform change being named in this spec (done, see Infra) and applied by Abdus; the runbook documenting create (stdin pipe) / read-once / delete (`--force-delete-without-recovery`) / verify-gone; the command printing fixed words only, never the email or an error message; the cost (USD 0.40/secret/month, prorated) stated in this spec (done, see Cost).
- Both an organisation slug and a community slug required: approved; the command refuses if the named community does not belong to the named organisation.
- One fixed secret name, not a name prefix covering a range: approved (done, see Scope/In and Infra), reusable on every run because the operator always force-deletes without recovery.
- Order of operations corrected: the existing-owner check runs before any create, so a second run naming a different email refuses rather than silently creating a stray user (done, see Behaviour and Risks).
- This chunk does not unpark staging; the Terraform change applies while parked, and the live run is deferred to the email chunk's staging proof (done, see Cost and Definition of done).
- The staging owner address is a shared team mailbox, supplied by Abdus out of band; it does not appear in this spec, the plan, or any commit.

## Tests

Security pins:

| Setting                                                                                            | Test                                                                                                                                                                                                                             | Source change that must make the test fail                                                                                        |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A second run naming a different email than the existing owner refuses and creates nothing          | Integration test provisions with email A, re-runs with email B, asserts exit 1 with `owner` and no new `identity.users` row                                                                                                      | Checking only whether an owner grant exists, not whether it belongs to the named email, before deciding to create                 |
| A second run against an already-provisioned org/community/owner with the **same** email is a no-op | Integration test runs the whole command twice with the same email, asserts the second prints `already_bootstrapped` and no new organisation, community, identity, or role-grant row exists                                       | Removing the existing-owner check, or removing the pre-check that skips `createImplicitOrganisation` when the pair already exists |
| Command refuses when the named community belongs to a different organisation than the named slug   | Integration test with a secret naming a real community under organisation A but organisation slug B fails with `organisation` and creates nothing                                                                                | Comparing only the community's existence, not its resolved `organisationId`, against the named organisation                       |
| Email matching uses the same normalisation and lookup as OTP sign-in                               | Integration test provisions with a mixed-case address, then signs in via the OTP path with a differently-cased version of the same address, and asserts both resolve to the same `user_id` with exactly one `identity.users` row | Using a different normalisation or a separate lookup path for the new command than `verifyEmailOtp` uses                          |
| Email never reaches a command/env override or stdout/stderr                                        | A test asserting the entrypoint's only input is `PROVISION_SECRET_ARN`, with no other env var or argv read                                                                                                                       | Adding an email-bearing CLI arg or env var                                                                                        |
| Tenant isolation                                                                                   | Existing tenant-isolation suite, plus a targeted test that org A's new owner cannot read or act on org B's rows                                                                                                                  | Removing `org_id` scoping on the new writes                                                                                       |
| The new IAM statement's resource is exactly one fixed secret name, not a range                     | Terraform test asserting the statement's `Resource` is that one name pattern, not `*` and not the three existing role-secret ARNs                                                                                                | Widening the statement's `Resource`                                                                                               |
| The compiled entrypoint ships in the image                                                         | Image test asserting `/app/provision-owner.js` exists in the built image, the same way an existing test pins `db-migrate.js`                                                                                                     | Removing the file from the build output without failing a test                                                                    |

Unit tests for the three new public exports, and for the new entrypoint's stdout/stderr contract per the tables above.

## Definition of done

This chunk is done when the code, the two new `core/tenancy`/`core/access`/`core/identity` public exports, the new entrypoint, its unit and integration tests, the image test, the runbook addition, and the Terraform change above are reviewed and merged — **not** when the command has been run on `staging-au`. The Terraform change is applied by Abdus while staging stays parked. The first live run of `provision-owner.js`, and the proof that it actually creates a working, signed-in-capable owner against a real database, is explicitly deferred to the email chunk's own staging proof run (which needs an owner to exist anyway to prove sign-in end to end) — the same way `db-migrate-command` shipped its command and image change and left the live proof to `staging-proof-run`.

## Rollback

No migration, no destructive DDL — rollback is reverting the commit. If an organisation, community, or owner grant were created in error, they are removed by hand (delete the role-grant rows, then the community row, then the organisation row); this chunk does not add tooling for that, since it is a rare operator action, not a steady-state one. At this stage an organisation has no plan, entitlement, or content referencing it, so deleting one has no cascade to worry about.

## Catalogue

Last task on this branch updates `docs/roadmap.md`: adds a `first-owner` row (done once merged) under Phase 1, and updates the "Where we are" snapshot's next-chunk sequence to read first-owner → email (SES) → stripe-billing.
