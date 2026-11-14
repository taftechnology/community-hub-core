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
  - the membership check inside `grantRole`, `grantCustomRole` and `linkUser`, and a membership from `bootstrapOwner`;
  - an invitations repository (create, list, resend, revoke, accept);
  - the `InvitationMail` port;
  - a test-only `infrastructure/testing.ts` with `addMember`, reached by alias, never exported or built.
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
  - Plan check 1 was such a pass, on Opus 5.5. It does not count as the owner's check.
- **Owner's check and second review:** the chunk owner runs these in a fresh session on Claude Sonnet 5.5, or on another model that is neither Opus 5.5 nor Gemini.
  - This chunk is sensitive: authentication, tenancy, encryption, and children's data through the contact rule.
  - The second review starts when the last task is pushed. The pull request does not merge until it is written.
- Only one run at a time uses the Docker test database.

## Checkpoints

- **After Task 3** (tables and membership enforcement): the reviewer runs pins 1 to 13 and the Task 3 half of pin 14 before Task 4 starts.
- **After Task 6** (the repository is complete): the reviewer runs pin 14 in full and pins 15 to 38 before Task 7.
- **After Task 8** (the routes and their integration suite): the reviewer runs pin 12 (HTTP half) and pins 39 to 44 before any admin work.
- **After Task 10** (the admin): the reviewer runs pins 45 to 47 before Task 11.

## Global constraints

- **Branch:** `feat/2026-11-14-user-invitations`, created from `origin/main` at `9da5ba7` (PR #85 merged).
  - The spec is its first commit (`ab67bb1`), and this plan is its second.
  - The spec's "Amendments after approval" A1 to A4 are approved together with this plan.
  - The plan stays `Status: draft` until the owner's assistant has read both on the branch. Then the chunk owner approves it.
- **Database:**
  - One migration, `0019`, made in Task 2 only. Generate it with `pnpm --filter @community-hub/db exec drizzle-kit generate`.
  - Tables, policies, checks, the partial unique index and the foreign keys are declared in `modules/core/access/db/schema.ts` and generated. Only FORCE RLS, the `REVOKE`/`GRANT` lines, the backfill `DO` block and the recovery note are hand-appended, as `0018_wise_starfox.sql:15-20` does.
  - A second `generate` must print no changes, because `packages/db/src/generate.test.ts` asserts that in CI and cannot run on Windows.
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
  - Every other access error stays an empty body, and every 500 and 503 is empty.
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
- **Role rules at create and accept** are exactly a grant's:
  - `access.roles.manage`;
  - `assertMayGrantRole`'s organisation rank;
  - every permission of the role's bundle, or of the custom role, held by the inviter.
- **The address** is normalised, encrypted with the identity key, and blind-indexed with the same HMAC and label as `identity.users.email`, all inside `core/identity`. Create never reads `identity.users`.
- **The token** is `v1.` + 107 base64url characters, the canonical encoding of 80 bytes: org id ‖ community id ‖ invitation id (16 bytes each) ‖ 32 random bytes.
  - It is parsed strictly, and only its SHA-256 is stored.
  - It travels in the URL fragment of `<ADMIN_ORIGIN>/#invite=…`.
- **Accept order:**
  - a. Parse the token.
  - b. Prove it in a read-only transaction.
  - c. `findCommunityById`.
  - d. `assertWritable`.
  - e. Run the write transaction: select `FOR UPDATE`, compare the hash, check pending and unexpired, compare blind indexes, then pure checks. Then, inside a savepoint: the membership, the internal grant and link writes, closing the row, and `access.invitation.accepted`.
- **Accept errors:** `invitation_invalid` 404 (no audit), `wrong_address` 403 (nothing written), `invitation_void` 409 (void, the address, contact and custom role cleared, `access.invitation.voided`).
- **Grants and links:** permission check first (403), then the membership check (422 `user_not_member`, plus `access.permission.denied` with purpose `access.user.not_member`).
- **Users list directory:** members with a grant or link in this community or an organisation grant, plus members whose accepted invitation was to this community. Emails are decrypted only for those, minus minor-linked and unreadable-linked users (PR 85, A1).
- **Retention (spec A3):**
  - Revoked and void rows closed more than 30 days ago, and pending rows expired more than 30 days ago, are deleted in create and list.
  - Accepted rows are kept, with ids only.
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
- **A database weakening** is an edit to `packages/db/drizzle/0019_*.sql`. It is either appended after a `--> statement-breakpoint` or made in place, as pins 3 to 6 edit the `DO` block or the index line. It is never typed into a running database, because every vitest run recreates it (`packages/db/test/global-setup.ts`).
  - Before the weakening, copy the file to `.superpowers/sdd/0019.backup.sql` and record its SHA-256 and `git status --short packages/db/drizzle`.
  - Restore by copying the backup back, then confirm both match. Do not use `git checkout -- packages/db/drizzle` before Task 2 is committed: it reverts the journal and snapshot and leaves the untracked `0019` behind.
- **Concurrency pins (20, 34 and 37)** use database locks the test holds. The test polls `pg_stat_activity` and `pg_locks` in a bounded loop until both backends wait or both calls have settled; the precedent is `modules/core/identity/infrastructure/session.integration.test.ts:264`. It then asserts the outcome. A weakened tree therefore fails on the assertion, not on a timeout. There are no timers or sleeps.

| #   | Setting                                                                    | Weakening                                                                                                                                                                                                                                                                                 | Pinning test                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Task |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | RLS and FORCE RLS on both tables                                           | append (a) `ALTER TABLE app.organisation_members NO FORCE ROW LEVEL SECURITY;` and, separately, the same for `app.invitations`; (b) `DISABLE ROW LEVEL SECURITY` on each; (c) drop each policy                                                                                            | `modules/core/access/infrastructure/privileges.integration.test.ts`: both tables have `relrowsecurity` and `relforcerowsecurity` (fails on a). With two organisations and two communities, as the `app` role, an org B membership is invisible under org A and a community 2 invitation is invisible under community 1 (fails on b and c; `NO FORCE` affects only the table owner)                                                                                        | 2    |
| 2   | Column privileges                                                          | append (a) `GRANT DELETE ON app.organisation_members TO app;` (b) `GRANT UPDATE (org_id, community_id, invited_by, role_key) ON app.invitations TO app;`                                                                                                                                  | the same file: `app` has INSERT and SELECT but not UPDATE, DELETE or TRUNCATE on `organisation_members`. On `invitations` it has UPDATE only on the eleven named columns (A2 adds `custom_role_id`), plus DELETE, and no TRUNCATE                                                                                                                                                                                                                                         | 2    |
| 3   | The backfill sets the tenant scope per community                           | remove the two `set_config` calls inside the loop                                                                                                                                                                                                                                         | `packages/db/test/membership-backfill.integration.test.ts`: on its own database (`freshDatabase`), apply migrations to `0018` from a temporary copy, seed grants and links in org A (communities 1 and 2) and org B, apply the full folder, and assert the exact membership set                                                                                                                                                                                           | 2    |
| 4   | The backfill resets the scope (spec A1)                                    | remove the reset after the loop                                                                                                                                                                                                                                                           | the temporary folder also holds `0020_probe.sql` (journal `idx 20`). It raises `scope leaked` if `app.org_id` or `app.community_id` is non-empty. The full apply must succeed                                                                                                                                                                                                                                                                                             | 2    |
| 5   | The backfill takes only users that exist in `identity.users`               | remove the `identity.users` join                                                                                                                                                                                                                                                          | the same test seeds a grant whose user id has no identity row, and that id gets no membership                                                                                                                                                                                                                                                                                                                                                                             | 2    |
| 6   | Table shape: unique keys start with `org_id`, no cascade, policy symmetry  | edit the `CREATE UNIQUE INDEX` line in `0019_*.sql` in place to `(email_bidx, org_id, community_id)`. `schema.test.ts` reads the SQL, not `schema.ts`. `schema.ts` and the SQL are compared only by `generate.test.ts` in CI, and the Task 2 report says so                               | `modules/core/access/db/schema.test.ts`, a `0019` case: both tables created; `org_isolation` and `community_isolation` each with `USING` equal to `WITH CHECK`; every unique target starts with `org_id`; no `ON DELETE CASCADE`; FORCE on both. The suite's one-file-per-table rule still holds, because the backfill names `app.user_links` unquoted                                                                                                                    | 2    |
| 7   | `grantRole` refuses a non-member                                           | remove the membership check from `grantRole`                                                                                                                                                                                                                                              | `grants.integration.test.ts`: three ids, granted by an owner of org A: a member of org B, a random uuid, and a real user with no membership. Each throws `not_member` with no grant row, and one `access.permission.denied` row has purpose `access.user.not_member`                                                                                                                                                                                                      | 3    |
| 8   | `linkUser` refuses a non-member                                            | remove the membership check from `linkUser`                                                                                                                                                                                                                                               | the same three cases for `linkUser`: `not_member`, and no link row                                                                                                                                                                                                                                                                                                                                                                                                        | 3    |
| 9   | `grantCustomRole` refuses a non-member                                     | remove the membership check from the custom-role path (`grants.ts:346`, reached from `:422-424`)                                                                                                                                                                                          | the same three cases with a custom role                                                                                                                                                                                                                                                                                                                                                                                                                                   | 3    |
| 10  | The permission check runs before the membership check                      | move the membership check above the permission check: (a) in `grantRole`, (b) in `linkUser`                                                                                                                                                                                               | a caller without `access.roles.manage` (a) or `access.users.manage` (b) acting on a non-member gets `forbidden`, not `not_member`                                                                                                                                                                                                                                                                                                                                         | 3    |
| 11  | `bootstrapOwner` makes the owner a member                                  | remove the membership insert from `bootstrapOwner`                                                                                                                                                                                                                                        | after `bootstrapOwner`, one `provision` membership exists for the owner, and granting that owner a second role succeeds                                                                                                                                                                                                                                                                                                                                                   | 3    |
| 12  | One identical refusal over HTTP                                            | put the user id, or a distinct code for a random id, in the 422 body                                                                                                                                                                                                                      | Task 3, `access-routes.test.ts`: `not_member` maps to 422 with the body exactly `{"error":"user_not_member"}`. Task 8: three byte-identical HTTP bodies for the three ids                                                                                                                                                                                                                                                                                                 | 3, 8 |
| 13  | The test helper never ships                                                | (a) add `"./testing"` to `modules/core/access/package.json` `exports`; (b) remove `infrastructure/testing.ts` from the tsconfig `exclude`                                                                                                                                                 | new `modules/core/access/infrastructure/testing-absence.test.ts`: the exports map is exactly `["."]`, and after a build neither `dist/infrastructure/testing.js` nor `testing.d.ts` exists (mirrors `packages/crypto/test/dist-absence.test.ts`). The lint rule bans importing `@community-hub/access/testing` from non-test source                                                                                                                                       | 3    |
| 14  | The organisation lock is shared                                            | give invitations a different lock key                                                                                                                                                                                                                                                     | Task 3: `membership.test.ts` finds one `pg_advisory_xact_lock` site, in `membership.ts`, used by `grants.ts`. Task 5: the scan includes `invitations.ts`, and pin 20 takes the lock through the exported `lockOrganisation`, so a different key fails it behaviourally                                                                                                                                                                                                    | 3, 5 |
| 15  | The AAD binds each invitation's own id                                     | open every row with the first row's id                                                                                                                                                                                                                                                    | `invitation-email.integration.test.ts`: two rows opened in reverse order return the right address each, and a ciphertext copied to another invitation id fails to open                                                                                                                                                                                                                                                                                                    | 4    |
| 16  | The invitation blind index equals the user blind index                     | use the label `app.invitations.email` for the index                                                                                                                                                                                                                                       | sealing `" Alex@Example.Test "` gives an index equal to `identity.users.email_bidx` for a user created with `alex@example.test`, and `userEmailBlindIndex` returns that same value                                                                                                                                                                                                                                                                                        | 4    |
| 17  | `openInvitationEmails` is capped and reads no `app` table                  | (a) raise the cap to 1,000; (b) add a select of `app.invitations`                                                                                                                                                                                                                         | (a) 101 rows throw before any decrypt. (b) A query spy sees exactly one query, the `identity.identity_keys` select, and a source scan of `invitation-email.ts` finds no `app.` reference                                                                                                                                                                                                                                                                                  | 4    |
| 18  | Seal and open never create a key (spec A4)                                 | call `deriveIdentityEmailKeys` or `ensureIdentityKey`                                                                                                                                                                                                                                     | with only `identity.identity_keys` deleted, seal and open throw `identity key is missing` and no key row is created                                                                                                                                                                                                                                                                                                                                                       | 4    |
| 19  | `findCommunityById` checks the organisation                                | drop the `organisation_id` condition                                                                                                                                                                                                                                                      | `implicit-organisation.integration.test.ts`: a community id paired with another organisation's id returns null                                                                                                                                                                                                                                                                                                                                                            | 4    |
| 20  | Caps are checked under the organisation lock                               | remove the `lockOrganisation` call from create                                                                                                                                                                                                                                            | `invitations.integration.test.ts`: 99 pending rows seeded with `created_at` more than an hour ago. The test takes `lockOrganisation` itself, starts two creates, polls until both wait or both settle, then releases. Exactly one succeeds and one gets `too_many`                                                                                                                                                                                                        | 5    |
| 21  | Uniqueness and caps are per community                                      | append to `0019`: drop the partial index and recreate it on `(org_id, email_bidx) WHERE status = 'pending'`                                                                                                                                                                               | two communities in one organisation: a pending and an expired pending invitation for an address in community 2 do not change create in community 1, which succeeds. 100 pending in community 2 do not trigger `too_many` in community 1                                                                                                                                                                                                                                   | 5    |
| 22  | An expired pending row is voided before the insert                         | remove the expired-row void                                                                                                                                                                                                                                                               | create, expire (`expires_at` moved into the past), create again: the second create succeeds, the first row is `void` with its address cleared, and one `access.invitation.voided` row is written                                                                                                                                                                                                                                                                          | 5    |
| 23  | Leaving `pending` clears the address, blind index, contact and custom role | remove the clearing from revoke (Task 5), accept and void (Task 6)                                                                                                                                                                                                                        | after revoke, accept and void, each row has null `email`, `email_bidx`, `person_id` and `custom_role_id`, and `closed_at` set                                                                                                                                                                                                                                                                                                                                             | 5, 6 |
| 24  | Resend and revoke answer one not-found                                     | return a distinct code for a non-pending row                                                                                                                                                                                                                                              | an unknown id, community 2's id, an accepted row, a revoked row, and (resend) an expired row each give `invitation_not_found` and write no audit row. Revoking an expired pending row succeeds, clears the address and writes `access.invitation.revoked`                                                                                                                                                                                                                 | 5    |
| 25  | The minor refusal at create                                                | remove the minor check from create                                                                                                                                                                                                                                                        | a minor contact gives `person_minor` and no row                                                                                                                                                                                                                                                                                                                                                                                                                           | 5    |
| 26  | Bundle subset at create and accept                                         | drop the bundle loop from `roleGrantAllowed`                                                                                                                                                                                                                                              | the inviter's custom role holds `access.roles.manage`, `access.users.manage` and `access.users.view`, but not `people.restricted.read`. (i) Task 5: inviting with `community_admin` gives `forbidden` and no row. (ii) Task 6: an invitation created while the inviter held the full set, accepted after one bundle permission was removed, gives `invitation_void` and no grant                                                                                          | 5, 6 |
| 26b | Custom-role permission subset at create and accept                         | skip the `custom_role_permissions` loop in `roleGrantAllowed`                                                                                                                                                                                                                             | the inviter holds a custom role with `access.roles.manage`, `access.users.manage` and `access.users.view`. (i) Task 5: inviting with a custom role that also carries `people.restricted.read` gives `forbidden` and no row. (ii) Task 6: a custom role changed after the invite to carry that extra permission gives `invitation_void` at accept, with no grant                                                                                                           | 5, 6 |
| 27  | Cap values                                                                 | (a) raise 20 to 21; (b) raise 100 to 101; (c) raise the resend cap to 4; (d) never reset the resend count                                                                                                                                                                                 | the 21st create within an hour gives `too_many`. The 101st pending gives `too_many` when the creates are older than an hour. The 4th resend within 24 hours gives `too_many`. With `last_sent_at` moved 25 hours back, a resend succeeds and the count resets                                                                                                                                                                                                             | 5    |
| 28  | Retention purge (spec A3)                                                  | (a) remove the purge; (b) include accepted rows                                                                                                                                                                                                                                           | list deletes a revoked row closed 31 days ago, a void row closed 31 days ago and a pending row expired 31 days ago. It keeps rows at 29 days, an unexpired pending row, and an accepted row closed 31 days ago                                                                                                                                                                                                                                                            | 5    |
| 29  | Strict, canonical token parsing                                            | accept any decoded length of 80 bytes or more, and decode without the alphabet check                                                                                                                                                                                                      | `invitation-token.test.ts`: a wrong prefix, 106 and 108 characters, a `!` inserted, a non-canonical last character, and a nil uuid each parse to `invalid`. The token must match `^v1\.[A-Za-z0-9_-]{107}$`, and re-encoding the decoded bytes must equal the input                                                                                                                                                                                                       | 5    |
| 30  | A custom role named by a pending invitation cannot be deleted (spec A2)    | remove the pending-invitation count from `deleteCustomRole`                                                                                                                                                                                                                               | `custom-roles.integration.test.ts`: deleting a role named by a pending invitation gives `role_in_use`, never a 500. A role named only by a revoked invitation deletes                                                                                                                                                                                                                                                                                                     | 5    |
| 31  | The full hash is compared                                                  | compare only the first 8 bytes: (a) in `proveInvitation`, (b) in `acceptInvitation`                                                                                                                                                                                                       | `invitation-accept.integration.test.ts`: the test sets `token_hash` (which `app` may update) to a value whose first 8 bytes equal `SHA-256(secret)` and whose rest differs. Accepting with the original token gives `invitation_invalid` and writes nothing, through `proveInvitation` (a) and through `acceptInvitation` called directly (b)                                                                                                                             | 6    |
| 32  | Pending and unexpired at accept                                            | (a) drop the expiry check; (b) drop the status check                                                                                                                                                                                                                                      | (a) an expired invitation gives `invitation_invalid`; (b) a revoked one gives `invitation_invalid`. Both write nothing                                                                                                                                                                                                                                                                                                                                                    | 6    |
| 33  | The blind-index match at accept                                            | skip the comparison                                                                                                                                                                                                                                                                       | a second user who holds the token gets `wrong_address`. There is no membership, no grant, no link, and the invitation stays pending                                                                                                                                                                                                                                                                                                                                       | 6    |
| 34  | `FOR UPDATE` serialises accepts                                            | remove `FOR UPDATE`                                                                                                                                                                                                                                                                       | the test locks the invitation row `FOR UPDATE` in its own transaction, starts two accepts by the invited user, polls until both wait or both settle, then commits. Exactly one `access.invitation.accepted` row exists, and the other call gives `invitation_invalid`                                                                                                                                                                                                     | 6    |
| 35  | The inviter re-check and the internal writers                              | (a) drop the inviter-permission re-check; (b) call the public `grantRole` in step 7                                                                                                                                                                                                       | (a) revoke the inviter's role, then accept: `invitation_void`, no grant, no `access.permission.denied` row. (b) A member who already holds the invited role accepts: 200, one grant, invitation `accepted` (the public writer would throw `duplicate_grant` and void). A user whose existing link is to a person now a minor gets `invitation_void`, not a 500                                                                                                            | 6    |
| 36  | The minor refusal at accept                                                | remove the minor check from the step 5 checks                                                                                                                                                                                                                                             | a contact made a minor after the invite gives `invitation_void`, and no link                                                                                                                                                                                                                                                                                                                                                                                              | 6    |
| 37  | A step 7 failure rolls back the membership and grant                       | run steps 6 to 9 outside the savepoint                                                                                                                                                                                                                                                    | the test holds a transaction that has inserted a `user_links` row for the contact. It starts accept, polls until accept waits on that row's unique key, then commits. Accept gives `invitation_void`, with no membership row, no grant and one `access.invitation.voided`                                                                                                                                                                                                 | 6    |
| 38  | No audit row on `invitation_invalid`                                       | write `access.permission.denied` on an invalid token                                                                                                                                                                                                                                      | a forged token naming org A writes no audit row in org A                                                                                                                                                                                                                                                                                                                                                                                                                  | 6    |
| 39  | Create never reads `identity.users`                                        | call `findUserByEmail` in the create route                                                                                                                                                                                                                                                | `invitation-routes.test.ts`, with `vi.mock("@community-hub/identity")` spying every export. During create, for an address with an account and one without, no identity export that reads `identity.users` is called, and neither is `userEmailBlindIndex`. `readSession` (the session) and `sealInvitationEmail` are expected. The two 201 bodies have the same shape. Task 5 keeps a type-level assertion that `createInvitation`'s dependency object is `{ seal }` only | 7    |
| 40  | Accept proves the token before tenancy and billing                         | call `findCommunityById` (a) or `assertWritable` (b) before `proveInvitation`                                                                                                                                                                                                             | for a forged token, the tenancy and billing spies record zero calls and the answer is 404 `invitation_invalid`                                                                                                                                                                                                                                                                                                                                                            | 7    |
| 41  | Route permissions, and 403 before the mail 503                             | (a) create with a role without `access.roles.manage`; (b) create with a contact without `people.view`; (c) list with `access.users.view` only; (d) resend needs `access.roles.manage` instead of `access.users.manage`; (e) move the mail check before permissions, or apply it to revoke | (a), (b) and (c) give 403 with no repository call. (d): a caller with only `access.users.manage` resends and revokes (204), and a caller with only `access.roles.manage` gets 403. (e): with mail unset, revoke succeeds (204), and a caller without rights gets 403, not 503                                                                                                                                                                                             | 7    |
| 42  | Bodies, `no-store` and logs                                                | (a) put `error.message` in a 500 body; (b) drop `no-store` from the invitations list; (c) log the token or the address                                                                                                                                                                    | a forced failure carrying a fixture address and token gives an empty 500. Every list response has `cache-control: no-store`. No log field contains the address or the token, and every field value is a primitive. `ses-invitation-mail.test.ts`: an SES error carrying the address is never logged                                                                                                                                                                       | 7    |
| 43  | Users list: members only, and the community rule                           | (a) drop the membership condition; (b) list every member of the organisation                                                                                                                                                                                                              | Task 7 unit, against a mocked directory. Task 8, `users-list.integration.test.ts`: (a) a user granted by raw SQL with no membership is absent, and the `readUserEmails` spy never receives that id. (b) A member granted only in community 2 is absent from community 1's list and never decrypted. A member whose accepted invitation was to community 1, with no grant, is listed there                                                                                 | 7, 8 |
| 44  | `assertWritable` on accept                                                 | remove it                                                                                                                                                                                                                                                                                 | `invitations.integration.test.ts` (api): in a read-only organisation, a valid token gets 402 and nothing is written                                                                                                                                                                                                                                                                                                                                                       | 8    |
| 45  | The admin's stale-response guards on the new fetches                       | remove each guard in turn (after `post`, after `json()`, in the `catch`)                                                                                                                                                                                                                  | `invitations.test.tsx` and `users-roles.test.tsx`: one test per guard, with ids present in both communities                                                                                                                                                                                                                                                                                                                                                               | 9    |
| 46  | The pickers never offer a raw id input                                     | restore the free-text User input                                                                                                                                                                                                                                                          | `users-roles.test.tsx`: the grant and link forms have no text input named User, and the picker lists exactly the users list rows                                                                                                                                                                                                                                                                                                                                          | 9    |
| 47  | The fragment is stripped before the router, and the token never stored     | (a) strip the fragment in `shell.tsx` after the router is built; (b) put the token in `sessionStorage`                                                                                                                                                                                    | `accept-invitation.test.tsx`: after load, `location.hash` and `router.state.location.hash` are both empty, and spies on `localStorage.setItem` and `sessionStorage.setItem` never receive the token                                                                                                                                                                                                                                                                       | 10   |

**Reviewed by diff, not pinned:**

- the accept transaction's scope is built only from the parsed token's ids;
- the hash comparison uses `crypto.timingSafeEqual`.

The Task 6 review checks both by reading the diff. A source scan in `invitations.test.ts` also asserts that `timingSafeEqual` is called on the accept path.

## Rollback

- Revert the pull request's merge commit. Grants and links then accept any user id again (O1 reopens), and the users list returns to PR 85's behaviour.
- Migration `0019` is expand-only. Its two tables stay after a revert and are unused. A later contract PR may drop them.
- The backfill only inserts membership rows. Rows already written stay, and they grant nothing on their own.
- Audit rows stay, because the audit log is append-only, and they hold ids only.

## Stop and ask (AGENTS.md §12)

The implementer stops and reports, without improvising, when:

- the plan is wrong or ambiguous, or the code does not match a pointer in it;
- a second migration, a change to an accepted `0019`, a grant, a dependency, a workspace package, a Dockerfile, a workflow or a Terraform change looks necessary;
- a production seam would be needed only so a test can run;
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
  - `acceptInvitationBody` `{ token }`, a string of at most 120 characters, parsed later;
  - `acceptInvitationResponse` `{ communitySlug }`;
  - `accessErrorBody` `{ error }` with the code enum.
- `email` is a string of at most 254 characters that passes Zod's `.email()` shape check, so most bad input is refused before a transaction opens. Normalisation, and the final check, happen in identity.
- These names are registered:
  - actions `access.invitation.created`, `.resent`, `.revoked`, `.accepted`, `.voided` and `access.invitations.listed`;
  - each action also as a purpose (the `public/index.ts:3-24` pattern);
  - purpose `access.user.not_member`, and the purposes the new routes deny under.
- `AccessErrorCode` gains `not_member`, `already_invited`, `invitation_invalid`, `wrong_address`, `invitation_void`, `invitation_not_found`, `person_linked`, `person_minor`, `person_not_found` and `role_not_found`, where absent. For the invitation contact, the repository throws `person_minor` and `person_not_found`, not the existing `minor_forbidden` and `not_found`. The RED for the union is `pnpm typecheck`.

**Rule it must not break:** existing access schemas are unchanged.

**Pins run:** none.

### Task 2: Migration `0019`, the schema and the backfill

**Commit:** `feat(access): add organisation members and invitations tables`

**Files:**

- `modules/core/access/db/schema.ts`: `accessTables` gains `{ encryptedColumn, blindIndexColumn }`, and the two tables are declared with:
  - their policies;
  - checks for status values, source values, built-in `role_key`, at most one role, a role or contact while pending, `(email is null) = (email_bidx is null)`, `email_bidx is null or octet_length(email_bidx) = 32`, and `status <> 'pending' or email_bidx is not null`;
  - the partial unique index `(org_id, community_id, email_bidx) WHERE status = 'pending'`;
  - the foreign keys `(org_id, person_id)` to persons and `(org_id, custom_role_id)` to custom roles, both `on delete restrict`;
- `modules/core/access/db/schema.test.ts`: the `0019` case (pin 6);
- `packages/db/drizzle.schema.ts:71`: passes `{ encryptedColumn, blindIndexColumn }` as `:57` does for people, and exports `organisationMembers` and `invitations` as `:73-77` export the others;
- `packages/db/drizzle/0019_*.sql`, its snapshot and journal entry;
- `modules/core/access/module.manifest.ts` and `domain/manifest.test.ts`;
- `modules/core/access/infrastructure/privileges.integration.test.ts` (pins 1 and 2);
- new `packages/db/test/membership-backfill.integration.test.ts` (pins 3 to 5). It follows `packages/db/test/migrate.integration.test.ts:93-125` and uses `fixtures/database-fixture.ts` `freshDatabase`.

**Hand-appended to `0019`:**

- `ENABLE` and `FORCE ROW LEVEL SECURITY` on both tables, if not generated;
- `REVOKE UPDATE, DELETE, TRUNCATE ON app.organisation_members FROM app;`
- `REVOKE UPDATE, TRUNCATE ON app.invitations FROM app;`, then `GRANT UPDATE (status, email, email_bidx, token_hash, expires_at, resend_count, last_sent_at, accepted_user_id, person_id, custom_role_id, closed_at) ON app.invitations TO app;`
- the backfill `DO` block:
  - a loop over `platform.communities`, with `set_config('app.org_id', …, true)` and `set_config('app.community_id', …, true)`;
  - an insert of `backfill` memberships from the three grant and link tables, joined to `identity.users`, with `ON CONFLICT DO NOTHING`;
  - a reset of both settings to `''` after the loop;
  - unquoted table names (`app.user_links`), so `schema.test.ts`'s one-file-per-table search still finds one file;
- a recovery note in an SQL comment: the tables are new, and a later contract PR may drop them.

**Test first:**

- The manifest test lists every new column with its class from the spec. `email` and `email_bidx` are `confidential-blind`, and every other column is `internal`.
- Pins 1 to 6.
- The backfill test:
  - copies `packages/db/drizzle` into a `mkdtemp` folder with journal entries `idx` 0 to 18;
  - applies it with `applyMigrations({ sql, folder, table: "__drizzle_migrations" })`, imported relatively from `../src/migrate.js`;
  - seeds as `migrator` with `set_config(…, true)`, one transaction per community;
  - copies the full folder plus `0020_probe.sql` (journal `idx 20`, with a `when` later than `0019`'s, using `coalesce(current_setting(…, true), '')`) and applies it;
  - sets an explicit long timeout. A timeout on this Windows machine is reported as a timeout, never called green, and the test must then pass in CI;
  - drops its database in `finally`.
- Report the membership count and the number of users holding grants in more than one organisation after the backfill on the seeded data. The PR records both, with the note that every real environment's database is empty today.

**Rule it must not break:** no change to existing tables, policies or privileges. A second `generate` prints no changes.

**Pins run:** 1, 2, 3, 4, 5, 6.

### Task 3: Membership enforcement, the owner's membership and the test helper

**Commit:** `feat(access): accept grants and links for organisation members only`

**Files:**

- `modules/core/access/infrastructure/grants.ts`;
- new `modules/core/access/infrastructure/membership.ts`, holding `lockOrganisation` (moved out of `grants.ts:170-176`, same key), `isMember` and `insertMembership`, and `membership.test.ts`;
- new `modules/core/access/infrastructure/testing.ts` exporting `addMember(tx, userId)`:
  - It is **not** in `package.json` `exports`. It is added to `exclude` in `modules/core/access/tsconfig.json`, so `dist` never holds it. `tsconfig.test.json` already includes it through `infrastructure/**/*.ts`, so typed lint sees it. A file at the module root would be in no tsconfig, and lint would fail.
  - The alias `@community-hub/access/testing` → that file is added to `resolve.alias` and `test.alias` in `modules/core/access/vitest.config.ts`, `apps/api/vitest.config.ts` and `apps/api/vitest.integration.config.ts`, and to `paths` in both packages' `tsconfig.test.json`. This is the `@community-hub/crypto/testing` pattern.
  - It is treated as test code: it is added to both test-file lists in `eslint.config.js` (`:22-27` and `:116-121`) and to `isTestFile` in `tooling/eslint-plugin-community-hub/lib/ast.js:164-170`.
- new `modules/core/access/infrastructure/testing-absence.test.ts` (pin 13);
- the ESLint rule `@community-hub/no-crypto-testing-import` (`tooling/eslint-plugin-community-hub`) also bans `@community-hub/access/testing` from non-test source. One fail fixture and one pass fixture are added to `tooling/checks/encrypted-column/selftest.ts`;
- `apps/api/src/access-routes.ts`: `statusFor` (`:209-227`) maps `not_member` to 422 with JSON `{ error: "user_not_member" }`. `apps/api/src/access-routes.test.ts` gets the case;
- the tests that grant or link a non-owner subject call `addMember` first, with no assertion weakened:
  - about 61 `grantRole(`/`linkUser(` call sites in 11 test files under `modules/core/access` and `apps/api/src`;
  - the HTTP grant and link posts in `apps/api/src/access-flow.integration.test.ts`, `billing-guard.integration.test.ts` and `users-list.integration.test.ts` (about 28), including the `newId()` subjects in the billing-guard fixture map and its pin 15 test;
  - the raw-SQL grant fixtures in the `users-list`, `grants`, `holds-any-grant` and `holds-permission` integration tests, which insert a membership row.

**Behaviour:**

- `grantRole`, `grantCustomRole` and `linkUser` call `isMember` after their permission checks and before the insert, in the same transaction.
  - On a miss, they append `access.permission.denied` with purpose `access.user.not_member`, using the same `appendAuditEvent` call `deny()` makes.
  - They then throw `AccessError("not_member")`. `deny()` itself always throws `forbidden` (`grants.ts:135-148`), so it is not used for this.
- `bootstrapOwner` inserts the `provision` membership under its lock, before its grants.

**Test first:** pins 7 to 13 and the Task 3 half of pin 14. The existing suites stay green with `addMember` added. The review compares each changed test's assertions line by line.

**Rule it must not break:** revoke and unlink are unchanged, and a member's grant still works exactly as before.

**Pins run:** 7, 8, 9, 10, 11, 12 (mapping half), 13, 14 (Task 3 half).

### Task 4: Identity and tenancy exports

**Commit:** `feat(identity): seal and open invitation addresses`

**Files:**

- new `modules/core/identity/infrastructure/invitation-email.ts`, with `invitation-email.test.ts` and `invitation-email.integration.test.ts`;
- `modules/core/identity/public/index.ts`;
- `modules/core/tenancy/infrastructure/implicit-organisation.ts` (`findCommunityById` beside `findCommunityBySlug` at `:78-101`), its integration test, and `modules/core/tenancy/public/index.ts`.

**Behaviour:**

- **Key loading.** `sealInvitationEmail` and `openInvitationEmails` load the identity key row read-only, as `readUserEmails` does (`user-emails.ts:43-52`). They throw `identity key is missing` when it is absent. They never call `deriveIdentityEmailKeys` or `ensureIdentityKey` (spec A4).
- `sealInvitationEmail(sql, kms, keyArn, { invitationId, address })` normalises with `normaliseEmail` (`domain/email.ts:6`). It returns plain `Uint8Array` `{ ciphertext, blindIndex }`.
  - The index uses `emailBlindIndex` unchanged (label `identity.users.email`).
  - The ciphertext uses AAD `{ tag: "chub/field-identity/v1", label: "app.invitations.email", rowId: uuidToBytes(invitationId), region: "au" }`. The row id is the 16 bytes of the invitation id, as in `user-emails.ts:42-52` and `email-lookup.ts:120-123`.
- `openInvitationEmails(sql, kms, keyArn, rows: { id, ciphertext }[])` decrypts with the same AAD and returns `Map<id, string>`. It is capped at 100, and it makes no query other than the key read.
- `userEmailBlindIndex(sql, userId)` reads `identity.users.email_bidx` for one user and returns plain bytes, or null.
- `findCommunityById(sql, { organisationId, communityId })` returns `{ id, organisationId, slug }`, or null when either id does not match.

**Test first:** pins 15 to 19.

**Rule it must not break:** `readUserEmails`, `findUserByEmail` and sign-in are unchanged, and the identity role gains no privilege.

**Pins run:** 15, 16, 17, 18, 19.

### Task 5: Invitations repository: create, list, resend, revoke

**Commit:** `feat(access): create, list, resend and revoke invitations`

**Files:**

- new `modules/core/access/infrastructure/invitations.ts`, with `invitations.test.ts` and `invitations.integration.test.ts`;
- new `modules/core/access/domain/invitation-token.ts` (token build and parse, pure) and `invitation-token.test.ts`;
- new `modules/core/access/domain/invitation-mail.ts` (the `InvitationMail` port and `rejectingInvitationMail`);
- `modules/core/access/infrastructure/grants.ts`: a pure `roleGrantAllowed(actor, role)` factored from `:79-94`, `:352-377` and `:428-444`. It returns a boolean and never calls `deny()`. `grantRole` and `grantCustomRole` use it with unchanged behaviour;
- `modules/core/access/infrastructure/custom-roles.ts` and `custom-roles.integration.test.ts`: `deleteCustomRole` also counts pending invitations naming the role (spec A2);
- `membership.test.ts` (the pin 14 scan extended to `invitations.ts`);
- `modules/core/access/public/index.ts`.

**Behaviour** (spec, Inviting and Pending invitations). Every function runs in a community-scoped `AppTransaction` that the caller opens. The seal function is passed in as the only dependency, so `core/access` never imports `core/identity` (`domain/boundaries.test.ts:25-33`). That scan covers every `.ts` file in the module, tests and helpers included. So the Task 5 and 6 tests use a stub `seal` and stub blind indexes, and no file in the module, not even a comment, names `@community-hub/identity` or `@community-hub/tenancy`.

- **The token.** `invitation-token.ts` builds the token from the three ids and 32 random bytes. It parses only an input that matches `^v1\.[A-Za-z0-9_-]{107}$` and whose decoded bytes re-encode to the same text.
- **`createInvitation`:**
  1. take `lockOrganisation`;
  2. purge old rows (spec A3);
  3. void an expired pending duplicate;
  4. check the duplicate and the caps;
  5. check `roleGrantAllowed` and, for a custom role, that it belongs to this community;
  6. check the contact (adult, readable, unlinked);
  7. insert. A unique violation on the partial index maps to `already_invited`; with the lock it should be unreachable;
  8. write `access.invitation.created`.

  A custom role is selected `FOR SHARE` in step 5, so a concurrent delete cannot cause a foreign-key 500. Create also re-checks `access.users.manage`, plus `access.roles.manage` with a role and `people.view` with a contact, inside the repository, so a second caller cannot skip them.

  It returns `{ invitationId, token }`. The token is never stored.

- **`listInvitations`** purges old rows. It returns at most 100 unexpired pending rows with their ciphertexts, for the route to open, and writes `access.invitations.listed`.
- **`resendInvitation` and `revokeInvitation`** select `FOR UPDATE` where pending (and, for resend, unexpired), and return `not_found` for everything else. Closing a row clears `email`, `email_bidx`, `person_id` and `custom_role_id`, and sets `closed_at`.
- **Mail-failure paths:** `deleteInvitationAfterMailFailure` and `voidInvitationAfterMailFailure`.

**Test first:** pins 20 to 30, and the Task 5 halves of pins 14, 23 and 26. Two communities and two organisations appear in the fixtures.

**Rule it must not break:** grants and links behave as after Task 3. The address and token appear in no audit row: each test scans the audit rows for the fixture address and the token text.

**Pins run:** 14, 20, 21, 22, 23 (revoke), 24, 25, 26 (i), 26b (i), 27, 28, 29, 30.

### Task 6: Invitations repository: accept

**Commit:** `feat(access): accept an invitation`

**Files:**

- `modules/core/access/infrastructure/invitations.ts`, gaining `proveInvitation` and `acceptInvitation`;
- `grants.ts`: internal grant and link writers that skip the permission check and never call `deny()`. The public `grantRole`, `grantCustomRole` and `linkUser` keep their checks and call the same writers;
- new `modules/core/access/infrastructure/invitation-accept.integration.test.ts`.

**Behaviour** (spec, Accepting):

- `proveInvitation(tx, token)` is read-only: select by id, compare the hash, check pending and unexpired. It returns `ok` or `invalid`.
- `acceptInvitation(tx, { token, userId, userBlindIndex })` runs steps 1 to 9.
  - The hash comparison is `crypto.timingSafeEqual` on equal-length buffers.
  - Step 5 re-checks:
    - the inviter's `access.users.manage`;
    - with a role, `access.roles.manage` and `roleGrantAllowed`;
    - with a contact, `people.view`, and that the contact is an adult, readable and unlinked;
    - that the user has no link to a different person in this community, and that any existing link is to an adult.
  - Steps 6 to 9 run inside `tx.savepoint(…)`. An `AccessError` from the internal writers rolls back the savepoint. The void is then written outside it, and the transaction commits.
  - Every statement that can fail runs on the savepoint's own handle, never on the outer `tx`. postgres.js records an error from a query on the outer transaction object and rethrows it at commit (`packages/db/src/audit-append.ts:73-76`), which would turn a void into a 500.
  - On `invitation_invalid` it writes nothing, audit included.

**Test first:** pins 31 to 38, and the Task 6 halves of pins 23 and 26. Plus:

- an existing member accepting adds only the role;
- a contact linked to another user since the invite gives `invitation_void`.

**Rule it must not break:** `grantRole`, `grantCustomRole` and `linkUser` behave exactly as after Task 3. Their existing tests pass unchanged.

**Pins run:** 23 (accept, void), 26 (ii), 26b (ii), 31, 32, 33, 34, 35, 36, 37, 38.

### Task 7: Mail adapter and the five routes

**Commit:** `feat(api): invitation routes and mail`

**Files:**

- new `apps/api/src/mail/ses-invitation-mail.ts` and `ses-invitation-mail.test.ts`, beside `ses-otp-mail.ts`. Same client, sender, configuration set and 5-second deadline;
- `apps/api/src/index.ts`: `bindServices` wires `InvitationMail` under the `OtpMail` condition (`:203-216`). Otherwise `rejectingInvitationMail`;
- new `apps/api/src/invitation-routes.ts` and `invitation-routes.test.ts`, registered in `productionRoutes` (`index.ts:366`);
- `apps/api/src/index.test.ts`: the route inventory at `:805-873` goes from 52 to 57. Create, resend and revoke are `write`, list is `read`, and accept is `exempt`;
- `apps/api/src/billing-guard.integration.test.ts`: fixture-map entries for the three new write routes (`:1166-1200` requires every write route):
  - create: `count` = invitation rows;
  - resend: `count` = a digest of the row's `token_hash`;
  - revoke: `count` = pending rows;
- `apps/api/src/access-routes.ts`: the users list directory query changes to the spec's member rule. Only the listed user ids are filtered by membership. `directory.grants` and `userLinks` stay whole, because `allows(directory, actor, …)` (`:229-248`) and the 500 cap read them. The `fakeTx` in `access-routes.test.ts` (`:139-185`) answers `[]` for unknown SQL, so it must answer the new membership query, or every users-list unit test shows no users;
- `apps/api/src/access-routes.test.ts`.

**Reaching 2xx in `billing-guard.integration.test.ts`:**

- That test does not build its server from `bindServices`. Its `beforeAll` (`:1063-1131`) assembles `serverRoutes` from the route factories with injected dependencies, the way `authRoutes` receives a `MemoryMail`. `productionRoutes` is used only for the write-route key set (`:1171-1176`).
- So `invitationRoutes(deps)` takes `{ checkout, kms, keyArn, now, apiHostname, adminOrigin: string | undefined, mail: InvitationMail, log, guardLog }`. `bindServices` supplies the SES adapter or `rejectingInvitationMail`, and `env.ADMIN_ORIGIN`.
- The billing-guard test adds `...invitationRoutes({ …, adminOrigin: "https://admin.example.test", mail: <in-memory InvitationMail> })` to `serverRoutes`. No SES mock and no `BILLING_SECRET_ARN` are needed.
- The five routes are registered unconditionally in `productionRoutes`, so the write-route key set includes the three write routes whatever the env, and the fixture-map equality at `:1176` holds.

**Behaviour:**

- **Create, resend and revoke** are `billing: "write"`. They run in this order:
  1. hostname, body and session;
  2. `communityScope` (including `guardWrite`, so read-only answers 402 first);
  3. permissions (403);
  4. for create and resend only, the mail and `ADMIN_ORIGIN` check (503 if either is unset). Revoke sends nothing and never answers this 503;
  5. the transaction.

  Create and resend send after commit, with the link `${ADMIN_ORIGIN}/#invite=${token}`. A mail failure calls the matching failure path and answers an empty 503.

- **List** is `billing: "read"`. Its purge deletes old rows and it writes an audit row, in a billing read-only organisation too. That is accepted: the purge removes only closed or long-expired rows, and the users list already writes audit rows under `read`. It needs `access.users.view` and `access.roles.view`, opens addresses through `openInvitationEmails` (identity checkout), and answers with `no-store`.
- **Accept** is `billing: "exempt"`. It runs, in order:
  1. `sessionUser`;
  2. parse the token;
  3. `proveInvitation` in a read-only app transaction scoped by the token;
  4. `findCommunityById` (platform);
  5. `assertWritable` (platform);
  6. `userEmailBlindIndex` (identity);
  7. `acceptInvitation` in the write transaction.
- **Every handler** has one whole-handler catch. A 500 is an empty body, and the log carries the route, the status and the error class only.
- **Error mapping for the five invitation routes.** One `invitationStatus` function; `grants` and `user-links` stay on `statusFor`.

  | Code                                                                               | Status | Body                         |
  | ---------------------------------------------------------------------------------- | ------ | ---------------------------- |
  | Zod failure, neither role nor contact, `invalid_email`                             | 400    | empty                        |
  | `forbidden`                                                                        | 403    | empty, as today              |
  | `wrong_address`                                                                    | 403    | `{ error: "wrong_address" }` |
  | `role_not_found`, `person_not_found`, `invitation_invalid`, `invitation_not_found` | 404    | `{ error: <code> }`          |
  | `already_invited`, `too_many`, `person_linked`, `invitation_void`                  | 409    | `{ error: <code> }`          |
  | `person_minor`                                                                     | 422    | `{ error: "person_minor" }`  |
  | billing read-only                                                                  | 402    | empty                        |
  | mail or `ADMIN_ORIGIN` unset, mail failure                                         | 503    | empty                        |

  The create route catches `IdentityError("invalid_email")` from `sealInvitationEmail` (`normaliseEmail`, `modules/core/identity/domain/email.ts:6-22`) and answers 400, so a typo is never a 500. The admin shows "Enter a valid email address".

- **Mail content:**
  - subject "You're invited to <slug> on Community Hub";
  - plain-text body naming the slug and the expiry date, with the link;
  - the line "If you weren't expecting this, you can ignore it";
  - no inviter name.

**Test first:** pins 39 to 42 and the unit half of pin 43. Mail tests assert the recipient, the subject, the link and the deadline, and that nothing is logged on failure.

**Rule it must not break:** `grants/list` and `capabilities` responses and headers are unchanged. The users list keeps its empty-body pin and its 500-cap behaviour.

**Pins run:** 39, 40, 41, 42, 43 (unit).

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
- `POST /v1/access/grants` with org B's member, a random uuid, and a signed-in user with no membership: three byte-identical 422 bodies, and no grant rows (pin 12, HTTP half).
- Org A's list never contains org B's users and never decrypts them.
- Pin 44 (billing read-only).
- Pin 43 (integration half).
- A token for org A replayed with org B's ids, and a token tampered in each id field: 404 `invitation_invalid`, and no audit row in either organisation. Pin 1 (b) and (c) are the weakenings this relies on.
- The fixture address and token appear in no log line and no audit row.

**Pins run:** 12 (HTTP), 43 (integration), 44.

### Task 9: Admin: invite, pending, pickers

**Commit:** `feat(admin): invite users and pick members on Users & Roles`

**Files:**

- new `apps/admin/src/invitations.tsx` (the invite form and the pending panel) and `invitations.test.tsx`;
- `apps/admin/src/users-roles.tsx` and `users-roles.test.tsx`.

**Behaviour** (spec, Inviting, Pending invitations, and the pickers):

- **The invite form** shows to `access.users.manage`. Its role select shows with `access.roles.manage`.
- **The contact picker** shows with `people.view`. It is an `Input` for the search plus a result list, calling `POST /v1/people/list` with `kind: "adults"`, `search` (1 to 100 characters) and `limit` 20, under a generation guard.
- **The pending panel** shows to `access.users.view` with `access.roles.view`. Resend and revoke show with `access.users.manage`.
- **The grant form's User field** becomes the `packages/ui` `Select` (a native `<select>`) over the users list rows. Rows are labelled by name, else email, else "User without details · <last 4 of id>". The link form gets the same, plus the contact picker. The raw id inputs are removed.
- **The empty picker** says "Invite someone first".
- **Errors** map the codes to plain sentences. 503 shows "Invitations are not available yet". `hideWrites` (billing) hides the invite form, resend and revoke.

**Test first:** pins 45 and 46. Also:

- each permission combination's visible controls;
- each error code's sentence;
- a StrictMode render;
- exact request bodies for create, resend and revoke;
- an axe pass with no violations.

**Rule it must not break:** the existing Users & Roles tests pass. Any test that typed a user id now picks from the select, with the same assertion on the request body.

**Pins run:** 45, 46.

### Task 10: Admin: the accept flow

**Commit:** `feat(admin): accept an invitation from the emailed link`

**Files:**

- new `apps/admin/src/accept-invitation.tsx` and `accept-invitation.test.tsx`;
- new `apps/admin/src/invite-token.ts` (the in-memory holder);
- `apps/admin/src/main.tsx`: it reads and strips `#invite=` with `history.replaceState` **before** `shell.tsx` is imported, using a dynamic import after the strip. `createBrowserRouter` (`shell.tsx:59`) captures the location at module load, so the router never sees the token;
- `apps/admin/src/shell.tsx`: while a token is held, the `/` index renders `AcceptInvitation`, and a signed-out person is sent to `/sign-in`;
- `apps/admin/src/sign-in.tsx`: the heading, and the post-sign-in navigation while a token is held (`:75`).

**Behaviour** (spec, Accepting):

- The token is kept in the module-level holder only.
- A signed-out person gets the sign-in screen headed "Sign in with the address this invitation was sent to". After sign-in, a person who holds a token sees the accept screen instead of `/settings/users`.
- **Accept screen:** "Accept invitation", then the button.
  - 200: switch to the returned slug and load capabilities. A 403 there shows "Your invitation was accepted. An administrator will give you access".
  - `wrong_address`: the sentence from the spec, with a sign-out button.
  - `invitation_invalid` and `invitation_void`: "This invitation is no longer valid. Ask for a new one".
  - 402: the billing read-only notice.
- The token is cleared from memory after any final answer.

**Test first:** pin 47. Also each answer's screen, no token in any request URL, a StrictMode render, and axe.

**Rule it must not break:** a normal sign-in with no token still lands on `/settings/users`, and the existing sign-in and shell tests pass unchanged.

**Pins run:** 47.

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
    - deleted on offboarding;
    - the cross-schema join that the migrator or a backup reader can make.
  - D13 (`:122`) gains `InvitationMail` beside `OtpMail` as an interim port until `EmailProvider`. No ADR (spec O2).
- **`docs/roadmap.md`:**
  - the row at `:172` becomes **done**, with the spec path;
  - a new **not started** row "Membership foreign keys". It is the contract step that reports grants and links without membership to the project owner before adding the keys. Its text says the time `0019` is applied in each environment is recorded there, so later rows can be told apart. The PR body says the same;
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
  - the task count, eleven, above AGENTS.md §3's 3 to 10 guide, by the chunk owner's decision;
  - spec amendments A1 to A4.
- Session scratch is cleaned up: no `docs/plans/*-report.md`, and nothing under `.superpowers/` staged.

## Owner decisions

For the chunk owner, answered once at plan approval:

1. **Task count:** eleven tasks in one PR. Recommendation: keep. Splitting would separate the membership gate from the invitations that make it usable.
2. **Spec amendments A1 to A4:** approve with this plan. Recommendation: approve.
3. **Implementer and reviewer:** Antigravity (Gemini) implements. The reviewer agent is Claude Opus 5.5. The owner's checks and the second review run on Sonnet 5.5 or another non-Opus, non-Gemini model.
4. **Deviation policy:** extra attempts, actor changes and fix commits are recorded as deviations in the PR, and cosmetic nits as PR notes.
5. **Next chunk after this one:** `Add Adult create`.

For the project owner: **O1** (spec, privacy retention) is still pending. Spec A3 narrows it: accepted rows are kept with ids only. If he chooses the sweep job, the spec gets an amendment and this plan gets a task before Task 11.

## Probe record

This plan has no Terraform assert, so no scratch probe is needed (AGENTS.md §4). Database weakenings are made in the `0019` file with the backup-and-hash restore above.

## Amendments after approval

None yet.
