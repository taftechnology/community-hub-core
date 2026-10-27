# Spec: Ops console proof on staging

Slug: ops-console-proof
Status: approved (2026-10-27, Abdus Salam)
Architecture refs: §8.5 (Ops console row), §11.4, §19 Ops console, §20; D16, D17; ADR 0009, ADR 0015.

Follows the four ops-console chunks, each of which left its staging check here:

- `docs/specs/2026-10-22-ops-identity-primitives.md`
- `docs/specs/2026-10-22-ops-operator-identity.md`
- `docs/specs/2026-10-25-ops-console-api.md`
- `docs/specs/2026-10-26-ops-operator-oneoff.md` (Out: "The first live run is in `ops-console-proof`")
- `docs/specs/2026-10-26-ops-console-ui.md` (Out-of-band: "Handed to `ops-console-proof`")

Model: `docs/specs/2026-10-21-stripe-billing-proof.md`. Operator path: `docs/runbooks/apply-staging-au.md` (**Stripe billing proof**: Pre-checks, Apply 1, One-offs, Running-task check, Apply 2) and `docs/runbooks/ops-operator.md`. The owner works in zsh on macOS, as both runbooks assume.

## Problem

No operator has ever signed in to a deployed console. `main` at `fd59b1e` (PR #65) holds the whole ops console:

- passkey-only operator identity;
- the ops routes and cookie sessions;
- the `ops-operator` one-off and its runbook;
- the `apps/ops` bundle, served from the image on the ops host.

CI's `publish` succeeded on that push. None of it has run on AWS.

The UI chunk proved the console only in jsdom. These things are checked only in a real browser:

- the CSP;
- the passkey ceremonies;
- the refusal of a second passkey on the same authenticator;
- refresh across tabs;
- Safari's handling of a ceremony that starts after a network call;
- contrast, target size and visible focus.

ADR 0015 requires a recovery runbook before first production use. The runbook was written in PR #64 and has never run.

## Decisions

| #   | Decision                | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Source                                                         |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| C1  | Image                   | The image `publish` pushed for `fd59b1e`, or for a later `main` commit that contains it. The owner names `${DEPLOY_SHA}` at pre-check. **Stop if** `publish` did not succeed, the scan is not `COMPLETE`, or the scan shows any CRITICAL finding. The admin shell is not exercised.                                                                                                                                                                                                                                                     | Runbook **Stripe billing proof → Pre-checks**                  |
| C2  | Unpark cost, window     | USD 0.0468 an hour. 24-hour target, 48-hour hard stop, both measured from Apply 1 completing to the start of the re-park apply. The owner re-parks at the hard stop even if proofs remain. Expected run: 3–6 hours.                                                                                                                                                                                                                                                                                                                     | `stripe-billing-proof` P2; **owner to re-confirm on approval** |
| C3  | Operator address        | The owner's SES-verified mailbox. While SES is in the sandbox, it is the only address that can receive the enrolment email code. The same address is also the tenant owner from `provision-owner` (C4). One identity user then holds a tenant role and an operator grant, with separate session kinds and email-code purposes. Tests already prove that separation.                                                                                                                                                                     | **Owner to confirm**                                           |
| C4  | Directory data          | `provision-owner` creates one implicit organisation and one community with synthetic slugs before the operator grant, so the directory has a row: kind `implicit`, region `au`. The parked database is destroyed at re-park.                                                                                                                                                                                                                                                                                                            | **Owner to confirm**                                           |
| C5  | Two authenticators      | Two authenticators from **different** providers, so the second is not a synced copy of the first. Registration requires a discoverable credential (`residentKey: required`) and user verification. **Proposed:** (a) the Mac's passkey store, and (b) either a FIDO2 security key that supports discoverable credentials and has a PIN set, or a phone passkey held by a different provider from (a). A passkey in the same synced password manager counts as the same device. **Without a qualifying (b), the chunk does not unpark.** | **Owner to confirm which two he has**                          |
| C6  | Browsers                | Enrolment in Chrome on the Mac, in a profile with no extensions, because extensions can raise their own CSP messages. Sign-in in Chrome and in Safari. Chrome may store a passkey in its own profile store or in a password manager rather than iCloud Keychain. The owner records which store each passkey went to (store name only).                                                                                                                                                                                                  | Developer, 2026-10-27; owner to confirm                        |
| C7  | Recover and Revoke live | Both run, Recover first, after the first enrolment and the sign-in proofs. This is the first run of ADR 0015's runbook.                                                                                                                                                                                                                                                                                                                                                                                                                 | ADR 0015; `ops-operator-oneoff`                                |
| C8  | 8-hour cap              | Not proven live; integration tests cover it. It stays an open item unless one sign-in happens to stay open for eight hours inside the window.                                                                                                                                                                                                                                                                                                                                                                                           | Developer, 2026-10-27                                          |
| C9  | Evidence                | Yes/no per check, counts, statuses, HTTP codes, key sets and SHAs only. No screenshots, because the address bar shows the ops hostname. No saved Lighthouse report, because it embeds the URL. No credential id, cookie value, code, address, slug, hostname, ARN or account id.                                                                                                                                                                                                                                                        | AGENTS.md §1 rules 5, 8; runbook evidence rules                |
| C10 | Email-code budget       | Enrolment email codes are capped at 5 an hour per address and purpose (`email-otp.ts` `CODES_PER_HOUR`), separately from tenant sign-in. This run needs at least two (O3 and O10). If a fourth code is needed within one hour, stop and wait for the hour to pass. A wrong guess uses one of the current code's attempts. A 401 never says which value was wrong.                                                                                                                                                                       | Code; developer, 2026-10-27                                    |
| C11 | Enrolment session       | An enrolment session lasts 15 minutes and does not refresh. Both passkey ceremonies, including a phone's QR flow, must finish within 15 minutes of verifying the codes. Restarting costs another email code.                                                                                                                                                                                                                                                                                                                            | `session.ts`; developer, 2026-10-27                            |

## Scope

In:

- A runbook section **Ops console proof** in `docs/runbooks/apply-staging-au.md`. It covers:
  - the held values;
  - the pre-checks and the one-offs;
  - the operator steps and the browser proofs;
  - the log counts, the evidence rules and the close-out list below.

  It refers to the Apply 1, Apply 2 and one-off steps of **Stripe billing proof** where they are unchanged. For Grant, Recover and Revoke it refers to `ops-operator.md`, including that runbook's shell-variable table, **Check the name is free** and **Delete and verify**. It records the verified-on-staging line for each of the four ops-console chunks.

- An unpark commit: `enable_database = true` and `desired_count = 1` in `infra/regions/au/env/staging.tfvars`. `service_image` goes only in the gitignored `staging.local.tfvars`.
- The run itself: read-only pre-checks, Apply 1, the one-offs, proofs O1–O14, an evidence commit, a re-park commit, Apply 2, and a plan that shows no changes.
- The last commit, which updates the catalogue:
  - `docs/roadmap.md`: the snapshot (last shipped, next chunk, counts reconciled), the `ops-console-proof` row marked **done**, the "Next is" line, the "The next chunk is" sentence, Open items, and Next spec (owner to name);
  - the `AGENTS.md:9` Repository state row.

  Staging is parked in committed files.

Out:

- Any change to application code, Terraform (including its tests), the Dockerfile, CI or dependencies. If a proof fails because of code, the owner re-parks and the fix goes on a separate `fix/` branch. This chunk then resumes with a new unpark after that fix merges and publishes.
- Production, a second operator, and two-person recovery (ADR 0015 review).
- Stripe and billing, and the admin shell. Their open findings stay open.

## Behaviour

**Who does what**

- **Owner (Abdus):**
  - the applies, every one-off, and the SES address check;
  - the held values;
  - every browser step;
  - every log count.
- **Owner's assistant (read-only):**
  - the image, migration and SES domain pre-checks;
  - the plan check against the expected addresses;
  - the running-task check;
  - the unauthenticated HTTP checks in O1;
  - the post-apply read-back.

  The assistant reads no raw log line. Where it needs a log fact, it uses a `jq` projection of `path`, `status` and `reason` only, after O13 has passed.

- **Implementer:** the commits.
- **Developer:** drafts and reports. The owner approves the spec and the plan.

**Held values (owner's proof shell only).** Each value below is entered at a silent prompt and kept until O13, then unset. Both runbooks unset their own variables when a step ends: `ops-operator.md` unsets `OPERATOR_EMAIL` and `ENROLMENT_CODE` at the end of Create, and the `provision-owner` step unsets the slugs and address. So the owner copies each value into its held variable **before** that unset.

| Variable                               | Holds                                 | Filled at                                                  |
| -------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `HELD_EMAIL`                           | the C3 address                        | before step 4                                              |
| `HELD_ORG_SLUG`, `HELD_COMMUNITY_SLUG` | the C4 slugs                          | step 4                                                     |
| `HELD_ENROLMENT_CODES` (array)         | each generated enrolment code         | after each **Generate the enrolment code**: step 6 and O10 |
| `HELD_EMAIL_CODES` (array)             | each email code read from the mailbox | O3, O10                                                    |

The enrolment code reaches the browser through the clipboard. The owner runs `print -rn -- ${HELD_ENROLMENT_CODES[-1]} | pbcopy`, pastes the code into the field, then clears the clipboard with `pbcopy < /dev/null`. The code is never typed as an argument, and never stored in a file or in shell history.

**Order**

1. **Pre-checks (parked).** Any failure is a stop, and nothing has been spent yet.
   - **C1:**
     - `publish` is `success` for `${DEPLOY_SHA}`;
     - the image digest is recorded, and its scan is `COMPLETE` with 0 CRITICAL findings;
     - the journal at `${DEPLOY_SHA}` holds 13 migration tags, from `0000_schemas` to `0012_polite_bloodstrike`.
   - **SES (assistant):**
     - the domain identity, DKIM and MAIL FROM are `SUCCESS`;
     - SES is still in the sandbox.
   - **SES address (owner, own shell):** the C3 address shows `VerificationStatus` `SUCCESS`. The owner enters the address at a silent prompt and records the status only, as in the Stripe proof. The assistant never sees the address.
   - **Parked before:** 0 RDS instances, 0 ECS clusters.
   - **Infrastructure unchanged:** `infra/` has no commit after `57b2d3d`, which is older than the Stripe proof's merge `b27593d`. So the expected plan is exactly the 18 addresses that **Stripe billing proof → Apply 1** lists.
2. **Unpark and plan.** Run these in order:
   1. Rebase the branch on `origin/main`, the last rebase this branch gets (AGENTS.md §5). `${DEPLOY_SHA}` must be an ancestor of it.
   2. Push the unpark commit.
   3. The owner writes `service_image` into `staging.local.tfvars`. `grep -c '^service_image'` must print 1.
   4. Run a read-only plan without the lock: 18 to add, 0 to change, 0 to destroy, with exactly those addresses.
3. **Apply 1.** Use the same SHA and the saved plan. Any other count or address is a stop before apply. Record the UTC completion time, which starts the cost clock. **Note the privacy-window start time, in milliseconds, before step 4.** The one-offs and Grant write to the same service log group, so they fall inside the window.
4. **One-offs.** Wait for RDS to be `available`. Each one-off exits 0 with stderr empty. Only one runs at a time.
   - `db-bootstrap`: prints one integer.
   - `db-migrate`: thirteen `applied <tag>` lines in journal order, then `done applied=13 total=13`.
   - `provision-owner` (C4): prints `created`. The provision secret is deleted and its absence verified.
5. **Running-task check.** The service is stable. The running task definition's image digest equals the pre-checked digest. Its environment variable names include `OPS_HOSTNAME`, `MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET`; record names only. That list is a subset: other names, such as `ADMIN_ORIGIN` and `BILLING_SECRET_ARN`, are expected too. `OPS_STATIC_DIR` is set by the image's `ENV`, not the task definition, so O1's `GET /` proves it.
6. **Grant (owner, `ops-operator.md` → Grant an operator).** Use the C3 address and `platform_admin`. The result is `granted`, and the secret is deleted and its absence verified. Every Grant, Recover and Revoke starts with **Check the name is free** and ends with **Delete and verify**, and no two overlap.
7. **Proofs.** Note the proof-window start time before O1; the positive controls use it. "The console" means `https://<ops host>/` in the named browser. Every yes/no check uses the exact strings in `apps/ops/src/messages.ts` and the headings in `apps/ops/src`.

   - **O1. Static files, headers and host checks.** The assistant runs these with no session, using `curl -sS --path-as-is -D -`. Record status codes and header names only.
     - `GET /` on the ops host answers 200 `text/html` with:
       - the CSP with `script-src 'self'` and `Cross-Origin-Opener-Policy` (`apps/api/src/ops-static.ts`);
       - `X-Content-Type-Options`, `Referrer-Policy` and `Strict-Transport-Security` (`apps/api/src/gate.ts`);
       - `Cache-Control: no-cache`.
     - Each `/assets/…` path in that HTML answers 200, with `Cache-Control` containing `immutable`.
     - `GET /index.html`, `GET /favicon.ico` and `GET /assets/../index.html` answer 404.
     - `GET /v1/ops/me` with no cookie answers 401 on the ops host.
     - On the API host, `GET /` and `GET /v1/ops/me` answer 404.
     - On the ops host, the tenant route `POST /v1/access/grants/list` answers 404.
   - **O2. CSP in the browser.** Use the clean Chrome profile with DevTools open on the Console tab. Visit sign-in, enrolment step 1, and the directory (at O5). Then repeat in Safari's Web Inspector. Record **yes/no**: zero messages containing `Content Security Policy` or `Refused to`.
   - **O3. Enrolment (Chrome).** Start at sign-in and follow "First time? Enrol with your codes".
     - **Step 1, "Enrol":** shows "Keep this tab open and finish enrolment here." The C3 address goes to step 2.
     - **Step 2, "Enter your codes":** shows "If this address has an open grant, a code is on its way." The email arrives, and the owner copies the code into `HELD_EMAIL_CODES`.
       - **First, one wrong enrolment code** (the right email code, and the held code with its last character changed). Expect "Those codes were not accepted. Each wrong try uses one of a small number of attempts."
       - **Then the right pair:** it moves to step 3.
     - **Step 3, "Register your first passkey":** authenticator (a). It moves to step 4. Record which store the passkey went to.
     - **O4. Duplicate refused.** At step 4, "Add a second passkey", the owner first tries authenticator (a) again. Expect the page to show "This device already has one of your passkeys. Use a different device or security key." Record yes/no. If the browser handles the duplicate inside its own dialog instead, record what it showed; that is a finding, not a stop.
     - **Step 4, completed:** authenticator (b) lands on "Sign in" with "Enrolment complete. Sign in." Record which store it went to.
     - Steps 2–4 finish within 15 minutes (C11).
   - **O5. Sign-in and cookies (Chrome).**
     - **Sign-in:** "Sign in with a passkey" with authenticator (a) shows the "Directory" heading. The table has columns Organisation, Kind, Region and Communities, and exactly one row: kind `implicit`, region `au`, with one community. No id is shown. The header shows "Directory" and "Sign out".
     - **Cookies:** in DevTools → Application → Cookies, both `__Host-ops_at` and `__Host-ops_rt` are HttpOnly, Secure, SameSite Strict, Path `/`, have no Domain, and expire at "Session". In the Console, `document.cookie.includes("__Host-ops")` is `false`. Record yes/no only, never values.
   - **O6. Sign-in with the other authenticator (Safari).** Sign in with authenticator (b). The directory shows. This also proves that Safari accepts a ceremony started after the options call (`ops-console-ui` U9). If Safari refuses, record it as a finding; O10 then uses a second Chrome profile as its second signed-in browser.
   - **O7. Refresh after expiry, two tabs (Chrome).**
     - Open the console in two Chrome tabs. Make no request in either tab for at least 16 minutes, counted from the last directory load, so the 15-minute access token expires. Then reload both tabs within about a second.
     - **Expected:** both show the directory, and neither shows sign-in.
     - **In the service log** (checked at O13):
       - `/v1/ops/me` 401 lines are expected, at least one per tab;
       - there is at least one `/v1/ops/session/refresh` 200 line;
       - there is no `/v1/ops/session/refresh` 401 line in this step.
     - **A refresh 401 here means the cross-tab lock failed.** A replayed refresh token revokes the whole session family. Treat it as a finding against `apps/ops/src/session.ts`, then sign in again. Do not retry the check.
   - **O8. Accessibility by hand (Chrome, still signed in).**
     - **Keyboard only:** sign-in, the directory and "Sign out" can each be reached with Tab and used with Enter. The focus ring is visible on every control. Record yes/no.
     - **Lighthouse:** use DevTools' built-in Lighthouse in **Snapshot** mode, Accessibility category, Desktop, on the directory page. Snapshot mode neither reloads the page nor clears storage, so the session survives. Record the score and the ids of any failing audits. Pass means no failure in `color-contrast`, `target-size` or `label`. The sign-in page is audited the same way after O9. The report is not saved or shared.
     - **Zoom:** at 200% zoom, the directory needs no horizontal scroll, and neither does sign-in after O9. Record yes/no.
   - **O9. Sign-out (Chrome).**
     - "Sign out" lands on "Sign in".
     - Reloading `/` shows "Sign in".
     - The second tab, on its next reload, also shows "Sign in". It may show "Your session has ended. Sign in again."; that is expected, so do not assert the message is absent.
   - **O10. Recover (owner, `ops-operator.md` → Recover an operator).**
     - **Before:** reload Safari and confirm the directory shows. If the access token has expired, the console refreshes first. This proves Safari holds a live session.
     - **Run:** a new enrolment code, added to `HELD_ENROLMENT_CODES`, with `platform_admin`. The result is `recovered`, and the secret is deleted and verified.
     - **After:**
       - Reloading Safari lands on "Sign in", because Recover revoked the sessions.
       - In Chrome, signing in with authenticator (a) gives "That passkey was not accepted.", because the old passkeys were deleted.
     - **Enrol again in Chrome:** use the new codes and both authenticators. The email code goes into `HELD_EMAIL_CODES`. It finishes on "Enrolment complete. Sign in.".
       - Recover emptied the server's passkey list, so `excludeCredentials` is empty for the first new passkey. Authenticator (a) may replace its old entry for this site. That is expected, not a refusal.
       - The O4 refusal is expected again only at step 4 with (a), because the server now lists (a)'s new credential.
     - **Sign in:** use (a), choosing the newest entry if the picker shows two. The directory shows.
   - **O11. Revoke (owner, `ops-operator.md` → Revoke an operator).**
     - The result is `revoked`, and the secret is deleted and verified.
     - Reloading the console lands on "Sign in".
     - Signing in with either authenticator gives "That passkey was not accepted."
   - **O12. Refusals (owner shell, no session).** On the ops host, `POST /v1/ops/enrolment/start` answers 403 in both cases:
     - with no `Origin` header;
     - with `Origin: https://example.com`.

     Both carry `Content-Type: application/json` and body `{"email":"x"}`. Record the codes only.

   - **O13. Log hygiene (owner shell).**
     - **How to count:** use the privacy window (step 3) for the value counts and the proof window for the controls. Pull `events[].message` with `--start-time` and no `--filter-pattern` from three groups: the service log group, the ops access log group, and the tenant API access log group. The log group variable names come from the plan. Count with `grep -c -i -F --`.
     - **Value counts, all 0 in every group:**
       - `HELD_EMAIL`, and its local part;
       - `HELD_ORG_SLUG` and `HELD_COMMUNITY_SLUG`;
       - each `HELD_ENROLMENT_CODES` entry;
       - each `HELD_EMAIL_CODES` entry;
       - the at-sign, written `$'\x40'`;
       - `Bearer`, `__Host-ops`, `Set-Cookie`.

       A non-zero count for an eight-digit email code is triaged: show the matching line's key set, never the line. It is not automatically a leak.

     - **Structural checks:** these prove that values nobody holds cannot appear. Token values and credential ids are HttpOnly or browser-held and cannot be counted. So the check is that no log line has a field that could carry them.
       - Every service line in the window parses as JSON. Its keys are a subset of `level`, `message`, the logger's fixed fields, and `GateLogFields` (`apps/api/src/gate.ts`): `method`, `path`, `status`, `duration`, `requestId`, `gatewayRequestId`, `reason`, `hostname`, `errorClass`, `errorCode`. The plan lists the logger's fixed fields from `packages/observability/src/logger.ts`.
       - Every ops access line has exactly the nine keys of `access_log_format` (`infra/modules/aws-ingress/main.tf`).
       - Record the distinct key sets with `jq -c 'keys'`.
     - **Known by design, not a leak:** the access log's `domainName` field and the service log's `hostname` field on cross-host 404s carry hostnames. Request ids and route patterns appear too. Evidence records counts only.
     - **Positive controls (proof window, service `request` lines by `path` and `status`; each count must be met):**

       | Route                                                                   | Status | At least                            |
       | ----------------------------------------------------------------------- | ------ | ----------------------------------- |
       | `/v1/ops/enrolment/start`                                               | 204    | 2                                   |
       | `/v1/ops/enrolment/verify`                                              | 200    | 2                                   |
       | `/v1/ops/enrolment/verify`                                              | 401    | 1                                   |
       | `/v1/ops/passkey/register/verify`                                       | 200    | 4                                   |
       | `/v1/ops/passkey/authenticate/verify`                                   | 200    | 4 (O5, O6, O10, and any re-sign-in) |
       | `/v1/ops/passkey/authenticate/verify`                                   | 401    | 3 (O10, O11)                        |
       | `/v1/ops/session/refresh`                                               | 200    | 1                                   |
       | `/v1/ops/session/end`                                                   | 204    | 1                                   |
       | `/v1/ops/enrolment/start`                                               | 403    | 2                                   |
       | `reason` `ops_route_on_other_hostname` or `other_route_on_ops_hostname` | 404    | the O1 cross-host checks            |

       Extra lines from retries are fine.

     - Only after O13, unset every held value and the runbooks' variables.
   - **O14. Verified-on-staging record.** One line per chunk, naming the proofs that cover it:
     - `ops-identity-primitives`: O5, O6 and O10 (passkeys bound to the ops RP ID with user verification, operator and enrolment session kinds, enrolment email purpose).
     - `ops-operator-identity`: O3–O6, O10 and O11.
     - `ops-console-api`: O1, O5 (cookie attributes), O7, O9 and O12.
     - `ops-operator-oneoff`: step 6, O10 and O11.
     - `ops-console-ui`: O2–O9.

8. **Evidence and re-park.**
   - Make the evidence commit.
   - Push the re-park commit and remove `service_image` from `staging.local.tfvars`; `grep -c` must print 0.
   - Apply 2 destroys exactly 18 resources, at the same addresses. Follow it with a plan that shows no changes.
   - Record the UTC completion time and the total window.
9. **Close-out.**
   - The owner deletes the ops-site passkey entries from both authenticators and records yes/no. Otherwise a later run's picker would offer dead entries.
   - Make the catalogue commit.
   - Run the full gate on the re-parked tree.
   - Confirm that no `docs/plans/*-report.md` exists and nothing under `.superpowers/` is staged.
   - Open the pull request. Its body records the applied SHAs and the review record.

**Failures and history**

- A failed proof, or a second failure on the same step, is a stop: re-park first (AGENTS.md §12).
- These are not failures. Record what was observed:
  - O4, when the browser handles a duplicate in its own dialog;
  - O6, when Safari refuses the ceremony. That is a finding, and its fix goes on a `fix/` branch;
  - a Spot interruption. Wait for the replacement task, then rerun that step once.
- After Apply 1 there is no rebase, amend or force-push on this branch.
- `main` comes in by a merge commit.
- The pull request merges with a merge commit.

## Data

No table, column or migration. Staging holds synthetic data only:

- one implicit organisation, one community, and one owner (C3, C4);
- one operator grant and its events, revoked at O11;
- that operator's passkeys, deleted at O10 and O11;
- the run's sessions and email challenges.

The re-park destroys the database. The authenticators' entries for the ops site are deleted at close-out.

## Rules touched

- **Rule 1.** The service, database, logs and secrets stay in `ap-southeast-2`. The operator uses the console from wherever he is, which is rule 1's operator case. The directory shows no personal data.
- **Rule 5.** O13 is the check, by values and by structure.
  - Evidence carries no address, slug, code, cookie, credential id, hostname, ARN or account id.
  - The SES address check runs in the owner's shell.
  - The assistant sees no raw log line.
- **Rule 7.** No production data exists. Staging is a separate AWS account.
- **Rule 8.**
  - Enrolment codes are generated offline and reach the browser through the clipboard, which is cleared after use.
  - Every held value is entered at a silent prompt and unset after O13.
  - The provision secret exists only between Create and Delete and verify, every time.
- **AGENTS.md §6 Cost.** This spec says why staging is unparked, what it costs and for how long. The chunk re-parks before merge.

Security-relevant settings the plan must pin with a test and a weakening change:

1. **Staging is parked in committed files at merge.** Use the same tests as `stripe-billing-proof` setting 1. The unpark and evidence commits are expected to fail them, and the full gate runs only on the re-parked tree.
2. **Production still refuses `enable_database = false`.** An existing test, run again.
3. **No identifier in any added line.** The plan names the scan the reviewer runs on the diff. It must match each of these:
   - an at-sign followed by a domain;
   - 12-digit numbers;
   - ARNs;
   - IPv4 and IPv6 addresses;
   - the zone name and the ops or API hostname suffix;
   - the `-provision-owner-` secret-name tail;
   - UUIDs;
   - base64url runs of 43 or more characters;
   - base32 runs of 26 or more characters;
   - 8-digit runs next to the word "code".

   It allows the placeholders and examples the runbook already uses.

## Contracts

None changed.

## Cost

| Line                          | Monthly USD      | Method                                                                                                                                          |
| ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Unpark (database, task, IPv4) | 34.20 if left up | USD 0.0468 an hour: about USD 1.12 at 24 hours and USD 2.25 at 48 hours. The last run (`stripe-billing-proof`) took 10 h 44 min, about USD 0.50 |
| One-off tasks, SES sends      | cents            | Billed per second; USD 0.10 per 1,000 messages. Outside the totals                                                                              |
| Provision secret              | under 0.01       | Exists for minutes, four times (`provision-owner`, Grant, Recover, Revoke), plus any rerun                                                      |
| API Gateway (ops stage)       | cents            | Per request; a few hundred requests                                                                                                             |

At Apply 2, staging returns to the parked month: about USD 7.70 plus images. This window alone cannot reach the USD 40 budget alert.

## Risks

- **No qualifying second authenticator (C5).**
  - Mitigation: the owner confirms C5 before approval. Without it, the chunk does not unpark.
- **The run needs focused time.** O7 needs a 16-minute wait, the C11 enrolment session lasts 15 minutes, and Recover and Revoke add two more one-off runs.
  - Mitigation: start Apply 1 only when O1–O13 can follow within hours.
- **A synced passkey from the same provider is offered as authenticator (b).**
  - O4's refusal is then correct behaviour. Pick (b) from a different provider.
- **The single Spot task is interrupted mid-ceremony.**
  - The ceremony fails with a fixed message. Retry once after the replacement task is up. Watch the C10 code budget.
- **A code defect found live cannot be fixed on this branch.**
  - Mitigation: re-park, then fix on a `fix/` branch.
- **A filter pattern may be recorded by CloudTrail.**
  - Mitigation: count locally (O13).
- **Lighthouse in navigation mode clears storage and signs the operator out.**
  - Mitigation: O8 uses Snapshot mode.
- **`stripe-billing-proof` finding 7.** Two boundaries tests read the gitignored `staging.local.tfvars` and fail while it holds `service_image`.
  - Mitigation: the full gate runs after the line is removed.

## Open items this chunk records but does not fix

- **The ops access log format is not pinned exactly.** `ingress.tftest.hcl` checks the tenant stage's format by `strcontains` only. O13 checks the nine keys live. A later `fix/` or chore can add an exact assertion.
- **The 8-hour session cap (C8).**

## Out-of-band

- **Legal:** none.
- **New vendor or AWS service:** none. Lighthouse is built into Chrome DevTools, runs locally, and adds nothing to the product. Rule 6 governs product surfaces.
- **Architecture change:** none.
- **Size:** docs plus one var-file flip each way, well under AGENTS.md §3's ~800 lines.
- **Second fresh-context review:** required, because this run covers authentication and operator access. The owner's assistant runs it when the pull request opens.
- **Rollback:** Apply 2 is the rollback.
