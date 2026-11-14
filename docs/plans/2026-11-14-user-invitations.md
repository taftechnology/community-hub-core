Spec: docs/specs/2026-11-14-user-invitations.md

# User invitations Implementation Plan

Slug: user-invitations
Status: draft

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** staff invite a person by email from Settings → Users & Roles. The person signs in with the invited address and accepts. Only then can they hold a role or a link in that organisation. Grants and links refuse every non-member with one identical answer. The users list decrypts sign-in emails for members only, and only for the community's own members. That closes accepted risk O1 of `users-roles-people-details`.

**Architecture:**

- `packages/contracts/src/access.ts` gets the five invitation routes' bodies and responses.
- `modules/core/access` gets:
  - `app.organisation_members` and `app.invitations` (migration `0019`, with its backfill);
  - the membership check inside `grantRole` and `linkUser`, and a membership from `bootstrapOwner`;
  - an invitations repository (create, list, resend, revoke, accept);
  - the `InvitationMail` port;
  - a `./testing` export with `addMember`.
- `modules/core/identity` gets `sealInvitationEmail`, `openInvitationEmails` and `userEmailBlindIndex`.
- `modules/core/tenancy` gets `findCommunityById`.
- `apps/api` gets:
  - `invitation-routes.ts` (five routes);
  - the SES invitation adapter;
  - the `user_not_member` mapping;
  - the members-only users list.
- `apps/admin` gets the invite form, the pending panel, the user and contact pickers, and the accept flow.
- The docs get `architecture.md` §11.1, §12.2.1 and D13, the roadmap, and `AGENTS.md` line 9.

## Who does what

- **Implementer:** Antigravity (Gemini), in this worktree on the chunk branch.
  - It writes tests first, makes one commit per task, commits locally and never pushes.
  - It runs one plan task per run, because this machine has 12 GB of RAM.
  - It runs every row of the Security pins table that its task names, and reports each failure.
  - It starts with no AWS credentials, and pushes are blocked by the push URL and the pre-push hook.
- **Reviewer agent:** this session, on Claude Opus 5.5 for the whole chunk.
  - Each task is reviewed by its diff.
  - A fresh-context reviewer subagent on the same model runs the tests and re-runs at least one pin per task.
  - Before any Review record is written, the reviewer agent checks the session transcript for the model it ran on.
- **Owner's check and second review:** the chunk owner runs these in a fresh session on Claude Sonnet 5.5, or on another model that is neither Opus 5.5 nor Gemini.
  - This chunk is sensitive: authentication, tenancy, encryption, and children's data through the contact rule.
  - The second review starts when the last task is pushed. The pull request does not merge until it is written.
- Only one run at a time uses the Docker test database.

## Checkpoints

- **After Task 3** (tables and membership enforcement): the reviewer runs pins 1 to 11 before Task 4 starts.
- **After Task 6** (the repository is complete): the reviewer runs pins 12 to 30 before Task 7.
- **After Task 8** (the routes and their integration suite): the reviewer runs pin 4 (HTTP half) and pins 31 to 34 before any admin work.
- **After Task 10** (the admin): the reviewer runs pins 35 to 37 before Task 11.

## Global constraints

- **Branch:** `feat/2026-11-14-user-invitations`, created from `origin/main` at `9da5ba7` (PR #85 merged).
  - The spec is its first commit (`ab67bb1`), and this plan is its second.
  - The plan stays `Status: draft` until the owner's assistant has read both on the branch. Then the chunk owner approves it.
- **Database:**
  - One migration, `0019`, made in Task 2 only. Generate it with `pnpm --filter @community-hub/db exec drizzle-kit generate`, then hand-append the SQL the task names to the generated file, as `0018_wise_starfox.sql:15-20` does.
  - A second `generate` must print "No changes", because `packages/db/src/generate.test.ts` asserts that in CI and cannot run on Windows.
  - Any other migration, or a change to `0019` after Task 2 is accepted, stops the run.
- **Dependencies:** none added. **Workspace packages:** none added, so no Dockerfile or `image.test.ts` change (`apps/api/Dockerfile:8` already builds access, identity, tenancy, billing and people).
- **Untouched:**
  - Terraform, workflows, `infra/`, the Dockerfile;
  - `identity` tables;
  - `/v1/access/capabilities` and `grants/list` responses;
  - the shared `empty()` helper.

  Staging stays parked.

- **Never disabled to get green:** a check, a lint rule, an axe rule, RLS, a test or a CI gate.
- **Fixtures** are synthetic:
  - Names are invented, not historical people.
  - Emails use `example.test` addresses.
  - Phones, if any, are ACMA fictional numbers (`0491 570 006`, `0491 570 156` to `159`).
  - Tokens are built at run time. No literal token-shaped or secret-shaped string is committed.
- **No personal data** in URLs, logs, traces, error bodies or audit rows. Tests assert this by searching log lines and audit rows for each fixture's address and token.
- **Error bodies:**
  - The five invitation routes answer JSON `{ error: <code> }` on 4xx.
  - `grants` and `user-links` answer JSON only for 422 `user_not_member`.
  - Every other access error stays an empty body, and every 500 is empty.
- **Build order:** `apps/api` tests import the built `dist` of `@community-hub/contracts`, `identity`, `tenancy`, `access` and `billing`. After changing one, run `pnpm --filter <package> build` before the `apps/api` tests.
- **Admin stale-response rules** apply to every new fetch:
  - a generation guard on every response, including after `json()` and in the `catch` of a rejected `json()`;
  - each guard pinned by a test that fails without it;
  - non-200 answers with JSON bodies covered;
  - a StrictMode render test;
  - no real waits;
  - exact call counts;
  - stale-response tests use an id present in both communities with different data.
- **Local gate per task:** `pnpm install --frozen-lockfile` and `pnpm build` in a fresh worktree, then `pnpm gate`.
  - When a brief skips the full gate for memory, it still runs `pnpm exec prettier --check .` and `pnpm check:boundaries`.
  - Bypass the turbo cache (`--force`) when a test reads a file outside its package.
- **Allowed failures on this Windows machine,** and only these:
  - `packages/db/src/generate.test.ts` drizzle ENOENT;
  - the `image-publish` symlink EPERM;
  - the `migrate.integration` and `plaintext-dist` timeouts.

## Decisions fixed by the spec (do not reopen)

- **Membership** is organisation-level: `app.organisation_members (org_id, user_id)`, policy `org_isolation`, insert-only for `app`. Sources are `invitation`, `provision` and `backfill`.
- **Invitations** are community-level: `app.invitations`, policy `community_isolation`. Uniqueness, caps, retention and the expired-row void are all per community.
  - Caps: 20 creates per hour and 100 unexpired pending; 3 resends, with the count reset after 24 hours without a send.
  - Expiry: 7 days.
- **Invitation contents:** a role, a contact, or both. Never neither (400).
- **The address** is normalised, encrypted with the identity key, and blind-indexed with the same HMAC and label as `identity.users.email`, all inside `core/identity`. Create never reads `identity.users`.
- **The token** is `v1.` + base64url of org id ‖ community id ‖ invitation id (16 bytes each) ‖ 32 random bytes. It is parsed strictly, and only its SHA-256 is stored. It travels in the URL fragment of `<ADMIN_ORIGIN>/#invite=…`.
- **Accept order:**
  - a. Parse the token.
  - b. Prove it in a read-only transaction.
  - c. `findCommunityById`.
  - d. `assertWritable`.
  - e. Run the write transaction: select `FOR UPDATE`, compare the hash, check pending and unexpired, compare blind indexes, run pure checks, insert the membership, run the internal grant and link writes, close the row, write `access.invitation.accepted`.
- **Accept errors:** `invitation_invalid` 404 (no audit), `wrong_address` 403 (nothing written), `invitation_void` 409 (void, address cleared, `access.invitation.voided`).
- **Grants and links:** permission check first (403), then the membership check (422 `user_not_member`, plus `access.permission.denied` with purpose `access.user.not_member`).
- **Users list directory:** members with a grant or link in this community or an organisation grant, plus members whose accepted invitation was to this community. Emails are decrypted only for those, minus minor-linked and unreadable-linked users (PR 85, A1).
- **Mail failure:** create deletes the row and writes `access.invitation.voided`. Resend voids. Both answer an empty 503.
- **Out of the chunk:**
  - membership foreign keys (roadmap row);
  - member removal;
  - bulk invitations;
  - a sweep job;
  - community display names;
  - second-factor setup at acceptance;
  - Laravel import memberships;
  - decoupling `ADMIN_ORIGIN` from billing.

## Security pins

The implementer runs each row named in its task once:

1. Weaken the source.
2. Watch the named test fail.
3. Restore the source.
4. Confirm the test is green again.
5. Report the failure output.

The weakened tree is never committed. The reviewer reads the weakening report, re-runs at least one row per task, and runs every row at its checkpoint.

- **Weakening a package that an `apps/*` test reads from `dist`:** rebuild that package after weakening and again after restoring.
- **A database weakening** is appended to `packages/db/drizzle/0019_*.sql` in the scratch tree, after a `--> statement-breakpoint`, and restored with `git checkout -- packages/db/drizzle`. It is never typed into a running database, because every vitest run recreates it (`packages/db/test/global-setup.ts`).
- **Concurrency pins (17 and 27)** use database locks the test holds, and wait on `pg_stat_activity`/`pg_locks` showing the expected waiting backends. They never use a timer or a sleep.

| #   | Setting                                                                      | Weakening                                                                                                                                                | Pinning test                                                                                                                                                                                                                                                                                                                                                   | Task |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | `grantRole` refuses a non-member                                             | remove the membership check from `grantRole`                                                                                                             | `grants.integration.test.ts`: three ids, granted by an owner of org A: a member of org B, a random uuid, and a real user with no membership. Each throws `AccessError("not_member")`. No grant row exists, and one `access.permission.denied` row has purpose `access.user.not_member` per attempt                                                             | 3    |
| 2   | `linkUser` refuses a non-member                                              | remove the membership check from `linkUser`                                                                                                              | the same three cases for `linkUser`: `not_member`, and no link row                                                                                                                                                                                                                                                                                             | 3    |
| 3   | The permission check runs before the membership check                        | move the membership check above the permission check in `grantRole`                                                                                      | a caller without `access.roles.manage` granting a non-member gets `forbidden`, not `not_member`                                                                                                                                                                                                                                                                | 3    |
| 4   | One refusal for every non-member                                             | throw `not_found` when the user id is absent from `identity.users`                                                                                       | Pin 1's test asserts the same error code for all three ids. Task 8's integration test asserts byte-identical HTTP bodies                                                                                                                                                                                                                                       | 3, 8 |
| 5   | `bootstrapOwner` makes the owner a member                                    | remove the membership insert from `bootstrapOwner`                                                                                                       | `grants.integration.test.ts`: after `bootstrapOwner`, one `provision` membership exists for the owner; granting that owner a second role succeeds                                                                                                                                                                                                              | 3    |
| 6   | RLS and FORCE RLS on both tables                                             | append `ALTER TABLE app.organisation_members NO FORCE ROW LEVEL SECURITY;` (and, separately, the same for `app.invitations`)                             | `packages/db/test/rls.integration.test.ts` pattern: both tables have `relrowsecurity` and `relforcerowsecurity`. A row of org B is invisible under org A's scope, and an invitation of community Y is invisible under community X                                                                                                                              | 2    |
| 7   | Column privileges                                                            | append (a) `GRANT DELETE ON app.organisation_members TO app;` (b) `GRANT UPDATE (org_id, community_id, invited_by, role_key) ON app.invitations TO app;` | `privileges.integration.test.ts`: `app` has INSERT and SELECT but not UPDATE, DELETE or TRUNCATE on `organisation_members`. On `invitations` it has UPDATE only on the ten named columns, plus DELETE, and no TRUNCATE                                                                                                                                         | 2    |
| 8   | The backfill sets the tenant scope per community                             | remove the two `set_config` calls inside the loop                                                                                                        | `membership-backfill.integration.test.ts`: apply migrations to `0018`, seed grants and links in org A (communities 1 and 2) and org B, apply `0019`, and assert the exact membership set                                                                                                                                                                       | 2    |
| 9   | The backfill resets the scope                                                | remove the reset after the loop                                                                                                                          | the same test asserts `current_setting('app.org_id', true)` and `app.community_id` are empty or null in the migration session after `0019`                                                                                                                                                                                                                     | 2    |
| 10  | The backfill takes only users that exist in `identity.users`                 | remove the `identity.users` join                                                                                                                         | the same test seeds a grant whose user id has no identity row, and that id gets no membership                                                                                                                                                                                                                                                                  | 2    |
| 11  | The organisation lock is shared                                              | give invitations a different lock key from `bootstrapOwner`                                                                                              | `membership.test.ts`: `lockOrganisation` is the single exported function used by `grants.ts` and `invitations.ts` (a source scan, as `kms-boundary.test.ts` does)                                                                                                                                                                                              | 3    |
| 12  | The AAD binds each invitation's own id                                       | open every row with the first row's id                                                                                                                   | `invitation-email.integration.test.ts`: two rows opened in reverse order return the right address each. A ciphertext copied to another invitation id fails to open                                                                                                                                                                                             | 4    |
| 13  | The invitation blind index equals the user blind index                       | use the label `app.invitations.email` for the index                                                                                                      | sealing `" Alex@Example.Test "` gives an index equal to `identity.users.email_bidx` for a user created with `alex@example.test`. `userEmailBlindIndex` returns that same value                                                                                                                                                                                 | 4    |
| 14  | `openInvitationEmails` is capped and issues no query                         | (a) raise the cap to 1,000; (b) read `app.invitations` inside it                                                                                         | (a) 101 rows throw before any decrypt. (b) `invitation-email.test.ts`: the function receives no SQL handle (a type-level check plus a source scan for a tagged template)                                                                                                                                                                                       | 4    |
| 15  | `findCommunityById` checks the organisation                                  | drop the `organisation_id` condition                                                                                                                     | `implicit-organisation.integration.test.ts`: a community id with the wrong organisation id returns null                                                                                                                                                                                                                                                        | 4    |
| 16  | Create never reads `identity.users`                                          | call `findUserByEmail` inside create                                                                                                                     | `invitations.test.ts`: create receives no identity checkout. Its dependency object has only the seal function, and a spy on every other identity export records no call                                                                                                                                                                                        | 5    |
| 17  | Caps are checked under the organisation lock                                 | remove the `lockOrganisation` call from create                                                                                                           | `invitations.integration.test.ts`: with 99 pending, the test takes the organisation advisory lock itself. It starts two creates, waits until both are blocked on the lock in `pg_locks`, then releases. Exactly one succeeds and one gets `too_many`                                                                                                           | 5    |
| 18  | Uniqueness and caps are per community                                        | append to `0019`: drop the partial index and recreate it on `(org_id, email_bidx) WHERE status = 'pending'`                                              | two communities in one organisation: a pending invitation and an expired pending invitation for the same address in community 2 do not change create in community 1, which succeeds; 100 pending in community 2 do not trigger `too_many` in community 1                                                                                                       | 5    |
| 19  | An expired pending row is voided before the insert                           | remove the expired-row void                                                                                                                              | create, expire (`expires_at` moved into the past), create again: the second create succeeds, the first row is `void` with its address cleared, and one `access.invitation.voided` row is written                                                                                                                                                               | 5    |
| 20  | The address, blind index and contact are cleared when a row leaves `pending` | remove the clearing from revoke (and, separately, from accept and void)                                                                                  | after revoke, accept and void, each row has null `email`, `email_bidx` and `person_id`, and `closed_at` set                                                                                                                                                                                                                                                    | 5, 6 |
| 21  | Resend and revoke answer one not-found                                       | return a distinct code for a non-pending row                                                                                                             | unknown id, community 2's id, an accepted row, a revoked row, and (resend) an expired row each give `invitation_not_found` and write no audit row                                                                                                                                                                                                              | 5    |
| 22  | The minor refusal at create                                                  | remove the minor check from create                                                                                                                       | a minor contact gives `person_minor` and no row                                                                                                                                                                                                                                                                                                                | 5    |
| 23  | Strict token parsing                                                         | accept any length of 112 bytes or more                                                                                                                   | `invitation-token.test.ts`: a wrong prefix, one byte short, one byte long, a non-base64url character, and a nil uuid each parse to `invalid`                                                                                                                                                                                                                   | 6    |
| 24  | The full hash is compared                                                    | compare only the first 8 bytes                                                                                                                           | `invitation-accept.integration.test.ts`: a token whose secret shares the first 8 bytes but differs after gives `invitation_invalid`                                                                                                                                                                                                                            | 6    |
| 25  | Pending and unexpired at accept                                              | (a) drop the expiry check; (b) drop the status check                                                                                                     | (a) an expired invitation gives `invitation_invalid`; (b) a revoked one gives `invitation_invalid`. Both write nothing                                                                                                                                                                                                                                         | 6    |
| 26  | The blind-index match at accept                                              | skip the comparison                                                                                                                                      | a second user who holds the token gets `wrong_address`. There is no membership, no grant, no link, and the invitation stays pending                                                                                                                                                                                                                            | 6    |
| 27  | `FOR UPDATE` serialises accepts                                              | remove `FOR UPDATE`                                                                                                                                      | the test locks the invitation row `FOR UPDATE` in its own transaction. It starts two accepts by the invited user, waits until both backends are waiting in `pg_stat_activity`, then commits. Exactly one `access.invitation.accepted` row exists, and the other call gives `invitation_invalid`                                                                | 6    |
| 28  | The inviter re-check and the internal writes                                 | (a) drop the inviter-permission re-check; (b) call the public `grantRole` in step 7                                                                      | revoke the inviter's role, then accept: `invitation_void`, no grant, and **no** `access.permission.denied` row (b fails on that). A user whose existing link is to a person now a minor gets `invitation_void`, not a 500                                                                                                                                      | 6    |
| 29  | The minor refusal at accept                                                  | remove the minor check from the step 5 checks                                                                                                            | a contact made a minor after the invite gives `invitation_void`, and no link                                                                                                                                                                                                                                                                                   | 6    |
| 30  | No audit row on `invitation_invalid`                                         | write `access.permission.denied` on an invalid token                                                                                                     | a forged token naming org A writes no audit row in org A                                                                                                                                                                                                                                                                                                       | 6    |
| 31  | `assertWritable` on accept, after the token is proven                        | (a) remove it; (b) move it before the read-only proof                                                                                                    | `invitations.integration.test.ts` (api): in a read-only organisation, a valid token gets 402 and nothing is written (a fails on this). A forged token for the same organisation and community gets 404 `invitation_invalid` (b fails on this)                                                                                                                  | 8    |
| 32  | Users list: members only, and the community rule                             | (a) drop the membership condition; (b) list every member of the organisation                                                                             | `users-list.integration.test.ts`: (a) a user granted by raw SQL with no membership is absent, and the `readUserEmails` spy never receives that id. (b) In org A, a member granted only in community 2 is absent from community 1's list and is never decrypted. A member whose accepted invitation was to community 1, with no grant, is listed in community 1 | 7, 8 |
| 33  | Route permissions                                                            | (a) create with a role without `access.roles.manage`; (b) create with a contact without `people.view`; (c) list with `access.users.view` only            | `invitation-routes.test.ts`: (a) and (b) each give 403 and no repository call; (c) gives 403                                                                                                                                                                                                                                                                   | 7    |
| 34  | Bodies, `no-store` and logs                                                  | (a) put `error.message` in a 500 body; (b) drop `no-store` from the invitations list; (c) log the token or the address                                   | `invitation-routes.test.ts`: a forced failure carrying a fixture address and token gives an empty 500. Every list response has `cache-control: no-store`. No log field contains the address or the token, and every field value is a primitive. `ses-invitation-mail.test.ts`: an SES error carrying the address is never logged                               | 7    |
| 35  | The fragment is removed and the token never stored                           | (a) skip `history.replaceState`; (b) put the token in `sessionStorage`                                                                                   | `accept-invitation.test.tsx`: after load `location.hash` is empty, and spies on `localStorage` and `sessionStorage` `setItem` never receive the token                                                                                                                                                                                                          | 10   |
| 36  | The admin's stale-response guards on the new fetches                         | remove each guard in turn (after `post`, after `json()`, in the `catch`)                                                                                 | `invitations.test.tsx` and `users-roles.test.tsx`: one test per guard, with ids present in both communities                                                                                                                                                                                                                                                    | 9    |
| 37  | The pickers never offer a raw id input                                       | restore the free-text User input                                                                                                                         | `users-roles.test.tsx`: the grant and link forms have no text input named User. The picker lists exactly the users list rows                                                                                                                                                                                                                                   | 9    |

## Rollback

- Revert the pull request's merge commit. Grants and links then accept any user id again (O1 reopens), and the users list returns to PR 85's behaviour.
- Migration `0019` is expand-only. Its two tables stay after a revert and are unused. A later contract PR may drop them.
- The backfill only inserts membership rows. Rows already written stay, and they grant nothing on their own.
- Audit rows stay, because the audit log is append-only, and they hold ids only.

## Stop and ask (AGENTS.md §12)

The implementer stops and reports, without improvising, when:

- the plan is wrong or ambiguous, or the code does not match a pointer in it;
- a second migration, a change to an accepted `0019`, a grant, a dependency, a workspace package, a Dockerfile, a workflow or a Terraform change looks necessary;
- a pin's weakening does not make its test fail;
- the same step fails twice;
- anything would put personal data or a token in a log, an error body, a URL path or query, or an audit row;
- a secret, token or account identifier appears in any file or output.

### Task 1: Contracts, error codes and audit names

**Commit:** `feat(access): add invitation contracts, error codes and audit names`

**Files:**

- `packages/contracts/src/access.ts` and `access.test.ts`;
- `modules/core/access/domain/error.ts`;
- `modules/core/access/public/index.ts`;
- `modules/core/access/infrastructure/audit-registration.test.ts`.

**Test first:**

- Strict Zod schemas, each rejecting an extra key:
  - `createInvitationBody` `{ communitySlug, email, roleKey?, customRoleId?, personId? }`, refined so that at most one of `roleKey`/`customRoleId` and at least one of role/`personId` is present;
  - `createInvitationResponse`;
  - `listInvitationsBody` and `listInvitationsResponse`;
  - `invitationActionBody` (resend, revoke);
  - `acceptInvitationBody` `{ token }` (a string of bounded length, parsed later) and `acceptInvitationResponse` `{ communitySlug }`;
  - `accessErrorBody` `{ error }` with the code enum.
- `email` is a string of at most 254 characters. Normalisation happens in identity, not in Zod.
- These names are registered:
  - actions `access.invitation.created`, `.resent`, `.revoked`, `.accepted`, `.voided` and `access.invitations.listed`;
  - purpose `access.user.not_member`, and the purposes the new routes deny under.
- `AccessErrorCode` gains `not_member`, `already_invited`, `invitation_invalid`, `wrong_address`, `invitation_void`, `invitation_not_found`, `person_linked` and `role_not_found`, where absent. The RED for the union is `pnpm typecheck`.

**Rule it must not break:** existing access schemas are unchanged.

**Pins run:** none.

### Task 2: Migration `0019`, the schema and the backfill

**Commit:** `feat(access): add organisation members and invitations tables`

**Files:**

- `modules/core/access/db/schema.ts`: `accessTables` gains `{ encryptedColumn, blindIndexColumn }`, and two tables;
- `packages/db/drizzle.schema.ts:71`: passes them, as `:57` does for people;
- `packages/db/drizzle/0019_*.sql`, its snapshot and journal entry;
- `modules/core/access/module.manifest.ts` and `domain/manifest.test.ts`;
- `modules/core/access/infrastructure/privileges.integration.test.ts`;
- new `modules/core/access/infrastructure/membership-backfill.integration.test.ts`;
- `packages/db/test/rls.integration.test.ts`.

**What `0019` holds after generation, hand-appended:**

- the two `community_isolation`/`org_isolation` policies, if drizzle does not emit them from `pgPolicy`;
- `ENABLE` and `FORCE ROW LEVEL SECURITY` on both tables;
- `REVOKE UPDATE, DELETE, TRUNCATE ON app.organisation_members FROM app;`
- `REVOKE UPDATE, TRUNCATE ON app.invitations FROM app;` then `GRANT UPDATE (status, email, email_bidx, token_hash, expires_at, resend_count, last_sent_at, accepted_user_id, person_id, closed_at) ON app.invitations TO app;`
- the checks (status values, source values, built-in `role_key`, at most one role, and a role or contact while pending);
- the partial unique index `(org_id, community_id, email_bidx) WHERE status = 'pending'`;
- the foreign keys `(org_id, person_id)` to persons and `(org_id, custom_role_id)` to custom roles, both `on delete restrict`;
- the backfill `DO` block (spec, Data):
  - a loop over `platform.communities`, with `set_config('app.org_id', …, true)` and `set_config('app.community_id', …, true)`;
  - an insert of `backfill` memberships from the three grant and link tables, joined to `identity.users`, with `ON CONFLICT DO NOTHING`;
  - a reset of both settings to `''` after the loop;
- a recovery note in an SQL comment: the tables are new and may be dropped by a later contract PR.

**Test first:**

- The manifest test lists every new column with its class from the spec. `email` and `email_bidx` are `confidential-blind`, and every other column is `internal`.
- Pins 6 to 10.
- The backfill test needs migrations applied only up to `0018`. A local helper copies `packages/db/drizzle` into a temporary folder with the journal truncated at `idx 18`, applies it with `applyMigrations` (`packages/db/src/migrate.ts:84`), seeds rows as the migrator with `set_config`, then applies the full folder. `packages/db/test/migrate.integration.test.ts:93-110` is the pattern. It runs on its own database name, so `global-setup` is not disturbed.
- Report the membership count and the number of users holding grants in more than one organisation after the backfill on the seeded data. The PR records both, with the note that every real environment's database is empty today.

**Rule it must not break:** no change to existing tables, policies or privileges, and both unique keys start with `org_id`. A second `generate` prints no changes.

**Pins run:** 6, 7, 8, 9, 10.

### Task 3: Membership enforcement, the owner's membership and the test helper

**Commit:** `feat(access): accept grants and links for organisation members only`

**Files:**

- `modules/core/access/infrastructure/grants.ts`;
- new `modules/core/access/infrastructure/membership.ts`, holding `lockOrganisation` (moved out of `grants.ts:170-176`, same key), `isMember`, `insertMembership`, and `membership.test.ts`;
- new `modules/core/access/testing/index.ts` exporting `addMember(tx, userId)`, plus the `./testing` entry in `modules/core/access/package.json` `exports`;
- `grants.integration.test.ts`;
- every existing test that grants or links a fresh user, about 62 `grantRole`/`linkUser` call sites in 11 test files under `modules/core/access` and `apps/api/src`. They call `addMember` first. The raw-SQL grant fixtures in `users-list`, `grants`, `holds-any-grant` and `holds-permission` integration tests insert a membership row.

**Behaviour:**

- `grantRole` and `linkUser` call `isMember` after their permission checks and before the insert, in the same transaction. A miss calls the existing `deny()` with purpose `access.user.not_member`, then throws `AccessError("not_member")`.
- `grantCustomRole` (`grants.ts:346`) gets the same check.
- `bootstrapOwner` inserts the `provision` membership under its lock, before its grants.
- Production code never imports `./testing`. A source-scan test in `membership.test.ts` asserts that no file outside `*.test.ts` imports `@community-hub/access/testing`.

**Test first:** pins 1 to 5 and 11. The existing suites stay green with `addMember` added, with no assertion weakened. The review compares each changed test's assertions line by line.

**Rule it must not break:** revoke and unlink are unchanged, and a member's grant still works exactly as before.

**Pins run:** 1, 2, 3, 4 (repository half), 5, 11.

### Task 4: Identity and tenancy exports

**Commit:** `feat(identity): seal and open invitation addresses`

**Files:**

- new `modules/core/identity/infrastructure/invitation-email.ts`, with `invitation-email.test.ts` and `invitation-email.integration.test.ts`;
- `modules/core/identity/public/index.ts`;
- `modules/core/tenancy/infrastructure/implicit-organisation.ts` (`findCommunityById` beside `findCommunityBySlug` at `:78-101`), its integration test, and `modules/core/tenancy/public/index.ts`.

**Behaviour:**

- `sealInvitationEmail(sql, kms, keyArn, { invitationId, address })` normalises with `normaliseEmail` (`domain/email.ts:6`) and derives keys with `deriveIdentityEmailKeys` (`email-lookup.ts:45-65`). It returns plain `Uint8Array` `{ ciphertext, blindIndex }`.
  - The index uses `emailBlindIndex` unchanged (label `identity.users.email`).
  - The ciphertext uses AAD `{ tag: "chub/field-identity/v1", label: "app.invitations.email", rowId: invitationId, region: "au" }`.
  - It never creates a key. A missing key throws.
- `openInvitationEmails(sql, kms, keyArn, rows: { id, ciphertext }[])` decrypts with the same AAD and returns `Map<id, string>`. It is capped at 100. It reads only the identity key row, never `app`.
- `userEmailBlindIndex(sql, userId)` reads `identity.users.email_bidx` for one user and returns plain bytes, or null.
- `findCommunityById(sql, { organisationId, communityId })` returns `{ id, organisationId, slug }`, or null when either id does not match.

**Test first:** pins 12 to 15.

**Rule it must not break:** `readUserEmails`, `findUserByEmail` and sign-in are unchanged, and the identity role gains no privilege.

**Pins run:** 12, 13, 14, 15.

### Task 5: Invitations repository: create, list, resend, revoke

**Commit:** `feat(access): create, list, resend and revoke invitations`

**Files:**

- new `modules/core/access/infrastructure/invitations.ts`, with `invitations.test.ts` and `invitations.integration.test.ts`;
- new `modules/core/access/domain/invitation-token.ts` (token build and parse, pure) and `invitation-token.test.ts`;
- new `modules/core/access/domain/invitation-mail.ts` (the `InvitationMail` port and `rejectingInvitationMail`);
- `modules/core/access/public/index.ts`.

**Behaviour** (spec, Inviting and Pending invitations). Every function runs in a community-scoped `AppTransaction` that the caller opens. The seal and open functions are passed in as dependencies, so `core/access` does not import `core/identity`.

- `createInvitation`:
  1. take `lockOrganisation`;
  2. purge old rows;
  3. void an expired pending duplicate;
  4. check the duplicate and the caps;
  5. check the role rules (the same as `assertMayGrantRole` and the custom-role lookup);
  6. check the contact (adult, readable, unlinked);
  7. insert;
  8. write `access.invitation.created`.

  It returns `{ invitationId, token }`. The token is never stored.

- `listInvitations` purges old rows. It returns at most 100 unexpired pending rows with their ciphertexts, for the route to open, and writes `access.invitations.listed`.
- `resendInvitation` and `revokeInvitation` select `FOR UPDATE` where pending (and, for resend, unexpired). They return `not_found` for everything else.
- `deleteInvitationAfterMailFailure` and `voidInvitationAfterMailFailure` are the two mail-failure paths.

**Test first:** pins 16 to 22. Two communities and two organisations appear in the fixtures.

**Rule it must not break:** no change to grants and links. The address and token appear in no audit row: each test scans the `audit` rows for the fixture address and the token text.

**Pins run:** 16, 17, 18, 19, 20 (revoke), 21, 22.

### Task 6: Invitations repository: accept

**Commit:** `feat(access): accept an invitation`

**Files:**

- `modules/core/access/infrastructure/invitations.ts`, gaining `proveInvitation` and `acceptInvitation`;
- `grants.ts`: internal grant and link writers that skip the permission check and never call `deny()`. The public `grantRole` and `linkUser` keep their checks and call the same writers;
- new `modules/core/access/infrastructure/invitation-accept.integration.test.ts`.

**Behaviour** (spec, Accepting):

- `proveInvitation(tx, token)` is read-only: select by id, compare the hash, check pending and unexpired. It returns `ok` or `invalid`.
- `acceptInvitation(tx, { token, userId, userBlindIndex })` runs steps 1 to 9.
  - The hash comparison is `crypto.timingSafeEqual` on equal-length buffers.
  - Any `AccessError` from the internal writers voids the invitation.
  - On `invitation_invalid` it writes nothing, audit included.

**Test first:** pins 20 (accept and void), 23 to 30. Plus:

- an existing member accepting adds only the role;
- a member already holding the role succeeds with no duplicate;
- a contact linked to another user since the invite gives `invitation_void`;
- a custom role cannot be deleted while a pending invitation names it (`role_in_use`).

**Rule it must not break:** `grantRole` and `linkUser` behave exactly as after Task 3. Their existing tests pass unchanged.

**Pins run:** 20 (accept, void), 23, 24, 25, 26, 27, 28, 29, 30.

### Task 7: Mail adapter and the five routes

**Commit:** `feat(api): invitation routes and mail`

**Files:**

- new `apps/api/src/mail/ses-invitation-mail.ts` and `ses-invitation-mail.test.ts`, beside `ses-otp-mail.ts`. Same client, sender, configuration set and 5-second deadline;
- `apps/api/src/index.ts`: `bindServices` wires `InvitationMail` under the `OtpMail` condition (`:203-216`). Otherwise `rejectingInvitationMail`;
- new `apps/api/src/invitation-routes.ts` and `invitation-routes.test.ts`, registered in `productionRoutes` (`index.ts:366`);
- `apps/api/src/access-routes.ts`:
  - `statusFor` maps `not_member` to 422 with JSON `{ error: "user_not_member" }`, for `grants` and `user-links` only;
  - the users list directory query changes to the spec's member rule;
- `apps/api/src/access-routes.test.ts`.

**Behaviour:**

- **Create, resend and revoke** are `billing: "write"`. Create and resend send after commit.
  - The link is `${ADMIN_ORIGIN}/#invite=${token}`. An unset `ADMIN_ORIGIN` or mail gives 503 before any write.
  - A mail failure calls the matching failure path and answers an empty 503.
- **List** is `billing: "read"`. It needs `access.users.view` and `access.roles.view`, opens addresses through `openInvitationEmails` (identity checkout), and answers with `no-store`.
- **Accept** is `billing: "exempt"`. It runs, in order:
  1. `sessionUser`;
  2. parse the token;
  3. `proveInvitation` in a read-only app transaction scoped by the token;
  4. `findCommunityById` (platform);
  5. `assertWritable` (platform);
  6. `userEmailBlindIndex` (identity);
  7. `acceptInvitation` in the write transaction.
- **Every handler** has one whole-handler catch. A 500 is an empty body, and the log carries the route, the status and the error class only.
- **Mail content:**
  - subject "You're invited to <slug> on Community Hub";
  - plain-text body naming the slug and the expiry date, with the link;
  - the line "If you weren't expecting this, you can ignore it";
  - no inviter name.

**Test first:** pins 32 (unit half, against a mocked directory), 33, 34. Mail tests assert the recipient, the subject, the link and the deadline, and that nothing is logged on failure.

**Rule it must not break:** `grants/list` and `capabilities` responses and headers are unchanged. The users list keeps its empty-body pin and its 500-cap behaviour.

**Pins run:** 32 (unit), 33, 34.

### Task 8: API integration suite

**Commit:** `test(api): invitations and members-only access end to end`

**Files:**

- new `apps/api/src/invitations.integration.test.ts`;
- `apps/api/src/users-list.integration.test.ts`.

These are tests only. A source change here stops the run, unless it fixes a bug the suite finds, and that bug is then reported.

**Cases:**

- Org A has communities 1 and 2. Org B has community 1. Sessions come from the existing `createSession(email)` helper (`users-list.integration.test.ts:251-265`) with a `MemoryMail`.
- Invite, then accept as the invitee:
  - membership, grant and link exist;
  - the users list shows the user with the email;
  - the pending panel is empty.
- `POST /v1/access/grants` with org B's member, a random uuid, and a signed-in user with no membership: three byte-identical 422 bodies, and no grant rows (pin 4, HTTP half).
- Org A's list never contains org B's users, and never decrypts them.
- Pin 31 (billing read-only).
- Pin 32 (integration half).
- A token for org A replayed with org B's ids, and a token tampered in each id field: 404 `invitation_invalid`, and no audit row in either organisation.
- The fixture address and token appear in no log line and no audit row.

**Pins run:** 4 (HTTP), 31, 32 (integration).

### Task 9: Admin: invite, pending, pickers

**Commit:** `feat(admin): invite users and pick members on Users & Roles`

**Files:**

- new `apps/admin/src/invitations.tsx` (the invite form and the pending panel) and `invitations.test.tsx`;
- `apps/admin/src/users-roles.tsx` and `users-roles.test.tsx`.

**Behaviour** (spec, Inviting, Pending invitations, and the pickers):

- **The invite form** shows to `access.users.manage`. Its role select shows with `access.roles.manage`, and its contact picker with `people.view`. The picker searches `POST /v1/people/list` (adults, `limit` 20) with a generation guard.
- **The pending panel** shows to `access.users.view` with `access.roles.view`. Resend and revoke show with `access.users.manage`.
- **The grant form's User field** becomes a `Select` over the users list rows, labelled by name, else email, else "User without details · <last 4 of id>". The link form gets the same, plus the contact picker. The raw id inputs are removed.
- **The empty picker** says "Invite someone first".
- **Errors** map the codes to plain sentences. 503 shows "Invitations are not available yet". `hideWrites` (billing) hides the invite form, resend and revoke.

**Test first:** pins 36 and 37. Also:

- each permission combination's visible controls;
- each error code's sentence;
- a StrictMode render;
- exact request bodies for create, resend and revoke;
- an axe pass with no violations.

**Rule it must not break:** the existing 48 Users & Roles tests pass. Any test that typed a user id is changed to pick from the select, with the same assertion on the request body.

**Pins run:** 36, 37.

### Task 10: Admin: the accept flow

**Commit:** `feat(admin): accept an invitation from the emailed link`

**Files:**

- new `apps/admin/src/accept-invitation.tsx` and `accept-invitation.test.tsx`;
- `apps/admin/src/shell.tsx`: it reads `#invite=` once at start-up, before the router renders;
- `apps/admin/src/sign-in.tsx`: the heading and the post-sign-in navigation while a token is held (`:75`).

**Behaviour** (spec, Accepting):

- The token is read from the fragment, the fragment is removed with `history.replaceState`, and the token is kept in a module-level memory holder only.
- A signed-out person gets the sign-in screen headed "Sign in with the address this invitation was sent to". After sign-in, a person who holds a token sees the accept screen instead of `/settings/users`.
- **Accept screen:** "Accept invitation", then the button.
  - 200: switch to the returned slug and load capabilities. A 403 there shows "Your invitation was accepted. An administrator will give you access".
  - `wrong_address`: the sentence from the spec, with a sign-out button.
  - `invitation_invalid` and `invitation_void`: "This invitation is no longer valid. Ask for a new one".
  - 402: the billing read-only notice.
- The token is cleared from memory after any final answer.

**Test first:** pin 35. Also each answer's screen, no token in any request URL, a StrictMode render, and axe.

**Rule it must not break:** a normal sign-in with no token still lands on `/settings/users`, and the existing sign-in tests pass unchanged.

**Pins run:** 35.

### Task 11: Architecture, roadmap and AGENTS.md

**Commit:** `docs: mark user-invitations done`

**Files:** `architecture.md`, `docs/roadmap.md`, `AGENTS.md`.

- **`architecture.md`:**
  - §11.1 (`:664-675`) gains:
    - organisation membership, and that grants and links require it;
    - invitations, with acceptance by signing in as the invited address;
    - the email decrypted only for members of the caller's community directory.
  - §12.2.1 (`:761-777`) gains the `app.invitations.email` row:
    - `confidential-blind`, with the identity key and the same blind index as `identity.users.email`;
    - cleared when the invitation closes;
    - deleted rows on offboarding;
    - the cross-schema join that the migrator or a backup reader can make.
  - D13 (`:122`) gains `InvitationMail` beside `OtpMail` as an interim port until `EmailProvider`. No ADR (spec O2).
- **`docs/roadmap.md`:**
  - the row at `:172` becomes **done**, with the spec path;
  - a new **not started** row "Membership foreign keys". It is the contract step that reports grants and links without membership to the project owner before adding the keys;
  - the Open items paragraph at `:307` is replaced: O1 is closed by this chunk;
  - new open items:
    - the per-community caps;
    - the organisation-wide-member residual;
    - the lazy retention and the sweep follow-up;
    - production SES needed before a parish uses invitations;
    - the staging check deferred to the next proof chunk;
  - the snapshot (`:21-27`): last shipped `user-invitations`, next chunk `Add Adult create`. The "Next spec" section at `:401` matches.
- **`AGENTS.md:9`** "Repository state": `User invitations` is done, and the next chunk is `Add Adult create`.

**Test first:** none, since this task is docs only. `pnpm exec prettier --check .` and `pnpm check:boundaries` pass.

**Rule it must not break:** no other row changes status, and no architecture decision changes beyond those above.

## Definition of done (AGENTS.md §8)

- All eleven tasks are accepted by the reviewer agent, every named pin has been run and reported, and CI is green on the pull request.
- The tenant-isolation tests (Tasks 2, 3, 5, 6 and 8) are green.
- **Not done in this chunk:** the staging-hostname check, because staging stays parked. It is deferred to the next proof chunk that unparks, and that chunk sends a real invitation through SES sandbox. The PR body records this as a §8 deviation.
- The PR body records:
  - the implementer: Antigravity (Gemini);
  - the reviewer agent: Claude Opus 5.5, as checked in the transcript;
  - the owner's checks, with their model and what they ran;
  - the second-review line;
  - the backfill counts from Task 2;
  - the task count, eleven, above AGENTS.md §3's 3 to 10 guide, by the chunk owner's decision.
- Session scratch is cleaned up: no `docs/plans/*-report.md`, and nothing under `.superpowers/` staged.

## Owner decisions

For the chunk owner, answered once at plan approval:

1. **Task count:** eleven tasks in one PR. Recommendation: keep. Splitting would separate the membership gate from the invitations that make it usable.
2. **Implementer and reviewer:** Antigravity (Gemini) implements. The reviewer agent is Claude Opus 5.5. The owner's checks and the second review run on Sonnet 5.5 or another non-Opus, non-Gemini model.
3. **Deviation policy:** extra attempts, actor changes and fix commits are recorded as deviations in the PR, and cosmetic nits as PR notes.
4. **Next chunk after this one:** `Add Adult create`.

For the project owner: **O1** (spec, privacy retention) is still pending. If he chooses the sweep job, the spec gets an amendment and this plan gets a task before Task 11.

## Probe record

This plan has no Terraform assert, so no scratch probe is needed (AGENTS.md §4). Database weakenings are made in the scratch tree's `0019` file and restored with `git checkout -- packages/db/drizzle`.

## Amendments after approval

None yet.
