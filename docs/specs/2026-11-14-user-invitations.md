# Spec: User invitations

Slug: user-invitations
Status: approved (2026-11-14, Adnan Bin Hossen)
Architecture refs: §6.3, §11.1, §11.2, §12.1, §12.2.1, §7.3; D13; ADR 0004, ADR 0009, ADR 0011, ADR 0013, ADR 0017; AGENTS.md §1 rules 1, 2, 3, 4, 5, 8; §2; §6; §7; §12; §13

**Sensitive chunk** (authentication, tenancy, encryption, and children's data through the contact rule). It needs a second fresh-context review on a model different from the implementer's and the reviewer agent's (AGENTS.md §2).

## Problem

An organisation cannot bring a new staff member in. Nobody can create a user from the admin. A user exists only once someone signs in with an email code (`modules/core/identity/infrastructure/email-otp.ts:134`), and then has no tie to any organisation.

Grants and user links accept any well-formed user id (`modules/core/access/infrastructure/grants.ts:178-221`, `:411-505`). They check the actor's permission and that the subject is an adult, and nothing else.

An admin in one organisation who knows a user id from another organisation can grant it a role. They can then read that user's sign-in email on Settings → Users & Roles (`apps/api/src/access-routes.ts:550-564`). A blank email in that list also shows whether an id has an account.

This is accepted risk O1 of `docs/specs/2026-11-11-users-roles-people-details.md:220`, accepted only until this chunk ships. The project owner asked on PR 85 that it ship before any real parish goes live.

The grant and link forms take a raw user id (`apps/admin/src/users-roles.tsx:644-650`, `:679`), which staff cannot know.

## Scope

In:

- **Organisation membership.** A new `app.organisation_members` table. A user is a member of an organisation in three ways:
  - by accepting an invitation to it;
  - through `bootstrapOwner` (`grants.ts:252-298`), which makes every first owner a member;
  - through the migration backfill below.
- **Invitations.** A new `app.invitations` table, scoped by community, and four staff routes: create, list pending, resend and revoke. Each invitation:
  - names one email address;
  - carries one role (a built-in community or organisation role, or a custom role), or one adult contact to link, or both.
- **Invitation email** through SES on the existing sender and configuration set. There is a new `InvitationMail` port and an SES adapter beside the sign-in one. There is no Terraform change: the task role may send any message from that sender (`infra/regions/au/ses.tf:75-97`).
- **Acceptance.** The emailed link opens the admin. The person signs in with an email code sent to the invited address, then accepts. In one transaction this makes them a member, creates the grant and the link, and marks the invitation accepted.
- **Grants and links accept members only.** `grantRole` and `linkUser` refuse a user id that is not a member of the caller's organisation. The refusal is the same for an unknown id, a non-member id and another organisation's member.
- **The users list decrypts emails for members only.** Its directory is built from members (rule below). `readUserEmails` receives member ids only.
- **Pickers.** The grant and link forms pick a user from the users list rows instead of typing an id. The link form and the invite form pick an adult contact by name from the existing adult search (`POST /v1/people/list`). That picker needs `people.view`. Without it the contact field is hidden.
- **Migration `0019`** (expand): both tables, with RLS, FORCE RLS and column privileges, plus the membership backfill.
- **Test support.**
  - A test helper `addMember(tx, userId)` in the access module's testing export. The existing integration tests that grant or link fresh users (about 70 `grantRole`/`linkUser` call sites in 12 files) call it. The raw-SQL grant fixtures in 4 files (`users-list`, `grants`, `holds-any-grant`, `holds-permission` integration tests) insert a membership row.
  - A migration test helper that copies the drizzle folder and journal truncated at `0018`, applies it, seeds rows, then applies the full folder. `applyMigrations` (`packages/db/src/migrate.ts:86`) always applies every pending migration.
- **Docs.**
  - `architecture.md` §11.1 (membership, invitations);
  - `architecture.md` §12.2.1 (the invitation address and its blind index);
  - D13 (`InvitationMail` beside `OtpMail`);
  - `docs/roadmap.md`: this row done, O1 closed in Open items, the snapshot, the next chunk, and a new row "Membership foreign keys".

Out:

- **Database foreign keys from grants and links to memberships.** This chunk enforces membership in code, inside the write transaction. A foreign key would make grants from the still-deployed service fail mid-deploy, which AGENTS.md §7 rules out for an expand migration. The new roadmap row "Membership foreign keys" is the contract step. Before adding the keys, that chunk lists the grants and links whose user has no membership and reports them to the project owner. They are then deleted, or given memberships, by his decision. It does not backfill them automatically, because such a row may be exactly the cross-organisation grant this chunk closes. The time `0019` is applied in each environment is recorded, so later rows can be told apart.
- Removing a member from an organisation. Revoking a grant or a link stays as it is.
- Bulk invitations, and invitations from the ops console.
- Memberships created by the Laravel import. The Phase 5 import chunk must create them; this spec records the requirement.
- Second-factor setup at acceptance. "Two-factor for staff" adds it to sign-up, which includes acceptance.
- A display name for communities. The email names the community by its slug until "Community memberships endpoint" adds the parish name.
- A sweep job for old invitation rows (see Data, retention).
- Decoupling `ADMIN_ORIGIN` from billing. Invitations need it, and today it reaches the task only with billing configured (`infra/modules/aws-ingress/main.tf:498`). This chunk accepts that coupling.
- Any member, Parish Hub or website surface. No collection, island or block.
- **Staging:** stays parked (chunk owner, 2026-11-14). The integration suite against Postgres and the admin tests verify the behaviour. The live check on the staging hostname, including a real invitation through SES sandbox, is deferred to the next proof chunk that unparks. The PR records this as an AGENTS.md §8 deviation.

## Behaviour

### Inviting (Settings → Users & Roles)

- Staff who hold `access.users.manage` see **Invite user**. The form takes:
  - an email address (required);
  - a role (optional);
  - a contact to link (optional, shown only with `people.view`, adults only).
- At least one of role and contact is required. A request with neither answers 400.
- Choosing a role also needs `access.roles.manage`, under the same rules as a grant:
  - organisation roles need `org_owner` or `org_admin` (`grants.ts:79-94`);
  - a custom role must belong to this community (`grants.ts:346-409`).
- Choosing a contact needs `people.view`. The contact must be an adult who is readable in this community and not linked to a user.
- These rules are checked at create and again at accept.
- The service normalises the address as sign-in does (`modules/core/identity/domain/email.ts`), and stores it encrypted with its blind index. Create never consults `identity.users`, so it answers the same whether or not the address has an account anywhere.
- Create takes the organisation's advisory lock before the cap checks, so concurrent creates cannot both pass a cap. `lockOrganisation` (`grants.ts:170-176`, private today) is exported from a shared access file with the same lock key, so `bootstrapOwner`, the last-owner revoke and invitations serialise together.
- Everything in create runs under the community policy, so it sees this community's invitations only. Uniqueness and caps are per community; no answer depends on another community's invitations.
- In the create transaction, before the insert, an unexpired pending row in this community for the same blind index stops the create. A pending row for the same blind index whose expiry has passed is set to `void`, its address and blind index are cleared, `access.invitation.voided` is written, and the insert goes ahead.
- The transaction then inserts the row and writes `access.invitation.created` (ids only), and commits.
- The service then sends the email. If SES fails or times out (the adapter's 5-second limit, `apps/api/src/mail/ses-otp-mail.ts:4`), the service:
  - deletes the row;
  - writes `access.invitation.voided`;
  - answers 503 with an empty body.

  On a timeout SES may still deliver the email; that link then answers `invitation_invalid`.

- Errors carry a JSON body `{ error: <code> }`:
  - `already_invited` (409): an unexpired pending invitation for the same normalised address exists in this community. A unique violation from a concurrent create in this community maps here too; it cannot come from another community.
  - `too_many` (409): this community already has 100 unexpired pending invitations, or has created 20 in the past hour.
  - `person_minor` (422), `person_not_found` (404), `person_linked` (409): the chosen contact is a minor, is not readable in this community, or is already linked to a user.
  - `role_not_found` (404).
- 403 for a caller who lacks a needed permission, as today (empty body).
- An address that already belongs to a member may be invited, to add a role or a link. Create never says that an address is a member.

### Pending invitations

- Users & Roles shows a **Pending invitations** panel to callers who hold `access.users.view` and `access.roles.view`, the pair the users list needs.
- It lists this community's unexpired pending invitations. Each shows:
  - the address (decrypted in `core/identity`, see Rules touched);
  - the role, if any;
  - whether a contact will be linked;
  - the expiry date.
- Holders of `access.users.manage` can **Resend** a pending invitation.
  - Resend writes a new token hash, resets the expiry to 7 days, writes `access.invitation.resent`, commits, then sends. The old link stops working.
  - If the send fails, the invitation is voided (address cleared, `access.invitation.voided`) and the route answers 503. Staff then create a new one.
  - Resend is capped at 3 per invitation. The count resets when the last send is more than 24 hours old (`too_many`).
- Holders of `access.users.manage` can **Revoke** a pending invitation (`access.invitation.revoked`). Revoking an expired pending row is allowed: it closes the row and clears the address.
- Resend and revoke select the row `FOR UPDATE` where `status = 'pending'`, and for resend also `expires_at > now()`. If no row matches (unknown id, another community's id, not pending, or for resend expired), they answer 404 `{ error: "invitation_not_found" }`. That is one body for every case, with no audit row. A revoke that races an accept waits on the lock and then finds the row no longer pending.
- Accepted, revoked, void and expired invitations leave the panel.
- The list response carries `Cache-Control: no-store`, as the users list does, and writes `access.invitations.listed` (ids only).

### Accepting

- The email links to `<ADMIN_ORIGIN>/#invite=<token>`.
  - It points at the root because reloading an admin deep link answers 403 from CloudFront (roadmap Open items).
  - The token is in the fragment, so it never reaches a server log, a CloudFront log or a `Referer`.
- **The token** is `v1.` followed by base64url of fixed-length binary: organisation id, community id, invitation id (16 bytes each), then 32 random bytes. There are no separators.
  - It is parsed strictly. A wrong prefix, a wrong length or a malformed id answers `invitation_invalid` before any SQL runs.
  - The service stores only the SHA-256 of the random part.
- **The admin**:
  - reads the fragment and removes it from the address bar (`history.replaceState`);
  - keeps the token in memory only;
  - shows the accept screen instead of the post-sign-in navigation (`apps/admin/src/sign-in.tsx:75`) while it holds a token.

  A signed-out person sees the sign-in screen, headed "Sign in with the address this invitation was sent to". A signed-in person sees "Accept invitation".

- `POST /v1/invitations/accept { token }` needs a signed-in tenant session. Sessions are user-only (`readSession` returns `{ userId }`), so a brand-new user can call it.
- The route runs in this order. Nothing about the token's organisation is revealed until the token is proven:
  - a. It parses the token strictly.
  - b. It opens a read-only `withAppTransaction` with `{ orgId, communityId }` from the token. That transaction selects the invitation by id, compares the hash and checks that it is pending and unexpired. Any failure answers `invitation_invalid`.
  - c. Only then does it read the community through a new `core/tenancy/public` export, `findCommunityById`, which supplies the slug for the response. It answers `invitation_invalid` if the community is missing or not in the token's organisation.
  - d. It calls `assertWritable` for that organisation. A read-only organisation answers 402 and nothing is written. A 402 is reachable only by someone who holds a valid token, so a forged token cannot reveal another tenant's billing state.
  - e. It opens the write transaction below.
- The write transaction is a `withAppTransaction` with `{ orgId, communityId }` from the token. It:
  1. selects the invitation by id `FOR UPDATE` (a tampered id selects no row);
  2. compares the token hash in constant time;
  3. checks that the invitation is pending and not expired;
  4. checks that the signed-in user's sign-in email blind index equals the invitation's;
  5. runs pure checks that write nothing:
     - the inviter still holds the permissions the invitation needs;
     - the role still exists;
     - the contact is still an adult, readable and not linked to another user;
     - the user is not already linked to a different person in this community;
     - the user's existing link, if any, is to an adult;
  6. inserts the membership, unless there is one, with source `invitation`;
  7. creates the grant (skipped if the user already holds that role) and the link (skipped if this exact link exists), with the inviter as the granting actor. Step 7 uses internal variants of the grant and link writes. Those variants skip the permission check, because step 5 did it, and never call `deny()`. Any `AccessError` thrown in step 7 voids the invitation exactly as a step 5 failure does, and writes no `access.permission.denied` row;
  8. marks the invitation accepted, records the accepting user and the time, and clears the address, its blind index and the contact id;
  9. writes `access.invitation.accepted` with the invitation id, the membership user id and the community in `targetIds`, so it can be matched with the grant and link rows written under the inviter.
- **Errors** (JSON body):
  - `invitation_invalid` (404), for any failure in steps 1 to 3 and for a bad token. It has one body, so the route never says which check failed. No audit row is written into the token's organisation for this outcome, so nobody can fill another tenant's audit log.
  - `wrong_address` (403), when step 4 fails. Nothing is written. The admin says "This invitation was sent to a different address. Sign out and sign in with that address", and never shows the invited address.
  - `invitation_void` (409), when a step 5 check or a step 7 write fails. In the same transaction the invitation is marked void, its address is cleared, and `access.invitation.voided` is written.
- **On success** the route answers `{ communitySlug }`. The admin switches to that community and loads capabilities.
  - A member with a grant lands where sign-in lands today.
  - A member with only a contact link has no grant, so capabilities answers 403. They see the existing no-access state, with the line "Your invitation was accepted. An administrator will give you access".
- Accepting twice answers `invitation_invalid` the second time. Two concurrent accepts serialise on the row lock, and exactly one succeeds.

### Grants, links and the users list

- `grantRole` and `linkUser` check membership after their permission check and before the insert, in the same transaction.
  - The permission check runs first, so a caller without `access.roles.manage` or `access.users.manage` gets 403 whatever the id.
  - A non-member raises the new `AccessError("not_member")`, which answers 422 `{ error: "user_not_member" }` and writes `access.permission.denied` with purpose `access.user.not_member`.
  - The body is identical for a random uuid, a real user in no organisation, and a member of another organisation.
- `bootstrapOwner` inserts the `provision` membership in its own transaction, before its grants.
- Revoke and unlink are unchanged; they act only on existing rows.
- `POST /v1/access/users/list` lists the members of the caller's organisation who:
  - hold a grant in this community, an organisation grant, or a link in this community; or
  - accepted an invitation to this community and hold no grant or link in it. This is `organisation_members.invitation_id` → `invitations.community_id` = this community.

  A member whose only grants and links are in a sibling community is not listed, and their email is not decrypted. Emails are decrypted only for listed members, and never for a member linked to a minor or to a person the community cannot read. That rule is unchanged from PR 85.

- **The grant form's User field** becomes a picker over the users list rows. It shows the name, else the sign-in email, else "User without details" with a short id suffix, so two such rows can be told apart.
  - It is shown only to callers who also hold `access.users.view` and `access.roles.view`. Without them the grant form is hidden, because there is nothing to pick.
  - The link form gets the same picker plus the contact picker.
  - The raw id inputs are removed.

### Empty, error and offline states

- No members other than the caller: the picker shows "Invite someone first", which links to the invite form.
- Mail not configured (`MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET`, as `bindServices` checks them at `apps/api/src/index.ts:204`), or `ADMIN_ORIGIN` unset: create and resend answer 503, and the admin shows "Invitations are not available yet".
- Network failure: the existing admin notice, with the form values kept.

## Data

**Migration `0019`.**

- Both tables are wired through `accessTables`, which gains a `{ encryptedColumn, blindIndexColumn }` parameter passed in `packages/db/drizzle.schema.ts`, as `peopleTables` receives them. Schema files import no values from `@community-hub/db`.
- Every column is listed in `modules/core/access/module.manifest.ts` `dataClasses`, with `manifest.test.ts` updated in the same task.

`app.organisation_members`: RLS and FORCE RLS, `org_isolation` policy (organisation-level, §6.3).

| Column        | Type                                                   | Class      |
| ------------- | ------------------------------------------------------ | ---------- |
| org_id        | uuid                                                   | `internal` |
| user_id       | uuid                                                   | `internal` |
| source        | text, check in (`invitation`, `provision`, `backfill`) | `internal` |
| invitation_id | uuid null                                              | `internal` |
| created_at    | timestamptz                                            | `internal` |

- Primary key `(org_id, user_id)`.
- Privileges: `UPDATE`, `DELETE` and `TRUNCATE` are revoked from `app`, so membership is insert-only in this chunk.

`app.invitations`: RLS and FORCE RLS, `community_isolation` policy (organisation and community), as the other community-scoped access tables have.

| Column           | Type                                                      | Class                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| org_id           | uuid                                                      | `internal`                                                                                                                                                                                                            |
| community_id     | uuid                                                      | `internal`                                                                                                                                                                                                            |
| id               | uuid                                                      | `internal`                                                                                                                                                                                                            |
| invited_by       | uuid (user id)                                            | `internal`                                                                                                                                                                                                            |
| email            | bytea null                                                | `confidential-blind`. Encrypted with the identity key inside `core/identity`, AAD `{ tag: "chub/field-identity/v1", label: "app.invitations.email", rowId: id, region: "au" }`. Same class as `identity.users.email`. |
| email_bidx       | bytea null                                                | `confidential-blind`. The same HMAC as `identity.users.email_bidx`, so acceptance can compare them. Equality only.                                                                                                    |
| token_hash       | bytea                                                     | `internal`. SHA-256 of 32 random bytes. Never logged.                                                                                                                                                                 |
| role_key         | text null                                                 | `internal`                                                                                                                                                                                                            |
| custom_role_id   | uuid null                                                 | `internal`                                                                                                                                                                                                            |
| person_id        | uuid null                                                 | `internal`                                                                                                                                                                                                            |
| status           | text, check in (`pending`, `accepted`, `revoked`, `void`) | `internal`                                                                                                                                                                                                            |
| expires_at       | timestamptz                                               | `internal`                                                                                                                                                                                                            |
| resend_count     | int                                                       | `internal`                                                                                                                                                                                                            |
| last_sent_at     | timestamptz                                               | `internal`                                                                                                                                                                                                            |
| accepted_user_id | uuid null                                                 | `internal`                                                                                                                                                                                                            |
| closed_at        | timestamptz null                                          | `internal`                                                                                                                                                                                                            |
| created_at       | timestamptz                                               | `internal`                                                                                                                                                                                                            |

- **Keys**
  - Primary key `(org_id, id)`.
  - Partial unique index `(org_id, community_id, email_bidx) WHERE status = 'pending'`.
  - Foreign key `(org_id, person_id)` to `app.persons`, `on delete restrict`, as every foreign key in the access module is (`modules/core/access/db/schema.ts:117,150,182`). A future erasure or person-delete path must void a pending invitation that names the person first; the erasure chunk owns that. Closed rows have `person_id` cleared, so they never block it.
  - Foreign key `(org_id, custom_role_id)` to `app.custom_roles`, `on delete restrict`, so a custom role with a pending invitation cannot be deleted (`role_in_use`, as with grants). The accept re-check still covers a role that changed.
  - A check that `role_key` is one of the built-in keys, mirroring `organisation_role_grants_role_key` (`schema.ts:61-64`) and the community role check.
  - At most one of `role_key` and `custom_role_id`, and at least one of role and `person_id` while pending.
  - Every unique key starts with `org_id`.
- **Privileges:** `UPDATE` and `TRUNCATE` are revoked from `app`, then `UPDATE` is granted on `status, email, email_bidx, token_hash, expires_at, resend_count, last_sent_at, accepted_user_id, person_id, closed_at` only. `DELETE` stays, for the SES-failure path and retention.
- Expiry is computed (`status = 'pending' AND expires_at > now()`), so there is no `expired` status.
- **Rule 3 (§12.2.1):** nothing filters, sorts or aggregates on `email`. `email_bidx` is filtered by equality only (the duplicate check). `token_hash` is compared only on a row already selected by id.
- **Retention:** the address parts below are superseded by amendment A5 (the address moves to `identity.invitation_emails`, with expiry erasure and a region-wide bounded sweep). The `app.invitations` row rules stay as A3 says.
  - When an invitation leaves `pending` (accepted, revoked, void), `closed_at` is set and `email`, `email_bidx` and `person_id` are cleared.
  - Rows closed more than 30 days ago, and pending rows that expired more than 30 days ago, are deleted in the create and list transactions for that community.
  - A community that never opens invitations keeps expired rows, address included, until the sweep follow-up. See Owner decision O1.
  - Offboarding an organisation must delete its invitation rows. The address is identity-keyed, so destroying the organisation's key does not erase it. §12.2.1 records this.
- **Backfill (in `0019`).**
  - It is a `DO` block that loops over `platform.communities`. For each community it calls `set_config('app.org_id', …, true)` and `set_config('app.community_id', …, true)`.
  - It then inserts `backfill` memberships for user ids found in `organisation_role_grants`, `community_role_grants` and `user_links` that also exist in `identity.users`, with `ON CONFLICT DO NOTHING`. The migrator owns all three schemas.
  - RLS is never disabled and FORCE is never dropped.
  - Drizzle runs every pending migration in one transaction (`drizzle-orm` `pg-core/dialect.js` `migrate`), so a transaction-local setting would outlive the block. After the loop, the block resets both settings to `''`. The test asserts `current_setting('app.org_id', true)` is empty after `0019`.
  - An organisation with no community is skipped. That is harmless, because `bootstrapOwner` needs a community.
  - Today every environment's database is new or empty (staging is parked, which removes its database), so the backfill finds no rows. It is there for the first database that does hold grants.
  - The integration test applies migrations up to `0018`, inserts grants and links in two organisations (two communities in one), applies `0019`, and asserts the exact membership set. A test on an empty database is not evidence.
  - The plan reports the users who hold grants in more than one organisation after the backfill, for the project owner to review.
- No change to `identity` tables.

## Rules touched

- **Permissions:** no new permission keys.
  - Create needs `access.users.manage`, plus `access.roles.manage` with a role, plus `people.view` with a contact.
  - Resend and revoke need `access.users.manage`.
  - The list needs `access.users.view` and `access.roles.view`.
  - Accept needs only a session; the inviter's rights are re-checked.
- **Billing:**
  - Create, resend and revoke are `billing: "write"`, and the list is `billing: "read"`.
  - Accept is `billing: "exempt"` in the route table (`apps/api/src/gate.ts:68-98`). It calls `assertWritable` itself, after the token is proven (Accepting, d), because `guardWrite` skips callers who hold no grant (`apps/api/src/billing-guard.ts:28-38`).
- **Audit names** are registered in `modules/core/access/public/index.ts`. They carry ids only, never an address or a token:
  - `access.invitation.created`, `.resent`, `.revoked`, `.accepted`, `.voided`;
  - `access.invitations.listed`;
  - `access.user.not_member` as the purpose of `access.permission.denied`.
- **Identity boundary:** `core/identity/public` gets three exports. All three return plain `Uint8Array` or strings, which `email-lookup.ts:76-79` does too, so no branded `Ciphertext` or `BlindIndex` is bound in an `apps/*` query.
  - `sealInvitationEmail(invitationId, address)` normalises, encrypts with the AAD above and computes the blind index.
  - `openInvitationEmails(rows: { id, ciphertext }[])` decrypts ciphertexts that `core/access` read under RLS in the app transaction. The AAD is bound to each id, the function issues no query, and it is capped at 100. The identity role gets no privilege on `app` (ADR 0004).
  - `userEmailBlindIndex(userId)` reads the session user's blind index through the identity checkout, for step 4.
- **Residency (rule 1):** the invitation email is sent from the regional service through SES in `ap-southeast-2`, a named subprocessor (ADR 0013). It carries only the recipient address, the community slug, the expiry date and the link.
- **Production mail:** like sign-in, invitations need production SES and the sandbox exit (ADR 0013, O5) before a parish goes live. Recorded, not in scope.
- **Children (rule 4):** a minor cannot be the contact of an invitation, at create or at accept. Minors' details never appear in the panel or the email.
- **No personal data in URLs or logs (rule 5):**
  - The link fragment holds opaque ids and a random secret.
  - Request bodies carry the address, never a path or a query string.
  - Logs carry the route, status and duration only. The token, the address and SES error text are never logged.
- **Secrets (rule 8):** fixtures build tokens at run time. No literal token-shaped string is committed.

## Contracts

`packages/contracts/src/access.ts` (Zod, request and response):

- `POST /v1/access/invitations/create` `{ communitySlug, email, roleKey?, customRoleId?, personId? }` → 201 `{ invitationId }`
- `POST /v1/access/invitations/list` `{ communitySlug }` → 200 `{ invitations: [{ id, email, roleKey | null, customRoleId | null, linksContact, expiresAt }] }`
- `POST /v1/access/invitations/resend` `{ communitySlug, invitationId }` → 204, or 404 `{ error: "invitation_not_found" }`
- `POST /v1/access/invitations/revoke` `{ communitySlug, invitationId }` → 204, or 404 `{ error: "invitation_not_found" }`
- `POST /v1/invitations/accept` `{ token }` → 200 `{ communitySlug }`
- `POST /v1/access/grants` and `/v1/access/user-links`: new 422 `{ error: "user_not_member" }`. The request is unchanged.
- `POST /v1/access/users/list`: the response shape is unchanged; the directory rule changes as above.

Other contracts:

- **Error bodies.** This chunk introduces JSON `{ error: <code> }` bodies for the invitation routes and for the 422 `user_not_member`. Every other access error stays an empty body, and the users list keeps PR 85's empty-body pin.
- **Mail port.** `InvitationMail` in `modules/core/access/domain/`, with one method, `send({ to, communitySlug, link, expiresAt })`. The SES adapter goes in `apps/api/src/mail/`, wired in `bindServices` under the same condition as `OtpMail`. Otherwise a rejecting adapter answers 503.
- **Tenancy port.** A new `core/tenancy/public` export, `findCommunityById`.
- No events and no website keys. The manifest changes in `dataClasses` only.

## Risks

| Risk                                                                               | Mitigation                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A grant or link accepts a non-member                                               | The check is in `grantRole` and `linkUser`, not only the route. A two-organisation integration test sends org B's member id, a random id and a real non-member id. It expects identical 422 bodies and no row.                                                                        |
| The users list decrypts a non-member's email, or a sibling community's             | A test spies on `readUserEmails` and asserts its id set is exactly the listed members. A second test uses two communities in one organisation: a member granted only in Y yields no row, and no decrypt, in X. Weakening either filter must fail a test.                              |
| A token is accepted in the wrong organisation or community                         | The organisation and community ids come from the token and scope the transaction under RLS. A token with either id changed answers `invitation_invalid` and writes nothing in either tenant, audit included.                                                                          |
| A forwarded link is accepted by someone else                                       | Step 4 compares blind indexes. Test: a second user with the token gets `wrong_address`, and nothing is written.                                                                                                                                                                       |
| The invite form becomes an account oracle                                          | Create never touches `identity.users`. Test: an identity spy records no call during create, for an address with an account and one without.                                                                                                                                           |
| An inviter who lost rights still grants through an old invitation                  | Step 5. Test: revoke the inviter's role, accept, expect `invitation_void`, and expect no grant and no `access.permission.denied` row.                                                                                                                                                 |
| Two accepts of one invitation                                                      | `FOR UPDATE` in step 1. The test runs two accepts with a barrier, not a timer, and expects exactly one success.                                                                                                                                                                       |
| A billing read-only organisation takes new grants through accept                   | `assertWritable` after the token is proven. Test: a read-only organisation answers 402 for a valid token and nothing is written; a forged token for the same organisation and community answers `invitation_invalid`, not 402.                                                        |
| A cross-community leak through invitations in one organisation                     | Uniqueness, caps and the expired-row void are per community, under the community policy. Test: two communities in one organisation; a pending and an expired invitation in Y for an address change nothing about create, list, resend or revoke in X.                                 |
| Residual: an organisation-wide member granted in a community that cannot list them | Membership is organisation-wide, so `grantRole` in community X accepts a member who is only in Y. Staff in X cannot list that member and would need the id out of band. Both are in one organisation, and the grant is audited. Recorded as a residual; it is not cross-organisation. |
| A spam vector through invitation mail                                              | Caps under the organisation lock, the resend cap, and SES sandbox today. The production-access request (ADR 0013 O5) adds a bounce alarm.                                                                                                                                             |
| The backfill misses rows under FORCE RLS                                           | Per-community `set_config` in the `DO` block, tested on a populated database across two organisations.                                                                                                                                                                                |
| The deploy window between migration and new code                                   | Expand-only. A grant the old service makes for a non-member in that window stays effective (`loadActor` does not check membership) but is hidden from the list. The "Membership foreign keys" chunk re-runs the backfill before adding keys. No real tenants exist today.             |
| Error text leaks SQL, an address or a hostname                                     | One whole-handler catch per route, with codes only in bodies. Tested with a thrown error that carries an address.                                                                                                                                                                     |
| Someone who can read both schemas learns which invited addresses have accounts     | Recorded in §12.2.1. Only the migrator and backup readers can join `app.invitations.email_bidx` to `identity.users.email_bidx`. Addresses are cleared when an invitation closes.                                                                                                      |

Security-relevant settings the plan must pin, each with a weakening that makes its test fail:

- the membership check in `grantRole` and in `linkUser`, and its order after the permission check;
- `bootstrapOwner`'s membership;
- the users list member filter and its community rule;
- the org and community ids taken from the token, with strict parsing;
- the constant-time hash comparison and the pending/expiry check;
- the blind-index comparison at acceptance;
- the inviter re-check, written as pure checks;
- the `FOR UPDATE` lock;
- `assertWritable` on accept;
- no audit row on `invitation_invalid`;
- the minor refusal at create and at accept;
- clearing the address, blind index and contact on leaving `pending`;
- the caps under the advisory lock, and per-community uniqueness;
- the accept order: token proven before `findCommunityById` and `assertWritable`;
- the step 7 internal writes: no `deny()`, any error voids the invitation;
- one `invitation_not_found` body for resend and revoke;
- the backfill resetting both settings after the loop;
- the fragment removal in the admin;
- RLS, FORCE RLS and the column privileges on both tables;
- the backfill under FORCE RLS;
- `no-store` on the list.

## Out-of-band

- **Legal:** none expected. A privacy-notice line on staff invitations may be wanted before production. Recorded, not blocking.
- **New subprocessor or vendor:** none. SES is already named (ADR 0013).
- **Cost:** no new billed resource. SES charges per message, which is negligible.
- **Second review:** required (sensitive chunk). The reviewer agent runs on Claude Opus 5.5. The owner's checks and the second review must run on a different model (not Opus 5.5, not Gemini/Antigravity). The PR records both.
- **Owner decisions (project owner, AGENTS.md §12):**
  - **O1. Privacy: storing an invitee's address before they consent. Accepted by the project owner on 2026-11-14: lazy deletion in create and list, no sweep job in this chunk.**
    - The address is held encrypted while the invitation is pending, and cleared when it is accepted, revoked or voided.
    - Rows are deleted 30 days after closing or expiring, the next time that community creates or lists invitations.
    - The alternative was a regional sweep job in this chunk, which would have added a scheduled task and its ECS schedule (Terraform). It was not chosen.
- **Decided without the project owner:**
  - **O2. Architecture record: no ADR (chunk owner, 2026-11-14).**
    - This is not an ADR-level decision. §11.1 already says users "hold memberships", and D13 already records `OtpMail` as an interim port.
    - Organisation membership as the gate for grants and links goes in `architecture.md` §11.1, and the identity-keyed invitation address goes in §12.2.1, in this PR.
    - `InvitationMail` goes in D13 beside `OtpMail` as a second interim port, until `EmailProvider` lands.
  - **O3. Laravel difference: answered by the project owner on PR 85 (2026-11-14).**
    - Laravel creates a user directly. Core invites, and the person accepts: "Its grants and links should accept only users who have accepted an invitation to that organisation."
    - This is recorded for the Laravel parity table.
- **Defaults, confirmed by the chunk owner (2026-11-14):**
  1. Expiry 7 days. Caps per community (the table is community-isolated, so an organisation-wide cap would need an organisation-level policy): 20 creates per hour and 100 unexpired pending; 3 resends per invitation, reset after 24 hours without a send.
  2. Membership is enforced in code now. Database foreign keys come in the "Membership foreign keys" chunk.
  3. The email names the community by slug. It does not carry the inviter's name.
  4. The admin holds the token in memory, not in session storage. If the tab is lost, the person opens the link again.
  5. Accept re-checks the inviter's rights and the contact, and voids the invitation if either check fails.
  6. A member may be invited again to add a role or a link. Create never says the address is a member.
  7. An invitation needs a role, a contact, or both.
  8. Identity crypto is reached through new `core/identity/public` exports, as `readUserEmails` is. There is no new kernel port.
  9. A failed send voids the invitation (create deletes the row; resend voids it). It is not retried or restored.

## Amendments after approval

Proposed 2026-11-14 from plan check 1 (Claude Opus 5.5). Approved by the chunk owner, Adnan Bin Hossen, on 2026-11-14, together with the plan.

- **A1. Backfill scope test.** The backfill section says the test asserts `current_setting('app.org_id', true)` is empty after `0019`. That check cannot fail, because the settings revert when drizzle's single migration transaction commits. The test instead appends a probe migration (`0020_probe.sql`) to its temporary folder only. The probe raises an error if either setting is non-empty, so a missing reset fails the apply. The reset itself is unchanged.
- **A2. Custom roles and closed invitations.**
  - When an invitation leaves `pending`, `custom_role_id` is cleared as well, and it joins the column `UPDATE` grant.
  - `deleteCustomRole` counts pending invitations that name the role, in addition to grants, and answers `role_in_use`.
  - Without this, the `restrict` foreign key turns deleting a role named by any invitation, open or closed, into a 500 for up to 30 days.
- **A3. Retention keeps accepted rows.**
  - The users list finds members whose accepted invitation was to this community through `organisation_members.invitation_id` → `invitations`. Deleting accepted rows after 30 days would drop such members from the list and the picker.
  - The purge therefore deletes revoked and void rows closed more than 30 days ago, and pending rows expired more than 30 days ago.
  - Accepted rows are kept. They hold ids only, because the address, blind index, contact and custom role are cleared on acceptance.
- **A4. Identity key read.** `sealInvitationEmail` and `openInvitationEmails` read the identity key row through the identity checkout, as `readUserEmails` does (`user-emails.ts:43-52`), and never create a key. "Issues no query" in Rules touched means it reads no `app` table and makes no query other than that key read.
- **Clarification (no change): role rules at create and accept.** "The same rules as a grant" includes the bundle-subset rule: the inviter must hold every permission of the built-in role's bundle, or of the custom role (`grants.ts:366-377`, `:436-444`). It is stated here because the plan tests it separately.
- **A5 (proposed 2026-11-14, needs the chunk owner's approval). Invitation addresses live in identity, with region-wide erasure (project owner's O1 conditions, 2026-11-14).**
  - **Why.** The project owner accepted O1 on three conditions:
    1. expiry erases the stored address, as accept, revoke and void do;
    2. clean-up of old rows runs region-wide, as one bounded statement in `core/identity`;
    3. this section states the rule, with must-fail tests.

    `app.invitations` is isolated per community under FORCE RLS, and the identity role has no `app` privileges (ADR 0004). So a region-wide clean-up of addresses is only possible if the address is held in `identity`, as `identity.users.email` is. Chosen by the chunk owner, 2026-11-14.

  - **New table `identity.invitation_emails`.** It is region-scoped, with no `org_id` (§6.3). Privileges: the `identity` role may `SELECT`, `INSERT` and `DELETE`, and `UPDATE` only `email`, `email_bidx`, `dedupe_key`, `expires_at` and `closed_at`. No `TRUNCATE`. The `app` and `platform` roles get nothing.

    | Column        | Type                             | Class                                                                                                                                                                    |
    | ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
    | invitation_id | uuid, primary key                | `internal`                                                                                                                                                               |
    | region        | text, check `'au'`               | `internal`                                                                                                                                                               |
    | email         | bytea null                       | `confidential-blind`. Identity key, AAD `{ tag: "chub/field-identity/v1", label: "identity.invitation_emails.email", rowId: <16 bytes of invitation_id>, region: "au" }` |
    | email_bidx    | bytea null                       | `confidential-blind`. The same HMAC as `identity.users.email_bidx`                                                                                                       |
    | dedupe_key    | bytea null, unique when not null | `confidential-blind`. HMAC of community id ‖ normalised address under the identity blind-index key, purpose `identity.invitation_emails.dedupe`                          |
    | expires_at    | timestamptz                      | `internal`                                                                                                                                                               |
    | closed_at     | timestamptz null                 | `internal`                                                                                                                                                               |
    | created_at    | timestamptz                      | `internal`                                                                                                                                                               |

    Checks:
    - `email`, `email_bidx` and `dedupe_key` are all null or all set;
    - `email_bidx` and `dedupe_key` are 32 bytes when set.

  - **`app.invitations` loses `email` and `email_bidx`,** with their checks, the partial unique index and the column grants on them. It holds no address or address-derived value. Migration `0019` is regenerated: it is unmerged and has never been applied in any environment, and dropping the columns in a later migration would be destructive DDL in the same PR (AGENTS.md §7). The `0019` backfill is unchanged.
  - **Retention (replaces the address parts of Data, Retention, and of A3):**
    1. **Close erases at once.** Accept, revoke and void call identity `closeInvitationEmail` inside the app transaction's callback, before the app commit. It sets `email`, `email_bidx` and `dedupe_key` to null and `closed_at` to now. If the app transaction then rolls back, the invitation keeps no address: list shows "Address removed", and accept answers `invitation_invalid`. This is the privacy-first direction.
    2. **Expiry erases at the next action anywhere in the region.** Every invitation action (create, list, resend, revoke, accept), in any community or organisation, first calls identity `sweepInvitationEmails(now)`. That is one SQL statement with two bounded parts:
       - it erases up to 500 rows where `expires_at <= now` and `email` is not null;
       - it deletes up to 500 rows whose `closed_at`, or whose `expires_at` if never closed, is more than 30 days old.
    3. **No read returns an expired address,** even before a sweep. `openInvitationEmails` and the acceptance comparison select only rows with `closed_at is null`, `expires_at > now()` and `email` not null, in identity itself, whatever the caller passes.
    4. **`app.invitations` rows,** which now hold ids only, keep A3's purge per community. Revoked and void rows closed more than 30 days ago, and pending rows expired more than 30 days ago, are deleted in create and list. Accepted rows are kept.
    5. **A scheduled sweep** comes with the first regional scheduler chunk, calling the same `sweepInvitationEmails`. The roadmap records it.
  - **Must-fail tests (identity integration, two organisations):**
    - (a) An expired address in org A is erased by a list in org B.
    - (b) With the sweep call removed, `openInvitationEmails` still returns nothing for an expired row, and accept does not match it.
    - (c) A row closed 31 days ago in org A is deleted by an action in org B, while rows at 29 days stay.
    - (d) Seeding 501 erasable rows, one action erases exactly 500.
    - (e) Revoke, accept and void each leave `email`, `email_bidx` and `dedupe_key` null with `closed_at` set.
    - (f) An address from one community never collides with the same address in another community, while a second pending invitation in the same community answers `already_invited`.
  - **Identity boundary (replaces the three exports in Rules touched, and A4).** All take the identity checkout and return plain values.
    - `createInvitationEmail`: normalises, encrypts and inserts. Before the insert, it erases any expired or closed row with the same `dedupe_key`. A unique violation answers `already_invited`. It is called from inside the app create transaction's callback, so `already_invited` rolls the app row back.
    - `refreshInvitationEmail`: sets a new expiry, for resend.
    - `openInvitationEmails(invitationIds)`: cap 100; unexpired and open rows only.
    - `invitationAddressMatches(invitationId, userId)`: compares `identity.users.email_bidx` with the invitation's index, for unexpired and open rows only, and returns a boolean.
    - `closeInvitationEmail(invitationId)`.
    - `sweepInvitationEmails(now)`.

    Callers pass only invitation ids read under RLS from `app.invitations`, as with `readUserEmails` (§11.1). Create still never reads `identity.users`.

  - **Effect on the plan:**
    - Task 2 gets a fix commit (regenerated `0019`, the identity table, privileges, manifest classes);
    - Task 4 is rewritten for the six identity functions;
    - Tasks 5 to 7 use them through injected dependencies;
    - pins 15 to 18, 21 and 23 are revised, and the tests (a) to (f) are added.

    The plan records this as amendment P1.
