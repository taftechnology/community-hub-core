# Spec: Admin screens restyle

Slug: admin-screens-restyle
Status: approved (2026-11-07, Adnan Bin Hossen)
Architecture refs: D16, §8.5, §12.1, §12.3; ADR 0007, ADR 0016, ADR 0017; roadmap "Admin screens restyle"; owner's Admin UI Handoff (chunk 2); design system version `1793646986-2cfc` and the admin screens boards, both read on 2026-11-07; Laravel feature decisions A and I

## Problem

The screens on `main` sit in the new shell, but their contents are still mostly unstyled. Staff cannot use parts of them:

- The sign-in Email and Code fields are raw inputs with no border or background, so nothing marks where to type.
- Users & Roles has raw text inputs. Family Records has raw selects and checkboxes, and Users & Roles and Module Toggles have raw checkboxes. Those checkboxes are 13px, too small to tap.
- Wide tables scroll sideways on phones.
- The design's panels, status, loading, empty and restricted patterns exist nowhere in `packages/ui`, so every later module would invent its own.

## Scope

In:

- **New `packages/ui` components**, listed with the screens that render them under Component map. Each is rebuilt from the design's rules on Base UI or plain elements, with an axe test. A component ships only if a screen in this chunk renders it.
- **Sign-in first.** Email and Code use `Field` and `Input`. Every other raw control follows.
- **Screens rebuilt from those components, with the same behaviour:** every screen under Screens below.
- **Walk follow-ups from `admin-design-shell`:** the life events table no longer scrolls sideways on phones; checkboxes meet the touch size.
- **Docs.** The last commit updates `docs/roadmap.md`:
  - this row **done**, and the snapshot;
  - the row's walk follow-ups, sign-in sentence and Users & Roles clause come out;
  - the open item "The admin shell has no layout or styling to speak of" comes out;
  - the new rows named under Out go in;
  - the proof chunk's row, `admin-screens-proof`, **not started**, goes in too (see Staging).

Out (explicitly):

- **Users & Roles names, emails and phones.** Moved out of this chunk (Adnan, 2026-11-07). The screen still shows ids and role keys after this chunk. The handoff already places this in chunk 3, and the roadmap row says "fix with the restyle", so the last commit corrects the row and adds a new Phase 2 row, `Users & Roles people details`, **not started**, sensitive. The route selects ids only, with no join to `app.persons` or `identity.users`. A real fix needs joins across two schemas, decryption and a new contract.
- **Locking a minor's fields.** The handoff's done line says "a minor's restricted fields still show as locked". They do not show as locked today: any holder of `people.restricted.read` sees them as plain text. Locking them, with per-field View and a fresh second factor, is the roadmap's `Children's data access` row (ADR 0017). This chunk neither locks nor widens them. See Done when.
- **`RestrictedBanner`.** The board's wording, "Only people with restricted access can see this section", states a policy ADR 0017 rejects. It belongs to `Children's data access`.
- **`Tabs` on Family Details.** The board shows a family-level Life Events tab, but today's life events belong to one person, with one panel per adult and per minor. A tab would move each minor's panel out of `MinorsSection`, which carries a gate and its tests, and would hide load and save alerts in an unselected panel. Each panel stays with its person. A family-level view belongs to `Life events: Laravel parity`.
- **`ConfirmDialog`, `Dialog`, `Radio` and `Toast`.** The handoff lists them, but no screen here needs them (decision D2). The guardian unlink confirm stays inline in its row.
- **Add Adult create action** (decision D1). The last commit moves the walk follow-up to a new Phase 2 row, `Add Adult create`, **not started**.
- Everything else in the handoff's chunk 3: All Contacts delete, CSV export, the extra columns, the inline Active switch and the filters; the Groups screen; family status, delete a family, move a child, edit a child; emergency contacts and pastoral notes. None of these has a roadmap row today, so the last commit adds a Phase 2 row, `People screens: Laravel parity`, **not started**, listing them.
- The Dashboard. The handoff places it with the modules whose widgets it shows, and its stat cards need list totals the cursor API does not return. It stays as it is.
- The boards' parts that need totals: the `StatCard` rows on All Contacts and Family Details, the count in "All Contacts (10)", "Showing 1 to 10 of 233", and page numbers. The list APIs are cursor-based and return no totals.
- Board sections with no data behind them. Contact Details: groups, activity log, gender, address, and the Email and Call actions. All Contacts: the age under a name. Family Details: Emergency Contacts, Pastoral Notes, Sacraments, Sacramental Records, and the registration and status fields. Contact Details also shows a Family field on the board, which today's screen does not have. Because of these, the boards' second column has nothing to show today, so Contact Details and Family Details are one column in this chunk.
- Global search, notifications, the Website button, `CommunitySwitcher` and the parish name in the sidebar.
- Copy changes, except what this spec names: the new line for callers without `people.restricted.read`, the `RestrictedValue` hidden text and native `title`, `None` in the household name cell, and `None` in place of `-` in the life events Place and Notes cells. Field labels, section headings, messages and button names stay as they are, because staff and tests rely on them. So Family Details keeps "Household Details" where the board says "Family Information", Contact Details keeps "Contact Details" where the board says "Personal Details", and "(required)" is not added to labels.
- The CloudFront 403 on reloading a deep link. It is infrastructure, and it is recorded in the roadmap.
- Any change to `apps/api`, `apps/ops`, `infra/`, CI, or the database.

## Behaviour

**Nothing a person can do changes.** Every route call, permission check, entitlement check, billing read-only state, conflict message, focus move and unsaved-changes guard stays exactly as it is. What changes is how each screen looks and how it fits on a phone. There are three named exceptions: the household name cell, the empty Place and Notes cells in life events, and the new line for callers without `people.restricted.read`.

**Layout.**

- Screens use `Panel` sections, with actions beside the content they affect.
- `Panel` takes a heading `level`, default `h2`, and passes `ref` and `tabIndex` to its heading. Every heading keeps today's level: the focus-target `h2`s, Billing as `h2`, Adults, Minors and Guardians as `h3`, the life events heading as `h4`, and the life events form heading as `h5`. A heading that is a focus target stays mounted during loading, error and not-found, because today's focus effects fire before the data arrives.
- The screen title stays in the top bar through `ScreenTitle`. No supporting line goes under it.
- Forms are one or two columns in `Panel`.
- Status carries a word as well as a colour.
- Rows are `size-row`. Controls are `size-control` with a mouse and `size-touch` on touch. Buttons inside table rows use the existing `sm` size, `size-control-sm` with a mouse and `size-touch` on touch.

**Tables on phones.**

- `DataTable` composes the existing `Table` parts, which stay exported with their tests. Every direct use in the admin moves to it.
- `DataTable` renders one `<table>` at every width. Below 640px, CSS turns each row into a labelled list, as the design's `.ch-table-list` does, with each cell's label coming from a `data-label` attribute.
- `display: block` removes table semantics in browsers, so `DataTable` sets explicit `role` attributes on the table, rows and cells to keep them. An axe test covers this.
- There is no second DOM for phones. A duplicate would double every row in tests and to screen readers.
- `DataTable` lets cells wrap, replacing the `whitespace-nowrap` that causes the sideways scroll, so the shell and the table never scroll sideways at 375px.

**Forms.**

- `Field` joins a label, help text and error to its control with `htmlFor`, `aria-describedby` and `aria-invalid`. It merges with an `aria-describedby` the control already has, as the move-adult target select does.
- `Select` is a styled native `<select>`, as the design's `.ch-select` is.
- `Checkbox` is a styled native checkbox, 18px with a 44px hit area on touch.
- `Switch` is the styled native `input type="checkbox" role="switch"` that Module Toggles already uses. The design's `Switch` is a button with the same role, and the native input keeps today's event handling. Its word is the `label` the design allows: today's module key. The design's note asks for a word such as Active beside it, so this is a recorded deviation, because a new word would be new copy.
- Validation timing does not change. The design says validate on blur, and that waits for the chunk that changes a form.
- Sign-in's "Sign-in failed" and "Directory unavailable", and the Users & Roles and Module Toggles notices, stay plain paragraphs with today's roles.

**All Contacts Adults and Minors.** The two buttons stay as they are, restyled: the `Contact types` group name, `aria-pressed`, and the Minors button shown only with `people.restricted.read`. The board has no such control, and it is not dropped. They do not become tabs.

**Guardian unlink.** The inline confirm stays in its row, restyled, with today's words, buttons, gate and focus. A dialog would hide which row is being unlinked, change what Escape does and move focus, so it waits for the first chunk that needs one.

**Loading.** `Skeleton` takes the final shape. Where a screen has loading words today, they stay as a visually hidden plain `<span>`, with no `role="status"` and no `aria-live`. The All Contacts list has none today, so its `Skeleton` is `aria-hidden` and adds none.

**Search.** `FilterBar` keeps today's search form, its visible labels "Search contacts" and "Search adults", and its Search button. The design debounces search, which would change when requests are sent, so that waits for the chunk that adds filters. No search term goes in a URL, as today.

**Empty.** `EmptyState` keeps today's sentences: "No contacts yet", "No contacts match", "No households yet", "No adults found" and "No life events recorded". Inside Family Details, "No adult members", "No minor members" and "No guardian links" stay plain text.

**Paging.** `Pagination` uses the design's cursor mode, on the All Contacts and Family Records lists. Its button keeps the name "Next page". It is absent, not disabled, when there is no cursor, and Previous does not render. It shows no numbers or totals. Add Adult's and move adult's paging sentences stay as plain text, with no paging control, because neither has one today.

**Billing status.** `StatusBadge` keeps today's words, and uses the existing token pairs. Active is `primary-ink` on `tint`. Payment retrying and In grace period are `warning-ink` on `warning-tint`. Read-only is `destructive-ink` on `destructive-tint`. No active subscription is `muted-foreground` on `muted`. Invoiced never reaches the State row, because that state shows "Billing is handled by invoice." instead. A pairing the tokens check lacks is added to it.

**Three restricted states stay distinct** (design rule):

| Shown            | Meaning                         | Where in this chunk                                                                                                                                                                                                    |
| ---------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `—` (restricted) | You may not see this            | `RestrictedValue`: the household name cell in the Family Records list, for a caller without `people.restricted.read`                                                                                                   |
| `None`           | Nothing is recorded             | The same cell for a caller with `people.restricted.read` and an unnamed household; a minor's date of birth; Contact Details email, phone and date of birth; life events Place and Notes, which show `-` today          |
| Section missing  | Your role excludes this section | Family Details: the Minors, Guardians and life events panels are absent for a caller without `people.restricted.read`, and life events also without `people.households`. All Contacts: the Minors button. All as today |

- The API returns `label: null` both for an unnamed household and for a caller without `people.restricted.read`, and today both show `—`. The screen tells them apart by the caller's permission. That is the household name cell exception above. It applies to the Family Records list only. The household name row on Family Details stays absent when `label` is null, for every caller, so it never shows `None` to someone who may not see the name, and the new line is the only signal. Two new tests pin that: no name row for an unnamed household with access, and none without access. The View button keeps its name, "View household", and the move adult list keeps showing a raw id for an unnamed household, as today. The existing test covers only the caller without `people.restricted.read`, though its title claims both. The plan replaces that title and adds a new test: a caller with `people.restricted.read` and an unnamed household sees `None`.
- `RestrictedValue` is a bold `—` marked `aria-hidden`, beside visually hidden text: "Household name hidden for your role". It carries a native `title`, "Hidden for your role", as the design does, because `packages/ui` has no `Tooltip`. It never says why. `None` is plain text in `muted-foreground`, so the two never look alike.
- A person without `people.restricted.read` sees one new line on the Family Records list and Family Details, in an `Alert` with `live="polite"`: "Household names and children are hidden for your role." It is the same on every household, whatever that household holds, so it reveals nothing. It shows beside "No households yet" too, so an empty list is treated the same. The wording is interim: ADR 0017 §7 will let other staff see that a household has a child, so `Children's data access` replaces it. It renders only after the access gate has passed, so it cannot flash on first load. Access is not reset when the community changes, so the line and the cell can briefly be wrong during a switch. They hold nothing about any household, so no data is exposed.
- `Avatar` is decorative and `aria-hidden`. It appears for adults only, and never for a minor. On Contact Details it renders only when the response's `isMinor` is exactly `false`, so a missing flag shows none. `parsePersonDetail` keeps `isMinor: Boolean(value.isMinor)` for the Edit contact gate, and adds `isAdultConfirmed: value.isMinor === false`, which only `Avatar` reads. Its initials and tone come from a name the caller can already read, and they never reach a URL, a title or a log.

**Empty and error states.** With no community slug set, screens behave as today. A failed load shows today's alert in today's place.

## Screens

Layouts come from the board where one exists, as far as today's data allows. Data on a board is synthetic, so fields come from the API.

| Screen                                                                        | Board           | Layout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in                                                                       | None            | The existing sign-in card stays. `Field` for Email and for Code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| All Contacts list                                                             | All Contacts    | One card: Add contact right-aligned on the first row, with no card heading, then `FilterBar`, then `DataTable`, then `Pagination` in the card's footer. `FilterBar` shows on the Adults list only, and Add contact keeps today's conditions. The Adults and Minors buttons sit above the card. Today's columns. The first column is primary and carries `Avatar` on the Adults list only                                                                                                                                                                                                      |
| Contact Details, add, edit                                                    | Contact Details | One column: a Contact Details `Panel` with `Avatar` in the head when `isMinor` is exactly `false`, today's Edit action beside it, and `DescriptionList` for today's fields. Forms in `Panel`                                                                                                                                                                                                                                                                                                                                                                                                  |
| Family Records list                                                           | None            | `DataTable`, `Pagination`, the new line, `RestrictedValue`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Family Details                                                                | Family Details  | One column of `Panel`s in the board's order: household details, adults, then minors with guardians. The household name row stays absent when `label` is null. Back to list and Rename household sit at the top right, as on the board. Add adult, Add minor and Link guardian sit in the head of their own `Panel`. Adult members, Minor members and Guardian links each stay a `DataTable` with today's columns and names, and Adult members carries `Avatar` in its first column. Life events panels stay where they mount today: after the Adult members table, and inside `MinorsSection` |
| Family forms: create, rename, Add Adult, move adult, add minor, link guardian | None            | One `Panel` each. `Field`, `Select`, `Checkbox`. Add Adult uses `FilterBar` and `DataTable` for its search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Life events                                                                   | None            | `DataTable`, `Select`, `Textarea`, `Field`, in both places it mounts today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Users & Roles                                                                 | None            | Untitled `Panel`s around today's groups, `Field`, `Checkbox`. They have no section headings today, so none are added. Today's lists and today's ids                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| General Settings, Billing                                                     | None            | `Panel` and `DescriptionList`; `StatusBadge` for the State value, with today's word. The billing banner keeps its two alerts and its slot                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Module Toggles                                                                | None            | One untitled `Panel` with one `Switch` per module. Without `canManage`, or when writes are hidden, the key shows as plain text with no `Switch`, as today. "No modules are allocated." stays plain text                                                                                                                                                                                                                                                                                                                                                                                       |
| Mass Times                                                                    | None            | `Panel` around the existing `RichTextEditor`, and nothing else. It shipped after the handoff was written, and it is a screen on `main`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Component map

| Component         | Rendered by                                                                                                              | Replaces                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `DataTable`       | All Contacts, Family Records list, Family Details (Adult members, Minor members, Guardian links), life events, Add Adult | Direct `Table` uses          |
| `FilterBar`       | All Contacts, Add Adult                                                                                                  | The bare search forms        |
| `Pagination`      | All Contacts, Family Records list                                                                                        | Bare Next page buttons       |
| `EmptyState`      | All Contacts, Family Records list, Add Adult, life events                                                                | Bare empty paragraphs        |
| `Skeleton`        | All Contacts list, Family Records list, Family Details, Contact Details, Add Adult, life events                          | Bare loading paragraphs      |
| `Field`           | Every form                                                                                                               | Bare labels and inputs       |
| `Select`          | Family Records, life events                                                                                              | Raw `<select>`               |
| `Checkbox`        | Family Records, Users & Roles                                                                                            | Raw checkboxes               |
| `Switch`          | Module Toggles                                                                                                           | Raw `role="switch"` checkbox |
| `Textarea`        | Life events                                                                                                              | Raw `<textarea>`             |
| `Panel`           | Every screen except the Dashboard and sign-in                                                                            | Bare sections                |
| `DescriptionList` | Contact Details, General Settings                                                                                        | Label lines and bare `<dl>`  |
| `StatusBadge`     | Billing status                                                                                                           | The bare State value         |
| `Avatar`          | All Contacts Adults list, Contact Details when `isMinor` is exactly `false`, Family Details Adult members                | Nothing; on the boards       |
| `RestrictedValue` | Family Records list                                                                                                      | The bare `—`                 |

`Input`, `Button`, `Alert` and `RichTextEditor` already exist.

## Data

No table, column, migration, route, contract or permission change. No personal field is added to any screen. Nothing new is written to device storage.

## Rules touched

- **Children (§1 rule 4, ADR 0017).** No new path to a minor's data. The people who can see a minor's fields after this chunk are the same people as today. ADR 0017's narrower rule arrives with `Children's data access`, not here. No child's name or count goes in a URL, a screen or document title, or a log. The life events heading and table label already hold a minor's name on the page, and they keep today's wording. `Panel` and `DataTable` titles never feed `ScreenTitle` or `document.title`. `DataTable` builds `data-label` from column headers only, and writes no row value or id into it.
- **Personal data (§1 rule 5).** Screen titles stay static labels.
- **Entitlements and permissions.** Unchanged, and moved with their markup, not rewritten. A control that a person may not use stays absent.
- **WCAG 2.2 AA (D16).** Every new component has an axe test. Any new colour pairing adds a contrast pair to `tokens.json`, and the tokens check must pass.
- **One catalogue (§8.5).** Screens compose `packages/ui`. No copy of the design's preview bundle.
- **No third-party calls (§1 rule 6).** No new font, icon or script source.

The plan's security table pins each of these conditions with a test and the source change that makes it fail:

- `people.restricted.read`, wherever it gates a minor, a label or a write;
- `people.view` and `people.manage`;
- the `people.directory` and `people.households` entitlements;
- `hideWrites` and the billing read-only state;
- `canManage` passed into `LifeEventsPanel`;
- `canManageRoles` and `canManageUsers` in Users & Roles;
- `canManage` in Module Toggles;
- `service_times.manage`;
- `!detailPerson.isMinor` on Edit contact;
- `activeTab === "adults"` on the search form and Add contact, and Add contact's `submittedSearch` condition;
- `canUnlinkGuardian` on the inline confirm;
- the household name row on Family Details absent when `label` is null, with and without `people.restricted.read`;
- `Avatar` absent for `isMinor`, when `isMinor` is missing, and on the Minors list, for a caller who holds `people.restricted.read`;
- the `people.restricted.read` gate on the new line, in both directions.

## Contracts

- New `packages/ui` exports as listed under Component map, with their class-string and axe tests.
- No API, event, entitlement, permission or website contract change.

## Done when

- Every screen under Screens renders from `packages/ui`, at 1280px and 375px, in light and dark, with screenshots of invented people in the PR.
- All Contacts, Contact Details and Family Details match their boards as far as today's data allows.
- No screen scrolls sideways at 375px, keyboard focus is visible everywhere, and axe passes.
- A minor's fields are visible to the same callers as today and no others. This replaces the handoff's "still show as locked", because they are not locked today (see Out and S2).
- No test lost a behaviour assertion.
- The PR names the §8 deviation: the browser check ran against a local stub, not the staging hostname (see Staging).

## Risks

- **A behaviour assertion lost in a test rewrite.** `all-contacts.test.tsx` is 3,214 lines and `family-records.test.tsx` 4,243. Earlier chunks lost assertions this way. Each task's report lists every removed `expect(` line with its replacement, and the reviewer checks that list against the diff.
- **A gate lost when markup moves.** Covered by the security table under Rules touched.
- **Restricted data shown to the wrong person.** Must-fail tests render each screen as a caller without `people.restricted.read`, with a household holding a minor, and assert that no minor's field or marker appears.
- **Table semantics lost on phones.** Pinned by the explicit roles and the axe test. jsdom does not apply the 640px rule, so the browser check covers the layout itself.
- **Hidden loading text announcing itself.** `billing-banner.test.tsx` asserts no `status` role in the shell, which is why the hidden text carries none.
- **Contrast.** jsdom computes no colour contrast. The tokens check covers pairs, and the browser check covers what is rendered.
- **Mass Times.** Its community-switch logic took several review rounds. Only `Panel` wraps the screen, and `service-times.tsx` logic does not change.
- **Chunk size.** This will pass the ~800-line guide by a wide margin. The handoff and AGENTS.md §3 keep it as one PR.
- **Worker memory.** This machine has 12 GB, and the two largest test files are heavy. Implementers run one task and named filters at a time.
- **Cost.** No new billed resource. Staging stays parked for this chunk (see Staging).

## Staging

AGENTS.md §8 asks for verification on the staging hostname, and staging is parked. Abdus chose option A for this chunk, then option C after it merges (S1).

**This chunk: no unpark.** No apply, no cost and no project owner step. The restyled screens are checked against a local stub API at 1280px and 375px, in light and dark, with screenshots in the PR. The PR names the §8 deviation, as `admin-design-shell` did. The stub copies the real contract shapes, including `minors` absent rather than empty. None is committed today, so it is rebuilt, and it stays uncommitted.

**After this chunk merges: `admin-screens-proof`.** Its own spec and PR. It checks the published build on the real publish path and clears the open checks for migrations `0013`–`0018`, at about USD 1.12 for 24 hours. These inputs are recorded for that spec:

- Parking removes the database, so the unpark starts empty: bootstrap, migrations, first owner and `module.engagement` on the plan, then synthetic people added through the admin.
- A sign-in needs a verified recipient while SES is in the sandbox.

**Rejected: one unpark inside this chunk.** It needs a build synced by hand and adds applies to a long branch, with no rebase or amend after the first one. It would mostly prove things this chunk does not change.

## Decisions

Chunk owner (Adnan, 2026-11-07):

- **D1. Add Adult create action: left out.** The roadmap carries "Add Adult has no create button", but the handoff says behaviour stays the same. Today a person can already do this in two steps: Add contact in All Contacts, then Add Adult. Laravel's behaviour here is not confirmed. The new `Add Adult create` row designs one server route that creates the contact and places them in the household in a single transaction. Using the two existing routes was rejected: if the second call fails, the contact exists without a household, a retry can create a duplicate, and the client must guess the person's version.
- **D2. Components left out.** `ConfirmDialog`, `Dialog`, `Radio`, `Toast`, `Tabs` and `RestrictedBanner` have no screen here, so they do not ship. The handoff lists them for this chunk, so this is a recorded deviation.
- **D3. Second review: required.** The handoff marks this chunk "no data change", but it rebuilds the screens that show minors' details. It is treated as sensitive under §2, with the second review running on a model other than the reviewer's and the implementer's.

Project owner (Abdus):

- **S1 (2026-11-07). Option A for this chunk, then option C as its own proof chunk.** See Staging. A cost item under AGENTS.md §12.
- **S2 (2026-11-07). Confirmed: this chunk does not change minors' fields.** Locking comes with `Children's data access`. Until then they show as plain text to anyone with `people.restricted.read`, as they do today, and ADR 0017 §8's known gap stays open. No client import happens before that gap closes. This replaces the handoff's done line about minors. A privacy item under AGENTS.md §12.

## How the design was read

- The admin screens boards and the design system's component notes were read live on 2026-11-07, read-only. The design system is still version `1793646986-2cfc`, the version the handoff names.
- The boards were read from their rendered page structure at 1440px, because screenshots of them would not complete. The Screens table takes its order, columns and regions from that. Nobody has compared the two by eye yet, so the browser check puts the built screens beside the boards.
- The boards are desktop only. Phone layouts follow the design rules: below 640px, tables become labelled lists and controls grow to `size-touch`.
- Screens with no board follow the design rules.

## Out-of-band

- No legal sign-off, new subprocessor or architecture change. No ADR.
- No new dependency is expected: `@base-ui/react` and `lucide-react` are already in `packages/ui`.
- Implementer: Antigravity. Reviewer agent: this session's model, recorded in the PR with the check's model.
