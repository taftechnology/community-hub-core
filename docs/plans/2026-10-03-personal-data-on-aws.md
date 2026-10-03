# Personal data on AWS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the decision that Community Hub core runs in AWS Sydney, and take the old Cloudflare design out of the living documents.

**Architecture:** One documents commit chain. ADR 0009 states the decision. Three commits then rewrite `architecture.md` by section range. The file describes only the Sydney runtime when the third of those commits lands. `AGENTS.md` renumbers the non-negotiables and drops Workers, jobs, and Durable Objects. The runbook refuses the old apply steps. The roadmap is the last content commit.

**Tech Stack:** Markdown, Prettier. No application code, no Terraform, no cloud command.

**Spec:** `docs/specs/2026-10-03-personal-data-on-aws.md`

Status: approved (2026-10-03, Abdus Salam)

**Branch:** `docs/2026-10-03-personal-data-on-aws` · one PR · 7 tasks, one commit each

## Global Constraints

- Documents only. Do not change application code, Terraform, CI workflows, or package manifests.
- Do not run `terraform apply`, `wrangler deploy`, or any command that creates, changes, or deletes a cloud resource.
- Do not edit a merged spec, plan, or ADR. ADR 0001 and ADR 0008 are superseded by ADR 0009. ADR 0006 is amended by a statement in ADR 0009. ADR 0002 is not edited. The paused branch `feat/2026-10-02-api-au-hostname` is not merged, continued, or deleted.
- Do not start the cleanup, foundations, ingress, service, first staging apply, or `kms-mrk-replica` chunks. Name them in the roadmap only.
- Copy figures from the spec. Do not recompute a price and do not invent one. The five infrastructure totals are USD 0.00, 6.60, 40.40, 62.28, and 94.51. Production at launch with staging parked is USD 68.88 before requests, logs, and GST.
- `architecture.md` may still describe the old design in sections a later task has not reached. It must describe only the Sydney runtime when task 4 commits. After that commit, Workers, Regional Services, Hyperdrive, the tunnel, the broker, D1, KV, R2, Cloudflare Queues, Workflows, Cron, and Durable Objects are not the current design.
- Do not turn a leaning into a decision. The four items in the spec's Open mechanisms section stay open. Architecture records the old path as superseded by ADR 0009, then the question, the leaning, and the chunk that decides it.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- No migration. There is no database change in this chunk.
- The human reviews each commit before the next task starts. A second fresh-context review of the final diff is required before merge. This chunk changes the residency rule and the encryption path. Record the configurations in the PR body. Do not pin a model name in the documents.
- Traceability stays red until this plan is approved and the PR body links the spec and the plan. Do not weaken the check.

**Rollback:** Revert the PR. No migration, no Terraform state, no running resource. The old documents return with the revert.

## Open mechanisms

Copy the spec's Open mechanisms section. Do not add a fifth, and do not drop the word "leaning".

| Question               | Owning chunk                                    | Sections                 |
| ---------------------- | ----------------------------------------------- | ------------------------ |
| Entitlement visibility | `entitlements-plans`, including cache staleness | §10.1, §10.3, §10.4, §26 |
| Hard usage limits      | The first chunk that enforces a limit           | §10.4, §26               |
| Partner code           | The partner-apps phase. A product decision.     | §16.2, §25, §26          |
| Usage aggregates       | `usage-facts` and `ops-console`                 | §19.3, §26               |

---

### Task 1: ADR 0009

**Files:**

- Create: `docs/adr/0009-personal-data-on-aws.md`
- Modify: none

**Interfaces:**

- Consumes: the approved spec. Do not add a decision the spec does not contain.
- Produces: ADR 0009, status accepted, date 2026-10-03. Later tasks cite it. They do not restate a second design.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0009-personal-data-on-aws.md` with this header and these sections. Prose is complete sentences. The rule 1 text, the three cases, the four regional exceptions, the old-to-new map, the five totals, and the rejected alternatives below are the wording. Do not soften them.

```markdown
# ADR 0009: Community Hub core runs in AWS Sydney

- Status: accepted
- Date: 2026-10-03
- Spec: `docs/specs/2026-10-03-personal-data-on-aws.md`
- Supersedes: ADR 0001, ADR 0008
- Amends: the form path in ADR 0006, by statement. ADR 0006 is not edited.
```

**Context.** The architecture kept personal data in Australia with Cloudflare Regional Services on every regional hostname. The account does not have Regional Services. It is an Enterprise add-on, priced by contract, and the DNS form has no Region option. Without it, a Worker runs in whichever data centre the visitor reaches. The documented limits are that Regional Services does not cover outbound subrequests, Queue consumers, Cron Triggers, or `workers.dev`, and log-location control is US or EU only. Staging has never been applied.

**Decision.** Community Hub core runs entirely in AWS Sydney (`ap-southeast-2`). Nothing of ours runs on Cloudflare Workers. There is no global tier until a second region exists. One ECS Fargate service, ARM, serves the API, sign-in, webhooks, background jobs, and the ops console. Ingress is a regional HTTP API with a VPC link to Cloud Map, `SRV` records, a `$default` stage, and a VPC link created on two private subnets from the first apply. DNS is Route 53. Turnstile is the only remaining Cloudflare product, and Terraform does not manage it. The envelope key is a multi-Region primary key. The task role calls KMS. The broker is removed. The database is RDS PostgreSQL `db.t4g.micro`, single-AZ, with the production protections in the spec. Passwords are in Secrets Manager, write-only, and the master user is bootstrap only.

**Rule 1.** Copy the spec's Rule 1 section, including cases (a), (b), and (c), and the four named exceptions. State that none of the exceptions holds personal data. Backups are in `ap-southeast-2` only. Any future copy of personal data stays in Australia. `kms-mrk-replica` is a replica of the envelope key, not a database backup.

**Non-negotiable map.** Copy the spec's old-to-new table. Old 2 and old 6 are removed. Old 1 becomes new 1. Old 3 becomes new 2. Old 4 becomes new 3. Old 5 becomes new 4. Old 7 becomes new 5. Old 8 becomes new 6. Old 9 becomes new 7. Old 10 becomes new 8. Merged specs and plans keep the old numbers and are not edited.

**Cost.** Copy the five infrastructure totals and the combined figure USD 68.88. State that each environment has its own state key (`ch-tfstate-staging-au`, `ch-tfstate-prod-au`), so two environments are the plain sum. Copy the key-rotation table: four keys are USD 4, then USD 8, then USD 12; five keys with the replica are USD 5, then USD 10, then USD 15. Cite the KMS pricing page for the cap at the second rotation. Copy the budget amounts: staging USD 50 (alert USD 40), production USD 110 (alert USD 88), two-zone USD 165 (alert USD 132). Mark the request volumes as estimates. Exclude GST from the five infrastructure totals and say the realistic months include 10 percent GST. Record the cost rules: cheap staging defaults, `environment` and `project` tags, a budget per environment, a later chunk names any new hourly or monthly resource, and no NAT gateway, load balancer, or extra interface endpoint without that. Savings Plans and a reserved database are an open item.

**Consequences.** What we lose: Cloudflare's edge protection in front of the API, and a ready-made global routing layer. A second region will need a small directory, built then. Single-AZ recovery is a restore, not a failover. The latest restorable time is typically the last five minutes. The targets stay at most 15 minutes of data lost and 4 hours to restore. Operators in Australia, Canada, and Bangladesh can see data under a grant. That is case (b), not a second stored copy. Then the four open mechanisms, copied from the spec, as work this decision leaves open. Each one names its leaning and the chunk that decides it. Do not write a leaning as a decision.

**Alternatives rejected.**

- Buying Regional Services. No public price. The product does not cover outbound calls, queues, cron, or `workers.dev`. No quote is being sought.
- Keeping a split: personal data on AWS, and Workers that hold no personal data on Cloudflare. The owner closed this on 2026-10-03.
- An Application Load Balancer in front of the API. The HTTP API is enough until WAF or a request longer than 30 seconds is required.
- Keeping the KMS broker. A Worker cannot hold an AWS credential; that reason is gone. ADR 0008's endpoint price of about USD 7–8 is not reused. The checked price is USD 0.013 an hour in each zone.
- IAM database authentication on `db.t4g.micro`. The RDS user guide requires 300 to 1,000 MiB of extra memory.
- A second service with no KMS permission, and a separate staff directory.

**Q13.** A form, a donation, or an RSVP posts from the browser to the Sydney hostname. It does not pass through a Jellycube Worker. Editor actions are attributed to the OIDC `sub`. Personal data is not sent to Jellycube. The old reason, that Durable Objects have no Australian jurisdiction, is replaced. ADR 0006 is not edited.

- [ ] **Step 2: Check the required sentences**

Run:

```bash
rg -n "ap-southeast-2|old 3|USD 68.88|Regional Services|kms-mrk-replica|OIDC" docs/adr/0009-personal-data-on-aws.md
```

Expected: rule 1 names `ap-southeast-2`; the map says old 3 becomes new 2; the combined total is USD 68.88; Regional Services appears only as the rejected alternative; the Melbourne row is a key replica; the Q13 paragraph names the OIDC `sub`.

- [ ] **Step 3: Format and commit**

```bash
pnpm exec prettier --write docs/adr/0009-personal-data-on-aws.md
git add docs/adr/0009-personal-data-on-aws.md
git commit -m "$(cat <<'EOF'
docs(adr): decide that core runs in AWS Sydney

Regional Services is not available, and a Worker without it is not
a residency guarantee. ADR 0009 records the Sydney runtime.

Refs: docs/plans/2026-10-03-personal-data-on-aws.md task 1
EOF
)"
```

---

### Task 2: architecture.md, sections 1 to 9

**Files:**

- Modify: `architecture.md` (sections 1 to 9 only, including D1 to D17)
- Modify: none of `docs/adr/0001-preview-urls-on-global-workers.md`, `docs/adr/0002-terraform-roots-follow-failure-domains.md`, `docs/adr/0006-website-collections-islands-blocks.md`, `docs/adr/0008-kms-broker-in-the-cell.md`

**Interfaces:**

- Consumes: ADR 0009. Where a sentence would contradict the ADR, the ADR wins.
- Produces: sections 1 to 9 describe the Sydney runtime. Sections 10 to 28 still describe the old design until tasks 3 and 4. That is expected. Do not edit them in this task.

There is no new automated test. Do not add a checker. Do not run the whole-file search in this task.

- [ ] **Step 1: Replace the current-design sentences in sections 1 to 9**

A decision row that changes carries the new decision. Its status says the row was changed by ADR 0009. Do not label that new text "superseded".

| Place                  | Replace with                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §2                     | The Laravel community registry is replaced by directory rows in the `platform` schema, not by a control-plane service. The mobile app talks to the Sydney API.                                                                                                                                                                       |
| §3 principle 1         | One codebase, deployed as one Fargate service. Extract a service only when there is a measured reason.                                                                                                                                                                                                                               |
| §3 principle 3         | Rule 1, including cases (a), (b), and (c). There is no global tier until a second region.                                                                                                                                                                                                                                            |
| §3 principle 10        | A new region is Terraform plus `terraform-invariants`, not a code fork and not `catalog.json`. Name the four exceptions. None holds personal data.                                                                                                                                                                                   |
| D1                     | Core runs on AWS in `ap-southeast-2`. Jellycube stays a separate product. Status: changed by ADR 0009.                                                                                                                                                                                                                               |
| D2                     | PostgreSQL in `ap-southeast-2`, reached from the ECS task's security group. No Hyperdrive and no tunnel. Status: changed by ADR 0009.                                                                                                                                                                                                |
| D5                     | TypeScript, Drizzle, and Zod stay. The runtime is a Node process on Fargate. The HTTP framework is decided in the service chunk's spec. Do not say whether Hono stays. Status: changed by ADR 0009.                                                                                                                                  |
| D8                     | The task role calls `kms:GenerateDataKey` and `kms:Decrypt`. The broker is removed. Status: changed by ADR 0009. Do not edit ADR 0008.                                                                                                                                                                                               |
| D9                     | Identity is the regional service. `platform_*` roles require a passkey. Email one-time codes cannot start a platform session. The library remains Q3. Status: changed by ADR 0009.                                                                                                                                                   |
| D11                    | Live screens poll. Durable Objects are not part of the design. Status: changed by ADR 0009.                                                                                                                                                                                                                                          |
| D12                    | The rule is unchanged. The sentence that decrypting every row inside a Worker does not scale becomes the service. Status: changed by ADR 0009.                                                                                                                                                                                       |
| §5 diagram             | Clients call the Sydney hostname. One service. Route 53. No gateway Worker and no control-plane Worker.                                                                                                                                                                                                                              |
| §6.3                   | Keep `set_config(..., true)` and the role split. Delete the Hyperdrive reason. Do not name a new pooler.                                                                                                                                                                                                                             |
| §7 title and §7.1–§7.2 | One Fargate service, HTTP API, VPC link, Cloud Map, RDS, KMS, S3. SQS and EventBridge are the later job path. Admin static files are S3 and CloudFront and hold no personal data. Delete the global-versus-regional box as a current layout.                                                                                         |
| §7.3                   | Rule 1, the three cases, and the four exceptions. Point at AGENTS.md for the eight non-negotiables. Delete the seven Cloudflare residency rules as current rules.                                                                                                                                                                    |
| §7.4                   | Client, API Gateway, the task, Postgres. No KV and no Hyperdrive. `set_config(..., true)` stays.                                                                                                                                                                                                                                     |
| §7.5                   | A later region is Terraform plus `terraform-invariants`. Do not tell anyone to edit `catalog.json`. Name the four exceptions and say none holds personal data.                                                                                                                                                                       |
| §7.6                   | Clients poll. The HTTP API has no WebSocket, and its integration timeout is 30 seconds. Drop the Durable Object fan-out option. Q10 is closed by this.                                                                                                                                                                               |
| §8.1                   | The service is `apps/api`, converted in place later. `apps/gateway` remains on disk until the cleanup row. Do not describe it as the design. `packages/residency` is not part of the design. `packages/db` is Drizzle, not Hyperdrive. The AU root is AWS, not a tunnel.                                                             |
| §8.2                   | `http/` is HTTP routes. The framework is decided in the service chunk's spec. Do not write Hono.                                                                                                                                                                                                                                     |
| §8.3                   | `domain/` stays free of the HTTP framework, Drizzle, and adapters. Do not name Hono. Delete the global-app rule and the `worker.meta.json` rule. Platform and ops modules must not import `@community-hub/crypto`, including `import type`. The granted-read module is the exception. That enforcement is the cleanup row.           |
| §8.5 Surfaces          | Admin static files come from S3 and CloudFront and hold no personal data. Data calls go to the Sydney hostname. The portal's data calls go to the Sydney hostname. The ops console is routes on this service, on its own hostname, with passkeys. Not Cloudflare Access, and not a proxy. Directory and plans are `platform` tables. |
| §8.5 design system     | Delete "Workers Static Assets". Admin static files are S3 and CloudFront. Do not decide the HTTP framework.                                                                                                                                                                                                                          |
| §8.5 UI rule 7         | Clients poll. Durable Objects are not used.                                                                                                                                                                                                                                                                                          |

- [ ] **Step 2: Format and commit**

```bash
pnpm exec prettier --write architecture.md
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): rewrite sections 1 to 9 for Sydney

Decisions, the cell, and the codebase tree. Sections 10 to 28
still describe the old design until the next two commits.

Refs: docs/plans/2026-10-03-personal-data-on-aws.md task 2
EOF
)"
```

---

### Task 3: architecture.md, sections 10 to 18

**Files:**

- Modify: `architecture.md` (sections 10 to 18 only)

**Interfaces:**

- Consumes: ADR 0009, task 2, and the spec's Open mechanisms section. A leaning is recorded as a leaning.
- Produces: sections 10 to 18 match the spec. Sections 19 to 28 still describe the old design until task 4.

- [ ] **Step 1: Replace the current-design sentences in sections 10 to 18**

| Place               | Replace with                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §10.1               | Plans, entitlements, and feature flags are tables in the `platform` schema. Community toggles stay database rows. There is no feature-flag vendor. Q12 is answered by that. For allocation and override, the KV and D1 path was superseded by ADR 0009. Then the entitlement-visibility question, its leaning, and `entitlements-plans`. Do not write the leaning as the design. |
| §10.3               | The five checks stay, in that order, in the API, the admin UI, and jobs. The KV snapshot and the flags service were superseded by ADR 0009. Then the entitlement-visibility question, its leaning, and `entitlements-plans`. The chunk must state how stale a cached entitlement may be. Do not write the leaning as the design.                                                 |
| §10.4               | The Stripe webhook is handled by the regional service on the Sydney hostname. The KV snapshot and the Durable Object counters were superseded by ADR 0009. Then both open questions, entitlement visibility and hard usage limits, each with its leaning and its owning chunk. Do not write either leaning as the design.                                                        |
| §11.1 and §11.4     | Operators sign in on the regional service. Passkeys, two `platform_security` people for lost-passkey recovery and for break-glass, grants as the spec states them. No Cloudflare Access, no country filter, no masking. The `platform` role has no privileges on `app`.                                                                                                          |
| §12.2               | The service encrypts before Postgres. The task role calls KMS. Delete the broker paragraph. Database operators and backups see ciphertext. Unwrapped keys are not logged. A cache is an open item, not a decision. TLS is 1.2 minimum at the API, plain HTTP inside the VPC, and `verify-full` to RDS.                                                                           |
| §12.2.1             | The rule is unchanged. "Worker" and `api-au` become the regional service. Do not change a classification.                                                                                                                                                                                                                                                                        |
| §12.4               | Retention is a scheduled job in the regional service. Schedules are EventBridge. Not a Workflow, and not `exec`.                                                                                                                                                                                                                                                                 |
| §13.1 and §13.3     | App Registry rows are `platform` schema, not a global control plane. Discovery and the API are the Sydney hostname. There is no global tier. Do not add a cache.                                                                                                                                                                                                                 |
| §14.1, §14.4, §14.5 | The regional service is the Stripe client. GivingJar and Stripe webhooks arrive on the Sydney hostname. There is no `exec`, no `webhooks-au`, and no control plane. There is no global tier to strip a payload for. Personal data is still not logged. Do not invent a new webhook state machine.                                                                                |
| §15.4               | Forms, donations, and RSVPs post to the Sydney hostname. Editor actions use the OIDC `sub`. Personal data is not sent to Jellycube. ADR 0006 is not edited.                                                                                                                                                                                                                      |
| §15.7               | The content notification is sent by the regional service. Not `jobs-au`.                                                                                                                                                                                                                                                                                                         |
| §16.2               | Signed partner webhooks go through SQS, encrypted, with a retention period. Workers for Platforms was superseded by ADR 0009. Then the partner-code question, its leaning, and the partner-apps phase. Say it is a product decision for the owner. Do not describe a hosted runtime.                                                                                             |
| §17                 | Rate limits are the spec's shared stage and write-route caps. Per-client limits are in the service. No client IP.                                                                                                                                                                                                                                                                |
| §18                 | A message carries IDs and the job loads what it needs. A personal field in a message is named in that feature's spec. Every queue and dead-letter queue has encryption and a retention period. Not a non-negotiable. The service publishes to SQS. Schedules are EventBridge. Not Cloudflare Queues, Workflows, Cron, or `exec`.                                                 |

- [ ] **Step 2: Format and commit**

```bash
pnpm exec prettier --write architecture.md
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): rewrite sections 10 to 18 for Sydney

Entitlements, encryption, payments, and jobs. Sections 19 to 28
still describe the old design. Open mechanisms stay leanings.

Refs: docs/plans/2026-10-03-personal-data-on-aws.md task 3
EOF
)"
```

---

### Task 4: architecture.md, sections 19 to 28

**Files:**

- Modify: `architecture.md` (sections 19 to 28, and any hit the search still finds in sections 1 to 18)

**Interfaces:**

- Consumes: ADR 0009 and tasks 2 and 3.
- Produces: one architecture. A hit that tells the reader to build the old path fails this task.

- [ ] **Step 1: Replace the current-design sentences in sections 19 to 28**

| Place             | Replace with                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §19.1             | Logs are in `ap-southeast-2`. Access logs are method, matched route, status, latency, response size, and request id. No query string and no client IP. Delete Workers Logs and the Hyperdrive metric. Do not name a new log product.                                                                                                                                                                                                                                              |
| §19.3 Sources     | Beacons post to the Sydney hostname. The copy of aggregates to a control plane was superseded by ADR 0009. Then the usage-aggregates question, its leaning, and the `usage-facts` and `ops-console` chunks. The `platform` role still has no privileges on `app`. Do not write the leaning as the design.                                                                                                                                                                         |
| §19.3 Ops console | Operators use the regional identity service. Not Cloudflare Access. This view is not support access to tenant records.                                                                                                                                                                                                                                                                                                                                                            |
| §20               | No WAF in this design. Turnstile stays on public forms. Throttle caps are the spec's. Secrets are in Secrets Manager. The task security group is the only database source. Operators use passkeys. Delete the Cloudflare edge, tunnel, Workers secrets, and Cloudflare Access rows as current controls. Do not add AWS WAF. An ALB is the later move if WAF is required.                                                                                                          |
| §22               | No out-of-country failover: a request Sydney cannot serve fails. Backups are in `ap-southeast-2` only. Any future copy stays in Australia. The database is single-AZ until the first paying parish or an agreed availability commitment. RPO stays at most 15 minutes and RTO stays at most 4 hours. The Melbourne row is the envelope-key replica, not a database backup and not a replica of restricted files. Delete "encrypted copies to ap-southeast-4" as a current backup. |
| §23               | Local is local Postgres and the fake KMS port. No Wrangler dev as the way to run the service. Terraform does not own Regional Services, Tunnel, Hyperdrive, or Workers VPC. Say ADR 0002 is not edited and ADR 0009 supersedes that ownership. Migrations stay backward compatible with the deployed service, not "the currently deployed Worker".                                                                                                                                |
| §23.3             | After cleanup, tests run on the Node runner, not the Workers pool. Delete the tunnel and Hyperdrive smoke test. The first staging apply is the live proof. The residency-payload check is removed in cleanup. Do not describe KV or workflow payload checks as current. Leave the PgBouncer fixture. The spec does not remove it.                                                                                                                                                 |
| §24.1             | A frozen static export, if the client agrees, is S3, not R2.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §24.2             | Delete Regional Services. Forms, donations, and RSVPs post to the Sydney hostname.                                                                                                                                                                                                                                                                                                                                                                                                |
| §25               | The short table follows `docs/roadmap.md`. Phase 0 is not "Terraform for Cloudflare". Phase 1's control plane is `platform` tables, the ops console is routes, and the admin shell is S3 and CloudFront. Phase 6 records the partner-code question, its leaning, and the partner-apps phase. Do not describe a hosted runtime. Phase 7 is a later region, not a cell designed here.                                                                                               |
| §26 Q3            | Stays open. Drop "on Workers" and "Workers compatibility". The library is not chosen.                                                                                                                                                                                                                                                                                                                                                                                             |
| §26 Q10           | Closed by ADR 0009. Clients poll. Durable Objects are gone.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| §26 Q12           | Closed. Feature flags are `platform` tables. There is no vendor.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| §26 Q13           | Forms, donations, and RSVPs post to the Sydney hostname. Editor actions use the OIDC `sub`. Personal data is not sent to Jellycube. Say ADR 0009 replaces the Durable Object sentence in ADR 0006, and do not edit ADR 0006. Which Cloudflare account serves Jellycube sites is not decided. Parish website design is out of scope.                                                                                                                                               |
| §26 R1 and R2     | Closed by ADR 0009. D1, Durable Objects, Hyperdrive, and Workers VPC are not a path back to the old design.                                                                                                                                                                                                                                                                                                                                                                       |
| §26 Q14 to Q17    | Four new rows, the next free numbers. Copy the spec's Open mechanisms section: entitlement visibility, hard usage limits, partner code, and usage aggregates. Each row is open, names its leaning, and names the chunk that decides it. Do not write a leaning as accepted.                                                                                                                                                                                                       |
| §27               | A region is the Sydney deployment: the service, the database, keys, and files. The control plane is `platform` tables, not a global service. `exec` is removed. App Registry rows are `platform` schema. A second region needs a small directory, built then. Do not design it.                                                                                                                                                                                                   |
| §28               | Facts about the running design match ADR 0009. Regional Services limits are the rejected alternative, not how we run.                                                                                                                                                                                                                                                                                                                                                             |

- [ ] **Step 2: Search the whole file**

Run a case-insensitive search for:

`Regional Services`, `Hyperdrive`, `exec-au`, `workers.dev`, `Durable Object`, `Cloudflare Access`, `control-plane`, `control plane`, `R2`, `Worker`, `gateway`, `broker`, `tunnel`, `KV`, `D1`, `Queues`, `Workflows`, `Cron`, `wrangler`, `exec`, `webhooks-au`, `api-au`, `Hono`

A hit is the Cloudflare product or the old hostname. SQS, EventBridge, S3, and the regional service are the new design and are not hits. "Every queue has encryption" is not a hit. "API Gateway", "execution role", and the decision IDs D1 and D10 to D17 are not hits.

Each hit is deleted, or is one clause that says it was superseded by ADR 0009. An open mechanism may name the old path only in that clause, then state the question, the leaning, and the owning chunk. Any other hit that tells the reader to build the old path fails the task. Fix a leftover in sections 1 to 18 in this same commit, and name that section in the message.

- [ ] **Step 3: Format and commit**

```bash
pnpm exec prettier --write architecture.md
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): rewrite sections 19 to 28 for Sydney

Logs, delivery, the glossary, and the appendix. The file now
describes the Sydney runtime. Four mechanisms are still open.

Refs: docs/plans/2026-10-03-personal-data-on-aws.md task 4
EOF
)"
```

---

### Task 5: AGENTS.md

**Files:**

- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: ADR 0009 and the spec's Rules touched table. The table is the list. Do not skip a row.
- Produces: eight non-negotiables. §6 no longer tells a reader to add a Worker. CI text says the Worker checks still run until the cleanup row merges.

- [ ] **Step 1: Apply every row of the spec's Rules touched table**

Rewrite §1 as the eight rules. Rule 1 is the spec's wording, including cases (a), (b), and (c). Delete old rules 2 and 6. Renumber the rest. The heading is no longer "ten non-negotiables".

Then apply the rest of that table, one row each:

- Repository state: the Phase 0 snapshot from the spec (19 rows, 12 done, 1 superseded, 6 not started, next is cleanup). `apps/gateway` and the Worker shell of `apps/api` are still on `main` until cleanup. They are not the design.
- §6 Residency: delete the Worker, `preview_urls`, Regional Services, and proxy-to-`api-au` bullets. Personal data stays in Australia by running in `ap-southeast-2`, with rule 1's exceptions.
- §6 queue path: the IDs convention, not a non-negotiable.
- §6 outbound call: the regional service. No control plane and no `exec`.
- §6 webhook: the Sydney hostname.
- §6 public website: the children sentence cites rule 4.
- §7: the deployed service. Long backfills are resumable jobs in that service, not Cloudflare Workflows.
- §8: behaviour is verified on the staging hostname, not a `workers.dev` preview.
- §10 Stage 1: name `worker-config`, `kms-broker-binding`, `residency-payload`, and `residency-cell` as removed by cleanup, and say CI still runs them until that row merges.
- §10 Stage 2: the Workers test pool for `apps/gateway` goes in cleanup. `apps/api` leaves that pool in the same row.
- §10 Stage 3: between cleanup and the service chunk, Stage 3 builds `@community-hub/api` and does not call Wrangler or require a Cloudflare token. The service chunk replaces that with the ARM image build.
- §10 Stage 4: merge deploys the container to staging. Migrations still run first. Terraform apply still needs a person.
- §11 residency: the regional service, SQS, logs, and an offshore call. Stripe calls come from the regional service.
- §11 money: Stripe Billing traffic is from the regional service. Webhooks are the Sydney hostname. Delete `exec` and `webhooks-au`.
- §11 jobs: the checkbox stays. Jobs are work that the regional service runs.
- §16: keep personal data outside Australia as rule 1. Delete the Durable Object line. Delete the control-plane line. The ops line becomes: the `platform` role has no privileges on `app`.

Do not change §1 rules that the spec says are unchanged, other than their numbers. Do not rewrite `tooling/checks/schema-rls`'s readme. The spec leaves "non-negotiable 3" for the cleanup chunk.

- [ ] **Step 2: Search AGENTS.md with the same list as task 4**

Case-insensitive: `Regional Services`, `Hyperdrive`, `exec-au`, `workers.dev`, `Durable Object`, `Cloudflare Access`, `control-plane`, `control plane`, `R2`, `Worker`, `gateway`, `broker`, `tunnel`, `KV`, `D1`, `Queues`, `Workflows`, `Cron`, `wrangler`, `exec`, `webhooks-au`, `api-au`, `Hono`.

A hit is the Cloudflare product or the old hostname. "API Gateway", "execution role", and the decision IDs D1 and D10 to D17 are not hits. A mention that cleanup has not yet removed a check is allowed. Each other hit is deleted, or is one clause that says it was superseded by ADR 0009. `rg` exiting 1 is a pass only after you have read that the file still states rule 1.

- [ ] **Step 3: Format and commit**

```bash
pnpm exec prettier --write AGENTS.md
git add AGENTS.md
git commit -m "$(cat <<'EOF'
docs(agents): renumber the rules for the Sydney runtime

Eight non-negotiables replace the Workers, jobs, and Durable Object
rules. The checks those rules added stay until the cleanup row.

Refs: docs/plans/2026-10-03-personal-data-on-aws.md task 5
EOF
)"
```

---

### Task 6: Runbook

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Consumes: the spec's Runbook section.
- Produces: a page whose old steps cannot be followed by mistake, and three new procedures that do not apply anything by themselves.

- [ ] **Step 1: Add the warning, the prerequisites, and the new procedures**

Above the existing "Apply order", add a warning in its own paragraph: the steps below it build the old design and must not be applied.

Above that warning, add the human prerequisites, in this order:

- Every apply uses an IAM Identity Center administrator profile. It never uses the root user.
- The budget alert address, for both environments. Do not invent the address.
- Register `communityhub-staging.net` in Route 53 before the first staging apply. Registration creates the hosted zone. Terraform uses that zone and does not create a second one. The price checked on 2026-10-03 is USD 17.00 a year, and restoration is USD 74.00.
- For `communityhub.one`, confirm the registrar is not Cloudflare Registrar, change the nameservers to the zone Terraform creates, and confirm the new nameservers answer before the old zone is removed.
- Do not apply the envelope key until `multi_region` is true and the Terraform test for that attribute is in the module.
- Before the Melbourne replica chunk, enable `ap-southeast-4`. It is an opt-in Region, and a check of this account on 2026-10-03 found it disabled. The replica chunk does not enable it.

Leave the old apply steps in place under the warning, so the history of the procedure is still visible. Do not delete them and do not mark them safe.

Add three new sections after the warning block. They are not steps of the old apply.

**Park and unpark.** A long park sets the staging task count to zero and deletes the staging database. A stopped database is only a short pause: storage is still billed, and RDS starts the instance again after seven consecutive days. Unpark recreates the database if it was deleted, runs the `ALTER ROLE` procedure, and sets the task count back to one. A VPC link with no traffic for 60 days becomes `INACTIVE` and takes a few minutes to return. Unpark waits until the link is `AVAILABLE` before treating a failed health check as a fault in the task.

**ALTER ROLE.** A person reads the master secret and the role secret in a session, connects as the master user, and runs `ALTER ROLE`. The service never connects as master. Rotation is the same procedure after `secret_string_wo_version` changes in a reviewed change. There is no rotation Lambda. The procedure does not contain a password, a secret ARN, or a connection string.

**Restore drill.** With one zone, backups are the only recovery path. The drill restores the staging database to a new instance from point-in-time recovery, records the time taken against the 4-hour target, and then deletes the restored instance, because it bills by the hour. It does not restore production. Reading `SHOW max_connections` belongs to the first staging apply, not to this drill.

- [ ] **Step 2: Format and commit**

```bash
pnpm exec prettier --write docs/runbooks/apply-staging-au.md
git add docs/runbooks/apply-staging-au.md
git commit -m "$(cat <<'EOF'
docs(runbook): refuse the old staging apply

The existing steps stay visible and must not be run. Prerequisites,
park and unpark, and the password procedure sit above them.

Refs: docs/plans/2026-10-03-personal-data-on-aws.md task 6
EOF
)"
```

---

### Task 7: Roadmap and the local gate

**Files:**

- Modify: `docs/roadmap.md`

**Interfaces:**

- Consumes: ADR 0009, the architecture, and AGENTS.md. The snapshot numbers must match the Repository state row written in task 5.
- Produces: the catalogue a later spec is cut from. Finished rows stay **done**.

- [ ] **Step 1: Update the catalogue**

In "Where we are", set Phase 0 to 19 rows, 12 done, 1 superseded (`api-au-hostname`), 6 not started. Next chunk is cleanup. Last shipped stays `kms-worker-adapter`.

On the finished rows whose later work supersedes them, add a note. Do not change their status from **done** and do not rewrite what they shipped. The note is one sentence: superseded for the runtime by ADR 0009, where that is true (`terraform-au-cell`, `packages-residency`, `api-au-skeleton`, `terraform-envelope-kms`, `kms-broker-service`, `kms-worker-adapter`). Leave rows that are still the design, such as `packages-db` and `packages-crypto`, without that note.

`api-au-hostname` stays in the table as superseded, not started, not deleted. `kms-mrk-replica` stays not started, reworded: a replica of the envelope key in `ap-southeast-4`, not a database backup, after the first staging apply, and the Region is opt-in and disabled until a person enables it.

Add six not-started rows, in this order, after the superseded hostname row and with `kms-mrk-replica` last:

1. Cleanup. Gateway app, Cloudflare and broker Terraform, Worker checks, `packages/residency`. `apps/api` stays. Wrangler files, the Worker class file, and `KMS_BROKER` go. Tests leave the Workers pool. `aws-kms-adapter.ts`, `context.ts`, and their tests move to `apps/api/src/kms/`. `@aws-sdk/client-kms` is added so those tests still run. The HTTP server, `main.ts`, the Dockerfile, `kms-port-v1`, `@community-hub/kms-aws`, and `kms-broker-binding` are deleted.
2. Foundations. Tags and the two budgets, the second public subnet, the database changes, the secrets and their key, the task role and the execution role, the multi-Region envelope key and its test. No apply before that test is merged.
3. Ingress. Route 53, the API certificate, Cloud Map `SRV`, the VPC link on two private subnets, the HTTP API `$default` stage, the ECS service module.
4. The regional service. `apps/api` in place. ARM, one process, the `KmsPort` reshape, the ported server tests, TLS `verify-full`.
5. First staging apply. Health, a database round trip, a KMS round trip, Cloud Map, and the VPC link reaching a task in a public subnet. One staging run with the KMS endpoint flag on before any production apply.
6. `kms-mrk-replica`, as reworded above.

SQS, EventBridge, file S3, and S3 with CloudFront are not rows here. The roadmap says they wait for the first chunk that uses them.

Phase 1 wording, same rows, new text:

- `admin-shell`: static files from S3 and CloudFront, no personal data. Data calls go to the Sydney hostname.
- `tenancy-implicit-org`: organisation and community rows in the `platform` schema. IDs, slugs, and region. Not a separate control plane.
- `identity-otp`: the regional service. No email on a gateway.
- `entitlements-plans`: `platform` schema. Not a D1 control plane.
- `stripe-billing`: webhooks on the Sydney hostname. The regional service does the work. Not `exec`.
- `ops-console`: routes on the regional service. Passkeys. The `platform` role has no `app` privileges. No Cloudflare Access.

The line that says the next chunk is `api-au-hostname` becomes cleanup.

- [ ] **Step 2: Run the local gate in CI order**

This chunk changes no code, so these commands are the proof the documents did not break the tree. Run them in this order. A failure stops the task.

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm check:boundaries
pnpm audit --audit-level=high
docker compose -f packages/db/test/docker-compose.yml up -d postgres
pnpm test
```

Expected: each command exits 0. `pnpm format` prints that the files use Prettier's style.

Do not run `terraform apply` or `wrangler deploy`. Traceability runs only on a pull request and will fail until this plan's Status line is `approved` and the PR body links the spec and the plan. That failure is expected before the human approves the plan. Do not edit the checker.

Gitleaks, the broker image build, offline Terraform, and the Wrangler preview job are unchanged by this chunk. If you run them and one fails, stop and report. Do not delete the broker Dockerfile in this task to make the image job pass.

- [ ] **Step 3: Format and commit**

```bash
pnpm exec prettier --write docs/roadmap.md
git add docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs(roadmap): point Phase 0 at the Sydney runtime

Twelve rows stay done. api-au-hostname is the only superseded row.
Cleanup is next, and the replica stays after the first apply.

Refs: docs/plans/2026-10-03-personal-data-on-aws.md task 7
EOF
)"
```

---

## Self-review

Spec coverage: ADR (task 1), architecture sections 1 to 9 (task 2), 10 to 18 (task 3), 19 to 28 (task 4), AGENTS (task 5), runbook (task 6), roadmap (task 7). Cost, rule 1, the number map, rotation, budgets, and the KMS file split are in the ADR and, where they change a living instruction, in architecture and AGENTS. The cleanup, foundations, ingress, service, and apply chunks are named and not started. No migration wave. The four open mechanisms are copied from the spec into the ADR, the named architecture sections, and §26. A leaning is not a decision.

Placeholder scan: the plan does not use TBD. Prices are the spec's figures. The restore drill records the time and deletes the instance. `SHOW max_connections` stays with the first staging apply.

Final CI: task 7 step 2 is the static job's format, lint, typecheck, boundary, and audit commands, then the test job's Postgres and `pnpm test`. Traceability is named and left red until the plan is approved.
