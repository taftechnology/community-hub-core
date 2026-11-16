# Spec: User invitations fixes

Slug: user-invitations-fixes
Status: approved (2026-11-16, Adnan Bin Hossen)
Architecture refs: §6.3, §11.1, §11.2, §12.1, §12.3; ADR 0009; AGENTS.md §1 rules 1, 2, 5; §2; §6; §8; §12. Follows `docs/specs/2026-11-14-user-invitations.md` (amendments A5, A6, A8).

**Sensitive chunk** (authentication, tenancy, privacy of invitation addresses). It needs a second fresh-context review on a model that differs from every implementer model used in this chunk and from the reviewer agent's (AGENTS.md §2). No exception this time.

## Problem

The project owner's pre-merge check of PR 86 found three things to fix before any parish uses invitations. The second review and the PR notes left two more.

1. **A failed resend can keep an address alive.** `resendInvitation` calls `addresses.refresh` (`modules/core/access/infrastructure/invitations.ts:412`). The route builds that adapter on its own `deps.checkout` (`apps/api/src/invitation-routes.ts:580-584`), so the new identity expiry commits at once, before the app transaction. If the audit append or the app commit then fails, `app.invitations` keeps its old expiry, but `identity.invitation_emails` keeps the address for up to 7 more days. Create already compensates for the same shape (`invitation-routes.ts:367-378`, `:417-428`). Resend does not.
2. **A5 tests (a) and (c) do not cross the real adapter.** They call `sweepInvitationEmails` directly or check a stub. No API test shows that an invitation action in one organisation erases or deletes another organisation's identity rows.
3. **Grant and link forms show on manage alone.** `apps/admin/src/users-roles.tsx:705` shows the grant form on `access.roles.manage`, and `:742` shows the link form on `access.users.manage`. The approved spec (`2026-11-14-user-invitations.md:172`) hides the grant form unless the caller also holds `access.users.view` and `access.roles.view`, because the user picker reads the users list, which needs both. The link form uses the same picker.
4. **An expired session on the accept screen looks like a failure.** When `POST /v1/invitations/accept` answers 401, `apps/admin/src/api.ts:107-108` clears the access token, and the accept screen falls to `failed` (`accept-invitation.tsx:70`) and shows "Something went wrong. Try again." (`:155`). Trying again cannot work: with no access token, `post` returns `"unavailable"`, and the screen shows the same sentence. The person has to know to sign in again. (Roadmap open item, PR 86 notes.)
5. **Invitation denials are audited under the wrong purpose.**
   - In the route, `checkActorPermissions` writes `access.permission.denied` with purpose `access.users.manage` when `people.view` is missing (`invitation-routes.ts:242`), because `people.view` is not in `DENIAL_PURPOSES`. (Second review of PR 86, Low.)
   - In the repository, a bare `deny(tx, id)` records `access.roles.manage`, the default in `modules/core/access/infrastructure/grants.ts:15`, `:170-174`. Every bare `deny` in `invitations.ts` therefore records `access.roles.manage`, whatever is missing:

     | Line | Function                           | Missing permission                                     | Purpose written now   |
     | ---- | ---------------------------------- | ------------------------------------------------------ | --------------------- |
     | 117  | `createInvitation`                 | `access.users.manage`                                  | `access.roles.manage` |
     | 120  | `createInvitation`                 | `access.roles.manage`                                  | `access.roles.manage` |
     | 123  | `createInvitation`                 | `people.view`                                          | `access.roles.manage` |
     | 291  | `listInvitations`                  | `access.users.view` or `access.roles.view` (one check) | `access.roles.manage` |
     | 356  | `resendInvitation`                 | `access.users.manage`                                  | `access.roles.manage` |
     | 441  | `revokeInvitation`                 | `access.users.manage`                                  | `access.roles.manage` |
     | 489  | `deleteInvitationAfterMailFailure` | `access.users.manage`                                  | `access.roles.manage` |
     | 528  | `voidInvitationAfterMailFailure`   | `access.users.manage`                                  | `access.roles.manage` |

   - These repository checks run only when a permission is revoked between the route's check and the action's transaction. For create, list, resend and revoke the row then persists, because `forbidden` commits (`invitation-routes.ts:158`, `:264-266`).

## Scope

In:

- Resend compensation in the route, as create does.
- Two API integration tests of the cross-organisation sweep, through the real identity adapter.
- The two extra permission conditions on the grant and link forms, with UI tests.
- The accept screen sends a signed-out person to sign in and keeps the invitation.
- Every invitation denial records a purpose that names the missing permission.
- The roadmap: this chunk done, the accept 401 open item removed.

Out:

- The race between `grantCustomRole` and `deleteCustomRole` (a pre-existing 23503 that answers 500, on `main` before PR 86). It is in the access roles code, not invitations, and gets its own fix.
- The scheduled sweep (waits for the first regional scheduler chunk, A5 retention point 5).
- Production SES, and any staging proof (see Out-of-band).
- Any change to create, list, revoke or accept beyond the denial purposes.
- The default purpose of `deny` in `grants.ts`, and every other module's denials.
- Any schema change, and any new audit purpose.

## Behaviour

### 1. Resend compensation

**When it runs.** The route wraps `baseAddresses.refresh` the way create wraps `create` (`invitation-routes.ts:292`, `:344-353`), and sets a flag when `refresh` **returned `true` or threw**. A throw may come after the identity update committed (a lost acknowledgement), so it is treated as refreshed. The route does not compensate when `refresh` returned `false`: resend then answers `invitation_not_found` as today (A6), and nothing was refreshed.

**Why compensation is tenant-safe.** `closeInvitationEmail` filters on `invitation_id` only, because identity has no `org_id`. The flag is set only inside the wrapped `refresh`, and `resendInvitation` calls `refresh` only after its row select, which is scoped to the caller's organisation and community (`invitations.ts:359-386`). A resend with another organisation's invitation id fails with `invitation_not_found` before `refresh`, so it never compensates. The flag must not be set around the whole `resendInvitation` call.

If the flag is set and the resend does not commit cleanly, for any reason, the route compensates. The reasons are an `AccessError` that rolls back, an `AccessError` that commits (`COMMIT_ON_ERRORS`), a thrown error, and a failed commit. Compensation is placed in both the `outcome instanceof AccessError` branch and the outer `catch`, as create does (`:367-378`, `:417-428`), and runs at most once per request.

**What it does**, in this order, each step best-effort:

1. **Close the address in identity.** `baseAddresses.close(invitationId)` in its own identity checkout, with the parsed invitation id `refresh` was called with. This sets `email`, `email_bidx` and `dedupe_key` to null and stamps `closed_at` (`modules/core/identity/infrastructure/invitation-email.ts:203-216`). It runs first and on its own, so the address is erased even if step 2 fails.
2. **Void the pending invitation.** In a new `withAppTransaction(sql, scope, …)` with the request's own `scope` and `actor.userId`, the existing `voidInvitationAfterMailFailure` (`invitations.ts:519-560`). It re-checks `access.users.manage`, voids the row only while it is `pending`, calls `close` again (harmless: `close` is idempotent), and writes `access.invitation.voided`. If the actor lost `access.users.manage` meanwhile, its denial row rolls back with that transaction; step 1 has already erased the address.

Each step catches its own error and logs `deps.log("compensation", { route: "invitations.resend", step: "close" | "void", errorClass, requestId })`, with no message, SQL, host or stack. A failed step never changes the answer.

**The answer is unchanged:** the mapped status for a mapped `AccessError`, otherwise 500. After a compensated resend the invitation shows as void, so staff invite again. That is the same outcome as a resend whose mail failed. The mail-failure path after a committed resend is unchanged.

**Accepted edge cases.** Each fails closed: no address outlives its invitation.

- **Lost commit acknowledgement.** If the app commit succeeded but its acknowledgement was lost, the route still compensates, and the committed resend ends void.
- **Concurrent resends.** Resend locks the row `for update` (`invitations.ts:380`). If request A refreshes and then fails, request B (waiting on the lock) may resend, commit and mail before A compensates. A's compensation then closes the address and voids B's invitation.
- **`refresh` threw before changing anything.** A transient identity error also sets the flag. If identity recovers before compensation, the invitation is voided although nothing was extended; staff invite again. On `main` today the invitation would stay usable. If identity is still down, `close` fails, the void's own `close` throws, the void rolls back, and nothing changes.
- **Close succeeded, void failed.** The invitation stays `pending` with no address. The list shows "Address removed"; accept answers `wrong_address` (A8); resend answers `invitation_not_found`, because `refresh` returns false; revoke still works; the row is purged after expiry (A3).

### 2. Cross-organisation sweep through the real adapter

Two API integration tests in `apps/api/src/invitations.integration.test.ts`, using the real `identityInvitationAddresses` through the test-owned `checkout`, not a stub. The harness runs on a wall clock, so rows are aged by updating `expires_at` and `closed_at` directly through the identity connection.

- (a) **Expiry erases across organisations.** Org A has a pending invitation. Its identity row's `expires_at` is moved into the past (`closed_at` stays null). A caller in org B calls `POST /v1/access/invitations/list`. Afterwards org A's row has `email`, `email_bidx` and `dedupe_key` null, and `closed_at` **still null** (expiry erases, it does not close; A5 retention point 2).
- (c) **Old rows are deleted across organisations.** Org A has two revoked invitations. Their identity rows' `closed_at` are moved to 31 and 29 days ago. A caller in org B calls `POST /v1/access/invitations/create`. Afterwards the 31-day row is gone and the 29-day row remains.

Each test creates both organisations, owners, sessions and org A's invitations first, ages the identity rows last, and makes no other invitation request between the ageing and the single call under test, because every invitation action sweeps region-wide (`invitations.ts:129`, `:287`, `:352`, `:437`, `:493`, `:532`, `:719`). Test (a) must fail when the `addresses.sweep(now)` call is removed from `listInvitations`, and test (c) when it is removed from `createInvitation`. The plan names those two deletions as the weakenings.

### 3. Grant and link forms

On Users & Roles:

- The grant form shows when the caller holds `access.roles.manage`, `access.users.view` and `access.roles.view`, and writes are not hidden.
- The link form (Link and Unlink) shows when the caller holds `access.users.manage`, `access.users.view` and `access.roles.view`, and writes are not hidden.
- If either view permission is missing, both forms are hidden, as the approved spec says ("there is nothing to pick"). Unlink is hidden with Link, because it uses the same user picker. The contact picker inside the link form keeps its own `people.view` condition.
- Nothing else on the screen changes. The API already refuses these writes on the server; this is the UI rule only.
- A real directory always carries `access.roles.view`, because `POST /v1/access/grants/list` refuses callers without it (`apps/api/src/access-routes.ts:489-490`). The `access.roles.view` condition is defence in depth, and its UI test uses a synthetic directory.
- Existing users-roles tests whose directory fixture lacks a view permission but expects Grant or Link (for example `apps/admin/src/users-roles.test.tsx:700-708`, `:1207-1265`) get the missing view permissions added to the fixture. Their assertions keep their meaning. These ranges are examples; the plan finds the full set by running the suite.

### 4. Accept screen with no session

When the accept screen gets a 401 from `POST /v1/invitations/accept`, or finds no access token before it sends (`readAccessToken() === null`, checked before calling `post`):

- It keeps the invitation token in memory (`invite-token.ts`). It does not clear it.
- It sets the phase back to idle, then navigates to `/sign-in`, replacing the history entry, with no router `state`, so the token never enters `history.state`.
- The sign-in screen already shows "Sign in with the address this invitation was sent to" when a token is held (`shell.tsx:56-69`). After sign-in it already returns to `/`, which is the accept screen (`sign-in.tsx:76-77`).
- The person then presses Accept again. Nothing is accepted without that press, so there is no loop.

The token stays in memory only. It is **not** written back to the address bar as `#invite=`, or to storage, a cookie, a URL, the console or a log, as `main.tsx` and `invite-token.ts` require today. A full page reload still loses it, as today; the person opens the emailed link again.

Every other failure keeps today's behaviour: "Something went wrong. Try again." with the token kept. That includes `post` returning `"unavailable"` while an access token is present (a network failure, or missing directory origins).

### 5. Denial purposes

Every `access.permission.denied` row written for a missing permission, on the invitation routes and in `invitations.ts`, records a purpose that names that permission:

| Missing permission    | Purpose               |
| --------------------- | --------------------- |
| `access.users.manage` | `access.users.manage` |
| `access.users.view`   | `access.users.view`   |
| `access.roles.manage` | `access.roles.manage` |
| `access.roles.view`   | `access.roles.view`   |
| `people.view`         | `people.person.view`  |

- Audit purposes have three dot-separated parts (`packages/kernel/src/audit-names.ts:1`, and the database check in `packages/db/drizzle/0002_rare_jimmy_woo.sql:26`), so `people.view` cannot be a purpose. A missing `people.view` is already audited as `people.person.view` elsewhere (`apps/api/src/people-routes.ts:32`, `:256-262`; `modules/core/access/infrastructure/restricted-read.ts:11-12`), and the access module already registers it (`modules/core/access/public/index.ts:38`). No new purpose is registered.
- In the route, `DENIAL_PURPOSES` becomes a typed map from each permission the invitation routes check to its purpose, keyed by `InvitationPermission` (the union of the table's left column). `checkActorPermissions` takes `readonly InvitationPermission[]` instead of `string[]` (`invitation-routes.ts:228-232`), and each route's `requiredPerms` is typed with it, so an unmapped permission fails typecheck. The fallback to `access.users.manage` (`invitation-routes.ts:242`) is replaced by a throw, as a backstop that answers 500 rather than writing a misleading row. No current call reaches it.
- In `invitations.ts`, every `deny` for a missing permission passes its purpose from the table: lines 117, 120 and 123 in create; 356, 441, 489 and 528 (`access.users.manage`). The combined check in `listInvitations` (`:291`) is split into two checks, `access.users.view` first and then `access.roles.view`, in the route's order (`invitation-routes.ts:480-483`), so a caller missing both is recorded under the same purpose by both.
- The `roleGrantAllowed` denials in `createInvitation` (`:164`, `:192`) are not about one missing permission and keep `access.roles.manage`.
- The registry test (`modules/core/access/domain/manifest.test.ts:72`) adds `people.person.view`.
- Two existing tests pin the old purpose and are inverted: `apps/api/src/invitation-routes.test.ts:1201-1206` and `:1268-1270`, and `apps/api/src/invitations.integration.test.ts:893-904`.

### Empty, error and offline states

Covered above: compensation never changes the answer; the accept screen's network failure is unchanged; the forms are hidden, not disabled, when a view permission is missing.

## Data

No new table, column or migration. No classification changes.

The identity row closed by compensation is the existing `identity.invitation_emails` row (`confidential` address, `confidential-blind` indexes, A5). Compensation only erases.

## Rules touched

- **Permissions:** the grant and link forms add `access.users.view` and `access.roles.view` (UI only). No server permission changes.
- **Audit:** no new purpose. Denial rows on invitation paths name the missing permission.
- **Privacy and retention:** a failed resend no longer extends an address's life (A5 retention).
- **Residency:** unchanged. All calls stay in the regional service.
- **Safeguarding:** unchanged. The contact rule (adults only) is not touched.

## Contracts

- No route, request or response shape changes.
- Status codes are unchanged, including after compensation.
- No new audit action or purpose.
- No events, ports, website collections, islands or blocks.

## Risks

| Risk                                                                                | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compensation does not run on one of the failure paths.                              | Route unit tests (the suite that mocks the repository, as pin 51 does for create, `invitation-routes.test.ts:827-858`) prove close-then-void order, arguments, scope, one compensation per request and the unchanged status for: `resendInvitation` calling `refresh` then throwing; a rejected commit; and `refresh` throwing. Two more cases are defensive, forced by the mock, and not reachable in the real repository, which throws every `AccessError` before `refresh` (`invitations.ts:355-357`, `:389-391`): an `AccessError` that rolls back after `refresh` returned `true`, and a committed `forbidden` after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The compensation only looks right in mocks.                                         | Integration tests. One resend request makes several app transactions (the billing guard, the permission check, the resend, then the compensation's void), and each commits inside `sql.begin` (`packages/db/src/app-transaction.ts:10-14`), so a hook around the test-owned `checkout`'s `run` cannot roll one back. The test passes the routes an `app` pool proxy whose `begin(fn)` runs `fn` and, when armed and when `checkout("identity", …)` was called during `fn`, throws after `fn` returns, so postgres.js rolls the transaction back. It disarms on first use. The guard and permission transactions make no identity call, and the resend transaction's first identity call is `sweep`, so the resend transaction is the first to match; the void then runs normally. The test asserts the identity row (`email`, `email_bidx`, `dedupe_key` null, `closed_at` set), the app row (`void`), the status (500), and exactly one `access.invitation.voided` audit row. A second variant throws after `run(app)` returns, once the resend transaction has committed (the lost-acknowledgement case), and expects the same end state: address erased, invitation `void`. |
| The process dies or times out between `refresh` and compensation.                   | Not mitigated in-process: compensation is best-effort, so the address lives until its new identity expiry. The scheduled sweep (A5 point 5, out of scope) is the backstop. Residual, recorded here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| The void step fails and the address survives.                                       | A route unit test makes the void step fail and still sees `close` called first, once, with the same id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Compensation closes an address that was never refreshed.                            | A route unit test where `refresh` returns `false` sees no `close` and no void. Another, where `resendInvitation` rejects with `invitation_not_found` without calling `refresh` (a foreign or unknown id), sees no `close` and no void.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The sweep is not region-wide and the tests pass anyway.                             | The two tests use two organisations and the real adapter. Removing the sweep call from `listInvitations` must fail (a); removing it from `createInvitation` must fail (c).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A form shows on manage alone again.                                                 | One UI test per missing view permission, per form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The token reaches the address bar, history, storage or a log on the way to sign-in. | The accept test asserts, after the 401, that the location has no fragment, `history.state` holds no token, and the token is still held. The existing storage and URL assertions in the accept tests stay, and so do the "clears the token" tests (`accept-invitation.test.tsx:421-466`). A new test asserts the token is **not** cleared on 401.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A network failure is read as signed out and loses the person's place.               | A test with an access token and a network failure stays on the accept screen with the failure sentence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A denial purpose is wrong or unregistered.                                          | A route test denies create-with-contact for a missing `people.view` and reads `people.person.view`. Repository integration tests call each function in `invitations.ts` with an actor missing the permission and read the purpose, one per row of the table. The registry test asserts every mapped purpose is registered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Out-of-band

- **Staging stays parked.** No chunk resource is added and nothing is unparked. Behaviour is verified by the integration suite and the admin tests, not on the staging hostname, as for PR 86. This is a deviation from AGENTS.md §8 for the chunk owner to accept.
- **Production SES** is still needed before a parish uses invitations. Unchanged by this chunk.
- No legal sign-off, architecture change, ADR or new subprocessor.

## Owner decisions

For the chunk owner (Adnan). Defaults are what this draft says.

1. **Compensate, not reorder.** The draft compensates after a failed resend, as the project owner asked and as create does. The alternative, refreshing identity only after the app commit, leaves the reverse gap: a committed resend whose refresh fails sends a link that no longer matches a live address.
2. **A compensated resend voids the invitation.** Staff invite again. The alternative, restoring the old expiry, needs the old value carried across two stores and is harder to prove. The invitee's earlier link stops working too, because the old row is voided. The accepted edge cases in §1 follow from this.
3. **The token stays in memory, not in `#invite=`.** Your note said "preserving `#invite=<token>`". Putting it back in the address bar would undo the PR 86 rule that the router and history never see it. The draft keeps it in memory, which already survives the move to sign-in and back.
4. **A missing `people.view` is audited as `people.person.view`.** Your note said "the dedicated denial purpose". `people.view` cannot be a purpose (three-part names), and `people.person.view` is what the people routes already write for the same denial.
5. **Repository denials are fixed too**, not only the route's (the table in Problem 5). The unknown-permission fallback becomes a typecheck error plus a throw.
6. **Staging stays parked** (§8 deviation, above).
7. **A thrown `refresh` counts as refreshed.** A lost acknowledgement means the expiry may have been extended, so the draft compensates, at the cost of voiding a valid invitation after a transient identity error (the fourth accepted edge case in §1). The alternative is to compensate only when `refresh` returned `true`, as create does for `create`, which leaves the lost-acknowledgement window open. Create keeps that asymmetry: it flags only when `create` returned `ok` (`invitation-routes.ts:346-352`), so an address whose `createInvitationEmail` committed and then threw survives until its expiry. Create is out of scope here; that window is a candidate for a later chunk.

No item here needs the project owner.
