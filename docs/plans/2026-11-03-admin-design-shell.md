Spec: docs/specs/2026-11-03-admin-design-shell.md

# Admin Design Shell Implementation Plan

Slug: admin-design-shell
Status: approved (2026-11-03, Adnan Bin Hossen)

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** every current admin screen renders inside the agreed design's sidebar and top bar, in light and dark, on the design's tokens and font, at 36px controls (44px on touch), with visible focus and axe passing. Staff can sign out, and signing out ends their session family on the server.

**Architecture:**

- `packages/tokens` takes the design's token contract, including a `decorative` list and the dark selectors.
- `packages/ui` gets:
  - the self-hosted font;
  - corrected Button, Input and Table primitives;
  - a widened opacity check;
  - eight shell components.
- `modules/core/identity` gets `endSession`.
- `packages/contracts` and `apps/api` get `POST /v1/auth/session/end`.
- `apps/admin` moves into `AppShell`, takes screen titles into the top bar, puts sign-in in its own layout, and wires Sign out.
- The docs get ADR 0016, the architecture fix and the roadmap.

## Who does what

- **Implementer:** Antigravity (Gemini), in its own worktree on the chunk branch. It writes tests first, makes one commit per task, commits locally and never pushes. It runs one plan task per run, because this machine has 12 GB of RAM.
- **Reviewer:** a fresh-context Claude session, reviewing each task by its diff.
- **Owner's check and second review:** from a third model family, arranged by the owner.
- Only one run at a time uses the Docker test database.

## Checkpoint

After Task 4 (the server sign-out is complete, before any admin wiring), the reviewer runs the weaken-and-fail table for pins 1–9. The reviewer accepts or returns the work before Task 5 starts.

## Global constraints

- **Branch:** `feat/2026-11-03-admin-design-shell`, created from `origin/main` after this plan is approved, with the spec and plan as its first commit.
- **Database:** no migration, no new table or column.
- **Values:** every token value comes from the design's `tokens.json`, version `1793646986-2cfc`. A copy sits in the session scratchpad and goes into the Task 1 brief. Never import or copy `components/bundle.js` or `bundle.css`. They are reference only.
- **Scope:** no screen layout changes. A screen gives up its own `<h1>` and nothing else. Every existing screen test passes with no behaviour assertion removed or weakened.
- **No third-party request at runtime:** no Google Fonts and no CDN. Fonts are emitted into `dist/assets`, never inlined as `data:` URIs.
- **No personal data or token** in URLs, logs, traces, storage keys or error text. The only query flag is the fixed `signout=unconfirmed`.
- **Fixtures** are synthetic. Fixture strings that look like secrets are split, so scanners never match.
- **Untouched areas:** staging stays parked; no Terraform, workflow or Dockerfile change. A new workspace dependency is re-checked against `apps/api/Dockerfile` and `image.test.ts` (the api image must not need it).
- **Dependencies:** only the two the spec names, `@fontsource/source-sans-3` and `lucide-react`, each pinned exactly.
- **Never disabled to get green:** a check, a lint rule or an axe rule. Every new component carries an axe test.
- **Admin stale-response rules** apply to any new fetch, which in this chunk is sign-out:
  - a generation guard on every response;
  - every guard pinned by a test that fails without it;
  - non-200 answers with JSON bodies covered;
  - a StrictMode render test;
  - no real waits;
  - exact call counts.
- **Local gate per task:** `pnpm gate`, after `pnpm install --frozen-lockfile` and `pnpm build` in a fresh worktree. When a brief skips the full gate for memory, it still runs `pnpm exec prettier --check .` and `pnpm check:boundaries`.
- **Allowed failures on this Windows machine,** and only these:
  - `packages/db/src/generate.test.ts` drizzle ENOENT;
  - the `image-publish` symlink EPERM;
  - the `migrate.integration` and `plaintext-dist` timeouts.

## Decisions fixed by the spec (do not reopen)

- `base-nova` stays. The copied Button, Input and Table sources change:
  - sizes: 36px, 44px under `pointer: coarse` and below 640px, 32px for row buttons;
  - solid `*-hover` fills;
  - a solid destructive fill;
  - a solid 2px ring with a 2px offset.
- `--ch-*` stays. The `space`, `fontSize` and `fontWeight` groups stay. `--font-sans` and other Tailwind names live only in `theme.css`. `radius-pill` stays `999px`. `rgba()` is allowed only for decorative roles.
- The decorative list is exactly: `border`, `control-border`, `control-border-hover`, `tint-border`, `destructive-border`, `warning-border`, `info-border`, `restricted-border`, `sidebar-border` and `scrim`. A decorative role is never also in a pair.
- The theme follows the system with nothing stored. The toggle is two-state. Storage uses `localStorage` key `community-hub.theme`.
- Dark values are emitted under:
  - `[data-theme="dark"]`;
  - `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`.

  There is no inline script.

- Section headings show at eight or more rows in the scrolling middle. The pinned foot doesn't count.
- The sign-out handle is kept in `sessionStorage` key `community-hub.signout-handle`. A data-call 401 does not clear it. Sign out always clears the access token, the handle and the slug, then does a full document navigation to `/sign-in`.
- `endSession` uses the `endOperatorSession` predicate (hash and `kind = 'tenant'`, with no expiry or revoked filter) and the `family:` advisory lock.
- The route answers:
  - 204 when ended or when nothing matched;
  - 401 when the `authorization` header is missing or is not `Bearer <token>` (a garbled token is "nothing matched": 204);
  - 400 for a bad body or content type;
  - 404 for a wrong hostname.
- The logo bar reads "Community Hub". The slug field stays, restyled. `CommunitySwitcher` is built and not rendered. Profile Settings, Help & Support, search, notifications and the Website button are not rendered.

## Security pins

The implementer runs each row once: weaken the source, see the named test fail, restore the source, and report the failure. The weakened tree is never committed. The reviewer reads the implementer's weakening report and re-runs a spot-check of at least one row per task. At the Task 4 checkpoint, the reviewer re-runs pins 1, 2, 5 and 6 personally.

| #   | Setting                                                                                    | Pinning test                                                                                                                                                                                                                             | Source change that must make it fail                                          |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Sign-out revokes the whole refresh family                                                  | `session.integration.test.ts`: create, refresh twice, end with the **first, rotated-out** access token; the latest refresh token → null; every row of the family has `revoked_at`                                                        | revoke only the row matched by the access hash                                |
| 2   | An expired access token still ends its family                                              | same file: `now` past access expiry, end, then refresh with the family's refresh token → null                                                                                                                                            | add `access_expires_at > now` to the lookup                                   |
| 3   | Only `kind = 'tenant'` is ended                                                            | same file: an operator session's access token passed to `endSession` → operator family untouched                                                                                                                                         | drop the `kind` filter                                                        |
| 4   | Other families of the same user survive                                                    | same file: two families for one user; ending one leaves the other refreshable                                                                                                                                                            | revoke by `user_id`                                                           |
| 5   | Revocation waits on the family lock                                                        | same file: a second connection holds the `family:` advisory lock in an open transaction; `endSession` is started; `pg_locks` shows its backend waiting on that advisory lock and the promise has not settled; release; every row revoked | remove the `pg_advisory_xact_lock` call                                       |
| 5a  | An enrolment token revokes nothing                                                         | same file: an enrolment session's access token passed to `endSession` → that family untouched                                                                                                                                            | widen the `kind` filter to `in ('tenant','enrolment')`                        |
| 5b  | Operator sign-out cannot end a tenant family                                               | `operator.integration.test.ts`: a tenant access token passed to `endOperatorSession` → tenant family untouched                                                                                                                           | drop `kind = 'operator'` from `endOperatorSession`                            |
| 6   | Through the server: after sign-out the access token and refresh token are refused          | `auth-flow.integration.test.ts`: sign in, end → 204; `passkey/register/options` with the old bearer → 401; `session/refresh` → 401                                                                                                       | make the route return 204 without calling `endSession`                        |
| 7   | Route status contract                                                                      | `auth-routes.test.ts`: no `authorization` header → 401; `Basic …` header → 401; garbled bearer → 204 and nothing revoked; extra body key → 400; no JSON content type → 400; wrong hostname → 404                                         | change `endSessionBody` from `z.strictObject` to `z.object`, or skip `onAuth` |
| 8   | No token in logs                                                                           | `auth-routes.test.ts` log capture: no fixture token or handle substring in any log line                                                                                                                                                  | log the bearer                                                                |
| 9   | Route class is tenant, billing exempt                                                      | `index.test.ts` route-class table entry                                                                                                                                                                                                  | mark it `billing: write`                                                      |
| 10  | Admin clears local state even when the server does not confirm                             | `user-menu` / shell test: 500 and network failure → access token, handle and slug cleared; navigation to `/sign-in?signout=unconfirmed`                                                                                                  | clear storage only on 204                                                     |
| 11  | A data-call 401 keeps the sign-out handle                                                  | `api.test.ts`: 401 clears the access token, not the handle                                                                                                                                                                               | clear the handle in `post()` on 401                                           |
| 11a | The handle lives only in `sessionStorage`                                                  | sign-out test: after sign-in, `localStorage` holds no key other than `community-hub.theme`; the handle is in `sessionStorage`                                                                                                            | store the handle with `localStorage.setItem`                                  |
| 11b | No token or handle in any navigation URL                                                   | sign-out test: every `location.assign` argument equals `/sign-in` or `/sign-in?signout=unconfirmed` exactly                                                                                                                              | append the handle to the sign-in URL                                          |
| 12  | Tokens check fails on an undeclared colour, a bad decorative entry, or rgba on a text role | `tooling/checks/tokens` must-fail fixtures: `decorative-unknown`, `decorative-in-pair`, `rgba-non-decorative`, plus the existing `missing-pair`                                                                                          | drop the decorative validation                                                |
| 13  | No opacity modifier on bg, ring, border or outline anywhere in `packages/ui/src`           | `opacity.test.ts` over every source file, plus fixtures `hover:bg-primary/80` and `ring-ring/50` → violations                                                                                                                            | restore the hover exemption                                                   |
| 14  | No third-party font request                                                                | `build-html.test.ts` (or a new build test): built HTML and CSS contain no `fonts.googleapis.com`, `fonts.gstatic.com` or `data:font`                                                                                                     | add the Google Fonts `@import` from the design CSS                            |
| 15  | Nav keeps every permission rule and the frozen order                                       | `nav.test.tsx` moved as-is; `shell.test.tsx` asserts the order against `labels`, Settings last                                                                                                                                           | render Settings before Contacts & Members                                     |

## Rollback

Revert the pull request. There is no migration. A deployed admin and api revert together. Sessions revoked by sign-out stay revoked, which is the intended outcome.

## Stop and ask (AGENTS.md §12)

Stop and report, without improvising, when any of these happens:

- A task grows past about 500 changed lines, excluding tests, fixtures, `tokens.json` data, generated CSS and the lockfile. Split it and ask.
- The plan is wrong.
- A task needs a migration, an infra, workflow or Dockerfile change, or a dependency the spec does not name.
- A design value is missing or contradicts the spec.
- Keeping a screen test green would need a layout change or a removed assertion.
- The same step fails twice.
- Anything looks like a security issue.

---

### Task 1: Token contract

**Files:** `packages/tokens/src/{tokens.json,generate.ts,generate.test.ts,tokens.css,index.ts}`, `packages/ui/theme.css` (regenerated), `packages/ui/src/write-theme-css.ts` and `theme.compile.test.ts`, `tooling/checks/tokens/{check.ts,selftest.ts,fixtures/**}`.

- [ ] RED:
  - generator tests for the new groups (`type`, `spacing`, `size`, `shadow`, `decorative`);
  - `rgba()` accepted only for decorative roles;
  - `radius-pill` emitted as-is;
  - the dark values under both selectors;
  - the new `@custom-variant dark`;
  - `--font-sans` in `theme.css` and not in `tokens.css`;
  - the must-fail fixtures for pin 12.
- [ ] GREEN:
  - carry all 68 colour roles and every non-colour group from the design file;
  - write the pair list from each usage note's named grounds in both modes, hover states included, with `subtle-foreground` only on `card` and `background`;
  - add the decorative list;
  - regenerate `tokens.css` and `theme.css`;
  - `pnpm check:boundaries` passes with the real file.
- [ ] Commit `feat(tokens): adopt the admin design token contract`.

Must not break: the namespace and self-reference checks; every existing pair still present or replaced by its design equivalent, which the report lists.

### Task 2: Font, sizes, hover and focus in the copied primitives

**Files:**

- `packages/ui/src/{button.tsx,input.tsx,table.tsx}` and their a11y tests;
- `packages/ui/src/{opacity.ts,opacity.test.ts}`;
- `packages/ui/src/fonts.css` (or equivalent), with `OFL.txt` beside the font import;
- `packages/ui/package.json`, `pnpm-lock.yaml`;
- `apps/admin/src/index.css`, `apps/admin/index.html` (`lang="en-AU"`);
- `apps/admin/src/build-html.test.ts`.

- [ ] RED:
  - pin 13 and pin 14;
  - Button renders 36px by default, 44px under a `pointer: coarse` media match, and 32px at `size="sm"`, asserted through class names, not computed layout;
  - no class with an opacity modifier on any variant;
  - a focus class gives a 2px ring with a 2px offset;
  - the destructive variant uses `bg-destructive` and `hover:bg-destructive-hover`.
- [ ] GREEN:
  - `@fontsource/source-sans-3` pinned exactly, with weights 400, 500, 600 and 700 imported from CSS;
  - `theme.css` maps `--font-sans`;
  - edit the copied primitives as fixed above;
  - widen the opacity check to every source file.
- [ ] Commit `feat(ui): design font, control sizes, solid hovers and focus rings`.

Must not break: WCAG 2.2 AA on every existing a11y test; the CSP (`font-src 'self'`).

### Task 3: endSession in identity

**Files:** `modules/core/identity/infrastructure/{session.ts,session.integration.test.ts,operator.integration.test.ts}`, `modules/core/identity/public/index.ts`, and the exports test if one lists public names.

- [ ] RED: pins 1–5, 5a and 5b.
- [ ] GREEN: `endSession(sql, kms, keyArn, { accessToken, now })`, mirroring `endOperatorSession` without the operator event: look up by `sessionAccessHash` with `kind = 'tenant'` and no expiry or revoked filter, then in one transaction take `pg_advisory_xact_lock(hashtextextended('family:' || family, 0))` and revoke the unrevoked rows of the family.
- [ ] Commit `feat(identity): end a tenant session family`.

Must not break: refresh rotation, reuse detection and operator sessions. Their existing integration tests stay green.

### Task 4: Sign-out route (checkpoint)

**Files:** `packages/contracts/src/` (`endSessionBody` and its test), `apps/api/src/{auth-routes.ts,auth-routes.test.ts,auth-flow.integration.test.ts,index.test.ts}`; `apps/api/Dockerfile` and `image.test.ts` re-checked, not changed.

- [ ] RED: pins 6–9.
- [ ] GREEN: `POST /v1/auth/session/end`, `surface: "tenant"`, `billing: "exempt"`. Steps:
  1. `onAuth`.
  2. Bearer, or 401.
  3. Parse a strict `{}`, or 400.
  4. `endSession`.
  5. Answer 204 with `cache-control: no-store`.
- [ ] Commit `feat(api): sign-out route ends the session on the server`.
- [ ] **Checkpoint:** the reviewer runs pins 1–9.

### Task 5: Shell components

**Files:** `packages/ui/src/{app-shell,app-sidebar,top-bar,logo,drawer,theme-toggle,user-menu,community-switcher}.tsx`, plus `dropdown-menu.tsx` and `tooltip.tsx` if used; an axe test and a behaviour test per component; `index.ts`, `exports.test.ts`, `package.json` (`lucide-react` pinned), `pnpm-lock.yaml`.

- [ ] RED:
  - **AppSidebar:** items in the given order; absent, not disabled; `aria-current`; the pinned foot; headings at a 7-row fixture (none) and an 8-row fixture (People, Outreach, Money), with order unchanged.
  - **TopBar:** one `<h1>` with `tabIndex=-1`; the back arrow when `backHref` is set; the menu button below 1024px.
  - **Drawer:** focus trap, Escape, focus returns to the menu button.
  - **ThemeToggle:** sets `data-theme`, stores the value, and survives storage that throws.
  - **UserMenu:** Sign out in `destructive-ink`, and the Sign in link when there is no handle.
  - **CommunitySwitcher:** renders only with two or more communities.
  - **Logo:** `aria-hidden` with a label beside it.
  - Every component passes axe in light and dark.
- [ ] GREEN: build each component on the Base UI primitive, with props as in the design READMEs, minus search, notifications and the Website button. `packages/ui` has no `react-router` dependency and gets none, so links come in through props (`href` plus `onNavigate`, or a `renderLink` slot). The admin supplies router links. Logo paths come from the outline SVGs; `currentColor` drives the white and teal variants.
- [ ] Commit `feat(ui): admin shell components`.

Must not break: the single catalogue (D16). Nothing is copied from the preview bundle.

### Task 6: Admin inside the shell

**Files:** `apps/admin/src/{shell.tsx,nav.tsx,labels.ts,community.tsx,sign-in.tsx,main.tsx,all-contacts.tsx,family-records.tsx,general-settings.tsx,users-roles.tsx,module-toggles.tsx,billing-banner.tsx}`, a new `apps/admin/src/screen-title.tsx`, and their tests.

- [ ] RED:
  - pin 15;
  - `labels` has "Enquiries";
  - `/sign-in` renders no sidebar, top bar or user menu, and has one `<h1>` "Sign in";
  - every screen route renders inside `AppShell` with exactly one `<h1>`, the screen title, in the top bar;
  - `document.title` follows the title;
  - the slug field and Set button are in the sidebar;
  - the theme toggle is wired to `<html>`.
  - All Contacts and Family Records focus tests are unchanged and pass.
- [ ] GREEN:
  - routes split into a shell layout and a bare sign-in layout;
  - `useScreenTitle` and `useFocusTitle`; screens replace their `<h1>` with the hook, and their focus refs call `focusTitle()`;
  - `AdminNav` logic moves into the `AppSidebar` items;
  - the "Enquires" label is renamed.
- [ ] Commit `feat(admin): every screen inside the new shell`.

Must not break: the nav permission rules; no control that only 403s; no screen behaviour.

### Task 7: Admin sign-out

**Files:** `apps/admin/src/{directory.ts,api.ts,sign-in.tsx,shell.tsx}`, a new `apps/admin/src/sign-out.ts`, and their tests.

- [ ] RED:
  - pins 10, 11, 11a and 11b;
  - 204 and 401 → `/sign-in` with no message;
  - 400, 404, 500, a network failure and a missing auth origin → the unconfirmed message;
  - exactly one POST per click, with a double click guarded;
  - the request carries `content-type: application/json`, body `{}` and the bearer handle;
  - after sign-out no entitled nav item survives (full navigation, asserted through the navigation call);
  - a StrictMode render.
- [ ] GREEN: sign-in stores the handle; `post()` leaves the handle on a 401; `signOut()` as the spec describes; Sign in reads `signout=unconfirmed` and shows the fixed message.
- [ ] Commit `feat(admin): sign out ends the session`.

### Task 8: ADR 0016 and architecture

**Files:** `docs/adr/0016-admin-design-source-and-token-contract.md`, `architecture.md`.

- [ ] ADR 0016: context, decision, consequences and alternatives (switching to `base-vega`, Figma, Google Fonts). It amends ADR 0007.
- [ ] `architecture.md`:
  - line 476: design lives in the owner's design artifacts;
  - the D16 status cell names ADR 0016.
- [ ] No test. Commit `docs(adr): design source and token contract for the admin`.

### Task 9: Catalogue (last task on this branch)

**Files:** `docs/roadmap.md`.

- [ ] Every rename the spec lists.
- [ ] New Phase 2 rows above Mass Timings: `admin-design-shell` **done**, `admin-screens-restyle` not started, and the community memberships endpoint not started.
- [ ] The snapshot: last shipped `admin-design-shell`, next chunk `Mass Timings`.
- [ ] Open items: the walk follow-ups carried to chunk 2 (the life events table scrolling sideways on phones, 13px checkbox targets, Add Adult with no create button).
- [ ] Run the §5 cleanup: `rm -f docs/plans/*-report.md; git status --short`.
- [ ] Commit `docs: mark admin-design-shell done`.

---

## Browser check before the PR (no commit)

agy walks the admin in Chrome against the stub API. The run covers:

- every screen at 1280px and 375px, in light and dark;
- the drawer open;
- the user menu open;
- sign-in;
- the unconfirmed sign-out message;
- keyboard focus on the sidebar, top bar and one form.

Screenshots go to `.superpowers/sdd/screens/` and into the PR. The reviewer judges the findings from the screenshots. Fixes are new commits on the branch, before the PR opens.

## Definition of done (AGENTS.md §8)

- Tasks 1–9 are done, or dropped with a note.
- `pnpm gate` is green apart from the allowed Windows failures, and CI Stages 1–3 are green on the PR.
- Every current screen renders in the shell at 1280px and 375px, in light and dark, with screenshots in the PR.
- Focus is visible everywhere, and axe passes.
- Sign-out is proven by `auth-flow.integration.test.ts`.
- The tenant-isolation suites are unaffected. Residency is unaffected, since there's no new outbound call.
- ADR 0016 and `architecture.md` are in the same PR. `docs/roadmap.md` is the last commit.
- The reviewer's sign-off is recorded. This chunk is sensitive (authentication), so the second review comes from a third model family, arranged by the owner, and its line stays open when the PR opens.
- The PR names two deviations: the size over ~800 lines (the owner's handoff), and verification by local walk rather than staging.
- Session scratch is cleaned up.

## Owner decisions

These are answered once, at plan approval.

1. **Next chunk after this one:** `Mass Timings` (roadmap), with `admin-screens-restyle` straight after it or before it. The default is Mass Timings, as the handoff says.
2. **Configurations:**
   - implementer: Antigravity (Gemini);
   - reviewer: fresh-context Claude;
   - second review and owner's check: a third family, arranged by Abdus.
3. **Deviation policy:** extra attempts and actor changes are recorded as deviations in the PR. Cosmetic nits are noted in the PR, not as open items.
4. **Open items:**
   - the memberships endpoint (new roadmap row);
   - "sign out everywhere" (with account settings, decision F);
   - the community name in the sidebar (no API yet).

## Probe record

None. There is no Terraform in this chunk.
