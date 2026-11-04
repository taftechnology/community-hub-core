# Spec: Admin design foundation and shell

Slug: admin-design-shell
Status: approved (2026-11-03, Adnan Bin Hossen)
Architecture refs: D16, §8.5, §12.3, §17, §19.1; ADR 0007 (amended by this chunk); ADR 0011 (in-house identity); roadmap "Admin navigation (frozen)"; owner's Admin UI Handoff (chunk 1); design system version `1793646986-2cfc`; Laravel feature decisions A (shell) and I (wording), all decided 2 November 2026

## Problem

- The admin works but has no design. Its screens are unstyled HTML on a neutral placeholder palette.
- The sidebar breaks the frozen order, with Settings second.
- Staff cannot sign out. The admin keeps only the access token, which lasts 15 minutes. It discards the refresh token from the verify response. But the server's refresh family stays live for 30 days, so a copied verify response can mint new sessions for a month, and nothing in the admin can stop that.
- The agreed design cannot be built screen by screen until its tokens, font, control sizes and shell exist in `packages/tokens` and `packages/ui`. Mass Timings, the next module, is to be built from them.

## Scope

In:

- **Token contract.**
  - `packages/tokens/src/tokens.json` carries every value from the design system's `tokens.json`, with the design's role names:
    - **Colour:** 68 roles in light and dark. These include the field, control and decorative borders, tint, the inks, the hover fills, 10 module tones (tint and ink each), the sidebar set, and the navy dark values.
    - **Type scale:** 13 styles, with family, size, line height, weight and tracking.
    - **Spacing**, **radius** (`radius-pill` stays `999px` and is not converted to rem), and the **overlay shadow** per mode.
    - **Sizes:** control 36, control-sm 32, touch 44, row 40 (condensed 32, tall 48), nav item 36, top bar 52, sidebar 256.
  - Custom properties stay `--ch-*` (ADR 0007). The existing `space`, `fontSize` and `fontWeight` groups stay, because base-nova classes use them. The design's type scale is added alongside them.
  - `--font-sans` and the other Tailwind theme names are mappings in the generated `packages/ui/theme.css` onto `--ch-*` values. They never appear in `tokens.css`, where the generator bans those prefixes.
  - The generator accepts a colour as 6-digit hex. It accepts `rgba()` only for a role declared decorative (`scrim`). Shadows are their own group, per mode.
- **Contrast pairs.**
  - The pair list follows each usage note's named grounds in both modes, hover states included: `primary-foreground` on `primary-hover`, `foreground` on `secondary-hover`, and so on. Every combination is not paired. For example, `subtle-foreground` is paired only on `card` and `background`, because it fails on `muted`.
  - The existing checks stay. These are `missingPairViolations`, `contrastViolations` (4.5:1 text, 3:1 non-text; `large-text` is not used), and the unknown-role check.
  - This chunk adds a top-level `decorative` list of role names, which applies to both modes. A decorative role is exempt from the missing-pair rule.
  - The check fails on a decorative name that is not a colour role. It also fails on a decorative role that also appears in a pair, and on a non-hex value for a role that is not decorative. Each rule has a must-fail fixture under `tooling/checks/tokens/fixtures/`.
  - **Decorative roles from the usage notes:** `border`, `control-border`, `tint-border`, `destructive-border`, `warning-border`, `info-border`, `restricted-border` and `sidebar-border`.
  - **Decorative roles added by this spec, not the design:**
    - `control-border-hover`, which is 2.56:1 on light `card`, so it cannot meet 3:1. It edges controls whose text identifies them.
    - `scrim`, which is translucent and behind a dialog.
  - `subtle-foreground` is a text role, not decorative.
- **Source Sans 3, self-hosted.**
  - Weights 400, 600 and 700 are used by the type scale. Weight 500 ships too, because base-nova's `font-medium` uses it.
  - The files are woff2 under SIL OFL 1.1. They are imported from CSS, so Vite emits them into `dist/assets` and they are never inlined as `data:` URIs (the CSP is `font-src 'self'`).
  - `OFL.txt` sits in the repo beside the font source, and the PR quotes it.
  - There is no Google Fonts link and no third-party font request.
- **Button, Input and size changes in the copied base-nova primitives.** We keep `base-nova` and change the copied source. We do not switch to `base-vega`.
  - Controls are 36px with a mouse. They are 44px under `pointer: coarse` and below 640px. Row buttons are 32px.
  - Hover is a solid fill (`primary-hover`, `secondary-hover`, `destructive-hover`). It is never an opacity modifier.
  - Destructive is the design's solid `destructive` fill.
  - Focus is a solid 2px `ring` with a 2px offset, on Button and Input. Table has no focusable controls of its own.
  - Inputs are 36px with a mouse and 44px on touch. This follows the design's component CSS (`.ch-input` at `size-control`). The token note "and form fields" on `size-touch` is read as applying on touch screens.
  - The opacity check (`packages/ui/src/opacity.ts`) widens to every source file in `packages/ui/src`. It fails on an opacity modifier on any `bg-`, `ring-`, `border-` or `outline-` utility, hover included. The current "allows hover opacity" test becomes a must-fail fixture.
- **Shell components in `packages/ui`.** Each is built on the shadcn/Base UI primitive, with an axe test.
  - `AppShell`: sidebar, top bar and scrolling content. One column below 1024px. Print hides the sidebar and top bar.
  - `AppSidebar`: dark in both themes, with a logo bar, a scrolling middle, and a pinned foot holding Settings. Optional section headings.
  - `Logo`: the outline rosette as an inline SVG component, in variants `outline-white` (sidebar) and `outline-teal` (sign-in). It is `aria-hidden` when a text label sits beside it. The filled rosette and its cyan are not used.
  - `TopBar`: the screen's one `<h1>` in `page-title`, an optional back arrow, a menu button below 1024px, `ThemeToggle` and `UserMenu`.
  - `ThemeToggle`.
  - `UserMenu`: an account menu with Sign out in `destructive-ink`. Below 640px it also holds the theme switch.
  - `Drawer`: the phone sidebar, using Base UI dialog semantics. It traps focus, closes on Escape, and returns focus to the menu button.
  - `CommunitySwitcher`: built and tested. The admin does not render it in this chunk (see Out).
  - `DropdownMenu` and `Tooltip` come in if the shell needs them.
- **Admin in the new shell.**
  - Every current screen renders inside `AppShell` with the new tokens and no layout change: Dashboard, General Settings with Billing, Users & Roles, Module Toggles, All Contacts, and Family Records with life events.
  - The billing banner keeps its single alert slot at the top of the content.
  - The community slug field and its Set button move into the sidebar's switcher slot. They keep today's behaviour. On phones they live in the drawer.
  - They are restyled on the sidebar's own pairs:
    - label and field text: `sidebar-foreground` on `sidebar`;
    - field edge: `sidebar-input` on `sidebar` (non-text);
    - Set button: `sidebar-foreground` on `sidebar-hover`.

    Each of these is a pair in the tokens check.
- **Sign-in outside the shell.** `/sign-in` becomes a sibling route with its own bare layout, so it has no sidebar, top bar or user menu. It shows the teal outline logo and an `<h1>` "Sign in", above today's form on the new tokens. Its fields and flow do not change.
- **Nav order and labels.** The sidebar renders the frozen order exactly, with Settings last and pinned. "Enquires" becomes **Enquiries**.
- **Sign-out.**
  - A route, `POST /v1/auth/session/end`, ends the caller's session family on the server.
  - The admin keeps a sign-out handle, so Sign out still works after the access token has expired.
  - A Sign out control sits in `UserMenu`.
- **Docs.**
  - ADR 0016 amends ADR 0007.
  - `architecture.md` §8.5 (line 476): design lives in the owner's design artifacts, not in Figma. The D16 status cell names ADR 0016. The module table (line 563) keeps the module name `Mass Timings`.
  - `docs/roadmap.md` renames (decision I):
    - "Enquires" → "Enquiries" at lines 135 and 155, in the Quick Actions line (370) and in the frozen table, where the "Label may become Enquiries" note is replaced by "Renamed by admin-design-shell".
    - "Mass Timings" → "Mass Times" as a nav label: the Engagement children in the frozen table, the Quick Actions line, the nav column at line 151, and the nav path at line 360.
    - "Global Setting" → "Global Settings" in the Website & CMS children and at line 192.
    - The module and chunk name stays `Mass Timings`.
  - The last commit adds new Phase 2 rows above Mass Timings:
    - `admin-design-shell`, **done**;
    - `admin-screens-restyle`, not started;
    - a memberships endpoint for the community switcher, not started.

    The snapshot keeps `Mass Timings` as the next chunk.

Out (explicitly):

- Global search and notifications. Neither has a backend. Each needs its own spec.
- The Website button. It stays hidden until Phase 4.
- Profile Settings and Help & Support. Neither has a screen or a backend, so neither is rendered. Decisions F and G put them in later chunks.
- Screen layouts. Rebuilding the screens from DataTable, Field, Panel and the like is chunk 2, `admin-screens-restyle`.
- A real community switcher. Core has no API that lists a user's communities. `CommunitySwitcher` ships but is not rendered. Decided by Adnan on 2026-11-03.
- The community's own name in the sidebar. There is no API for it, so the logo bar reads "Community Hub".
- Ending other sessions of the same user (other devices). Audit events for tenant sign-in and sign-out, since tenant sessions have no audit trail today; operator sessions do, and are unchanged.
- A way back to "follow the system" after a person has chosen a theme. The toggle is two-state, as the design has it. Clearing site data restores the default.
- Any change to `apps/ops`, `infra/` or CI. Tenant CORS already allows `authorization` and `content-type` to the admin origin, the gate answers OPTIONS on the auth host, and POST falls under the existing write throttle.
- Staging. It stays parked (see Risks).

## Behaviour

**Shell, at 1024px and wider.**

- The sidebar is 256px. Its logo bar is 52px: the white outline logo at 30px, then "Community Hub".
- The top bar is 52px on `card`, so the two separators line up. It holds the screen title in `page-title` (22/28, 700), with no supporting line under it.
- Content is padded by `space-6`.

**Shell, below 1024px.**

- The sidebar is hidden. A 44px menu button at the left of the top bar opens it as a drawer.
- Choosing an item closes the drawer and moves focus to the top-bar title, unless the new screen moves focus itself on mount, in which case the screen's focus wins.
- Below 640px the theme switch moves into the user menu.
- At 375px the shell never scrolls sideways. A screen's own wide table may still scroll inside its box until chunk 2.

**Screen titles.**

- The top bar's `<h1>` is the only `<h1>` on a screen.
- A screen sets it through `useScreenTitle(title)`. A sub-view that has its own `<h1>` today (an All Contacts or Family Records detail or form) sets its title the same way, and its `<h2>` stays where it is.
- The title `<h1>` has `tabIndex={-1}`. `useFocusTitle()` returns a function that focuses it. All Contacts and Family Records call that function where they focus their own `<h1>` ref today, so their existing focus assertions keep passing unchanged.
- `document.title` is "<screen title> · Community Hub". Screen titles are static labels and never carry personal data.
- `index.html` sets `lang="en-AU"`.

**Sidebar items.**

- The frozen order is: Dashboard, Enquiries, Engagement, Contacts & Members, Family Records, Membership, Records, Certifications, Volunteers, Forms, Communication, Mobile App, Website & CMS, Donations, E-commerce, Settings.
- An item shows only when it has a screen and the caller is entitled and permitted. These are today's `visibleLabels` and `AdminNav` rules, moved and not rewritten.
- Dashboard always shows.
- Contacts & Members, with its child All Contacts, needs `people.directory` and `people.view`.
- Family Records needs `people.households` and `people.view`.
- Settings always shows, pinned in the foot, with General Settings, Users & Roles and Module Toggles under it.
- A hidden item is absent, not disabled.
- The current route's item uses `sidebar-selected` and carries `aria-current="page"`.

**Section headings.**

- Headings group the order and never change it:
  - **People:** Contacts & Members to Volunteers.
  - **Outreach:** Forms to Website & CMS.
  - **Money:** Donations and E-commerce.
- A row is any item or child shown in the scrolling middle. The pinned foot does not count. Headings appear when eight or more rows show.
- Today at most four rows show (Dashboard, Contacts & Members, All Contacts, Family Records), so real users see no headings yet.
- Tests use a fixture item list at seven rows (no headings) and eight rows (headings).

**Theme.**

- The design system says light is the default. The owner's handoff, which is later and says "follows the system by default", wins.
- With nothing stored, the admin follows `prefers-color-scheme`. This is done in CSS only, because the admin's CSP forbids inline scripts and `build-html.test.ts` forbids inline script and style.
- The generator emits the dark values under both `[data-theme="dark"]` and `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`.
- The Tailwind dark variant becomes `@custom-variant dark` over the same two conditions.
- The toggle sets `data-theme` on `<html>` and stores `light` or `dark` in `localStorage` under `community-hub.theme`. The admin's own module reads it on load.
- If storage throws, the toggle still works for the life of the page.
- When the stored choice differs from the system theme, the page may show the system theme for a moment before the module applies the stored one. That flash is accepted, because the CSP forbids an inline bootstrap script.
- The sidebar looks the same in both themes.

**Focus.**

- Every interactive element shows a solid 2px `ring` with a 2px offset on `:focus-visible`. Inside the sidebar the ring is `sidebar-ring`.
- No colour is faded with opacity, which the widened opacity check enforces.

**Sign-out.**

- At sign-in the admin stores the access token as today. It also stores the same token as the sign-out handle, under `community-hub.signout-handle` in `sessionStorage`.
- A 401 on a data call still clears the access token, as today. It does not clear the handle.
- `UserMenu` shows Sign out while a handle exists. It shows a Sign in link to `/sign-in` when there is none.
- Sign out posts `{}` with `content-type: application/json` and `authorization: Bearer <handle>` to `POST /v1/auth/session/end` on the auth hostname.
- Then, whatever the answer, it clears the access token, the handle and the community slug, and does a full document navigation to `/sign-in`. That drops all in-memory state: capabilities, billing and the slug.
- What Sign in then shows depends on the answer:

  | Answer                                                             | Sign in shows                                                                                                                                                      |
  | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | 204                                                                | Nothing extra. The family was ended, or there was nothing to end.                                                                                                  |
  | 401                                                                | Nothing extra. No bearer reached the server, so there is no session it could end.                                                                                  |
  | 400, 404, any 5xx, a network failure, or no auth origin configured | "We couldn't confirm you signed out. Close your browser to end the session." The message is carried as `?signout=unconfirmed`, a fixed flag with no personal data. |

- The control never leaves the person signed in on this device.

**Empty and error states.** With no community slug set, screens behave as today.

## Data

- No new table, column or migration.
- Sign-out writes `identity.sessions.revoked_at`, an existing column, on every row of the caller's refresh family where it is still null.
- The theme preference (`light` or `dark`) and the sign-out handle are device storage only. The handle is the access token the admin already stores, in the same `sessionStorage` scope. Neither is ever put in a URL, log or trace. The theme is not personal data and never reaches the server.

## Rules touched

- **Authentication (sensitive).** `POST /v1/auth/session/end`:
  - Surface `tenant`, billing `exempt`, behind the same `onAuth` hostname check as every `/v1/auth/*` route.
  - Body `endSessionBody`, strict `{}`.
  - `endSession` finds the session by access-token hash with `kind = 'tenant'`. It ignores `access_expires_at` and `revoked_at`, using the same predicate as `endOperatorSession`. So an expired or rotated access token still ends its family while that family exists.
  - In one transaction, under the same `family:` advisory lock that refresh takes, it revokes every unrevoked row in that family.
  - Answers:
    - 204 when the family was ended or nothing matched. "Nothing matched" covers an unknown or garbled token, and an operator or enrolment token, which revokes nothing.
    - 401 when the `authorization` header is missing or is not `Bearer <token>`. This is the house rule for bearer routes, using the existing `bearer()` helper.
    - 400 for a bad body or a missing JSON content type.
    - 404 for a wrong hostname (`onAuth`).
  - `endOperatorSession` keeps its `kind = 'operator'` filter, so operator sign-out cannot end a tenant family either.
  - The sign-out handle lives only in `sessionStorage`, never in `localStorage`. No token or handle appears in any navigation URL.
  - Afterwards the old access token is refused (401) by `POST /v1/auth/passkey/register/options`, and the refresh token is refused (401) by `/v1/auth/session/refresh`.
  - Other families of the same user are untouched.
  - Identity sessions are user-wide, not per community, so one sign-out ends the session for every community that user works in. Identity tables have no `org_id`, by §1 rule 2.
- **Entitlements and permissions.** Nav visibility is unchanged and moved, not rewritten.
- **Personal data (§1 rule 5).** No token, handle, slug or name goes in a URL, log or trace. The route logs no token.
- **No third-party calls (§1 rule 6).** The font and icons ship with the app.
- **Children (§1 rule 4).** No change. No screen shows new data.

## Contracts

- New route `POST /v1/auth/session/end`, body `endSessionBody` (`z.strictObject({})`) in `packages/contracts`. It answers 204, 400, 401 or 404 as above.
- New identity public function `endSession(sql, kms, keyArn, { accessToken, now })`, for kind `tenant` only.
- New `packages/ui` exports: `AppShell`, `AppSidebar`, `TopBar`, `ThemeToggle`, `UserMenu`, `Drawer`, `CommunitySwitcher` and `Logo`, plus `DropdownMenu` and `Tooltip` if used.
- New admin hooks `useScreenTitle` and `useFocusTitle`.
- Changes to the `packages/tokens` JSON format:
  - new groups `type`, `spacing`, `size`, `shadow` and `decorative`;
  - `rgba()` allowed for decorative roles;
  - the generator, `theme.css` mapping and tokens check updated to match.
- No event, entitlement key, permission, or website collection, island or block changes.

## Risks

- **Sign-out that doesn't end the session.**
  - An integration test through the real server signs in, signs out, and proves the access token and the refresh token are both refused. It also proves a second family of the same user still works.
  - A second test advances `now` past the 15-minute access expiry before signing out, and the refresh token is still refused afterwards.
- **Residual gap.** If someone closes the tab without signing out, `sessionStorage` is lost and the family lives out its 30 days. That is no worse than today, and the admin itself holds no refresh token. The roadmap's memberships row is not the fix. A later "sign out everywhere" belongs with account settings (decision F).
- **Revoking the wrong family.** Scoping by access-token hash and `kind = 'tenant'` means an operator token cannot end a tenant family, and the reverse. Each case has a test.
- **Refresh racing sign-out.**
  - Revocation takes the family advisory lock that refresh takes.
  - A test holds that lock on a second connection and asserts, through `pg_locks`, that `endSession` waits for it. Then it releases the lock and checks that every row in the family is revoked.
- **Nav regression.** Today's nav and shell tests move with the nav and keep every permission assertion. The frozen order is asserted against `labels`.
- **Focus regression from the title move.** The All Contacts and Family Records focus tests stay unchanged and must pass through `useFocusTitle`.
- **Contrast regressions.** The tokens check fails CI on a missing pair, a failing pair or a bad decorative entry.
- **Layouts drifting into chunk 2.** Screens only hand their title to the top bar and pick up tokens. Every existing screen test passes with no behaviour assertion removed.
- **Staging not used.**
  - AGENTS.md §8 asks for verification on the staging hostname. Staging is parked, and unparking costs money.
  - This chunk instead verifies in a local browser against a stub API, at 1280px and 375px, in light and dark, with screenshots in the PR. The PR names this as a deviation.
  - The sign-out proof is the server integration test.
- **Chunk size.** This chunk will exceed the ~800-line guide in AGENTS.md §3. The owner's handoff says "A large chunk stays as one PR; don't split it for size", and the PR records that as the owner's decision.
- **Cost.** No new billed resource.

## Out-of-band

- No legal sign-off is needed. Source Sans 3 is SIL OFL 1.1, a new bundled asset, and the PR justifies it.
- New dependencies, each justified in the PR:
  - `@fontsource/source-sans-3` (OFL), for the woff2 files. The files can be vendored with `OFL.txt` if the reviewer prefers.
  - `lucide-react` (ISC), for the shell icons. The design names Lucide, and `components.json` already says `iconLibrary: lucide`.
- ADR 0016 amends ADR 0007 and records:
  - design lives in the owner's design artifacts;
  - the token contract's new shape, including the shadow tokens ADR 0007 left out;
  - `base-nova` kept, with the size, hover and focus changes;
  - the self-hosted font;
  - Lucide.
- Sensitive chunk (authentication). The owner arranges the second review from a model family other than the implementer's (Gemini) and the reviewer agents' (Claude). The owner's recent assistant has been Claude, which overlaps the reviewer family. The PR's second-review line stays open until that review is written.
