Spec: docs/specs/2026-11-16-user-invitations-fixes.md

# User invitations fixes Implementation Plan

Slug: user-invitations-fixes
Status: draft

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** close the five gaps the spec names before any parish uses invitations. A failed resend erases the address it extended. Two API tests prove the sweep crosses organisations through the real identity adapter. The grant and link forms need both view permissions. The accept screen sends a signed-out person to sign in and keeps the invitation. Every invitation denial records a purpose that names the missing permission.

**Architecture:** no schema, contract, port, dependency or workspace package changes.

- `modules/core/access/infrastructure/invitations.ts`: each `deny` passes its purpose; the list check is split in two.
- `apps/api/src/invitation-routes.ts`: a typed denial map and `checkActorPermissions` signature; resend compensation.
- `apps/api/src/invitations.integration.test.ts`: an `app` pool proxy for fault injection, used only by the routes' `checkout`; the compensation and cross-organisation sweep tests.
- `apps/admin/src/users-roles.tsx` and `accept-invitation.tsx`: the form gates and the accept-screen sign-in.
- `docs/roadmap.md` and `AGENTS.md` line 9: this chunk done.

## Who does what

- **Implementer:** Antigravity (Gemini 3.8 Flash High), in `C:\Recovered\Taftech\wt-invitation-fixes` on the chunk branch.
  - It writes tests first, makes one commit per task, commits locally and never pushes.
  - It runs one plan task per run (12 GB of RAM on this machine).
  - For every Security pins row its task names, it writes the weakening as a `.patch` file under `.superpowers/sdd/pins/` and adds the row to `.superpowers/sdd/pins/manifest.json` (the `pinrun.mjs` format). The reviewer runs them. It does not hand-run and report pin output. This departs from AGENTS.md §4 Phase 2 ("the implementer runs each change once"), by owner decision 3; the PR body records it.
  - Every claim of a test result in its report points to a log file it wrote with `tee` under `.superpowers/sdd/task-N-logs/`. A claim without a log counts as not run.
  - It starts with no AWS credentials, and pushes are blocked by the push URL and the pre-push hook.
- **Reviewer agent:** this session, on Claude Opus 5.5 for the whole chunk.
  - Each task is reviewed by its diff, with the tests re-run and every named pin run through `pinrun.mjs`.
  - A fresh-context reviewer subagent on the same model reviews each task's diff.
  - Plan check 1 is such a pass. It does not count as the owner's check.
- **Owner's check and second review:** the chunk owner runs these in a fresh session on Claude Sonnet 5.5, GPT or Grok. Never Opus, never Gemini 3.8 Flash.
  - If any task falls back to another implementer (for example Sonnet when Antigravity is out of usage), that model is excluded too, and the reviewer says so before the next check.
- **Docker test database:** one run at a time. Tasks 1, 2 and 3 need it; Tasks 4 and 5 do not.

## Checkpoints

- **After Task 3** (all server work): the reviewer runs pins 1a to 22 (every sub-id, about 25 minutes of Docker time) together on the Task 3 commit, then the chunk owner runs an owner's check of Tasks 1 to 3 before Task 4 starts.
- **After Task 5** (the admin): the reviewer runs pins 23 to 31 and repeats both admin test files five times.

## Global constraints

- **Branch:** `fix/2026-11-16-user-invitations-fixes`, created from `origin/main` at `290cc67` (PR #86 merged). The spec is its first commit (`0b98e2f`), and this plan is its second. The plan stays `Status: draft` until the chunk owner approves it.
- **Untouched:** migrations and every `packages/db/drizzle` file; `packages/contracts`; identity and tenancy source; Terraform, workflows, `infra/`, the Dockerfile; `grants.ts` and its `deny` default; every route other than the five invitation routes. Staging stays parked.
- **Dependencies:** none added. **Workspace packages:** none added.
- **Never disabled to get green:** a check, a lint rule (no `eslint-disable` of any kind), an axe rule, RLS, a test or a CI gate. No `@ts-ignore` or `@ts-expect-error`.
- **Fixtures** are synthetic: invented names, `example.test` addresses, tokens built at run time. No literal token-shaped or secret-shaped string is committed.
- **No personal data** in logs, error bodies, URLs or audit rows. The new compensation log line carries exactly `route`, `step`, `errorClass` and `requestId`.
- **Build order:** `apps/api` tests import the built `dist` of `@community-hub/access`. After changing access source, run `pnpm --filter @community-hub/access build` before the `apps/api` tests.
- **Local gate per task:** on this Windows machine `pnpm gate` stops at the allowed `@community-hub/db#test` failure before `check:boundaries` (`tooling/checks/gate/cli.ts:16-22`), so each task runs instead `pnpm format && pnpm lint && pnpm typecheck && pnpm exec turbo run test --continue --force; pnpm check:boundaries`, tees it to its log folder, and reads the turbo summary for any failure other than the allowed ones. Bypass the turbo cache (`--force`) when a test reads a file outside its package. When memory forces a narrower run, the task still runs `pnpm exec prettier --check .`, `pnpm check:boundaries`, `pnpm lint` and `pnpm typecheck`, plus the named package tests.
- **Allowed failures on this Windows machine,** and only these: `packages/db/src/generate.test.ts` drizzle ENOENT; the `image-publish` symlink EPERM; the `migrate.integration` and `plaintext-dist` timeouts; the identity `tsbuildinfo.test` 5 s timing flake. Use `turbo --continue` so one allowed failure does not stop the dependents.
- **Admin tests:** no real waits; exact call counts; a new test file section is repeated five times green before the task is reported.

## Decisions fixed by the spec (do not reopen)

1. Compensate after a failed resend; do not reorder the refresh after the commit.
2. A compensated resend voids the invitation. Close runs first and on its own, then `voidInvitationAfterMailFailure` in a new app transaction with the request's scope.
3. The flag is set when the wrapped `refresh` returned `true` or threw, never around the whole `resendInvitation` call.
4. The answer after compensation is the unchanged mapped status, or 500.
5. A missing `people.view` is audited as `people.person.view`. No new audit purpose.
6. The route's unknown-permission fallback becomes a typecheck error plus a runtime throw.
7. The invitation token stays in memory; it never returns to the address bar, `history.state`, storage, a cookie or a log.
8. Every other accept failure keeps "Something went wrong. Try again." with the token held.

## Security pins

Each row is a weakening the implementer writes as a patch and the reviewer runs through `node ~/.claude/crew/bin/pinrun.mjs .superpowers/sdd/pins/manifest.json --only <id>`. The weakened run must fail **on an assertion** in the named test; the restored run must pass. A weakening of `modules/core/access` used by an `apps/api` test lists `@community-hub/access` under `build`. The weakened tree is never committed.

Files: **R** = `apps/api/src/invitation-routes.test.ts` (unit config); **I** = `apps/api/src/invitations.integration.test.ts` (`vitest.integration.config.ts`); **A** = `modules/core/access/infrastructure/invitations.integration.test.ts`; **U** = `apps/admin/src/users-roles.test.tsx`; **X** = `apps/admin/src/accept-invitation.test.tsx`.

| #   | Setting                                                               | Weakening                                                                                                                     | File | Test that must fail (exact `it` title)                                                 |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| 1a  | Route: missing `people.view` → `people.person.view`                   | Map `people.view` to `access.users.manage` in the denial map                                                                  | R    | every route denial writes a registered audit purpose                                   |
| 1b  | same                                                                  | same                                                                                                                          | I    | route denials are audited in the database                                              |
| 2   | Route: every checked permission is mapped (typecheck)                 | Delete the `people.view` key from the map                                                                                     | —    | `pnpm --filter @community-hub/api typecheck` fails (reviewer runs by hand, not pinrun) |
| 3   | Create: missing `access.users.manage`                                 | Drop the purpose argument at the first `deny` in `createInvitation`                                                           | A    | create without users.manage                                                            |
| 4   | Create: missing `access.roles.manage` with a role                     | Pass `access.users.manage` at the second `deny`                                                                               | A    | create with a role without roles.manage                                                |
| 5   | Create: missing `people.view` with a contact                          | Drop the purpose argument at the third `deny`                                                                                 | A    | create with a contact without people.view                                              |
| 6a  | List: missing `access.users.view`                                     | Merge the two list checks back into one bare `deny`                                                                           | A    | list without users.view                                                                |
| 6b  | List: missing `access.roles.view`                                     | Drop the purpose argument at the second list `deny`                                                                           | A    | list without roles.view                                                                |
| 7   | List: check order users.view then roles.view                          | Swap the two list checks                                                                                                      | A    | list without either view permission                                                    |
| 8   | Resend: missing `access.users.manage`                                 | Drop the purpose argument in `resendInvitation`                                                                               | A    | resend without users.manage                                                            |
| 9   | Revoke: missing `access.users.manage`                                 | Drop the purpose argument in `revokeInvitation`                                                                               | A    | revoke without users.manage                                                            |
| 10  | Delete-after-mail-failure: missing `access.users.manage`              | Drop the purpose argument in `deleteInvitationAfterMailFailure`                                                               | A    | delete after mail failure without users.manage                                         |
| 11  | Void-after-mail-failure: missing `access.users.manage`                | Drop the purpose argument in `voidInvitationAfterMailFailure`                                                                 | A    | void after mail failure without users.manage                                           |
| 12a | `roleGrantAllowed` denial (built-in role) keeps `access.roles.manage` | Pass `access.users.manage` at the built-in-role `deny` (`invitations.ts:163-165`)                                             | A    | create with a built-in role above the inviter keeps roles.manage                       |
| 12b | `roleGrantAllowed` denial (custom role) keeps `access.roles.manage`   | Pass `access.users.manage` at the custom-role `deny` (`invitations.ts:186-193`)                                               | A    | create with a custom role above the inviter keeps roles.manage                         |
| 13  | Compensation closes the address                                       | Remove the close step                                                                                                         | R    | resend compensates when refresh succeeded and the transaction then failed              |
| 14a | Compensation voids the invitation                                     | Remove the void step                                                                                                          | R    | resend compensates when refresh succeeded and the transaction then failed              |
| 14b | same                                                                  | same                                                                                                                          | I    | a failed resend transaction erases the address and voids the invitation                |
| 15a | Close runs before void                                                | Swap the two steps                                                                                                            | R    | resend compensation closes before it voids                                             |
| 15b | A failed close does not skip the void                                 | Put close and void in one `try`                                                                                               | R    | resend compensation still voids when the close fails                                   |
| 16a | A thrown `refresh` counts as refreshed                                | Set the flag only when `refresh` returned `true`                                                                              | R    | resend compensates when refresh threw                                                  |
| 16b | `refresh` returning `false` does not count                            | Set the flag on every `refresh` call, whatever it returned                                                                    | R    | resend does not compensate when refresh returned false                                 |
| 17a | The flag is set only inside `refresh`                                 | Set the flag before calling `resendInvitation`                                                                                | R    | resend with an unknown invitation does not compensate                                  |
| 17b | same, against the real repository (tenant safety)                     | same                                                                                                                          | I    | a resend of another organisation's invitation leaves its address alone                 |
| 18a | Compensation in the outer catch                                       | Remove compensation from the outer `catch`                                                                                    | R    | resend compensates after a rejected commit                                             |
| 18b | same                                                                  | same                                                                                                                          | I    | a failed resend transaction erases the address and voids the invitation                |
| 18c | same                                                                  | same                                                                                                                          | I    | a lost resend acknowledgement still erases the address and voids the invitation        |
| 19  | Compensation in the `AccessError` branch                              | Remove compensation from the `outcome instanceof AccessError` branch                                                          | R    | resend compensates on a mapped error after refresh                                     |
| 20a | Compensation log carries no message                                   | Add `message: String(error)` to the compensation log fields                                                                   | R    | resend compensation logs only route, step, error class and request id                  |
| 20b | Compensation runs once                                                | Remove the `compensated` guard                                                                                                | R    | resend compensation runs once                                                          |
| 21  | Sweep in list is region-wide                                          | Remove `await addresses.sweep(now)` from `listInvitations`                                                                    | I    | a list in org B erases org A's expired address                                         |
| 22  | Sweep in create is region-wide                                        | Remove `await addresses.sweep(now)` from `createInvitation`                                                                   | I    | a create in org B deletes org A's 31-day-old row                                       |
| 23  | Grant form needs `access.users.view`                                  | In the grant gate only (`users-roles.tsx:705`), replace the shared condition with `permissions.includes("access.roles.view")` | U    | hides the grant form without access.users.view                                         |
| 24  | Grant form needs `access.roles.view`                                  | In the grant gate only, replace the shared condition with `permissions.includes("access.users.view")`                         | U    | hides the grant form without access.roles.view                                         |
| 25  | Link form needs `access.users.view`                                   | In the link gate only (`:742`), replace the shared condition with `permissions.includes("access.roles.view")`                 | U    | hides the link form without access.users.view                                          |
| 26  | Link form needs `access.roles.view`                                   | In the link gate only, replace the shared condition with `permissions.includes("access.users.view")`                          | U    | hides the link form without access.roles.view                                          |
| 27  | 401 keeps the token                                                   | Call `clearInviteToken()` on 401                                                                                              | X    | a 401 sends the person to sign in and keeps the invitation                             |
| 28  | 401 navigates to sign-in                                              | Fall through to `failed` on 401                                                                                               | X    | a 401 sends the person to sign in and keeps the invitation                             |
| 29  | No router state carries the token                                     | Navigate with `{ replace: true, state: { token } }`                                                                           | X    | a 401 sends the person to sign in and keeps the invitation                             |
| 30  | No access token before sending → sign-in                              | Remove the `readAccessToken() === null` check                                                                                 | X    | with no session it goes to sign in without sending                                     |
| 31  | A network failure with a session is not "signed out"                  | Treat every `"unavailable"` as signed out                                                                                     | X    | keeps the token after a network failure (existing, `:494`)                             |

Manifest notes:

- The last column is the exact `it` title, with no prefix, and the manifest's `test` field uses the same text. Every title is unique in its file.
- Entries for file **I** use `"config": "vitest.integration.config.ts"`. Weakenings of `modules/core/access` run by an `apps/api` test (pins 17b, 21 and 22) list `"build": ["@community-hub/access"]`.
- Pins 23 to 26 weaken one form's gate only. They never edit the shared `canViewUsersAndRoles` constant, which would fail both forms' tests and stop isolating one condition.
- The round-trip test in Task 5 ("after a 401 and sign-in the person can accept") is a behaviour test with no pin of its own: its only plausible weakening is caught by pin 28.
- **Not pinned, by design:** the route's runtime throw for an unmapped permission. It is unreachable once the map is typed (pin 2 covers the compile-time side), and reaching it would need a production seam.

## Rollback

- Revert the pull request's merge commit. Resend then stops compensating (the 7-day window returns), the forms show on manage alone, the accept screen shows the generic sentence on 401, and denial purposes return to the old values.
- No migration or data change. Audit rows already written stay (append-only, ids only).

## Stop and ask (AGENTS.md §12)

The implementer stops and reports, without improvising, when:

- the plan is wrong or ambiguous, or the code does not match a pointer in it;
- a migration, a contract change, a dependency, a workspace package, a Dockerfile, a workflow or a Terraform change looks necessary;
- a production seam would be needed only so a test can run (the `app` proxy in Task 2 lives in the test file only);
- a test it wrote passes before the source change it is meant to drive, except: Task 3's two tests, and the tests of pins 4, 12a, 12b, 16b and 17a, which pin behaviour that does not change. Their proof is the pin. The report lists them as "passes before the change, by design";
- the same step fails twice;
- anything would put personal data or a token in a log, an error body, a URL path or query, `history.state`, storage or an audit row;
- a secret, token or account identifier appears in any file or output.

### Task 1: Denial purposes

**Commit:** `fix(access): name the missing permission in invitation denials`

**Files:**

- `modules/core/access/infrastructure/invitations.ts`: each `deny` passes its purpose per spec §5 (lines 117, 120, 123, 356, 441, 489, 528); the check at `:290-292` becomes two checks, `access.users.view` first, then `access.roles.view`. The `roleGrantAllowed` denials (`:164`, `:192`) keep `access.roles.manage`, written explicitly.
- `modules/core/access/infrastructure/invitations.integration.test.ts`: a new `describe("denial purposes")`, one `it()` per row of pins 3 to 12, including 6b ("list without roles.view", whose actor holds `access.users.view` only, as the `users_view_only` fixture at `:1518-1544` does), named exactly as in the pins table. Fixtures: pin 3's actor holds no `access.users.manage`; pin 4's holds `access.users.manage` only and passes a role key; pin 5's holds `access.users.manage` and passes any uuid as `personId` (the denial comes before the person lookup, `:122-124`); pin 6a's custom role holds `access.roles.view` only; pin 7's actor is a plain member with no grant (as at `:1393-1400`); pins 8 to 11 need no `access.users.manage`, and pins 10 and 11 need no invitation row (`loadActor` then `deny` come first, `:487-490`, `:526-529`), so any uuid will do. Pin 12a's actor is a custom role holding `access.users.manage` and `access.roles.manage` that invites with `roleKey: "org_owner"` (built-in denial, `:163-165`); pin 12b's same actor invites with a custom role that holds a permission the actor lacks (custom denial, `:186-193`). Pattern: `bootstrapOwner`, `addMember` an actor with a custom role that has every needed permission but the one under test (`:1433-1451`); inside one `runInCommunity`, call the function, catch the `AccessError` (`forbidden`), then in the **same** transaction select `purpose` from `app.audit_events` where `action = 'access.permission.denied'` and the actor is the test actor, and assert exactly one row with the expected purpose. Catching inside the transaction keeps the row (the transaction is not aborted by a JavaScript error).
- `modules/core/access/domain/manifest.test.ts:72-77`: add `people.person.view`.
- `apps/api/src/invitation-routes.ts`:
  - `DENIAL_PURPOSES` (`:41-46`) becomes `const DENIAL_PURPOSES = { "access.users.manage": …, "access.users.view": …, "access.roles.manage": …, "access.roles.view": …, "people.view": "people.person.view" } as const satisfies Record<string, string>`, and `type InvitationPermission = keyof typeof DENIAL_PURPOSES`.
  - `checkActorPermissions` (`:228-232`) takes `readonly InvitationPermission[]`; each caller's list (create's `requiredPerms` at `:324-330`, list at `:480-483`, resend `:569-571`, revoke `:687-689`) is typed with it.
  - `:242` writes `DENIAL_PURPOSES[perm]`. A runtime guard throws `new Error("unmapped invitation permission")` if the lookup is `undefined`.
- `apps/api/src/invitation-routes.test.ts`: the purpose set at `:1201-1206` gains `people.person.view`; `:1268-1270` expects `people.person.view`.
- `apps/api/src/invitations.integration.test.ts:901-904`: expects `purpose = 'people.person.view'`.

**Test first:** the new access tests (RED: purposes read `access.roles.manage`), the inverted route and integration assertions (RED), then the source.

**Rule it must not break:** no denial status changes; no other module's denial changes; the existing invitation suites stay green.

**Pins run:** 1a to 12b (patches and manifest rows only; the reviewer runs them).

### Task 2: Resend compensation

**Commit:** `fix(api): erase the address when a resend fails after its refresh`

**Files:**

- `apps/api/src/invitation-routes.ts`, the resend handler (`:540-655`):
  - Declare `baseAddresses`, `refreshed`, `compensated`, and `let scope` / `let actorId` before the handler's `try`, as create declares its state before its `try` (`:291-297`); fill `scope` and `actorId` as soon as they are known (`:556-567`); define `compensate()` before the `try` too, so the outer `catch` can call it. `compensate()` does nothing unless `refreshed` is true, so it never needs them earlier. Use the route's validated `invitationId` for `close` and the void input.
  - Wrap `baseAddresses` as create does (`:343-353`): an `addresses` object whose `refresh` calls the base, sets `refreshed = true` when it returns `true`, and in a `catch` sets `refreshed = true` and rethrows. Pass this wrapped object to `resendInvitation`.
  - A local `compensate()` that runs at most once (`compensated` flag), only when `refreshed`:
    1. `try { await baseAddresses.close(invitationId) } catch (e) { deps.log("compensation", { route: "invitations.resend", step: "close", errorClass: errorClassFor(e), requestId }) }`;
    2. `try { await deps.checkout("app", (sql) => withAppTransaction(sql, scope, (tx) => voidInvitationAfterMailFailure(tx, baseAddresses, { invitationId, actorUserId: actor.userId, now: deps.now() }))) } catch (e) { … step: "void" … }`.
  - Call it in the `outcome instanceof AccessError` branch before mapping, and in the outer `catch` before mapping. `invitationId` is the parsed id `refresh` was called with; `scope` and `actor` are the request's own.
- `apps/api/src/invitation-routes.test.ts`: a new `describe("resend compensation")`, one `it()` each:
  - "resend compensates when refresh succeeded and the transaction then failed": `resendInvitation` mock calls `addresses.refresh({ invitationId: input.invitationId, expiresAt })` then throws; 500, empty body; `closeInvitationEmail` once with the id; `voidInvitationAfterMailFailure` once with `{ invitationId, actorUserId, now }`; the void's `withAppTransaction` scope equals the request's.
  - "resend compensation closes before it voids": `invocationCallOrder` of the close is lower than the void's.
  - "resend compensates when refresh threw": `refreshInvitationEmail` rejects; same assertions.
  - "resend compensates after a rejected commit": the `db.withAppTransaction` mock rejects only for the call whose callback called `refreshInvitationEmail` (the resend's; the billing guard and permission calls come before it). It runs the callback, then rejects. The compensation's void (the next call) resolves normally.
  - "resend compensates on a mapped error after refresh" (defensive): the mock refreshes then throws `AccessError("invitation_not_found")`; 404 as today, plus compensation. And the committed `forbidden` variant (`COMMIT_ON_ERRORS`); 403, plus compensation.
  - "resend does not compensate when refresh returned false": `refreshInvitationEmail` resolves `false`, the mock throws `invitation_not_found` as the real code does; 404; no close, no void.
  - "resend with an unknown invitation does not compensate": the mock rejects `invitation_not_found` without calling `refresh`; no close, no void.
  - "resend compensation still closes when the void fails" and "resend compensation still voids when the close fails": status unchanged; the other step ran once.
  - "resend compensation runs once": the mock calls `addresses.refresh(...)` and then throws an unmapped `AccessError` (for example `"invalid_role"`), so the `AccessError` branch compensates and calls `logInternalError`; `deps.log` throws once on its first `"request"` call, which sends control to the outer `catch`. Assert one close, one void and a 500.
  - "resend compensation logs only route, step, error class and request id": the logged fields equal exactly those four keys; no message, SQL text or stack.
  - The existing success and mail-failure tests stay unchanged (no compensation on success).
- `apps/api/src/invitations.integration.test.ts`:
  - A test-only fault switch: `const fault = { mode: "off" as "off" | "rollback" | "after_commit", identitySeen: false }`. The routes' `checkout` (`:216-224`) returns, for role `app`, a proxy of `app` whose `begin(fn)` calls the real `begin` with a callback that resets `identitySeen = false` first (the one reset point, for both modes: the session read sets it before any app checkout), runs `fn`, and then, if `fault.mode === "rollback"` and `identitySeen`, sets `fault.mode = "off"` and throws `new Error("injected rollback")`. `checkout("identity", …)` sets `identitySeen = true`. For `"after_commit"`, `checkout("app", run)` awaits `run(proxy)`, and if `identitySeen` was set during it, sets `fault.mode = "off"` and throws `new Error("injected lost acknowledgement")`. The helpers (`inScope`, `setupOwner`, `createAdult`, `addMember`) keep the raw `app`. Every test that does not arm it is unaffected. Add `afterEach` to the file's vitest import (`:1-37`). An `afterEach` resets `fault.mode = "off"` and `identitySeen = false`, so an armed test that fails early cannot leak into the next one.
  - "a failed resend transaction erases the address and voids the invitation": invite in one org, arm `rollback`, resend; 500; the identity row has `email`, `email_bidx`, `dedupe_key` null and `closed_at` set; the app row is `void`; exactly one `access.invitation.voided` audit row for it; `fault.mode` is `off` afterwards.
  - "a lost resend acknowledgement still erases the address and voids the invitation": the same with `after_commit`.
  - "a resend of another organisation's invitation leaves its address alone": invite in org A; org B's owner posts `/v1/access/invitations/resend` with org A's `invitationId`. Assert 404 with `invitation_not_found`; org A's identity row still has `email`, `email_bidx` and `dedupe_key` non-null and `closed_at` null; org A's app row is still `pending`; no `access.invitation.voided` audit row in org A. (The real row select at `invitations.ts:359-381` is scoped by org and community and throws before `refresh` at `:412`.)

**Test first:** the route unit tests (RED: no compensation), then the integration tests (RED), then the handler change.

**Rule it must not break:** the resend success path, its mail-failure path and every other invitation test are unchanged; no new log line on success.

**Pins run:** 13 to 20b and 17b (patches and manifest rows only).

### Task 3: Cross-organisation sweep through the real adapter

**Commit:** `test(api): sweep other organisations' invitation addresses through the real adapter`

**Files:** `apps/api/src/invitations.integration.test.ts` only.

- "a list in org B erases org A's expired address": create orgs A and B, owners and sessions; invite in org A; then, as the last step before the call, set org A's row `expires_at` to a value computed in JavaScript, `new Date(Date.now() - 60 * 60 * 1000)`, through `identitySql` (the sweep compares with the API's clock, and the Docker clock may drift from it); then exactly one request, a list in org B. Assert org A's row has `email`, `email_bidx`, `dedupe_key` null and `closed_at` **null**.
- "a create in org B deletes org A's 31-day-old row": create orgs A and B; invite twice in org A and revoke both; then, last, set their `closed_at` to `now() - interval '31 days'` and `now() - interval '29 days'`; then exactly one request, a create in org B. Assert the 31-day row is gone and the 29-day row remains.
- No other invitation request between the ageing and the call. A comment says why: every invitation action sweeps region-wide.

**Test first:** these tests pin existing behaviour, so they pass at once. Their proof is pins 21 and 22: the task writes the two patches and manifest rows, and the reviewer runs them.

**Rule it must not break:** the file's other tests (they share the database, and the ageing touches only this test's rows).

**Pins run:** 21, 22.

### Task 4: Grant and link forms need both view permissions

**Commit:** `fix(admin): show the grant and link forms only with both view permissions`

**Files:**

- `apps/admin/src/users-roles.tsx` (`:529-533`): `canViewUsersAndRoles = permissions.includes("access.users.view") && permissions.includes("access.roles.view")`; the grant form (`:705`) needs `canManageRoles && canViewUsersAndRoles`, the link form (`:742`) `canManageUsers && canViewUsersAndRoles`. Nothing else changes.
- `apps/admin/src/users-roles.test.tsx`:
  - four new tests, each with every other permission present: "hides the grant form without access.users.view", "hides the grant form without access.roles.view", "hides the link form without access.users.view" (Link and Unlink both absent), "hides the link form without access.roles.view";
  - existing fixtures whose caller permissions lack a view permission while the test needs Grant, Link or Unlink get the view permissions added. Two checks measured 16 to 18 such tests in this file and none elsewhere; the owner's plan check measured these 16: "clears rows and write controls when switching to a community that answers 403"; "hides Grant while status is loading after switching to a read_only community"; "hides Grant, Revoke, and Delete without access.roles.manage"; "hides Link without access.users.manage"; "hides the create custom role form without access.roles.manage"; "ignores a 402 mutation response that arrives after switching community"; "keeps write controls visible and hides read-only alert when billing status is unknown or fails"; "pin 46: grant and link forms have no text input named User and the select lists the users"; "resets read-only blocked state when switching community after a 402 write"; "sends the selected user id and contact in the link body"; "sends the selected user id in the grant body"; "shows Invite someone first and disables the user select when the users list is empty"; and "shows write controls and no alert in" grace, invoiced, ok and retrying. Confirm the set by running the suite after the source change. Three of them ("hides Grant, Revoke…", "hides Link…", "hides the create custom role form…") are negative tests that fail only because their fixture also expects the other form; check each still fails for its own reason after the fixture change. Assertions are not changed. Negative tests that expect a form absent are checked to still fail for their own reason.

**Test first:** the four new tests (RED), then the gate.

**Rule it must not break:** every other Users & Roles behaviour; the contact picker keeps its own `people.view` condition.

**Pins run:** 23 to 26 (patches and manifest rows only). Repeat the file five times green.

### Task 5: Accept screen sends a signed-out person to sign in

**Commit:** `fix(admin): send a signed-out person to sign in from the accept screen`

**Files:**

- `apps/admin/src/accept-invitation.tsx`, in `accept()`:
  - Before `post`: if `readAccessToken() === null`, set the phase to `idle` and `navigate("/sign-in", { replace: true })`; send nothing; keep the token.
  - After `post`: if the response is a `Response` with status 401, set the phase to `idle`, keep the token, and `navigate("/sign-in", { replace: true })`. No `state` argument.
  - Every other outcome is unchanged, including `"unavailable"` while an access token is present.
- `apps/admin/src/accept-invitation.test.tsx`, a new `describe("signed out")`:
  - "a 401 sends the person to sign in and keeps the invitation": `installFetch` answers accept with 401. After the click: pathname `/sign-in`; the invited heading is shown; `getInviteToken()` equals the token; `window.location.hash` is empty; `JSON.stringify(window.history.state)` does not contain the token; no storage write contains it (the spy pattern at `:208`).
  - "with no session it goes to sign in without sending": mount, clear the access token from session storage, click; pathname `/sign-in`; no accept request in the recorded calls; token held.
  - "after a 401 and sign-in the person can accept": `installFetch` with accept answering 401 on the first call and 200 after (a counter, as the test at `:468` does); `mountAccept()`, click Accept; assert pathname `/sign-in` and the invited heading; fill Email and Code **on the already-mounted screen** with a local helper that neither navigates nor renders (`signInThroughForm()` renders a second `<Shell />` and cannot be used here); click Verify; wait for pathname `/` and the Accept button; click it; assert pathname `/settings/users` and exactly two accept calls, both with `{ token }`. A behaviour test with no pin of its own.
  - The existing "keeps the token after a network failure" (`:494`) and generic-sentence tests (`:397`, `:406`) stay unchanged.

**Test first:** the three new tests (RED), then the screen.

**Rule it must not break:** every existing accept and sign-in test; a normal sign-in with no token still lands on `/settings/users`.

**Pins run:** 27 to 31 (patches and manifest rows only). Repeat the file five times green.

### Task 6: Roadmap and repository state

**Commit:** `docs: mark user-invitations-fixes done`

**Files:**

- `docs/roadmap.md`:
  - a `done` row below `User invitations` for `User invitations fixes`, citing this spec and plan;
  - snapshot: last shipped `user-invitations-fixes`, next `Add Adult create`;
  - remove the "Accept follow-up" open item (`:320`);
  - add an open item: create's lost-acknowledgement window (spec owner decision 7) is a candidate for a later chunk; a process that dies between a resend's refresh and its compensation leaves the address until its expiry, until the scheduled sweep exists.
- `AGENTS.md:9`: add `User invitations fixes` to the done list. No other change.
- The `AGENTS.md:9` edit and the two new open items are not in the spec's Scope list. They follow precedent (`373c5ec` did the same) and record spec owner decision 7.

**Rule it must not break:** `pnpm exec prettier --check .`; no decision text changes, so no ADR and no `architecture.md` edit.

**Pins run:** none.

## Definition of done (AGENTS.md §8)

- All six tasks are accepted by the reviewer agent, every pin in the table has been run by the reviewer, and CI is green on the pull request.
- The tenant-isolation tests touched (Tasks 1 to 3) are green.
- **Not done in this chunk:** the staging-hostname check, because staging stays parked (spec Out-of-band, §8 deviation accepted by the chunk owner).
- The PR body records: implementer Antigravity (Gemini 3.8 Flash High) and any fallback; reviewer agent Claude Opus 5.5; the owner's spec check (Sonnet 5.5, draft 4; the earlier Gemini check of draft 2 noted as not counted); the owner's plan and checkpoint checks with their models; the second-review line.
- Session scratch is cleaned up: no `docs/plans/*-report.md`, and nothing under `.superpowers/` staged.

## Owner decisions

For the chunk owner, answered at plan approval:

1. **Six tasks, one PR.** Recommendation: keep.
2. **Checkpoint owner's check after Task 3** (all server and database work), on Sonnet 5.5, GPT or Grok. Recommendation: keep; the admin tasks then go to the final review only.
3. **Pins run by the reviewer through `pinrun.mjs`,** the implementer writing patches only (as from Task 8 of PR 86). This departs from AGENTS.md §4 Phase 2, which has the implementer run each weakening; the PR body records it. Recommendation: keep, because PR 86's implementer reported pin output it had not produced.
4. **Deviation policy:** extra attempts, implementer changes and fix commits are recorded as deviations in the PR; cosmetic nits as PR notes.

Nothing here needs the project owner.

## Spec pointer corrections

The approved spec cites `apps/api/src/access-routes.ts:489-490` for the `access.roles.view` refusal on `grants/list`; the check is at `:528-529`. Behaviour is unaffected; the implementer uses the real line.

## Probe record

This plan has no Terraform assert, so no scratch probe is needed (AGENTS.md §4). No database weakening edits a migration.
