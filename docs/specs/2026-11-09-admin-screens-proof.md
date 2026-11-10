# Spec: Admin screens proof on staging

Slug: admin-screens-proof
Status: approved (2026-11-09, Adnan Bin Hossen)
Architecture refs: §8.5, §11.4, §12.1, §20; D16; ADR 0009, ADR 0017.

Follows `docs/specs/2026-11-07-admin-screens-restyle.md` (Staging, option C, chosen by the project owner on 2026-11-07). Each of these six chunks left a migration check open in `docs/roadmap.md`:

- `0013_cooing_emma_frost` (`usage-facts`)
- `0014_small_puff_adder` (`Groups`)
- `0015_sudden_natasha_romanoff` (`All Contacts admin`)
- `0016_smooth_forgotten_one` (`Family Records`)
- `0017_adorable_anthem` (`Life events`)
- `0018_wise_starfox` (`Mass Times`)

Model: `docs/specs/2026-10-27-ops-console-proof.md`. The operator path is in `docs/runbooks/apply-staging-au.md`:

- **Ops console proof**: Pre-checks, Apply 1, One-offs, Running-task check, Apply 2.
- **Stripe billing proof**: Stripe dashboard, Webhook secret, the `billing-admin` one-offs, S3 Checkout, S4 Webhook link, S9 delivery check.
- **Apply product migrations**.
- **Provision the first owner**.
- **Row counts**: the `db-ops` `createDirectSql` one-off.

Branch: `feat/2026-11-09-admin-screens-proof`.

## Problem

No admin screen that reads or writes people has ever run against a deployed API. `main` at `cfcf3f7` (PR #82) holds these screens, all restyled:

- All Contacts
- Family Records
- life events
- Mass Times
- Users & Roles
- Module Toggles
- General Settings and Billing

CI's `admin-publish` and `publish` passed on that push. The only check so far on the published admin loaded the Dashboard before sign-in (runbook **Admin shell**).

These can be checked only on the real path:

- the published build's API origin and auth origin (`apps/admin/src/directory.ts:14-21`), the API's CORS for the admin origin (`infra/modules/aws-ingress/main.tf:195-200`) and the admin CSP `connect-src` (`infra/modules/aws-admin-static/main.tf:3`), all three together;
- sign-in by email code from the published admin;
- the restyled screens with real responses, at 1280px and 375px, in light and dark;
- live, that a caller without `people.restricted.read` gets no minor from the API and sees none.

Migrations `0013` to `0018` have never been applied to a staging database.

## Decisions

| #   | Decision                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Source                                                                                                       |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A1  | Image and build              | The owner names `${DEPLOY_SHA}` at pre-check: `cfcf3f7`, or a later `main` commit that contains it. `publish` pushed the image for that SHA, and `admin-publish` succeeded for the same SHA with nothing published since. **Stop if** either job did not succeed, the scan is not `COMPLETE`, or the scan shows any CRITICAL finding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Runbook **Ops console proof → Pre-checks**                                                                   |
| A2  | Unpark cost, window          | USD 0.0468 an hour: about USD 1.12 for 24 hours and USD 2.25 at 48. The target is 24 hours and the hard stop is 48, both counted from Apply 1 completing to the start of the re-park apply. At the hard stop the owner re-parks even if proofs remain. Expected run: 4 to 8 hours.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `ops-console-proof` C2; restyle spec S1; owner confirmed 2026-11-09                                          |
| A3  | Admin build target           | Repository variable `ADMIN_API_ORIGIN` points at the staging API host, and `ADMIN_AUTH_ORIGIN` at the staging auth host. The owner answers yes or no and never shares the values. If the answer is no, the owner sets them and reruns `admin-publish` before Apply 1, and A1 names that run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `infra/modules/aws-ingress/main.tf:124-125`; owner confirmed 2026-11-09 (compared in his shell, not printed) |
| A4  | Sign-in addresses            | Two SES sandbox recipients that the owner verifies in his own shell, recording the status only. **U1** is the first owner, from `provision-owner`. **U2** is a second user. Both are the developer's mailboxes, and the developer types every code. The addresses are never recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Developer, 2026-11-09; owner confirmed 2026-11-09                                                            |
| A5  | Plan and entitlements        | The All Contacts, Family Records and Mass Times nav items need the entitlements `people.directory`, `people.households` and `module.engagement`, and the permissions `people.view` and `service_times.manage` (`apps/admin/src/nav.tsx:53-61`). The only code that assigns a plan is the Stripe webhook, and only for an organisation in `self_serve` mode (`modules/core/billing/infrastructure/apply.ts:109,121`). Only `billing-admin mode` creates that row (`accounts.ts:147-161`); without it the account resolves to `invoiced` and no plan is assigned. So the run uses Stripe test mode, as the Stripe proof did. The `billing-admin` one-offs are, in order: `settings`, then `plan` (whose entitlements include the three keys, alongside the Stripe proof's list), then `seed-test-catalogue`, then `mode <org slug> self_serve`, which prints `none`. U1 then subscribes from General Settings → Billing, using Stripe's test card and synthetic Checkout values, and the webhook assigns the plan. Expected `/v1/billing/status`: `state` `ok`, `planKey` `starter`. The plan confirms from code that U1's bootstrap roles hold `people.view`, `people.manage`, `people.restricted.read` and `service_times.manage`, and stops if they don't.                                                                                                                                                                                                                      | Independent check H1; Stripe proof one-offs, S3, S4                                                          |
| A6  | U2's role                    | 1. U2 signs in once. That creates the identity user (`email-otp.ts:134`); with no grant, U2 sees no people screen. 2. The owner runs a `db-ops` one-off on the identity login, which can read `identity.users` but not the `app` grants. It prints `count(*)::int`, which must be 2, and then the id from `select id from identity.users order by id desc limit 1`. Postgres has no `max` for `uuid`. Ids are time-ordered UUIDv7 (`packages/db/src/ids.ts:3-14`). `provision-owner` creates U1's row (`provision-owner.ts:139`) before U2's first sign-in creates U2's, so the newest id is U2. Before the plan goes for approval, the plan runs the exact `node -e` command once against the local Postgres 17 test container. The id goes to the one-off's log. The owner alone runs that one-off's wait, `describe-tasks` and `get-log-events`, and reports only the exit code and the count. The reviewer agent runs none of the three. After reading the id, the owner deletes that task's log stream and records yes, so the id does not stay in CloudWatch until the retention expires. 3. The owner passes the id to the developer privately. 4. The developer checks that it is not the id on the owner's grant line in Users & Roles, then pastes it into Users & Roles → Grant as U1, choosing a custom role with `people.view` and `people.manage` and without `people.restricted.read`. The id never appears in evidence or in the reviewer agent's script output. | Independent checks H2 (drafts 2 and 3)                                                                       |
| A7  | Synthetic data               | Added through the admin only, after the plan is assigned: 3 households, 6 adults, 2 minors (one with a date of birth, one without), 1 guardian link, 2 life events (one for an adult, one for a minor), and the Mass Times text. The plan fixes the invented names, with no famous people. Every household gets a name, so U1 never sees a raw household id. No contact has an email or a phone, so Contact Details shows "None". The database is destroyed at re-park.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | AGENTS.md §1 rule 7; independent check M5                                                                    |
| A8  | Browser                      | The developer creates a Brave profile used only for this run. Its only extension is playwriter, and Shields is off for the admin host. The reviewer agent drives that profile through playwriter and never launches a browser. All work happens in **one tab**, because the token and slug live in that tab's `sessionStorage` (`directory.ts:23-33`, `community.tsx:11`). **Every reload is at `/`**: reloading a deep link returns 403 from CloudFront (roadmap open item; `infra/modules/aws-admin-static/tests/admin.tftest.hcl:117`), so every screen change is navigation inside the app. The developer types the email codes and the community slug, and the owner passes the slug to the developer privately. A baseline console is recorded on the admin's `/` before sign-in. Only messages sourced from the admin, API or auth host count.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Independent check M2, M3, L2                                                                                 |
| A9  | What the reviewer agent sees | The page shows the slug in the sidebar picker (`community.tsx:88-95`), user ids in Users & Roles (`users-roles.tsx:135,313,375`), and possibly a household id in Family Records' target-household select (`family-records.tsx:1687`). The reviewer agent's scripts print only booleans, counts, HTTP statuses and role-query results. They never print page text, a URL, `sessionStorage` or a request target. This covers the transcript only. The agent does look at each screenshot it checks, so A11's mask and the synthetic-only data are what protect the images. The org slug also appears in the `billing-admin mode` ECS overrides and in CloudTrail, as in the Stripe proof. The developer accepts this for the run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Independent check H3, M5                                                                                     |
| A10 | Screens                      | Every screen in the restyle spec's Screens list, except sign-in and Users & Roles, is shown once at 1280px light and once at 375px dark as U1. Contact Details, Family Records and Family Details are shown again as U2. About 30 views. The theme is set the way the app sets it: the stored preference `community-hub.theme`, then a reload at `/`. The width comes from the viewport size. There is no media emulation. Each view gets an axe run with colour contrast on, a sideways-scroll check, and a count of console errors and failed requests under A8. Sign-in is checked for sign-in only. Its axe result is recorded, not required to be 0, because it has no `main` landmark. Users & Roles is proven by role-query assertions only, with no screenshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Developer, 2026-11-09                                                                                        |
| A11 | Evidence                     | Screenshots show the page only, never the browser frame. Before each capture, a style rule hides the sidebar Community picker. For U2, it also hides the Family Records target-household select, which shows raw household ids because U2's labels are null (`family-records.tsx:1685-1687`). A screenshot may show only synthetic people. It must not show an address, a hostname, a slug, a user id, a household id or a code. The reviewer agent checks every image in its scratchpad (`proof/shots/`) and deletes any that fails. The developer attaches the passing images to the PR, and no image is committed. The runbook and PR carry only counts, statuses, booleans and SHAs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | AGENTS.md §1 rules 5, 8                                                                                      |
| A12 | Sessions and codes           | Access tokens last 15 minutes (`session.ts:11`), and the admin does not refresh them. An expired call shows the signed-out state, and any unsaved form edit is lost. So browser work runs in **sessions of 14 minutes or less**, each with a work list in the plan. Codes are capped at 5 per address in a rolling window (`email-otp.ts:19,40,57`). At the cap, the start call sends nothing and shows no error (`email-otp.ts:55-58`). A code that never arrives means waiting out the window, not resending. The plan counts codes per address per hour, uses at most 4, and keeps one spare. A 4 to 8 hour run may need 16 to 32 codes in total. The reviewer agent scripts each session so it finishes well inside its 14 minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Independent check H3 (draft 2)                                                                               |

## Scope

In:

- A runbook section **Admin screens proof** in `docs/runbooks/apply-staging-au.md`. It covers:
  - the held values;
  - the pre-checks;
  - the one-offs, including the A6 id query and the M13 to M18 queries;
  - the Stripe steps;
  - the browser sessions;
  - proofs P1 to P9 and M13 to M18;
  - the evidence rules;
  - the close-out list.

  Where steps are unchanged, it refers to **Ops console proof** and **Stripe billing proof**.

- An unpark commit: `enable_database = true` and `desired_count = 1` in `infra/regions/au/env/staging.tfvars`. `service_image` goes only in the gitignored `staging.local.tfvars`.
- The run itself:
  1. read-only pre-checks;
  2. Apply 1;
  3. the one-offs;
  4. the proofs;
  5. an evidence commit;
  6. a re-park commit;
  7. Apply 2;
  8. a plan that shows no changes.
- The last commit, which updates the catalogue:
  - `docs/roadmap.md`:
    - the snapshot;
    - the `admin-screens-proof` row marked **done**;
    - the six migration open items closed;
    - the "Next is" line;
    - Open items;
    - Next spec.
  - The `AGENTS.md:9` Repository state row.

  Staging is parked in committed files.

Out:

- Any change to application code, Terraform (including its tests), the Dockerfile, CI or dependencies. If a proof fails because of code, the owner re-parks and the fix goes on a separate `fix/` branch. This chunk then resumes with a new unpark after that fix merges and publishes.
- Session refresh in the admin, the deep-link 403, and sign-in's missing `main` landmark and theme. They stay open items.
- Stripe findings beyond A5's steps, and the ops console.
- Production, and any data beyond A7.

## Behaviour

**Who does what**

- **Owner (Abdus):**
  - the applies, the `staging.local.tfvars` edits, every one-off and the SES address checks;
  - the Stripe dashboard checks, and cancelling the test subscription;
  - passing the slug and U2's id to the developer;
  - the answers to A2 to A4.
- **Reviewer agent (read-only on AWS):**
  - the image, admin build, migration journal and SES domain pre-checks;
  - the plan check against the expected addresses;
  - the running-task check;
  - the webhook outcome and delivery counts;
  - the browser proofs, under A9;
  - the post-apply read-back.
- **Developer (Adnan):**
  - the browser profile;
  - typing the codes, the slug and U2's id;
  - the synthetic Checkout values;
  - approving the spec and the plan.
- **Implementer:** the commits.

**Order**

1. **Pre-checks (parked).** Any failure is a stop, and nothing has been spent yet.
   - **A1:** `publish` and `admin-publish` show `success` for `${DEPLOY_SHA}`. The image digest is recorded. The scan is `COMPLETE` with 0 CRITICAL findings. The journal at `${DEPLOY_SHA}` holds 19 tags, `0000_schemas` to `0018_wise_starfox`.
   - **A3:** answered yes.
   - **SES:** the domain identity, DKIM and MAIL FROM are `SUCCESS`, and SES is still in the sandbox. The owner sees `SUCCESS` for both A4 addresses.
   - **Stripe (owner, test mode):** the four **Stripe dashboard** checks pass, and the billing secret holds the test-mode values.
   - **Parked before:** 0 RDS instances, 0 ECS clusters.
   - **Expected plan:** `infra/` has no commit after `57b2d3d`, so the plan is exactly the addresses **Ops console proof → Apply 1** lists.
2. **Unpark.**
   1. Rebase on `origin/main`, the last rebase this branch gets.
   2. Push the unpark commit.
   3. The owner writes `service_image` into `staging.local.tfvars`. `grep -c '^service_image'` prints 1.
   4. Run a read-only plan without the lock.
   5. Apply 1.
   6. Read back, then the running-task check.
3. **One-offs**, each exiting 0, in this order:
   1. `db-bootstrap`;
   2. `db-migrate` (19 migrations);
   3. `provision-owner` for U1;
   4. `billing-admin settings`;
   5. `billing-admin plan`, with the A5 keys;
   6. `billing-admin seed-test-catalogue`;
   7. `billing-admin mode <org slug> self_serve`, which prints `none`.
4. **Proofs**, in this order. Browser work follows A8 and A12.
   - **M13 to M18.** One `db-ops` `node -e` one-off on the identity login (runbook **Row counts**). It prints booleans and counts only. The identity login has no `USAGE` on schema `app`, so every check takes the table's OID from `pg_class` joined to `pg_namespace` and uses the OID forms: `has_table_privilege('app', oid, …)` and `has_column_privilege('app', oid, attnum, 'UPDATE')`, iterated over `pg_attribute`. Row security comes from `relrowsecurity` and `relforcerowsecurity`, the trigger from `pg_trigger`, and the permission CHECK from `pg_get_constraintdef`. The column loop reads `pg_attribute` with `attnum > 0 and not attisdropped`. `has_table_privilege(…, 'UPDATE')` is true only for a table-level grant. `has_column_privilege` is also true for every column when a table-level grant exists.

     The grants are not uniform, because default privileges give `app` `SELECT`, `INSERT`, `UPDATE` and `DELETE` (`0000_schemas.sql:13`). Each migration revokes only what it names. The expected end state after `0018`, one row per table:

     | Table (`app.`)      | Migration              | RLS  | FORCE | `DELETE` | `TRUNCATE` | Table `UPDATE` | Columns with `UPDATE`                                                       |
     | ------------------- | ---------------------- | ---- | ----- | -------- | ---------- | -------------- | --------------------------------------------------------------------------- |
     | `usage_facts_daily` | `0013`                 | true | true  | false    | false      | true           | all                                                                         |
     | `groups`            | `0014`                 | true | true  | false    | false      | true           | all                                                                         |
     | `group_members`     | `0014`                 | true | true  | **true** | false      | true           | all                                                                         |
     | `persons`           | `0005`, `0015`, `0016` | true | true  | false    | false      | false          | exactly the ten in `0015_sudden_natasha_romanoff.sql:4` plus `household_id` |
     | `households`        | `0005`, `0016`         | true | true  | false    | false      | false          | exactly `label`, `version`                                                  |
     | `household_keys`    | `0005`                 | true | true  | false    | false      | false          | none                                                                        |
     | `life_events`       | `0017`                 | true | true  | false    | false      | false          | exactly `event_type`, `event_date`, `place`, `notes`, `version`             |
     | `service_times`     | `0018`                 | true | true  | false    | false      | false          | exactly `content_html`, `version`, `updated_at`                             |

     Also:
     - `persons.version` and `households.version` exist.
     - The trigger `persons_before_update` exists on `app.persons`.
     - The definition of `custom_role_permissions_permission` contains `people.view`, `people.manage` and `service_times.manage`.

     Each check prints its boolean beside the expected value, with a final count of mismatches. That count must be 0. The plan pins the full command.

   - **P1 Published build.**
     - The admin host serves the build for `${DEPLOY_SHA}`: the `index.html` script name matches the CI artefact.
     - The page's requests go to exactly two other hosts, the API origin and the auth origin (a count of hosts only).
     - Methods used: `POST`, plus `OPTIONS` preflights.
     - No CSP violation and no CORS failure.
   - **P2 Sign-in.** U1 signs in by email code from `/`. The developer types the slug, and the shell loads the community.
   - **P3 Plan.**
     1. U1 subscribes in Billing (A5).
     2. Checkout returns to `/?billing=done`, and the admin strips the query (`apps/api/src/billing-routes.ts:254`; Stripe proof S3).
     3. Within 5 minutes, the webhook outcomes are `processed`, with none `unlinked` (counts only, as in Stripe proof S4).
     4. `/v1/billing/status` is `ok`.
     5. After a reload at `/`, the three nav items show.
   - **P4 Data.** U1 adds the A7 data. Every write answers 2xx.
   - **P5 Screens as U1.** The A10 views. On every shell screen:
     - 0 axe violations;
     - no sideways scroll at 375px;
     - 0 counted console errors;
     - 0 failed requests other than any expected 4xx the plan lists.

     Positive control: the household with minors shows its minors and guardian link to U1.

   - **P6 Mass Times.** U1 saves the text, navigates away and back, and sees it.
   - **P7 Restricted caller**, in this order:
     1. U2 signs in once (A6 step 1). U2 sees no people screen.
     2. The owner runs the A6 one-off and passes the id.
     3. U1 signs in again, creates the role and grants it to U2.
     4. U2 signs in again. U2's sign-in replaces U1's token in the tab, so U1 is done before this step.
     5. Checks, as booleans from the page and from its own responses:
        - All Contacts has no Minors button.
        - Family Records shows the alert "Household names and children are hidden for your role."
        - Every household cell holds the restricted marker labelled "Household name hidden for your role".
        - Every `households/list` row has `label: null`.
        - Every `people/list` item U2 receives has `isMinor` false.
        - The `households/read` response for the household with minors has no `minors` key, and its `guardians` list has no link to a minor (`modules/core/people/infrastructure/household.ts:544-560`). In A7's data, that leaves it empty.
        - Family Details shows no minor, no guardian row and no date of birth.
        - No fixed minor name from the plan appears in the page text (`innerText.includes`, per name).
        - U2's views get the A10 checks.
   - **P8 Write as U2.** U2 adds one adult. The write answers 2xx, and the adult appears.
   - **P9 Sign out.** Each user signs out. A reload at `/` asks for sign-in.
5. **Close-out.**
   1. The owner cancels the test subscription in Stripe. The `customer.subscription.deleted` delivery answers 2xx, as in Stripe proof S9. This happens before the re-park, so Stripe does not retry against a parked host.
   2. The evidence commit, then the re-park commit.
   3. The owner removes `service_image`: `grep -c '^service_image'` prints 0.
   4. Apply 2: 0 to add, 0 to change, 18 to destroy, the same addresses Apply 1 added.
   5. Read back: 0 RDS instances, 0 ECS clusters.
   6. A plan with no changes.
   7. The full gate runs only after the line is removed (Stripe proof finding 7).
6. **Catalogue commit.**

## Data

None. No table, column or migration is added. The six migrations already on `main` are applied to a new staging database and checked.

## Rules touched

- **Children (§1 rule 4, ADR 0017).** Only invented minors are used. P7 shows live that the API withholds minors from a caller without `people.restricted.read`, and that the admin shows none. A minor's name in any U2 view is a failed proof, not evidence.
- **Personal data (§1 rule 5).** No address, slug, hostname or id goes in a screenshot, the runbook, the PR or a log (A9, A11).
- **Residency (§1 rule 1).** Staging runs in `ap-southeast-2`, as before. Stripe calls come from the regional service.
- **Production (§1 rule 7).** No production data. Everything is synthetic, including the Checkout values.
- **Secrets (§1 rule 8).** Email codes are typed, never stored or printed. The Stripe keys stay in the billing secret.

**Security-relevant settings the plan must pin:**

- Staging is parked in the committed files when the PR merges: `enable_database = false`, `desired_count = 0`, and no `service_image` in any committed var file.
- Production still refuses `enable_database = false`.
- A no-identifier scan covers every added line in the runbook, roadmap and PR body.

## Contracts

None.

## Cost

Unpark costs about USD 0.0468 an hour: about USD 1.12 for 24 hours, USD 2.25 at the 48-hour hard stop, and USD 34.20 a month if left up. No new resource. Stripe test mode and SES sandbox sends cost nothing at this volume.

## Risks

- **The published build points elsewhere.** A3 and P1 catch it before any data is added.
- **The webhook does not apply the plan.** P3 stops the run, and Stripe proof S4 is the diagnostic. The usual cause is a missing `mode self_serve` (A5).
- **A proof fails because of code.** Re-park, fix on a `fix/` branch, and unpark again after the fix publishes. The cost clock restarts.
- **U2's id is left in a log.** The A6 one-off prints it to the `db-ops` log. The owner deletes that log stream after reading it (A6 step 2). If the deletion fails, the id stays until the log group's retention expires, and the owner records that.
- **A screenshot leaks an identifier.** A11's mask and check run before anything leaves the scratchpad.
- **The window runs long.** A2's 48-hour hard stop wins over unfinished proofs.
- **A session expires mid-step.** The unsaved edit is lost. Sign in again at `/`, in the same tab, within A12's count, and redo the step.
- **A cancelled subscription's webhook hits a parked host.** Close-out step 1 checks the delivery before the re-park.

## Out-of-band

- No legal sign-off. No architecture change. No new subprocessor: Stripe is an existing subprocessor, used in test mode.
- **Second review: required.** This chunk proves live which callers see children's data, and it runs authentication on staging (AGENTS.md §2). The owner's assistant runs it when the PR opens, on a model that is neither the implementer's nor the reviewer agent's.
- Owner's steps: A2 to A4, the Stripe dashboard checks, both applies, the tfvars edits, the one-offs, passing the slug and U2's id, and deleting the A6 log stream.
