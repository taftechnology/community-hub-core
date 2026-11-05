Spec: docs/specs/2026-11-04-mass-times.md

# Mass Times Implementation Plan

Slug: mass-times
Status: approved (2026-11-05, Abdus Salam)

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** a community admin with `service_times.manage` opens Engagement → Mass Times, writes one block of formatted text (headings, bold, italic, lists), saves it, and the saved text is exactly what the public projection returns. The text is cleaned on save to an allow-list, so Jellycube and the Parish Hub app can render it safely.

**Architecture:**

- `modules/features/engagement` (`@community-hub/engagement`) holds the sanitiser, the `app.service_times` table (one row per community), the repository functions, the manifest, the audit action and the usage producer.
- `packages/db` gets migration `0018_*`: the table, forced RLS, literal grants, and the re-created access CHECK with ten keys.
- `packages/policy` and `modules/core/access` gain `service_times.manage`.
- `packages/contracts` gets `./service-times` and the widened capabilities response.
- `apps/api` gets the gate marking `largeBody: "content"` and `engagement-routes.ts` (`get`, `save`).
- `modules/verticals/faith-church` supplies the label and the editor field label.
- `packages/ui` gets `RichTextEditor` on its own subpath, built on Tiptap.
- `apps/admin` gets the Engagement nav, the capabilities widening, and the Mass Times screen with a new leave guard.
- The docs get ADR 0019, the architecture edits, the roadmap and `AGENTS.md` line 9.

## Who does what

- **Implementer:** Antigravity (Gemini), in its own worktree on the chunk branch. It writes tests first, makes one commit per task, commits locally and never pushes. It runs one plan task per run, because this machine has 12 GB of RAM.
- **Reviewer:** a fresh-context Claude session, reviewing each task by its diff.
- **Owner's check and second review:** from a third model family, arranged by the owner. This chunk is sensitive (a new `app` table, tenancy, the database, a permission change, and HTML that other surfaces render), so the second review starts when the last task is pushed and the pull request does not merge until it is written. Its brief names the sanitiser and the gate body limit as first-class targets.
- Only one run at a time uses the Docker test database.
- **Size.** This is one pull request by the owner's decision D7. It spans more than two modules (AGENTS.md §3 split trigger) and has 11 tasks, one over the usual ten. Both are accepted knowingly. The PR body says so, and says "verified on the staging hostname" is dropped because staging stays parked.

## Checkpoints

- **After Task 3** (the table, migration, permission key): the reviewer runs the security pins 13 to 17 before Task 4 starts.
- **After Task 7** (the routes are live in `productionRoutes()`): the reviewer runs pins 1 to 21 before any admin work starts.

## Global constraints

- **Branch:** `feat/2026-11-04-mass-times`, created from `origin/main` at `a67e3d4` (PR #74 merged), with the spec as its first commit and this plan as its second. The plan stays `Status: draft` until the owner's assistant has read both on the branch; the owner then approves it.
- **Database:** exactly one migration, `0018_*`, one expand wave. Recovery note: re-creating the access CHECK with the previous nine keys undoes the permission change; the table is dropped by the reverse migration only before any production use, because nothing in production calls the module until the Public Content API chunk.
- **Dependencies (D8, answered):**
  - `sanitize-html` in `@community-hub/engagement`, pinned exactly;
  - `@tiptap/react`, `@tiptap/starter-kit` and `@tiptap/pm` in `packages/ui`, pinned exactly, and the three at one version;
  - `jsdom` **30.1.1** as a dev dependency of `@community-hub/engagement`, the version the repo already uses;
  - nothing else. Each library is justified in the PR: what it replaces, its licence, who maintains it, its size. Task 2 and Task 8 record the licence and install size in their reports.
  - `sanitize-html` brings `postcss` into the API image, so the dependency audit now covers it.
- **Never disabled to get green:** a check, a lint rule, an axe rule, RLS or a CI gate.
- **Fixtures** are synthetic. Hostile-input fixtures are plain strings; strings that look like secrets are split so scanners never match.
- **No personal data** in URLs, logs, traces or errors. No content, and no length of the content, in an audit line or a log line.
- **Untouched areas:** staging stays parked; no Terraform or workflow change. The Dockerfile build filter changes only in Task 7, with `image.test.ts`.
- **Residency, children, money:** no change. The table has no person column.
- **Admin stale-response rules** apply to the new fetches (load and save):
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

- The block is one row per community, primary key `(org_id, community_id)`. No rows, weekdays, status, delete or list.
- Classes: `org_id`, `community_id`, `version`, `created_at`, `updated_at` are `internal`; `content_html` is `public`. The projection allow-list is derived from `dataClasses`.
- Grants are written literally:
  - `REVOKE UPDATE, DELETE, TRUNCATE ON app.service_times FROM app;`
  - `GRANT SELECT, INSERT ON app.service_times TO app;`
  - `GRANT UPDATE (content_html, version, updated_at) ON app.service_times TO app;`
- Sanitiser allow-list: tags `p br h1 h2 h3 h4 strong em ul ol li`; `b` to `strong`, `i` to `em`; no attributes (`allowedAttributes: {}`); `script style iframe object embed svg math template noscript textarea option` dropped with their content, nested allowed tags included; comments, CDATA and processing instructions dropped; other tags unwrapped with their allowed contents kept; a result with no text normalises to `""`. The cap is 20,000 UTF-16 units of the **cleaned** string, enforced in `saveServiceTimes`; Zod caps the raw `html` at 120,000 units only.
- Concurrency: expected `0` inserts with `insert … on conflict (org_id, community_id) do nothing returning version`; expected `n > 0` updates `where … and version = :expected`; zero rows is `version_conflict`, an empty `409`. No select first.
- Gate: `GateRoute.largeBody` is `"webhooks" | "content"`. `"content"` is allowed only on `POST /v1/engagement/service-times/save`, is 128 KiB (`CONTENT_BODY_MAX_BYTES = 131_072`), never applies on the webhooks hostname, and returns 413 when exceeded. Every other POST keeps 4,096 bytes and a 400.
- Routes: `POST /v1/engagement/service-times/get` (read) and `/save` (write); tenant surface; entitlement `module.engagement`; permission `service_times.manage`; `save` is billing-guarded.
- Permission grants: `community_admin` the whole catalogue; `org_owner` and `org_admin` with the catalogue; `content_editor` an explicit bundle of `service_times.manage` only; custom roles may hold it.
- The editor: StarterKit with `blockquote`, `code`, `codeBlock`, `horizontalRule`, `strike`, `link` and `underline` off and `heading` levels 1 to 4; `injectCSS` off; exported from `@community-hub/ui/rich-text-editor`, not the barrel. The dirty baseline is `editor.getHTML()` captured right after loading the server's HTML.
- The leave guard (`beforeunload` and `useBlocker`) is new in this chunk.
- Out of the chunk: the Public Content API route, the importer step, the legacy compatibility route, events, Jellycube, the mobile display.

## Security pins

The implementer runs each row once: weaken the source, see the named test fail, restore the source, and report the failure. The weakened tree is never committed. The reviewer reads the implementer's weakening report and re-runs a spot-check of at least one row per checkpoint.

| #   | Setting                                                         | Weakening                                                   | Pinning test                                                                                                                                                       |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Sanitiser allow-list                                            | add `a` and `href` to the allowed tags and attributes       | `sanitise.test.ts` structural hostile suite: every element in the allow-list, zero attributes                                                                      |
| 2   | No attributes of any kind                                       | `allowedAttributes: false`                                  | same file: an input with `onclick`, `style`, `class`, `data-x`, `start` keeps none                                                                                 |
| 3   | `script` and `style` content removed                            | drop `script` from `nonTextTags`                            | same file: `<script>b</script>` leaves no `b`                                                                                                                      |
| 4   | Container tags drop nested allowed tags                         | remove the `exclusiveFilter`                                | same file: `<svg><p>x</p></svg>` becomes `""`                                                                                                                      |
| 5   | Empty normalisation                                             | return the raw cleaned string                               | same file: `<p></p>`, `<p><br></p>`, `<h1> </h1>`, `<ul><li><p></p></li></ul>` become `""`                                                                         |
| 6   | The sanitiser runs inside `saveServiceTimes`                    | remove the call                                             | `service-times.integration.test.ts`: store `<p onclick=x>a</p><script>b</script>`, read back `<p>a</p>`                                                            |
| 7   | The cap is on the cleaned string                                | check the raw string instead                                | same file: 21,000 raw units that clean to under 20,000 are accepted; cleaned 20,001 is `invalid_input`                                                             |
| 8   | The content body limit is allowed only on the save route        | let `assertRoutes` accept `"content"` on any POST           | `gate.test.ts`: `RoutesRejected` for `"content"` on another route; `index.test.ts` route-list test fails if any other route carries it                             |
| 9   | The content limit never applies on the webhooks hostname        | drop the host condition                                     | `server.test.ts`: the save route on the webhooks hostname rejects a 5,000-byte body                                                                                |
| 10  | A body over 128 KiB returns 413; others keep 400 at 4,096 bytes | return 400 for content, or raise the default                | `server.test.ts`: 131,073 bytes on the save route → 413; 4,097 bytes on another route → 400                                                                        |
| 11  | First save is `on conflict do nothing`                          | use a plain `insert`                                        | `service-times.integration.test.ts`: two concurrent first saves → one success, one `version_conflict`, one row                                                     |
| 12  | The version match on update                                     | drop `and version = :expected`                              | same file: a stale version returns `version_conflict` and the stored text is unchanged                                                                             |
| 13  | Community predicate and `FORCE`                                 | drop `community_id` from the policy, or drop `FORCE`        | `schema.test.ts` policy text and `relforcerowsecurity`; integration test with two organisations and two communities in one organisation                            |
| 14  | Column-level `UPDATE` grant                                     | grant table-level `UPDATE`                                  | `schema.test.ts`: `org_id`, `community_id` and `created_at` cannot be updated by `app`                                                                             |
| 15  | `DELETE` and `TRUNCATE` revoked                                 | drop the revoke                                             | `schema.test.ts`: `app` cannot `DELETE` or `TRUNCATE`; the three literal grant statements are in the migration                                                     |
| 16  | The access CHECK lists ten keys                                 | re-create it with nine                                      | `access/db/schema.test.ts`: the CHECK lists `service_times.manage`; a custom role can hold it                                                                      |
| 17  | `content_editor` and `community_admin` grants                   | swap `service_times.manage` for `groups.manage` in a bundle | `decide.test.ts`: each built-in role's grant pinned                                                                                                                |
| 18  | Route permission guard                                          | guard `save` with a weaker key                              | `engagement-routes.test.ts`: a member with another permission gets 403                                                                                             |
| 19  | Entitlement guard                                               | remove the `module.engagement` guard                        | same file: entitlement off → 403 or the existing entitlement answer                                                                                                |
| 20  | Projection allow-list                                           | select `version` or spread the row                          | `projection.test.ts`: the allow-list derived from `dataClasses`; an extra-properties row (`org_id`, `version`, a `confidential` field, a minor flag) leaks nothing |
| 21  | Audit line is written and carries ids only                      | remove `appendAuditEvent`, or add the content to it         | integration test: one `engagement.service_times.saved` row per save; no content or length in it                                                                    |
| 22  | Usage is recorded last, on success only                         | call `recordSuccess` first, or on failure                   | integration test: a rejected save adds nothing to `module.engagement` usage; a good save adds one                                                                  |
| 23  | Editor schema equals the allow-list                             | enable `strike` or `codeBlock`                              | `rich-text-editor.test.tsx`: node and mark names equal the sanitiser's allow-list                                                                                  |
| 24  | No injected `<style>`                                           | set `injectCSS: true`                                       | same file: no `<style>` element after mount                                                                                                                        |
| 25  | Dirty baseline is the editor's own output                       | compare against the server string                           | `mass-times.test.tsx`: load, then leave, gives no prompt                                                                                                           |
| 26  | Nav needs entitlement and permission                            | drop the permission from the predicate                      | `nav.test.tsx`: a user with the entitlement and without the permission sees no Mass Times item                                                                     |
| 27  | Label boundary                                                  | put `mass` in an exported identifier or route               | `label-boundary.test.ts` fails                                                                                                                                     |

## Rollback

Revert the pull request. The migration is expand-only: the access CHECK is re-created with the previous nine keys and the new table is dropped, by a follow-up migration written only if a rollback is needed before the first production use. Nothing in production calls the module until the Public Content API chunk, so there is no data to preserve at rollback.

## Stop and ask (AGENTS.md §12)

Stop and report, without improvising, when any of these happens:

- A task grows past about 500 changed lines, excluding tests, fixtures, generated files and the lockfile. Split it and ask.
- The plan is wrong, or the sanitiser library does not behave as the spec says (report the case and the output).
- A task needs a migration, an infra, workflow or Dockerfile change, or a dependency the plan does not name.
- Keeping an existing test green would need a removed or weakened assertion.
- A test the plan says must change is not the test that fails.
- The same step fails twice.
- Anything looks like a security issue.

---

### Task 1: Gate marking `largeBody: "content"`

**Files:** `apps/api/src/{gate.ts,server.ts,gate.test.ts,server.test.ts,index.test.ts}`

- [ ] RED:
  - `gate.test.ts`: `assertRoutes` accepts `largeBody: "content"` only on `POST /v1/engagement/service-times/save` and throws `RoutesRejected` for any other method or pattern; the existing `"webhooks"` rules stay as they are.
  - `server.test.ts`: a route marked `"content"` accepts a body of 131,072 bytes on the API hostname and answers 413 at 131,073; the same route on the webhooks hostname rejects a 4,097-byte body with 400; an unmarked route still rejects 4,097 bytes with 400; the webhook route keeps 256 KiB. The test route uses the save pattern.
  - `index.test.ts`: a route-list test, in the style of the #74 test, enumerates every route in `productionRoutes()` with a `largeBody` marking and asserts the set equals `{ "POST /v1/stripe/webhook": "webhooks" }` for now, and that no route other than the save pattern ever has `"content"` (Task 7 extends the set to include the save route).
- [ ] GREEN: widen the type to `"webhooks" | "content"`; add `CONTENT_BODY_MAX_BYTES = 131_072`; `assertRoutes` allows `"content"` only for `POST` and the save pattern; `server.ts` picks the limit from the route marking and the presented hostname (content never on the webhooks hostname) and answers 413 for any large-body route that goes over. The existing 30-second request timeout is untouched.
- [ ] Commit `feat(api): content body limit for one route`.

Pins 8 to 10. Must not break: the webhook limit and its 413; the 4,096-byte default; `assertRoutes` for static routes.

### Task 2: Engagement package and the sanitiser

**Files:** `modules/features/engagement/{package.json,tsconfig.json,tsconfig.test.json,vitest.config.ts}`, `domain/{sanitise.ts,sanitise.test.ts,fixtures.ts}`, `public/index.ts`; `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `turbo.json`

- [ ] RED (`sanitise.test.ts`):
  - each allowed tag survives; `b` and `i` become `strong` and `em`; other tags are unwrapped with their allowed contents kept (`<div><p>x</p></div>` becomes `<p>x</p>`);
  - `script`, `style`, `iframe`, `svg`, `math`, `template`, `object`, `embed` are dropped with content, nested allowed tags included;
  - every attribute stripped, including `href`, `src`, `style`, `class`, `id`, `on*`, `data-*` and `start`; a test fails if `allowedAttributes` were `false`;
  - `javascript:` and `data:` URLs, entity-encoded and nested payloads, unclosed and stray tags, and comments do not survive;
  - fixtures `</br>`, `<br/>`, `<BR>`, `<p>` inside `<li>`, `ul > li > ol`, `&nbsp;` (kept as U+00A0), `&lt;script&gt;` (stays escaped text), a stray `</p>`;
  - idempotence over the whole corpus (`sanitise(sanitise(x)) === sanitise(x)`);
  - empty normalisation to `""`;
  - the **structural hostile suite**: each output parsed with `jsdom` 30.1.1, asserting every element is in the allow-list, every element has zero attributes, and there is no comment, CDATA or processing-instruction node. `<script` and `on…=` are substring checks only.
  - The cap is **not** in the sanitiser; it is in `saveServiceTimes` (Task 4).
- [ ] GREEN:
  - the package scaffold copies `groups` (exports to `dist/public`, pinned `drizzle-orm`, `vitest.config.ts` with the shared `globalSetup`, `fileParallelism: false`);
  - `pnpm-workspace.yaml` gains the module line; `turbo.json` adds `@community-hub/engagement#test` to the serial Docker-database chain after groups and `modules/features/*/db/schema.ts` to the `@community-hub/db#test` inputs;
  - `sanitize-html` and `jsdom` (dev) pinned exactly; the lockfile updated;
  - `sanitiseServiceTimesHtml` configured exactly as the spec says (`allowedTags`, `allowedAttributes: {}`, `disallowedTagsMode: "discard"`, `transformTags`, `nonTextTags` with the default entries repeated, an `exclusiveFilter` for the container tags, no `textFilter`, `allowVulnerableTags` false) plus the empty normalisation;
  - `public/index.ts` exports it.
- [ ] Report: the licence, who maintains it and the install size of `sanitize-html` and its dependencies (for the PR), and the weaken-and-fail result for pins 1 to 5.
- [ ] Commit `feat(engagement): sanitiser for Mass Times content`.

Must not break: boundaries (the package imports nothing from other modules yet); the schema loader rule (no schema file yet).

### Task 3: Table, migration and the permission key

**Files:** `modules/features/engagement/{db/schema.ts,db/schema.test.ts,module.manifest.ts,domain/manifest.test.ts}`; `packages/db/{drizzle.schema.ts,drizzle/0018_*.sql,drizzle/meta/**}`; `packages/policy/src/{decide.ts,decide.test.ts}`; `modules/core/access/{domain/role.ts,domain/role.test.ts,db/schema.test.ts}`

- [ ] RED:
  - `schema.test.ts`: columns and classes; primary key `(org_id, community_id)` starting with `org_id`; the policy text parsed from the migration SQL (both `USING` and `WITH CHECK` on `org_id` and `community_id`); `relforcerowsecurity` true; the three literal grant statements present; `app` cannot `TRUNCATE` or `DELETE`; `UPDATE` only on `content_html`, `version` and `updated_at`; length check on `content_html`;
  - `manifest.test.ts`: whole-manifest `toEqual`, `dataClasses` covers every column;
  - `decide.test.ts`: the catalogue is ten keys (`:27-38`); `community_admin` equals `all` (`:56-58`); the `content_editor` bundle is exactly `["service_times.manage"]` (`:79`); each built-in role's grant of `service_times.manage` pinned;
  - `role.test.ts:32` and `access/db/schema.test.ts` (pin 14) updated; the CHECK lists ten keys; a custom role can hold the key.
- [ ] GREEN:
  - `engagementTables(app)` (imports no value from `@community-hub/db`), wired in `packages/db/drizzle.schema.ts`;
  - `module.manifest.ts`: key `engagement`, `requires: ["core.usage"]`, `features: ["module.engagement"]`, `permissions: ["service_times.manage"]`, `website: { collections: ["engagement.service_times"] }`, `dataClasses` for every column;
  - migration `0018_*` generated, then hand-appended: `FORCE ROW LEVEL SECURITY`, the three grant statements, and the drop and re-add of `custom_role_permissions_permission` with ten keys; the recovery note in a comment;
  - the key added to `CATALOGUE` in `decide.ts` and the copy in `role.ts`.
- [ ] Report: pins 13 to 17.
- [ ] Commit `feat(engagement): service times table and permission`.

Must not break: every other module's schema and pins; the `0015` CHECK history; `generate.test.ts` (allowed Windows failure only).

**Checkpoint:** the reviewer runs pins 13 to 17.

### Task 4: Repository functions and the projection

**Files:** `modules/features/engagement/{infrastructure/service-times.ts,infrastructure/service-times.integration.test.ts,domain/projection.ts,domain/projection.test.ts,domain/error.ts,domain/error.test.ts,domain/boundaries.test.ts,public/index.ts}`

- [ ] RED:
  - integration (Docker database): first save inserts at version `1`; save with the right version increments `version` and `updated_at`; a stale version, expected `0` with a row present, and a non-zero expected version with no row all give `version_conflict` and change nothing; two concurrent first saves leave one row, one success and one `version_conflict`; an empty save stores `""`; the stored value equals the cleaned value, not the input (`<p onclick=x>a</p><script>b</script>` reads back `<p>a</p>`); the cap on the cleaned string, both sides (21,000 raw units that clean to 19,000 are accepted; cleaned 20,001 is `invalid_input` and nothing is stored); `getServiceTimes` returns `""` at version `0` with no row; `getPublishedServiceTimes` returns `{ html }` only; two organisations, and two communities in one organisation, never cross; audit rows hold ids and no content or length; usage adds one on a good save and nothing on a rejected one;
  - `projection.test.ts`: the allow-list is derived from `dataClasses` and fails if any non-`public` column is in it; an extra-properties row (`org_id`, `community_id`, `version`, a `confidential` field, a minor flag) leaks nothing; the shape passes `serviceTimesPublicSchema` once Task 5 exists (the test imports the contract in Task 5, not here);
  - `boundaries.test.ts`: the module imports only `@community-hub/usage`, `@community-hub/kernel`, `@community-hub/db` (transaction type and `appendAuditEvent`) and `sanitize-html`;
  - `error.test.ts`: `ServiceTimesError` codes `version_conflict`, `invalid_input`.
- [ ] GREEN: `getServiceTimes`, `saveServiceTimes` (sanitise, cap on the cleaned string, expected `0` via `insert … on conflict (org_id, community_id) do nothing returning version`, expected `n` via `update … where org_id, community_id and version`, audit `engagement.service_times.saved`, `recordSuccess(tx, "module.engagement", now)` last), `getPublishedServiceTimes` (names the one column, never `select *`), `toPublicServiceTimes`; exports in `public/index.ts` only. No function takes an organisation or community as an argument.
- [ ] Report: pins 6, 7, 11, 12, 20, 21, 22.
- [ ] Commit `feat(engagement): save and read the Mass Times block`.

Must not break: the §1 rules; usage producers' pattern (`record.ts`).

### Task 5: Contracts and capabilities

**Files:** `packages/contracts/{package.json,src/service-times.ts,src/service-times.test.ts,src/access.ts,src/access.test.ts}`; `apps/api/src/{access-routes.ts,access-routes.test.ts}`

- [ ] RED:
  - `service-times.test.ts`: request and response schemas strict; `save` carries `html` (raw cap 120,000 units) and an integer `version` ≥ 0 (negative or non-integer is rejected); the staff response returns `html` and `version`; `serviceTimesPublicSchema` is `{ html }` strict and never carries a version or timestamp; the error codes;
  - `access.test.ts:112-125` and `access-routes.test.ts:541-544`: the capabilities response lists `module.engagement` and `service_times.manage`, strict shape.
- [ ] GREEN: `./service-times` export; add `module.engagement` to `CAPABILITIES_ENTITLEMENTS` and `service_times.manage` to `CAPABILITIES_PERMISSIONS`; widen the route in `access-routes.ts`. The projection test from Task 4 gains the `serviceTimesPublicSchema` round trip here.
- [ ] Commit `feat(contracts): service times and capabilities`.

Must not break: the `.strict()` shape for existing keys; every existing capabilities consumer.

### Task 6: faith-church pack and the label boundary

**Files:** `modules/verticals/faith-church/{package.json,tsconfig.json,tsconfig.test.json,vitest.config.ts,src/terminology.ts,src/terminology.test.ts,public/index.ts}`; `pnpm-workspace.yaml`, `pnpm-lock.yaml`; `modules/features/engagement/domain/label-boundary.test.ts` (reads the other packages' files by relative path)

- [ ] RED:
  - `terminology.test.ts`: `terminology("engagement.service_times")` returns singular "Mass Time" and plural "Mass Times", and the editor field label and hint text; an unknown key throws;
  - `label-boundary.test.ts`: scans file paths, route patterns, manifest keys, exported identifiers and SQL names in `modules/features/engagement/**`, `packages/contracts/src/service-times.ts`, `apps/api/src/engagement-routes.ts` (when present), the migration, and the admin component and file names; fails on a case-insensitive `mass`; exempts `modules/verticals/**` and string literals inside `*.test.*` fixtures; a must-fail fixture proves it fires; a boundary test asserts `faith-church` is imported only by `apps/admin`.
- [ ] GREEN: the pack at `modules/verticals/faith-church`, package `@community-hub/faith-church`, listed in `pnpm-workspace.yaml`, exporting `terminology(key)`. It is not in the API image filter.
- [ ] Commit `feat(faith-church): Mass Times labels and the label boundary test`.

Pin 27. Must not break: nothing imports the pack from the API.

### Task 7: API routes and packaging

**Files:** `apps/api/src/{engagement-routes.ts,engagement-routes.test.ts,engagement-routes.integration.test.ts,index.ts,index.test.ts,image.test.ts}`, `apps/api/package.json`, `apps/api/Dockerfile`, `pnpm-lock.yaml`

- [ ] RED:
  - route tests: 401, 403 (another permission), 402 (billing read-only on `save`), entitlement off, request validation (negative or non-integer `version`, extra keys), the empty `409`, `html` that cleans to over 20,000 units is `invalid_input` (400), the save body of 20,000 characters is accepted, a body over 128 KiB is 413 (through the real server);
  - `index.test.ts`: `productionRoutes()` markings for both routes (tenant surface; `get` read, `save` write; `save` is the only route with `largeBody: "content"`); the route-list test from Task 1 now expects `{ "POST /v1/stripe/webhook": "webhooks", "POST /v1/engagement/service-times/save": "content" }`; the #74 test that `run()` boots exactly `productionRoutes()` still passes;
  - `image.test.ts:150-159`: the hard-coded name list includes `@community-hub/engagement`, so the test fails until the Dockerfile filter has it.
- [ ] GREEN: `engagement-routes.ts` (`get`, `save`, JSON body carrying `communitySlug`, no ids in paths, fixed error codes, no content in logs); added to `productionRoutes()` only; `apps/api/package.json` gains the workspace dependency; the Dockerfile build filter gains `@community-hub/engagement`; the API image still builds.
- [ ] Report: pins 1 to 22 re-run through the routes where they apply, pins 18 and 19.
- [ ] Commit `feat(api): Mass Times routes`.

Must not break: the route-class table; the webhook route; every existing route's body limit.

**Checkpoint:** the reviewer runs pins 1 to 21.

### Task 8: `RichTextEditor`

**Files:** `packages/ui/{package.json,src/rich-text-editor.tsx,src/rich-text-editor.test.tsx,src/rich-text-editor.a11y.test.tsx,src/rich-text-editor.css (or the existing CSS entry),src/exports.test.ts,vitest setup}`; `pnpm-lock.yaml`

- [ ] RED:
  - the editor's schema node and mark names equal the sanitiser's allow-list (pin 23); headings offer levels 1 to 4;
  - no `<style>` element after mount (pin 24);
  - the toolbar (heading, bold, italic, bullet list, numbered list, no link, image, quote or code) is operable by keyboard, with `aria-pressed` and an accessible name; the editable area has an accessible name;
  - `exports.test.ts`: `@community-hub/ui/rich-text-editor` resolves, and the barrel does not export it;
  - axe in light and dark; the component takes `value`, `onChange` and the labels as props and renders no copy of its own;
  - the test setup stubs `getClientRects` and `elementFromPoint`; tests drive `editor.commands` and the toolbar buttons, not typing.
- [ ] GREEN: Tiptap StarterKit configured as fixed above, `injectCSS: false`, the ProseMirror base rules in `packages/ui` CSS using only declared tokens (`check-tokens` passes), 36px controls and 44px touch targets, visible focus; subpath export in `package.json`; the three Tiptap packages pinned exactly at one version.
- [ ] Report: the licence, maintainer and install size of the Tiptap packages (for the PR); pins 23 and 24.
- [ ] Commit `feat(ui): rich text editor for formatted content`.

Must not break: the single catalogue (D16); the ops bundle (it must not import the editor); the token and opacity checks.

### Task 9: Admin nav, capabilities and the Mass Times screen

**Files:** `apps/admin/{package.json,src/people-access.tsx,src/nav.tsx,src/labels.ts,src/visible-labels.ts,src/shell.tsx,src/mass-times.tsx,src/service-times-api.ts}` and their tests (`nav.test.tsx`, `shell.test.tsx`, `visible-labels.test.ts`, `mass-times.test.tsx`); `pnpm-lock.yaml`

- [ ] RED:
  - `PeopleAccess` default and `parseAccess` carry `module.engagement` and `service_times.manage`;
  - `nav.test.tsx` and `shell.test.tsx` (frozen labels): `Engagement` is in `entitlementMap`; a Mass Times child (label from the pack) shows only with the entitlement **and** the permission (pin 26); the Engagement parent is hidden when no child is visible; the frozen order is unchanged; `visible-labels.test.ts` updated;
  - `mass-times.test.tsx`:
    - load with saved text; empty with the pack's placeholder; saving; "Saved" status announced;
    - the screen shows the server's cleaned HTML after a save;
    - 402, 403, generic error, and `version_conflict` states (the conflict keeps the staff member's text, says another change was saved first, and offers to reload);
    - the over-cap message (cleaned length above 20,000 is not sent);
    - the leave prompt: `beforeunload` and `useBlocker` fire with unsaved edits, and **not** after a save or right after load (pin 25);
    - the stale-response guard (every response guarded, each guard pinned);
    - a StrictMode render; axe on the screen; mobile width; light and dark.
- [ ] GREEN: the screen is one `RichTextEditor` (from `@community-hub/ui/rich-text-editor`) and a Save button, with the title, hint, placeholder and field label from the pack; the dirty baseline is `editor.getHTML()` captured after each load; the new leave guard; `apps/admin/package.json` gains `@community-hub/faith-church`, with tsconfig and vitest resolution; the nav branch and the capabilities widening.
- [ ] Commit `feat(admin): Mass Times screen`.

Must not break: no control that only 403s; every existing nav permission rule; the frozen nav order; no existing screen behaviour.

### Task 10: ADR 0019 and architecture

**Files:** `docs/adr/0019-service-times-collection-and-sanitised-content.md`, `architecture.md`

- [ ] ADR 0019: context, decision, consequences and alternatives for (1) the label mechanism through the vertical pack, (2) the first external collection pattern: a single-block collection with a public-only projection and no HTTP route yet, (3) sanitise-on-write with a zero-attribute allow-list, (4) the content body limit on one route, (5) the library choices. Alternatives: rows per service time, in-house sanitiser, in-house editor, a small cap under the 4,096-byte limit.
- [ ] `architecture.md`:
  - the module catalogue row for engagement;
  - §8.4 and §15.5 notes: service times is a single-block collection that returns one item `{ html }`, `""` when empty, no filters or sorts, `maxLimit` 1, `html` marked as sanitised HTML;
  - §12.1 (line ~732): the table's column-level `UPDATE` grant and its `DELETE` state;
  - §24 (line ~1367): correct the `mobile_app_services` row and add `website_settings.mass_timings` → `app.service_times`;
  - §25 Phase 2 line (line ~1401): the first public collection ships without its HTTP route;
  - line ~562: "Mass Timings" renamed "Mass Times".
  - legacy paths written as `/api/mobile-app/*` and `/api/v1/mobile-app/*`.
- [ ] No test. Commit `docs(adr): service times collection and sanitised content`.

### Task 11: Catalogue (last task on this branch)

**Files:** `docs/roadmap.md`, `AGENTS.md` (line 9 only)

- [ ] `Mass Timings` **done** and renamed "Mass Times" everywhere it appears: the row (line 177), the snapshot and next-chunk lines (25, 99, 397) and the rule at line 161. This overrides the admin design shell spec's "the module and chunk name stays `Mass Timings`".
- [ ] Amend line 161: a collection ships its schema, projection and tests; the Public Content API routes are a separate chunk.
- [ ] Add a row **Public Content API**: owns the HTTP routes, host-to-community resolution, caching and rate limits; names `engagement.service_times` as the first collection it must serve; records the three collection facts (one item `{ html }`, `""` when empty, filters and sorts empty, `maxLimit` 1, `html` marked sanitised HTML). Edit the **Content** row (line 183) to point at the new row.
- [ ] Name **Users & Roles** in the "Admin screens restyle" row next to the sign-in note (owner answer).
- [ ] Add one line each to the **Laravel importer** row (maps `website_settings.mass_timings` to `saveServiceTimes` through `sanitiseServiceTimesHtml`, expected version `0` on a fresh community, a re-run reads the version first; runs real exports through the sanitiser and reports what was dropped) and the **Mobile home CMS + Parish Hub** row (the legacy compatibility router's `/mobile-app/mass-timings` returns `{ success: true, data: html }` from `getPublishedServiceTimes`; the router chunk confirms the exact path).
- [ ] Snapshot: last shipped `mass-times`, next chunk, counts. Update `AGENTS.md` line 9 ("Next is …") as earlier chunk-closing commits did.
- [ ] Open item: the next chunk that unparks staging verifies the new table (row level security forced, `app` lacks `TRUNCATE` and `DELETE`, column-level `UPDATE`).
- [ ] Run the §5 cleanup: `rm -f docs/plans/*-report.md; git status --short`.
- [ ] Commit `docs: mark mass-times done`.

---

## Browser check before the PR (no commit)

agy walks the admin in Chrome against the stub API. The run covers:

- Engagement → Mass Times at 1280px and 375px, in light and dark;
- an empty block, a saved block, a save conflict and a billing read-only state;
- bold, italic, a heading and both list types through the toolbar, then a save and a reload;
- the leave prompt with an unsaved edit;
- the nav with and without the permission.

Screenshots go in the PR. Fixtures use invented text only.

## Owner decisions

These are answered once, at plan approval.

1. **Next chunk after this one:** the next not-started roadmap row, which is `admin-screens-restyle`, unless Abdus says otherwise.
2. **Configurations:**
   - implementer: Antigravity (Gemini);
   - reviewer: fresh-context Claude;
   - second review and owner's check: a third family, arranged by Abdus.
3. **Deviation policy:** extra attempts and actor changes are recorded as deviations in the PR. Cosmetic nits are noted in the PR, not as open items.
4. **Open items:**
   - the Public Content API route (new roadmap row);
   - the importer step for `website_settings.mass_timings` (Laravel importer row);
   - the legacy `/mobile-app/mass-timings` route (Mobile home CMS + Parish Hub row);
   - staging verification of the table (next chunk that unparks staging);
   - the `HostCollection` JSON Schema and query shape for a one-item collection (host contract freeze).

## Probe record

None. There is no Terraform in this chunk.
