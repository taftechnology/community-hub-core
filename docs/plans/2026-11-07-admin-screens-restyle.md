Spec: docs/specs/2026-11-07-admin-screens-restyle.md

# Admin Screens Restyle Implementation Plan

Slug: admin-screens-restyle
Status: draft

> **For agentic workers:** one task = one commit, test first. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/`.

**Goal:** every admin screen renders from `packages/ui`, fits a 375px phone without sideways scrolling, and behaves as it does today, apart from the spec's three named exceptions.

**Architecture:**

- `packages/ui` gains 15 components, each with class-string and axe tests, and each rendered by a screen in this chunk.
- `apps/admin` screens swap their markup for those components. Gates, handlers, fetches and focus effects move with the markup and are not rewritten.
- `parsePersonDetail` gains `isAdultConfirmed`, which only `Avatar` reads.
- `docs/roadmap.md` and `AGENTS.md` line 9 close the chunk.

No table, column, migration, route, contract, permission, Terraform or workflow change.

## Who does what

- **Implementer:** Antigravity (Gemini), in worktree `wt-restyle` on the chunk branch. Tests first, one commit per task, commits locally, never pushes. One plan task per run, because this machine has 12 GB of RAM.
- **Reviewer agent:** Claude Code, Opus 5.5. Reviews each task by its diff, reruns its tests and runs that task's security pins.
- **Owner's check on this plan and on the PR:** Sonnet 5.5 or Fable 5.1, in a fresh session, arranged by the chunk owner.
- **Second review:** required by decision D3. It starts when the PR opens, on a model other than the reviewer's and the implementer's.
- **Superpowers:** if the plugin is not installed in the session that runs this plan, the PR says so. The briefs carry the same steps.

## Checkpoints

- **After Task 5** (`DataTable` on the first list, committed): the reviewer checks table semantics, `data-label` and pins 1, 10, 12, 15, 17, 20, 23, 24 and 25 before more screens move.
- **After Task 9** (Family Details and minors, committed): the reviewer reruns pins 2 to 9, 11, 13, 14, 18, 19, 21, 22, 26 to 30 and 39 to 41 before the forms move.

## Global constraints

- **Branch:** `feat/2026-11-07-admin-screens-restyle`, with the spec as its first commit and this plan as its second. The plan stays `Status: draft` until the owner's check has read both on the branch.
- **Start condition:** Task 1 waits until PR #81 merges, because #81 changes four test files this chunk also rewrites. The branch is then rebased on `origin/main` before the first task. It has not been pushed or applied, so a rebase is allowed.
- **Database:** none. No migration wave.
- **Dependencies:** none new. `@base-ui/react` and `lucide-react` are already in `packages/ui`.
- **Never disabled to get green:** a check, a lint rule, an axe rule, RLS or a CI gate.
- **Fixtures** are synthetic, and screenshots show invented people only.
- **No personal data** in URLs, logs, titles or `data-label`. `Panel` and `DataTable` titles never feed `ScreenTitle` or `document.title`.
- **Untouched areas:** `apps/api`, `apps/ops`, `infra/`, CI and the database. Staging stays parked.
- **Copy is frozen.** Words stay exactly as they are, including the colons in Contact Details labels, except for the spec's named changes.
- **Colour:** token utilities only. Existing pairs cover `StatusBadge` and `Avatar`, so `tokens.json` should not change. If a task needs a new pair, it adds it there and the tokens check must pass.
- **New `packages/ui` files** that adapt shadcn/ui keep the MIT header, as `input.tsx` does. Every new component is exported from `src/index.ts`. `opacity.test.ts` and `focus-classes.test.ts` scan new files too.
- **Test timing.** A new or moved check waits for the state it needs. No sleeps, longer timeouts, retries or fake timers. Each task reruns its admin test files under the timing probe from PR #81, at 25 ms (`.superpowers/sdd/race.*`, scratch, not committed).
- **A lost assertion is the main risk.** Each task's report lists every removed `expect(` line with its replacement. The reviewer checks that list against the diff. A selector may change. What it asserts may not.
- **Local gate per task:** in a fresh worktree run `pnpm install --frozen-lockfile` and `pnpm --filter "@community-hub/admin^..." build` first. Then run the task's named test files, `pnpm --filter @community-hub/ui test` when `packages/ui` changed, admin `typecheck` and `lint`, `pnpm exec prettier --check .` and `pnpm check:boundaries`. The whole of `pnpm gate` runs once, after the browser check and before Task 11, so any fix lands before the roadmap commit. This per-task subset is a §8 deviation (see Owner decisions).
- **Allowed failures on this Windows machine,** and only these: `packages/db/src/generate.test.ts` drizzle ENOENT, the `image-publish` symlink EPERM, and the `migrate.integration` and `plaintext-dist` timeouts.

## Decisions fixed by the spec (do not reopen)

- Users & Roles keeps ids and role keys. Minors' fields are unchanged and show as plain text to anyone with `people.restricted.read`.
- `ConfirmDialog`, `Dialog`, `Radio`, `Toast`, `Tabs` and `RestrictedBanner` do not ship. Guardian unlink stays inline.
- `DataTable` renders one `<table>` with explicit roles, and CSS makes the phone list from `data-label`, which is built from column headers only.
- `Select` and `Checkbox` are native, and `Switch` stays the native `input type="checkbox" role="switch"`.
- `Pagination` is cursor mode: "Next page", absent with no cursor, no Previous, no numbers or totals.
- `RestrictedValue` is a bold `—` marked `aria-hidden`, with hidden text "Household name hidden for your role" and native `title` "Hidden for your role". `None` is plain `muted-foreground` text.
- Search stays a submitted form with no debounce. Validation timing does not change.
- Contact Details and Family Details are one column. Headings keep their levels, and a heading that is a focus target stays mounted during loading, error and not-found.

## Calls made in this plan

- `StatusBadge` has no icon. The design's note gives it one, but the spec keeps today's words and the word already carries the meaning. The PR records this as a deviation.
- `DescriptionList` takes `{ term, value }` only. Nothing in this chunk needs the design's `state: hidden`, and `RestrictedValue` covers the one hidden value.
- "Household name" on Family Details stays a plain row, because the spec's Component map gives `DescriptionList` only to Contact Details and General Settings.

## Security pins

Baseline measured on 2026-11-07 at `59180e2`, by weakening today's source: 47 changes, 36 caught, 11 not. Nine of the 11 become `New` pins here, and two are named under the table. The other `New` pins cover behaviour this chunk adds. **Exists** means an existing test failed. **New** means no test failed, so the named task adds one. The implementer runs each change once after the task that moves the gate, sees the test fail, restores the source and reports it. The weakened tree is never committed.

| #   | Setting                                                                    | Source change                                    | Test that must fail                                                                                        | State  | Task |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------ | ---- |
| 1   | `people.restricted.read`: All Contacts Minors button                       | Condition becomes `true`                         | "Minors tab appears only with people.restricted.read (Pin 15)"                                             | Exists | 5    |
| 2   | `people.restricted.read`: `MinorsSection` mount                            | Drop the permission from the mount condition     | "defensively omits minors section when caller lacks people.restricted.read…"                               | Exists | 9    |
| 3   | `canRename`                                                                | Drop `canRestricted`                             | "hides 'Rename household' button when caller lacks people.restricted.read"                                 | Exists | 9    |
| 4   | `canMoveAdult`                                                             | Drop `canRestricted`                             | "hides 'Move adult' button when caller lacks people.restricted.read (Pin 21)"                              | Exists | 9    |
| 5   | `MinorsSection` `canAddMinor`                                              | Drop `canRestricted`                             | "independently hides 'Add minor' button in MinorsSection…"                                                 | Exists | 9    |
| 6   | `MinorsSection` `canLinkGuardian`                                          | Drop `canRestricted`                             | "independently hides 'Link guardian' button in MinorsSection…"                                             | Exists | 9    |
| 7   | `canUnlinkGuardian` on the inline confirm                                  | Drop `canRestricted`                             | "independently hides 'Unlink' button in MinorsSection…"                                                    | Exists | 9    |
| 8   | Page `canReadLifeEvents`                                                   | Drop `canRestricted`                             | "Pin 16: hides life events panel and sends no request without people.restricted.read"                      | Exists | 9    |
| 9   | `MinorsSection` `canReadLifeEvents`                                        | Drop `canRestricted`                             | New: rendered directly without the permission, no life events panel and no request                         | New    | 9    |
| 10  | All Contacts `people.view`                                                 | Drop it from the page gate                       | "shows not allowed and makes no list call when caller has canManage but lacks canView…"                    | Exists | 5    |
| 11  | Family Records `people.view`                                               | Drop it from the page gate                       | "shows Not allowed and makes no list call when caller lacks people.view"                                   | Exists | 7    |
| 12  | All Contacts `people.manage`                                               | Drop it from Add contact                         | "treats missing permission fields in access response as not allowed (Pin 15)"                              | Exists | 5    |
| 13  | Edit contact `people.manage`                                               | Drop it from Edit contact                        | "treats missing permission fields in access response as not allowed (Pin 15)"                              | Exists | 6    |
| 14  | Create household `people.manage`                                           | Drop it from `canCreate`                         | "hides 'Create household' button when caller lacks people.manage (Pin 21)"                                 | Exists | 7    |
| 15  | `people.directory` on All Contacts                                         | Drop it from the page gate                       | "shows not allowed and makes no list call when directoryEnabled is false (Pin 15)"                         | Exists | 5    |
| 16  | `people.directory` on Add Adult                                            | Drop it from `canAddAdult`                       | "hides 'Add adult' when people.directory entitlement is off"                                               | Exists | 10   |
| 17  | `hideWrites` on Add contact                                                | Drop it                                          | "hides Add and Edit controls when billing status is read_only (Pin 15)"                                    | Exists | 5    |
| 18  | `hideWrites` on Create household                                           | Drop it                                          | "read-only billing state hides write controls and shows read-only banner"                                  | Exists | 7    |
| 19  | `isReadOnly` on Unlink                                                     | Drop it from `MinorsSection` `canUnlinkGuardian` | New: `MinorsSection` rendered read-only shows no Unlink                                                    | New    | 9    |
| 20  | `activeTab` on the search form                                             | Condition becomes `true`                         | "Minors tab has no search box and never sends includeRestricted…"                                          | Exists | 5    |
| 21  | `canManage` to life events: adult mount, `MinorsSection` prop, minor mount | Each becomes `true`, one at a time               | "hides life event Add and Edit buttons while billing is loading or read-only…"                             | Exists | 8, 9 |
| 22  | `canEdit` in `LifeEventsPanel`                                             | Drop `canManage`, then drop `isReadOnly`         | New: `life-events.test.tsx` covers each input on its own                                                   | New    | 8    |
| 23  | `activeTab` on Add contact                                                 | Drop it                                          | "never provides create or edit control for a minor"                                                        | Exists | 5    |
| 24  | `submittedSearch` on Add contact                                           | Drop `(!submittedSearch \|\| items.length > 0)`  | New: a search with no results shows no Add contact                                                         | New    | 5    |
| 25  | `Avatar` on the Minors list                                                | Render it on every tab                           | New: a caller with `people.restricted.read` sees no `Avatar` on the Minors list                            | New    | 5    |
| 26  | `!detailPerson.isMinor` on Edit contact                                    | Drop it                                          | "never provides create or edit control for a minor"                                                        | Exists | 6    |
| 27  | `Avatar` on Contact Details                                                | `isAdultConfirmed` becomes `!value.isMinor`      | New: `isMinor` missing shows no `Avatar`; `isMinor: true` shows none                                       | New    | 6    |
| 28  | Household name cell                                                        | Swap `RestrictedValue` and `None`                | New: each caller sees the right one, with hidden text and `title`                                          | New    | 7    |
| 29  | New line on the Family Records list, both directions                       | Invert the `canRestricted` condition             | New: shows without the permission, beside "No households yet"; absent with it                              | New    | 7    |
| 30  | Family Details name row                                                    | Render the row when `label` is null              | New: no row with or without `people.restricted.read` when `label` is null                                  | New    | 9    |
| 31  | `canManageRoles`                                                           | `access.roles.manage` check removed              | "hides Grant, Revoke, and Delete without access.roles.manage"                                              | Exists | 2    |
| 32  | `canManageUsers`                                                           | `access.users.manage` check removed              | "hides Link without access.users.manage"                                                                   | Exists | 2    |
| 33  | Users & Roles `hideWrites`, five places                                    | Drop each, one at a time                         | "hides all write controls and shows read-only alert in none (pin 16)"                                      | Exists | 2    |
| 34  | Custom role limit                                                          | Drop `limitReached`                              | New: at 20 custom roles the create form is absent                                                          | New    | 2    |
| 35  | Module Toggles `canManage`                                                 | Drop it                                          | "renders the key without a switch when canManage is false or missing"                                      | Exists | 2    |
| 36  | Module Toggles `hideWrites`                                                | Drop it                                          | "hides toggle switch and shows read-only alert in none (pin 16)"                                           | Exists | 2    |
| 37  | `service_times.manage`                                                     | Drop it from `hasAccess`                         | New: permission off, entitlement on, fixed message and no request                                          | New    | 3    |
| 38  | `module.engagement`                                                        | Drop it from `hasAccess`                         | New: entitlement off, permission on, fixed message and no request                                          | New    | 3    |
| 39  | `people.households` on Family Records                                      | Drop it from the page gate                       | "shows Not allowed when caller lacks people.households entitlement"                                        | Exists | 7    |
| 40  | New line on Family Details, both directions                                | Invert the `canRestricted` condition             | New: shows without the permission, after the access gate; absent with it                                   | New    | 9    |
| 41  | `people.households` on `MinorsSection` life events                         | Drop it from the section `canReadLifeEvents`     | "Pin 16: hides life events panel and sends no request without people.households"                           | Exists | 9    |
| 42  | Page `canAddMinor`                                                         | Drop `canRestricted`                             | New: open add minor, re-render access without `people.restricted.read`, submit, and no request is sent     | New    | 10   |
| 43  | Page `canLinkGuardian`                                                     | Drop `canRestricted`                             | New: open link guardian, re-render access without `people.restricted.read`, submit, and no request is sent | New    | 10   |

**Not pinned, on purpose.** Two weakenings cannot change anything a test can see, and both stay as they are, because this chunk moves gates without rewriting them. The final PR names them.

- Dropping `people.households` from the page-level `canReadLifeEvents` (`family-records.tsx` line 590). Line 1409 already returns "Not allowed" without that entitlement, and pins 39 and 41 cover it.
- Dropping `canRestricted` from the page-level `canUnlinkGuardian` (line 598). Its handler starts only from the confirm inside `MinorsSection`, which unmounts without the permission. Pins 2 and 7 cover it.

**The earlier test that overstates its reach.** The test "renders — for household label when label is null (unrestricted caller or unlabelled)" claims to cover both callers but covers only one. Task 7 corrects its title and adds the missing case.

**Restricted data must-fail test.** Tasks 5, 7 and 9 each render their screen as a caller without `people.restricted.read`, against a fixture household that holds a minor, and assert that no minor's name, date of birth or marker appears.

## Rollback

Revert the merge commit. There is no data or infrastructure change to undo.

## Stop and ask (AGENTS.md §12)

Stop and report, without improvising, if:

- a task needs a change to `apps/api`, `apps/ops`, `infra/`, CI, a migration, a dependency or a contract;
- a behaviour test can only pass by changing what it asserts;
- a gate cannot move with its markup unchanged;
- a screen needs a word this spec does not name;
- the design's rule and the spec disagree (the spec wins, so report the difference);
- a new colour pair fails the contrast check;
- the same step fails twice.

---

### Task 1: `Field`, and sign-in

**Files:** `packages/ui/src/field.tsx`, `field.test.tsx`, `field.a11y.test.tsx`, `index.ts`; `apps/admin/src/sign-in.tsx`, `sign-in.test.tsx`

- [ ] Test first: `Field` joins label, help and error with `htmlFor`, `aria-describedby` and `aria-invalid`, merges with an `aria-describedby` the control already has, and uses the control's own `id` when it has one.
- [ ] Add a must-fail sign-in test that Email and Code each render through `Input` (`data-slot="input"`).
- [ ] Build `Field` for one child control. Move Email and Code to `Field` and `Input`. The sign-in card, "Sign-in failed" and "Directory unavailable" stay as they are.
- [ ] Commit `feat(ui): add Field and use it on sign-in`.

**Rule:** no sign-in behaviour, focus or message changes.

### Task 2: `Panel`, `Checkbox`, `Switch`, Users & Roles, Module Toggles

**Files:** `packages/ui/src/panel.tsx`, `checkbox.tsx`, `switch.tsx`, with their tests, `index.ts`; `apps/admin/src/users-roles.tsx`, `users-roles.test.tsx`, `module-toggles.tsx`, `module-toggles.test.tsx`

- [ ] Test first: `Panel` renders `level` h2 by default, h3 to h5 when asked, no heading when untitled, and passes `ref` and `tabIndex` to the heading. `Checkbox` keeps its accessible name, is 18px, and has a 44px hit area on touch. `Switch` keeps `role="switch"` and native change handling.
- [ ] Add pin 34.
- [ ] Users & Roles: untitled `Panel`s around today's groups, `Field` and `Input` for the raw inputs, `Checkbox` for the permission checkboxes. Today's lists, ids and notices stay.
- [ ] Module Toggles: one untitled `Panel`, one `Switch` per module, labelled with today's key. Without `canManage` or with writes hidden, the key stays plain text.
- [ ] Run pins 31 to 36. Commit `feat(ui): add Panel, Checkbox and Switch for Users & Roles and Module Toggles`.

**Rule:** the `Switch` word stays the module key (recorded deviation). No new headings.

### Task 3: `DescriptionList`, `StatusBadge`, General Settings, Billing, Mass Times

**Files:** `packages/ui/src/description-list.tsx`, `status-badge.tsx`, with their tests, `index.ts`; `apps/admin/src/general-settings.tsx`, `general-settings.test.tsx`, `service-times.tsx`, `service-times.test.tsx`

- [ ] Test first: `DescriptionList` renders a real `dl`, with `dt` and `dd` pairs. `StatusBadge` carries its word, and each tone uses its spec pair: Active `primary-ink` on `tint`; Payment retrying and In grace period `warning-ink` on `warning-tint`; Read-only `destructive-ink` on `destructive-tint`; No active subscription `muted-foreground` on `muted`.
- [ ] Add pins 37 and 38.
- [ ] General Settings: `Panel` and `DescriptionList`. Billing stays an `h2`. State uses `StatusBadge` with today's word. The invoiced line and the banner's two alerts and slot stay.
- [ ] Mass Times: wrap the screen in one `Panel`. The diff to `service-times.tsx` is that wrapper and nothing else.
- [ ] Commit `feat(ui): add DescriptionList and StatusBadge for settings and billing`.

**Rule:** no change to `service-times.tsx` logic.

### Task 4: `DataTable` and list parts

**Files:** `packages/ui/src/data-table.tsx`, `filter-bar.tsx`, `pagination.tsx`, `empty-state.tsx`, `skeleton.tsx`, `avatar.tsx`, with their tests, `index.ts`

- [ ] Test first for `DataTable`: columns take `{ key, header, render, primary, srHeader }`; explicit `role` on the table, rows and cells; `data-label` equals the header and never holds a row value; cells can wrap; axe passes. It composes the existing `Table` parts, which stay exported and unchanged.
- [ ] Test first for the rest: `FilterBar` keeps a submitted form with no debounce. `Pagination` shows "Next page" only with a cursor. `EmptyState` takes one sentence. `Skeleton` is `aria-hidden` and has no `status` role. `Avatar` is `aria-hidden`, gives one name the same tone every time, and never writes the name to `title`.
- [ ] Commit `feat(ui): add DataTable and list parts`.

**Rule:** no change to `apps/admin` in this task.

### Task 5: All Contacts list

**Files:** `apps/admin/src/all-contacts.tsx`, `all-contacts.test.tsx`

- [ ] Add pins 24 and 25 and the restricted must-fail test.
- [ ] All Contacts list: the card layout from the Screens table, on the Adults list, with `Avatar` in the first column. `DataTable`, `FilterBar`, `Pagination`, `EmptyState`, and `Skeleton` marked `aria-hidden` with no loading words, as the list has none today. Adults and Minors buttons stay above the card, with `Contact types`, `aria-pressed` and the Minors gate.
- [ ] Run pins 1, 10, 12, 15, 17, 20 and 23. Commit `feat(admin): restyle the All Contacts list`, then stop for the checkpoint.

**Rule:** no search term in a URL, no change to when requests are sent.

### Task 6: Contact Details, add and edit

**Files:** `apps/admin/src/all-contacts.tsx`, `all-contacts.test.tsx`

- [ ] Add pin 27, with `Boolean(value.isMinor)` kept for the Edit gate and a test that a missing `isMinor` keeps today's Edit behaviour.
- [ ] `parsePersonDetail` gains `isAdultConfirmed: value.isMinor === false`. Only `Avatar` reads it.
- [ ] Contact Details: one `Panel` with `Avatar`, today's Edit action, and `DescriptionList` for today's labels with their colons. `None` stays where it shows today. `Skeleton` shows while loading, with "Loading contact details..." kept as hidden text in a plain `<span>`.
- [ ] Add and Edit: `Panel`, `Field` and `Input` in `ContactFields`. Heading refs, conflict, Reload and alert focus stay as they are.
- [ ] Run pins 13 and 26. Commit `feat(admin): restyle Contact Details and its forms`.

**Rule:** focus-target headings stay mounted during loading, error and not-found.

### Task 7: Family Records list, `RestrictedValue`

**Files:** `packages/ui/src/restricted-value.tsx`, with its tests, `index.ts`; `apps/admin/src/family-records.tsx`, `family-records.test.tsx`

- [ ] Test first for `RestrictedValue`: bold `—` marked `aria-hidden`, the hidden text, the native `title`, and a look different from `None`.
- [ ] Correct that test title. Add a test that a caller with `people.restricted.read` and an unnamed household sees `None`.
- [ ] Add pins 28 and 29, and the restricted must-fail test. Pin 29 covers: rendered only after the access gate passes, and beside "No households yet".
- [ ] List: `DataTable`, `Pagination`, `EmptyState`, `Skeleton`, with "Loading households..." kept as hidden text in a plain `<span>`, and the new line in `Alert live="polite"`. "View household" keeps its name.
- [ ] Run pins 11, 14, 18 and 39. Commit `feat(admin): restyle the Family Records list`.

**Rule:** the raw id in the move adult list stays. `billing-banner.test.tsx` still passes untouched.

### Task 8: Life events

**Files:** `apps/admin/src/life-events.tsx`, `life-events.test.tsx`; `packages/ui/src/select.tsx`, `textarea.tsx`, with their tests, `index.ts`

- [ ] Test first: `Select` is a native styled `select`, and `Textarea` a native styled `textarea`, with axe tests.
- [ ] Add pin 22. Change the test for empty Place and Notes from `-` to `None`.
- [ ] Panel: `DataTable`, `Select`, `Textarea`, `Field`, `EmptyState`, `Skeleton`. The headings stay `h4` and `h5`. The table's `aria-label` keeps today's wording.
- [ ] Run pin 21 for the panel's props. Commit `feat(admin): restyle life events`.

**Rule:** the panels stay in both places they mount today. The person's name stays out of titles and URLs.

### Task 9: Family Details

**Files:** `apps/admin/src/family-records.tsx`, `family-records.test.tsx`

- [ ] Add pins 9, 19, 30 and 40, and the restricted must-fail test.
- [ ] `Panel`s in the board's order: household details, Adults (`h3`), Minors and Guardians (`h3`). Back to list and Rename household at the top right. Add adult, Add minor and Link guardian in their own `Panel` head.
- [ ] Adult members, Minor members and Guardian links each become a `DataTable` with today's columns and names. Adult members gets `Avatar` in its first column. Minor members never does.
- [ ] `Skeleton` shows while loading, with "Loading household details..." kept as hidden text in a plain `<span>`.
- [ ] The new line shows on this screen in `Alert live="polite"`, after the access gate, with the same words as the list.
- [ ] Guardian unlink keeps its inline confirm in the row, with today's words, gate and focus.
- [ ] Run pins 2 to 9, 19, 21, 30, 40 and 41. Commit `feat(admin): restyle Family Details`, then stop for the checkpoint.

**Rule:** `MinorsSection` keeps its own gates. Life events panels stay after Adult members and inside `MinorsSection`.

### Task 10: Family forms

**Files:** `apps/admin/src/family-records.tsx`, `family-records.test.tsx`

- [ ] Test first: the move adult `Select` keeps its existing `aria-describedby` through `Field`.
- [ ] Add pins 42 and 43. Each test renders through `PeopleAccessContext.Provider`, so access can change while the form is open.
- [ ] Create, rename, Add Adult, move adult, add minor and link guardian: one `Panel` each, `Field`, `Select`, `Checkbox`. Add Adult uses `FilterBar`, `DataTable`, `EmptyState` and `Skeleton` for its search. Add Adult's and move adult's paging sentences stay plain text.
- [ ] Report the result of searching `apps/admin/src`, excluding tests, for `<Table`, `<select`, `<textarea`, `<input` and `type="checkbox"`. Each must be gone, or be inside a `packages/ui` component.
- [ ] Run pin 16. Commit `feat(admin): restyle the family forms`.

**Rule:** add minor and link guardian keep their conditions and messages.

## Browser check before Task 11 (no commit)

The screens run against a local stub API, rebuilt in `.superpowers/` and never committed. It copies the real contract shapes, including `minors` absent rather than empty.

- Every screen under the spec's Screens table, at 1280px and 375px, in light and dark.
- No sideways scroll at 375px, visible keyboard focus, and axe on the rendered page.
- Each caller: with and without `people.restricted.read`; billing read-only.
- All Contacts, Contact Details and Family Details beside their boards.

Fixes go in as their own `fix(admin):` commits before Task 11. The reviewer then runs `pnpm gate`, and any fix from that also lands before Task 11. Screenshots of invented people go in the PR. The PR names the §8 deviation: this check ran against a stub, not the staging hostname.

### Task 11: Catalogue (last task on this branch)

**Files:** `docs/roadmap.md`, `AGENTS.md` (line 9 only)

- [ ] `admin-screens-restyle` **done**. Take out the row's walk follow-ups, sign-in sentence and Users & Roles clause, and the open item "The admin shell has no layout or styling to speak of".
- [ ] Add Phase 2 rows, each **not started**: `Users & Roles people details` (sensitive), `Add Adult create`, `People screens: Laravel parity` (listing what the spec's Out section lists), and `admin-screens-proof` (published build on the real publish path, and the `0013`–`0018` checks).
- [ ] Snapshot: last shipped, next chunk, counts. Update `AGENTS.md` line 9, as earlier chunk-closing commits did. The spec's Docs bullet does not list it, so the PR names it as a consistency edit.
- [ ] Run the §5 cleanup: `rm -f docs/plans/*-report.md; git status --short`.
- [ ] Commit `docs: mark admin-screens-restyle done`.

After Task 11, the reviewer reruns `pnpm exec prettier --check .` and `pnpm check:boundaries`, pushes, and only then opens the PR. A fix CI needs after that follows the roadmap commit, as AGENTS.md §4 allows.

## Owner decisions

These are answered once, at plan approval.

1. **Next chunk after this one:** `admin-screens-proof`, unless Abdus says otherwise.
2. **Configurations:** implementer Antigravity (Gemini); reviewer Claude Code, Opus 5.5; owner's check and second review on Sonnet 5.5 or Fable 5.1.
3. **Deviation policy:** extra attempts and actor changes are recorded as deviations in the PR. Cosmetic nits are noted in the PR, not as open items.
4. **Open items carried by the new rows:** Users & Roles people details, Add Adult create, People screens: Laravel parity, and the proof chunk.
5. **Per-task gate (§8 deviation):** each task runs the subset under Global constraints, and `pnpm gate` runs once before Task 11, because this machine has 12 GB of RAM. The PR records this.
6. **Size:** 11 tasks, one over the usual ten, because Task 4 was split so its diff can be read in one sitting. The PR records this.

## Probe record

None. There is no Terraform in this chunk.

## Amendments after approval

None yet.
