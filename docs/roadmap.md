# Product roadmap

Status: approved (2026-09-18, Abdus Salam) — living companion to [architecture.md](../architecture.md) §25
Sequence only: no calendar dates, quarters, or deadlines
First customer: one live Australian parish, full cutover (admin + Parish Hub + public site in one window)

This file is the catalogue later specs are cut from. Architecture §25 stays the eight-row summary. A new spec does not start until a chunk below is pulled into `docs/specs/YYYY-MM-DD-<slug>.md` and approved.

---

## North star

A current Laravel parish leaves self-hosted Community Hub in **one window**: tenant admin, Parish Hub, and the public website all talk only to core ([architecture §24](../architecture.md#24-migrating-from-self-hosted-laravel)).

**Hard gate before any client moves:** on `staging-au`, donate, form submit, and RSVP succeed on the public site (or the Phase 4 fallback renderer). Architecture already forbids splitting a live parish across Laravel and core.

---

## Where we are

|              |                                                                   |
| ------------ | ----------------------------------------------------------------- |
| Phase        | 1 — Core platform                                                 |
| Last shipped | `ops-console-proof`                                               |
| Next chunk   | `usage-facts`                                                     |
| Phase 0      | 26 rows: 25 done, 1 superseded (`api-au-hostname`), 0 not started |
| Later phases | not started                                                       |

Update the snapshot and the row in the **same PR**, last commit on the chunk branch, before the PR opens. Do not defer to a follow-up chore after merge. Do not put implementer reports here ([AGENTS.md](../AGENTS.md) §5).

---

## How to read this

| Status          | Meaning                                                         |
| --------------- | --------------------------------------------------------------- |
| **done**        | On `main`. Do not re-spec.                                      |
| **in progress** | Spec approved or PR open.                                       |
| **not started** | No approved spec yet.                                           |
| **superseded**  | The row stays. ADR 0009 replaced that runtime. Do not build it. |

Phase 0–1 rows are **chunks** (one spec → plan → branch → PR). Phase 2–7 rows are **journeys**; specs are cut when we enter that phase.

---

## Architecture decisions

Chunks that change a documented decision without belonging to a phase. They do not count toward phase totals.

| Status | Chunk                   | What                                                                                                                                                   |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| done   | `website-host-contract` | Collections, host islands and block packs replace the widget pack; kernel `website` manifest field. ADR 0006. Spec `2026-09-24-website-host-contract`. |

---

## Process

Chunks that change how work is reviewed. They do not count toward phase totals.

| Status | Chunk             | What                                                                                                                        |
| ------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| done   | `review-workflow` | Parking, the owner's check, the local gate, and when a pull request opens. Spec `docs/specs/2026-10-07-review-workflow.md`. |

---

## Phase 0 — Foundations

Architecture: monorepo, CI, Terraform for AWS in `ap-southeast-2`, kernel, db with RLS, crypto, observability, audit, `packages/ui`.

| Status     | Chunk                        | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| done       | `monorepo-skeleton`          | Workspace, gateway `/health`, checkers, CI Stages 1–3. Spec `2026-09-17-monorepo-skeleton`.                                                                                                                                                                                                                                                                                                                                                                                        |
| done       | `terraform-au-cell`          | Cloudflare + AU AWS foundations. No tenant data. Spec `2026-09-18-terraform-au-cell`. Superseded for the runtime by ADR 0009.                                                                                                                                                                                                                                                                                                                                                      |
| done       | `packages-db`                | Privileged bootstrap, wrapped Drizzle runner, transaction-local `set_config`, RLS. Spec `2026-09-18-packages-db`.                                                                                                                                                                                                                                                                                                                                                                  |
| done       | `packages-crypto`            | AES-256-GCM, KMS wrap, blind indexes. Synthetic data only. Spec `2026-09-18-packages-crypto`.                                                                                                                                                                                                                                                                                                                                                                                      |
| done       | `kernel-runtime`             | `defineModule`, request context, DI, outbox. Keeps `healthPayload`. Spec `2026-09-19-kernel-runtime`.                                                                                                                                                                                                                                                                                                                                                                              |
| done       | `packages-residency`         | Cell config; global Workers cannot import personal-data modules. Spec `2026-09-20-packages-residency`. Superseded for the runtime by ADR 0009.                                                                                                                                                                                                                                                                                                                                     |
| done       | `packages-ui`                | shadcn copied into the repo + tokens (D16). No product screens. Spec `2026-09-25-packages-ui`.                                                                                                                                                                                                                                                                                                                                                                                     |
| done       | `audit-log`                  | Tamper-evident append. First events when identity writes. Spec `2026-09-25-audit-log`.                                                                                                                                                                                                                                                                                                                                                                                             |
| done       | `api-au-skeleton`            | Regional Worker, class regional, preview_urls false, health through kernel. Spec `2026-09-26-api-au-skeleton`. Superseded for the runtime by ADR 0009.                                                                                                                                                                                                                                                                                                                             |
| done       | `terraform-envelope-kms`     | Wrapping key, key policy, KMS endpoint, broker tunnel. Spec `2026-09-30-terraform-envelope-kms`. Superseded for the runtime by ADR 0009.                                                                                                                                                                                                                                                                                                                                           |
| done       | `kms-broker-service`         | Broker process, image, ECS task, Workers VPC service on the broker tunnel. Spec `2026-10-01-kms-broker-service`. Superseded for the runtime by ADR 0009.                                                                                                                                                                                                                                                                                                                           |
| done       | `kms-worker-adapter`         | Worker `KmsPort` against `kms-port-v1.json`. VPC binding only on `apps/api`. Spec `2026-10-01-kms-worker-adapter`. Superseded for the runtime by ADR 0009.                                                                                                                                                                                                                                                                                                                         |
| superseded | `api-au-hostname`            | Set enable_regional_hostnames, apply, attach the api route on au.api.<zone>, and verify the running Worker. Not deleted. Superseded for the runtime by ADR 0009.                                                                                                                                                                                                                                                                                                                   |
| done       | cleanup                      | Gateway app, Cloudflare and broker Terraform, Worker checks, and `packages/residency` go. `apps/api` stays. Its Wrangler files, Worker class file, and `KMS_BROKER` go, and its tests leave the Workers pool. `aws-kms-adapter.ts`, `context.ts`, and their tests move to `apps/api/src/kms/`. `@aws-sdk/client-kms` is added so those tests still run. The HTTP server, `main.ts`, the Dockerfile, `kms-port-v1`, `@community-hub/kms-aws`, and `kms-broker-binding` are deleted. |
| done       | foundations                  | Task group, multi-Region envelope key, database alarms, secrets key, tags, and budgets behind `enable_budgets`.                                                                                                                                                                                                                                                                                                                                                                    |
| done       | ingress                      | Route 53, the API certificate, Cloud Map `SRV`, the VPC link on two private subnets, the HTTP API `$default` stage, and the ECS service module.                                                                                                                                                                                                                                                                                                                                    |
| done       | `db-tls`                     | Production connection factories require TLS and take host, port, database, user, password, and the CA as separate values. Plaintext URLs stay in `@community-hub/db/plaintext` for local tests. Spec `2026-10-04-db-tls`.                                                                                                                                                                                                                                                          |
| done       | regional service             | `apps/api` in place. ARM, one process, the `KmsPort` reshape, the ported server tests, and TLS `verify-full`. The connection factories and required TLS landed in `db-tls`. This row converts `apps/api`, the `KmsPort` reshape, the probe, and the image. Spec `docs/specs/2026-10-05-regional-service.md`.                                                                                                                                                                       |
| done       | `staging-base`               | Staging applied with no task, proofs recorded, then parked. Spec `docs/specs/2026-10-05-staging-base.md`.                                                                                                                                                                                                                                                                                                                                                                          |
| done       | `db-ops-task`                | Image command is `CMD`. Bootstrap uses a SCRAM verifier. The ops task is not applied. Spec `docs/specs/2026-10-06-db-ops-task.md`.                                                                                                                                                                                                                                                                                                                                                 |
| done       | `first-running-task`         | The task ran, the proofs were recorded, and staging was parked again. Spec `docs/specs/2026-10-06-first-running-task.md`.                                                                                                                                                                                                                                                                                                                                                          |
| done       | `image-publish`              | CI builds, tests, and pushes by digest through a GitHub OIDC role scoped to this one repository. A pull request still does not push. A push to `main` publishes the digest. Spec `docs/specs/2026-10-06-image-publish.md`.                                                                                                                                                                                                                                                         |
| done       | `kms-mrk-replica`            | A replica of the envelope key in `ap-southeast-4`, not a database backup. Spec `docs/specs/2026-10-07-kms-mrk-replica.md`.                                                                                                                                                                                                                                                                                                                                                         |
| done       | `service-image-runtime-base` | The service image final stage has no package manager. `gnutls28` is not in the runtime. Spec `docs/specs/2026-10-10-service-image-runtime-base.md`.                                                                                                                                                                                                                                                                                                                                |
| done       | `db-migrate-command`         | The image gains `/app/db-migrate.js`, which applies the product migrations as the master login, refuses to run before `db-bootstrap`, and prints the tags it applied. It has not been run on staging. Spec `docs/specs/2026-10-12-db-migrate-command.md`.                                                                                                                                                                                                                          |
| done       | `staging-proof-run`          | The distroless image runs on Fargate. `db-bootstrap` then `db-migrate` applied the ten product migrations to RDS and a second run applied none. The sign-in-code route answers 503 with no mail vendor; role and entitlement routes refuse a request with no session; the service re-read a changed database secret and recovered without a restart. Staging was re-parked the same day. Spec `docs/specs/2026-10-12-staging-proof-run.md`.                                        |

Next is `usage-facts`.

SQS, EventBridge, file storage, and the admin static-file distribution are not rows here. Each waits for the first chunk that uses it.

Kernel ships `defineModule`, request context, and the organisation-scoped outbox. Observability is the logger only (no product analytics SDK — D17).

Shipped with the skeleton (not separate chunks): `@community-hub/kernel` `healthPayload()`, structured logger, `apps/gateway`, `tooling/checks/`, ADR 0001 preview URLs, session-scratch gitignore.

---

## Phase 1 — Core platform

Vertical slices. Nav items appear in the frozen order (see [Admin navigation](#admin-navigation-frozen)) and stay **hidden** until entitled.

| Status      | Chunk                     | What                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| done        | `admin-shell`             | The shell is static, Dashboard only, and makes no data call. Spec `docs/specs/2026-10-07-admin-shell.md`.                                                                                                                                                                                                                                                           |
| done        | `tenancy-implicit-org`    | Organisation and community rows in the `platform` schema. IDs, slugs, and region. Not a separate control plane. Spec `docs/specs/2026-10-10-tenancy-implicit-org.md`.                                                                                                                                                                                               |
| done        | `identity-otp`            | The regional service. OTP and passkeys as designed. No email on a gateway. Spec `docs/specs/2026-10-11-identity-otp.md`.                                                                                                                                                                                                                                            |
| done        | `people-households`       | Person, Household, GuardianLink, `is_minor`. Tags + activity log land here. Spec `docs/specs/2026-10-11-people-households.md`.                                                                                                                                                                                                                                      |
| done        | `access-roles`            | Settings → Users & Roles. Spec `docs/specs/2026-10-12-access-roles.md`.                                                                                                                                                                                                                                                                                             |
| done        | `entitlements-plans`      | Plans and allocations in the platform schema. Community toggles; nav hide/show. Spec docs/specs/2026-10-12-entitlements-plans.md.                                                                                                                                                                                                                                   |
| done        | `first-owner`             | Operator-run one-off that provisions the organisation and community (if absent) and the first owner. No HTTP route, no claim link yet. Spec `docs/specs/2026-10-13-first-owner.md`.                                                                                                                                                                                 |
| done        | `email-provider`          | Sign-in codes go through SES in Sydney behind the mail port; staging SES identity and DNS applied; live proof in `ses-sign-in-proof`. Spec `docs/specs/2026-10-14-email-provider.md`.                                                                                                                                                                               |
| done        | `ses-sign-in-proof`       | Real email OTP sign-in through SES on staging-au (sandbox); first owner provisioned; P1–P5 passed; staging re-parked. Spec `docs/specs/2026-10-15-ses-sign-in-proof.md`.                                                                                                                                                                                            |
| done        | `stripe-billing`          | Stripe subscriptions for organisations through the regional service; signed webhooks on the webhooks hostname; Checkout, Portal and status routes; `billing-admin` one-off; billing secret applied while parked in Apply 0. Spec `docs/specs/2026-10-17-stripe-billing.md`.                                                                                         |
| done        | `billing-read-only`       | The 402 write guard on `write` routes, the route marking, the shell billing banner, and Settings → General Settings → Billing. Spec `docs/specs/2026-10-19-billing-read-only.md`.                                                                                                                                                                                   |
| done        | `stripe-billing-proof`    | Live test-mode proof on staging-au of Checkout, the signed webhook, failed payment and recovery, Portal and end of subscription, with `billing-read-only`'s deferred staging verification (402 guard and admin read-only) included; staging unparked 10 h 44 min (about USD 0.50) and re-parked the same day. Spec `docs/specs/2026-10-21-stripe-billing-proof.md`. |
| done        | `ops-identity-primitives` | Operator identity primitives refactor with no tenant behaviour change. Spec `docs/specs/2026-10-22-ops-identity-primitives.md`.                                                                                                                                                                                                                                     |
| done        | `ops-operator-identity`   | Operator grants, enrolment by email code plus owner-issued code, ops passkeys, eight-hour operator sessions, and the operator event record, as identity module functions. Spec `docs/specs/2026-10-22-ops-operator-identity.md`.                                                                                                                                    |
| done        | `ops-console-api`         | Ops routes, cookie-held operator sessions, static serving on the ops host, and the read-only directory. Spec `docs/specs/2026-10-25-ops-console-api.md`.                                                                                                                                                                                                            |
| done        | `ops-operator-oneoff`     | The `ops-operator` one-off, the `provision-owner` shape refusal, the operator runbook including recovery, and the PR #62 follow-ups. Spec `docs/specs/2026-10-26-ops-operator-oneoff.md`.                                                                                                                                                                           |
| done        | `ops-console-ui`          | Operator console interface in `apps/ops`. Spec `docs/specs/2026-10-26-ops-console-ui.md`.                                                                                                                                                                                                                                                                           |
| done        | `ops-console-proof`       | Live proof on staging-au of operator enrolment with two passkeys, sign-in in Chrome and Safari, refresh after expiry, sign-out, recover and revoke, and log hygiene; staging re-parked. Spec `docs/specs/2026-10-27-ops-console-proof.md`.                                                                                                                          |
| not started | `usage-facts`             | `core/usage` skeleton (community × feature × day). Facts grow as modules ship.                                                                                                                                                                                                                                                                                      |

Phase 1 does **not** fill Enquires, Engagement, Family Records, Membership, Records, Certifications, Volunteers, Forms, Communication, Mobile App, Website & CMS, Donations, or E-commerce.

---

## Phase 2 — Engagement and mobile

Journeys, not a full backlog. Cut specs when this phase starts. Fill nav in this order where possible. Ship **`verticals/faith-church`** here (Mass times, sacraments, parish wording).

**Every public-facing journey** (Mass Timings, Notice Board, Bulletins, Events, Content) ships its **external collection** with the Public Content API: a Zod schema in `packages/contracts`, a public-only projection, and a must-fail minor test (architecture §15.5, ADR 0006). The same projection feeds Parish Hub, so this is not extra work. It is what makes Phase 4 small.

| Status      | Journey                      | Nav / surface                             | Must include                                                                                                          |
| ----------- | ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| not started | Groups                       | Contacts & Members → Groups               | Ministries, members, export                                                                                           |
| not started | All Contacts admin           | Contacts & Members → All Contacts         | Built on people/households; no children in public directories                                                         |
| not started | Family Records               | Family Records                            | Household UI; **life events** inside this item                                                                        |
| not started | Mass Timings                 | Engagement → Mass Timings                 | Service times; labels from faith-church                                                                               |
| not started | Notice Board                 | Engagement → Notice Board                 | Pin; **approve / reject**                                                                                             |
| not started | Bulletins                    | Engagement → Bulletins                    | CRUD, PDF as in Laravel if still required                                                                             |
| not started | Events                       | Engagement → Events                       | Free and **paid** RSVP, ticket types, capacity, booking detail, external ticketing URL. Staging **RSVP** gate         |
| not started | Forms + Enquires             | Forms; Enquires                           | Builder, classification on fields, public submit, enquiry inbox. Staging **form submit** gate                         |
| not started | Broadcast Messages           | Communication                             | Email to entitled audiences; IDs in the message, send from the regional service. No personal data in the job          |
| not started | Content                      | Website & CMS: Blog, Gallery, Team, Media | Public Content API + collections (articles, gallery, team). Our Schools / Our Places as content, not new modules      |
| not started | Website host contract freeze | — (agreement with Jellycube)              | Freeze `dataSources`, `islands`, notifications, role mapping with Jellycube while collection schemas are written (Q2) |
| not started | Mobile home CMS + Parish Hub | Mobile App                                | Cards, nav, ministries, sacraments, mass times. App Registry. **`parish-hub-au` only**. Legacy compatibility router   |

Laravel has **no check-in**. Do not port it here.

---

## Phase 3 — Money and safeguarding

| Status      | Journey                 | Nav / surface  | Must include                                                                                             |
| ----------- | ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| not started | Giving                  | Donations      | Campaigns, splits, GivingJar adapter, ledger, receipts. Staging **donate** gate. Recurring blocked on Q1 |
| not started | Membership              | Membership     | Plans, numbers, renewals via `PaymentProvider`                                                           |
| not started | Records                 | Records        | Compliance documents, due dates                                                                          |
| not started | Certifications          | Certifications | Parish certificate requests (admin + mobile); restricted PDFs; often children’s data                     |
| not started | Volunteers              | Volunteers     | Applications, WWCC / Blue Card, documents, **police verification** page                                  |
| not started | Safeguarding + check-in | (ops / kiosk)  | **New in core.** Incidents, messaging rules, check-in/out. Not a Laravel port                            |
| not started | Commerce                | E-commerce     | Products, orders, inventory — only if a pilot uses the shop                                              |

After this phase, donate + form submit + RSVP can be proven on staging APIs even if the public site is still Laravel (Phase 4 is the public-site gate).

---

## Phase 4 — Public website on core

| Status      | Journey                           | Must include                                                                                                                                                        |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| not started | Jellycube host adapter            | `dataSources` over the Phase 2 collections (events, notices, bulletins, service times), OIDC + `mapRoles`, lifecycle, theme tokens, **Edit in Community Hub** links |
| not started | Host islands                      | `forms.embed`, `giving.donate`, `engagement.rsvp` in `packages/web-components`. Turnstile, WCAG 2.2 AA. Staging form submit, donate and RSVP gates                  |
| not started | Freshness notification            | `website.source.changed.v1` from the outbox, sent by the regional service, signed, IDs only; Jellycube re-renders the affected routes                               |
| not started | Embedded editor + parish template | Website & CMS opens the Jellycube editor in the admin; sites provisioned from the `faith-church` template into Jellycube-managed Git. Needs Q13                     |

If Jellycube collections are not ready, ship the thin in-core renderer on the **same data sources** (Q2). Islands and the notification are the same either way.

Fills Website & CMS → Pages, Global Setting, Templates, and the top-bar **Website** button. Header/Footer live in the builder.

**Gate on first client migration:** public donate, form submit, and RSVP on staging against core — not against Laravel.

---

## Phase 5 — Client migration

| Status      | Journey          | Must include                                                                                      |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| not started | Laravel importer | Repeatable, idempotent against staging until sign-off. Restricted fields encrypted during import. |

**Each client** moves admin, mobile, and public website in one window. No live parish split across Laravel and core.

**Must already be green:** tenant-isolation and residency suites for modules they use; staging donate / form submit / RSVP on the public site.

First success: **one live Australian parish**.

---

## Phase 6 — Growth

| Status      | Journey                | Must include                                                                                    |
| ----------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| not started | Further directory apps | Mosques, sports clubs, other store names                                                        |
| not started | White-label apps       | Additional branded mobile apps                                                                  |
| not started | Organisation features  | Dioceses, leagues                                                                               |
| not started | SSO / SCIM             | Enterprise identity                                                                             |
| not started | Partner apps           | Open (Q16). The leaning is that partners host their own code. No hosted runtime in this design. |
| not started | Vertical packs         | Mosques and sports clubs                                                                        |

---

## Phase 7 — New regions

| Status      | Journey              | Must include                                                       |
| ----------- | -------------------- | ------------------------------------------------------------------ |
| not started | Legal review + cells | Canada, EU, US are designed for but not deployed until this phase. |

---

## Laravel → core (do not re-litigate)

Inventory: `/Users/iamabdus/ai-coding-2/Community-Hub` against architecture §9 (2026-09-18).

- **No missing top-level module.** Eleven Laravel toggles map to the catalogue.
- **Name as journeys, not new modules:** certificate requests, mobile home CMS, Our Schools / Our Places, police verification.
- **Intentionally dropped:** backups, ZIP system update, URL scanner, per-client SMTP, deploy-migrate webhook, in-core visual editor (Jellycube).
- **Core adds that Laravel lacks:** check-in, safeguarding incidents, Person + Household + GuardianLink.

---

## Open questions that block later rows

From architecture §26. Do not invent answers in a spec.

| #   | Blocks                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Recurring giving, refunds, GivingJar onboard                                                                                   |
| Q2  | Phase 4 Jellycube vs thin renderer; contract freeze row in Phase 2                                                             |
| Q13 | Closed for forms, donations, and RSVPs: they post to the Sydney hostname. Which account serves Jellycube sites is not decided. |
| Q3  | Closed by ADR 0011. There is no identity library.                                                                              |
| Q8  | Q8a decided (spec 2026-10-17); Q8b plan contents and prices open                                                               |
| Q9  | EmailProvider (Settings → Email Settings)                                                                                      |
| Q12 | Closed. Feature flags are `platform` tables. There is no vendor.                                                               |

---

## Open items

Startup does not prove the database or KMS, `GET /health` opens neither, and a route that needs them fails that request, decided in `identity-otp`. Unwrapped keys are not cached today; reusing them within one request is the intended direction, and the choice is made when the first list screen can be measured.

`is_minor` is written once. Before any customer data is imported, a later chunk adds a daily job in the regional service that selects minors whose `birthday_md` is today, decrypts the date of birth, and moves those who have turned 18 to the community key and the clear name columns. A person whose `age_basis` is `unknown` does not age out. In a year that is not a leap year the job also selects `birthday_md` 229 on 1 March.

The access routes derive both ids from `findCommunityBySlug`. `withAppTransaction` does not verify that a community belongs to an organisation. Later routes follow the same directory lookup and never take either id from request input.

`readSnapshot` in `core/entitlements` does not verify that the community belongs to the organisation; the routes always pass a matching pair from one lookup, so it is hardening, not a defect.

The distroless image ran on Fargate in `staging-proof-run`: health stayed 200, the `/tmp` write one-off and the ops bootstrap and migrate succeeded, and staging was re-parked the same day.

With one task on Fargate Spot, the service was interrupted twice in eight minutes during the proof run and staging had no running task for a minute or two each time until ECS started a replacement.

The webhooks hostname answers a preflight with the admin origin allowed, because the gateway's CORS configuration is shared by the api, auth and webhooks hostnames. Recorded in the proof run; stays open, as Stripe sends no preflight and no credentials.

Reloading an admin deep link (`/sign-in`, `/settings/users`, `/settings/modules`) returns 403 from CloudFront. The signed-out browser pass must start at `/`.

The admin shell has no layout or styling to speak of. Functional, but too poor to use as is.

The pooled checkout logs nothing when it re-reads a secret after a password change; CloudTrail was the only evidence of the re-read in the proof run.

The turbo build cache does not hash the staging var file, so the three parked-state tests can replay a cached result across an unpark or re-park commit. Bypass the cache (`pnpm test --force`, or the full gate form in the proof-run plan) when those flags change; see that plan's "CI and local gate while unparked" section.

`ses-sign-in-proof` is done: a real email OTP sign-in through SES on staging-au (sandbox), first owner provisioned, P1–P5 passed, and staging re-parked.

The editor chat/Run input can send a command to a different shell than the one holding variables, and it turned a literal at-sign into a full-width character; commands that use held variables are typed into the one terminal (runbook SES findings 1–2).

`grep '^Plan:'` misses Terraform's coloured summary across the runbook's plan blocks; add `-no-color` (finding 5). The forced provision-secret delete is asynchronous; the verify step should poll (finding 3).

`sed -l` in the runbook's apply filters is BSD-only; portable replacement `awk '{gsub(/ \[id=[^]]*\]/,""); print; fflush()}'` for Linux/WSL operators.

The parked-state tests (pins 1a and 1b) are presence regexes, so a comment holding the parked values can pass them while the tree is unparked; Task 4 closed the gap for this chunk with a byte-equality check against `origin/main`, but the tests themselves were not changed.

SES production access is still pending (account in the sandbox, 200 a day, verified recipients only).

`unpaid` and `grace` billing states were not proven live.

The Portal paying an `incomplete` first invoice was not proven (spec P8).

The Stripe Subscriptions write and Customers read permissions of the restricted key were not exercised by the service.

Migration `0010`'s plan update is a no-op on a new database, so every new environment needs `billing-admin plan` before Checkout.

A missing Stripe permission surfaces only as `STRIPE_API`.

Stripe dashboard has no "End trial now"; the runbook's S5 step should use the Workbench shell with `--payment-behavior=allow_incomplete` (finding 4).

The people and access `boundaries.test.ts` files read the gitignored `staging.local.tfvars` too, so they fail in a checkout whose local file holds `service_image` (finding 7).

The ops console proof observed the 8-hour operator session limit live: refresh succeeded 40 minutes after sign-in (09:03Z) and was refused 11.6 hours after sign-in (20:00Z, refresh 401 x3). That shows the session expires; the exact 8-hour boundary is pinned by the unit test, not by the run.

The ops access log format (`access_log_format` in `infra/modules/aws-ingress/main.tf`) is not pinned exactly by a Terraform test; the ops console proof checked its nine keys live only.

---

## Next spec

The next chunk is **usage-facts**. Q8b (plan contents and prices) is still open.

---

## Admin navigation (frozen)

Copied from Laravel `CommunityHubLayout.jsx`, same sequence. Core **hides** by entitlement; it does not reorder. A Phase 2–5 journey is not done until its item appears here (or is explicitly still hidden).

Top bar: **Website** (opens the public site) — live in Phase 4.

Dashboard **Quick Actions** stay in screenshot order once those modules exist: Enquires, Event, Notice, Bulletin, Article/Blog, Send Message, Add Member, Gallery, Team Members, Mass Timings.

| #   | Nav item           | Children                                                                                  | Filled in                                             | Notes                                                                                            |
| --- | ------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Dashboard          | —                                                                                         | Phase 1 shell; widgets in 2–3                         | Always visible                                                                                   |
| 2   | Enquires           | —                                                                                         | Phase 2 (forms)                                       | Label may become “Enquiries”; order stays                                                        |
| 3   | Engagement         | Bulletins, Events, Notice Board, Mass Timings                                             | Phase 2                                               | Events include paid RSVP, tickets, capacity (staging RSVP gate)                                  |
| 4   | Contacts & Members | All Contacts, Groups                                                                      | Phase 1 people; Phase 2 groups                        | Tags + activity log with people                                                                  |
| 5   | Family Records     | —                                                                                         | Phase 2                                               | Life events live inside this item, not a new top-level row                                       |
| 6   | Membership         | —                                                                                         | Phase 3                                               |                                                                                                  |
| 7   | Records            | —                                                                                         | Phase 3                                               | Compliance docs (due dates, attachments)                                                         |
| 8   | Certifications     | —                                                                                         | Phase 3                                               | Parish certificate requests — own nav row, same module family as records                         |
| 9   | Volunteers         | —                                                                                         | Phase 3                                               | Police verification is a page under this item, not a new row                                     |
| 10  | Forms              | —                                                                                         | Phase 2                                               | Staging form-submit gate                                                                         |
| 11  | Communication      | Broadcast Messages                                                                        | Phase 2                                               |                                                                                                  |
| 12  | Mobile App         | —                                                                                         | Phase 2                                               | Per-community home CMS (cards, nav, ministries, sacraments, mass times)                          |
| 13  | Website & CMS      | Pages, Blog / News, Photo Gallery, Team Members, Media Library, Global Setting, Templates | Content in Phase 2; Pages/Templates/Global in Phase 4 | Header/Footer stay in the website builder, not extra sidebar rows                                |
| 14  | Donations          | —                                                                                         | Phase 3                                               | Campaigns, splits; staging donate gate                                                           |
| 15  | E-commerce         | Products, Orders & Inventory                                                              | Phase 3 or 5                                          | Add-on; only if a pilot uses the shop                                                            |
| 16  | Settings           | General Settings, Email Settings, Users & Roles                                           | Phase 1                                               | Laravel also had URL Scanner, System Update, Backup — **dropped**. Module Toggles → entitlements |
