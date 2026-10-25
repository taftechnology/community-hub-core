# AGENTS.md — How work gets done in this repository

Applies to **every contributor: AI agents and humans**. If you are an agent, read this file before your first action in a session.

|                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Companion document** | [`architecture.md`](architecture.md) — what we are building and why. This file is _how_ we build it.                                                                                                                                                                                                                                                                                                                                                            |
| **Precedence**         | `architecture.md` decisions (D1…) > this file > personal preference. If you must break a rule here, say so in the PR and why.                                                                                                                                                                                                                                                                                                                                   |
| **Repository state**   | Phase 0: 26 rows, 25 done, 1 superseded (`api-au-hostname`), 0 not started. `stripe-billing`, `billing-read-only`, `stripe-billing-proof`, `ops-identity-primitives`, `ops-operator-identity` and `ops-console-api` are done. Next is `ops-operator-oneoff`. `packages/kernel`, `packages/observability`, `packages/db`, `tooling/checks`, CI Stages 1–3, and `apps/api` are on `main`. Workers were superseded by ADR 0009, and that layout is not the design. |
| **Tooling**            | [Superpowers](https://github.com/obra/superpowers) is required for agent sessions: `/plugin install superpowers@claude-plugins-official`                                                                                                                                                                                                                                                                                                                        |

---

## 1. The eight non-negotiables

Everything else in this file is process. These are correctness. A change that breaks one of them is reverted, not discussed.

1. **Personal data is stored and processed in Australia.** The service, the database, the keys that wrap personal data, and the logs are in `ap-southeast-2`. Backups are in `ap-southeast-2` only. Any future copy of personal data stays in Australia. It leaves Australia only when a tenant's own signed-in user opens it, wherever they are; when a support operator reads it under a grant or break-glass; or when it is sent to a named subprocessor, and only the fields that function needs (architecture §7.3, [ADR 0009](docs/adr/0009-personal-data-on-aws.md)).
2. **Every `app`-schema table has `org_id`, RLS and `FORCE ROW LEVEL SECURITY`.** Tenant scope is set per transaction with `set_config(..., true)`, never session-level `SET`. Identity and platform schemas are region-scoped and have **no** `org_id` (§6.3).
3. **A field that SQL must filter, sort or aggregate is not encrypted.** Use a blind index, a derived clear column, or reclassify (§12.2.1).
4. **Minors' data is restricted by default.** When `is_minor` is true, that person's `confidential*` columns are held under the household key. Children never appear in public content, directories or data sources (§12.1, §12.3).
5. **No personal data in URLs, logs, traces, analytics or AI calls.** Ever (§12.3, §17, §19.1).
6. **No third-party analytics SDK or session replay on any surface** (D17).
7. **Nothing touches production data outside production.** No prod dumps in dev, staging, tests, fixtures or an agent's context (§23.1).
8. **Secrets never enter the repo, a prompt, a log or a commit.** If one leaks, stop and escalate immediately (this file, §14).

CI enforces what it can. The rest is on the reviewer.

---

## 2. Roles

Three roles. **No agent both writes and signs off on the same work.**

| Role                  | Who                                             | Does                                                                                                                       | Must not                                                          |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Human owner**       | You                                             | Approves specs and plans. Merges PRs. Decides trade-offs, scope, legal and product questions.                              | —                                                                 |
| **Reviewer agent**    | The session you talk to (where subagents exist) | Writes the spec, drafts the plan, spawns implementers, reviews every task and the final PR, keeps `architecture.md` honest | Write implementation code or tests for the chunk it is reviewing  |
| **Implementer agent** | Spawned subagent(s), fresh context              | Implements one task at a time, with tests, and reports back                                                                | Approve its own work, merge, or change the spec/plan unilaterally |

Before approving a spec or a plan, and before merging, the owner has the work checked by an independent assistant. The assistant is in a different tool, and on a different model family, from the implementer and reviewer agents. The owner decides. The assistant reviews by diff, verifies by running, and never writes repo files, never applies, and never merges.

There are still three roles. The assistant is how the owner checks. It is not a fourth role, and it is not one of the repo's agents.

**If the tool has no subagent capability**

Single-agent tools (or a session where spawning is unavailable) collapse to **two roles, not one**: the agent implements, and **the human is the reviewer**. The principle does not bend — nobody signs off on their own work.

|                           | Multi-agent tool                                                           | Single-agent tool                     |
| ------------------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| Spec and plan             | Reviewer agent drafts                                                      | Agent drafts                          |
| Approval of spec and plan | Human                                                                      | Human                                 |
| Implementation            | Implementer agent(s)                                                       | The agent                             |
| Task review               | Reviewer agent, diff only                                                  | **Human**, diff only                  |
| Sensitive chunks (§2)     | Owner's assistant, in a fresh session. The reviewer agent may add its own. | Owner's assistant, in a fresh session |
| Merge                     | Human                                                                      | Human                                 |

In that mode, keep tasks small enough that a human can review each commit in a few minutes — that is the whole reason for one commit per task.

**Rules of separation**

- The reviewer agent and the implementer agent are **separate sessions with separate context**. The reviewer reads the diff, not the implementer's narration.
- An implementer that finds the plan wrong **stops and reports**. It does not redesign.
- For chunks touching **children's data, payments, authentication, encryption, residency or tenancy**, the owner's assistant runs the second fresh-context review in a fresh session that has not seen the implementation discussion. The reviewer agent may add its own. The owner's assistant starts that review when the pull request opens, alongside the final review, and does not wait until the final review has finished. The pull request's second-review line stays open until that review is written. A sensitive pull request does not merge until then.
- **No model names are pinned in this file.** Use different model configurations for reviewer and implementer where available, so a single model never both produces and validates the same work. Record which configuration was used in the PR description.

---

## 3. The unit of work: a chunk

A **chunk** is one shippable slice of behaviour. **One spec = one plan = one branch = one PR = many small commits.** That chain is 1:1 in both directions: a PR that implements two specs is split, and a spec that needs two PRs was two chunks.

**Naming — the slug and date tie the chain together**

| Artifact | Form                                                 | Example                                    |
| -------- | ---------------------------------------------------- | ------------------------------------------ |
| Spec     | `docs/specs/YYYY-MM-DD-<slug>.md`                    | `docs/specs/2026-09-17-giving-checkout.md` |
| Plan     | `docs/plans/YYYY-MM-DD-<slug>.md`                    | `docs/plans/2026-09-19-giving-checkout.md` |
| Branch   | `<type>/<spec-date>-<slug>`                          | `feat/2026-09-17-giving-checkout`          |
| PR title | `<type>(<scope>): <summary>` + spec link in the body | `feat(giving): checkout through GivingJar` |

- The **date is the date that document was created** — a plan written two days after its spec keeps its own date. The **slug is identical** across spec, plan and branch; that is what pairs them.
- The branch carries the **spec's** date, so the branch always points back to the document that authorised the work.
- Superseding a spec means a new file with a new date and a `Supersedes:` line, not an edit to a merged one.
- `docs/plans/` holds only those approved plans. Implementer reports (`t1-report.md`, `task-N-report.md`, and the like) are not plans — see §5.

**Right-sized chunk**

- Delivers something a user or another module can actually use (a vertical slice, not "the schema layer").
- 3–10 tasks, each 1 commit.
- Reviewable in one sitting: aim for **under ~800 changed lines** excluding generated files, lockfiles and migrations.

**Split the chunk if** it spans more than two modules, mixes a refactor with a feature, or needs more than one database migration wave.

**Do not split** so far that a PR cannot be tested end to end. "Add a column" is not a chunk.

**Work that has no spec.** A dependency bump, flaky-test quarantine, CI fix, or a docs-only edit to `AGENTS.md` / `architecture.md` that does **not** change a documented decision is not a chunk: branch `chore/<YYYY-MM-DD>-<slug>` (or `fix/…`), and the PR body opens with `No spec:` plus why. The traceability check skips spec and plan for those branches. If the change would alter user-visible behaviour, add a table, touch §1, or change an architecture decision, it is a chunk — write the spec (and an ADR when §13 requires one).

---

## 4. The lifecycle

```
  ┌──────────┐  human   ┌──────────┐  human   ┌──────────────┐        ┌──────────┐
  │ 1. SPEC  │ ───────► │ 2. PLAN  │ ───────► │ 3. TASKS     │ ─────► │ 4. PR    │
  │ reviewer │ approves │ reviewer │ approves │ implementer  │ review │ human    │
  │  agent   │          │  agent   │          │ + reviewer   │        │ merges   │
  └──────────┘          └──────────┘          └──────────────┘        └──────────┘
       │                     │                       │                     │
  docs/specs/          docs/plans/            one commit per task    merge commit
  <chunk>.md           <chunk>.md             + reviewer sign-off
```

Both gates are **human**. An agent never advances past a gate on its own judgement.

### Phase 1 — Spec (reviewer agent)

Use superpowers **`brainstorming`** to pressure-test the idea before writing anything.

Write `docs/specs/YYYY-MM-DD-<slug>.md`:

```markdown
# Spec: <chunk name>

Slug: <slug> # identical in the plan and the branch name
Status: draft | approved (YYYY-MM-DD, approver)
Supersedes: docs/specs/… (only when replacing an earlier spec)
Architecture refs: §…, D…

## Problem

What the community, member, child, guardian, staff member or operator cannot do today.

## Scope

In: …
Out: … (explicitly)

## Behaviour

User-visible behaviour, including empty, error and offline states.

## Data

New/changed tables and columns, each with a classification from architecture §12.1.
Blind index or derived-clear decisions per §12.2.1.

## Rules touched

Entitlement keys, permissions, consent, retention, residency, safeguarding.

## Contracts

API routes, events published/consumed, port changes, website collection / island / block keys (architecture §15.5).

## Risks

What could break tenancy, residency, children's data or money. Mitigations.

## Out-of-band

Legal sign-off needed? Architecture change needed? New subprocessor?
```

**Approval criteria:** unambiguous behaviour, every new column classified, no non-negotiable breached, risks named. Stop and ask the human for anything legal, pricing or product-shaped.

### Phase 2 — Plan (reviewer agent)

Use superpowers **`writing-plans`**. Write `docs/plans/YYYY-MM-DD-<slug>.md`, opening with `Spec: docs/specs/<spec-date>-<slug>.md`:

- Ordered tasks, each **one commit**, each independently testable, each with its test first.
- For every task: files touched, the test that proves it, the rule it must not break.
- Migration wave marked explicitly (expand → migrate → contract; see §7).
- Rollback note: what undoes this chunk.
- For each security-relevant setting the spec names under Rules touched, Contracts, or Risks, the plan lists the test that pins it and the source change that makes that test fail. The implementer runs each change once, sees that test fail, restores the source, and reports the failure. The weakened tree is never committed. This is limited to those named settings, not every line. The report is session scratch, not a file under docs/plans/.
- The plan's Terraform asserts are run in a scratch probe before the plan is sent for approval. The probe uses the plan's proposed test with override_during = plan. The probe is outside the repo, or in a scratch worktree, and it is not committed. An assert that errors or cannot pass is rewritten before the plan is sent. The probe does not apply and does not read a real var file.

**Approval criteria:** tasks are genuinely sequential, no task is "and then wire everything together", and the last task leaves the system releasable. The last task on the branch updates [`docs/roadmap.md`](docs/roadmap.md) (this chunk **done**, snapshot, next chunk) so the PR that merges the work also updates the catalogue. Do not defer that to a follow-up chore.

### Phase 3 — Tasks (implementer agents, reviewed one by one)

Use superpowers **`executing-plans`** and **`subagent-driven-development`** to dispatch, **`test-driven-development`** inside each task, **`systematic-debugging`** when something fails, and **`verification-before-completion`** before reporting done.

Per task:

1. Implementer writes the failing test (RED), the minimum code (GREEN), then refactors.
2. Implementer runs the local gate (§8) and reports to the parent: what changed, what the test proves, what it did **not** do. A Superpowers report file, if used, is `.superpowers/sdd/task-N-report.md` — never `docs/plans/`. The commit contains only files named in that task.
3. Reviewer agent reviews the **diff** against the plan, the spec and §1 — using superpowers **`requesting-code-review`** for an independent pass on sensitive chunks.
4. Reviewer either accepts (commit stands) or returns it with specific findings. Returned work is fixed by the implementer, not by the reviewer.

A task is not done because the implementer says so. It is done when the reviewer accepts it and CI is green.

### Phase 4 — PR (human merges)

The last commit on the chunk branch has already updated `docs/roadmap.md`. Run the session-scratch cleanup in §5, then use superpowers **`finishing-a-development-branch`**. Open the PR with the template in §9, then **stop**. Agents do not merge.

Push task commits as usual. The pull request opens only when every plan task is done, including the catalogue commit. CI triggers only on pull_request and on push to main, so pushing a branch with no pull request costs no Actions minutes. The runbook requires the applied SHA to be on origin. After the pull request is open, run pnpm gate and push related fix commits together. One fix is not one push. Each fix is still its own commit.

---

## 5. Working environment

- **Branch per spec**, named `<type>/<spec-date>-<slug>` — `feat/`, `fix/`, `chore/`, `docs/`. No chunk branch is opened before its spec is approved. The no-spec lane in §3 is the exception; its date is today, not a spec date.
- Use superpowers **`using-git-worktrees`** so parallel chunks never share a working tree.
- **Never commit to `main`.** Not docs, not AGENTS, not a hotfix. `main` moves only by a human merging a PR. Never force-push a shared branch.
- Create every branch from **`origin/main`**, not from a local `main` that may have unpushed commits:

```bash
git fetch origin
git switch -c <type>/<YYYY-MM-DD>-<slug> origin/main
```

- Before the first apply on a branch, rebase on origin/main and keep history linear. After the first apply there is no rebase, no amend, and no force-push. When origin/main moves after that apply, bring it in with a merge commit.
- Push task commits as usual. The pull request opens only when every plan task is done, including the catalogue commit. CI triggers only on pull_request and on push to main, so pushing a branch with no pull request costs no Actions minutes. The runbook requires the applied SHA to be on origin. After the pull request is open, run pnpm gate and push related fix commits together. One fix is not one push. Each fix is still its own commit.
- After the human merges: `git switch main && git pull --ff-only && git branch -d <branch>`. Do not accumulate personal commits on local `main`.
- Parallel implementers are allowed (**`dispatching-parallel-agents`**) only when tasks touch disjoint files. Two agents in one module at once is a merge conflict factory.

**Session scratch — never committed**

Superpowers subagent-driven development writes task briefs, implementer reports, review diffs and a progress ledger. Those files belong in `.superpowers/sdd/` (gitignored). They are not plans and they are not part of the chunk.

- Dispatch reports to `.superpowers/sdd/task-N-report.md`. Do not write them under `docs/plans/`.
- Implementer commits contain only the files named in that task. Never `git add` a `*-report.md`, `.superpowers/`, or other session scratch.
- **At the end of the chunk** — before finishing-a-development-branch, opening a PR, merging, or reporting done — delete leftover reports from the wrong place and confirm nothing scratch is staged:

```bash
rm -f docs/plans/*-report.md
git status --short
```

`.superpowers/` may stay on disk for the rest of the session; it must not appear in `git status` as staged. If a report was already committed, remove it in a follow-up commit — do not rewrite shared history.

---

## 6. Implementation rules

Architecture-specific rules that reviewers check on every diff. Most map to a CI check; all of them are your responsibility.

**Tenancy and data**

- Every new `app` table: `org_id`, `community_id` (unless organisation-level), RLS + FORCE RLS, classification on every column.
- Queries go through `packages/db` helpers. No raw pool access, no session-level `SET`.
- Identity-schema work is `core/identity` only (identity role). Platform-schema work is `core/tenancy` only (platform role). Neither sets `app.org_id`; those tables have no `org_id`.
- New encrypted column? Prove nothing filters, sorts or aggregates on it. A minor's `confidential*` fields use the household key; their blind indexes are household-scoped, not community-wide.

**Residency**

- Personal data stays in Australia by running in `ap-southeast-2`, with rule 1's exceptions. The Workers runtime rules were superseded by ADR 0009.
- A queue message carries IDs and the job loads what it needs. That is a convention, not a non-negotiable. A personal field in a message is named in that feature's spec. Every queue and dead-letter queue has encryption and a retention period.
- A new outbound call carrying personal data (Stripe, EmailProvider, SMS, push, other provider) originates from the regional service.
- A new inbound webhook whose payload may contain personal data arrives on the Sydney hostname. There is no global tier to strip the payload for.

**Cost**

- A chunk that adds a resource billed by the hour or the month names it and its monthly cost in its spec. No NAT gateway, load balancer, or extra interface endpoint appears without that.
- Staging is parked by default. Parked means enable_database = false and desired_count = 0 in the committed infra/regions/au/env/staging.tfvars, and no service_image in any committed var file under infra/regions/au/env/. Parking removes the database and runs zero tasks. Stopping a database is not parking, because RDS starts a stopped instance again after seven days.
- Staging is unparked only inside a chunk whose approved spec says so. That spec names why, the expected extra monthly cost, and how long it stays up. The same chunk re-parks before its pull request is merged, and docs/runbooks/apply-staging-au.md records both applies. The human runs every park and unpark apply. An agent never does. The steps are in that runbook and are not copied here.

**Modules**

- Cross-module access only through `public/`; prefer events.
- `domain/` stays framework-free.
- Modules never import adapters; they depend on ports.
- New entitlement key, permission, event, or website collection / island / block: declare it in `module.manifest.ts` (`website: { collections, islands, blocks }`). Plans reference manifest keys only.

**Public website (Jellycube host — architecture §15, ADR 0006)**

- Default to an **external collection**: a Zod schema in `packages/contracts` and a public-only projection on the module's Public Content API. Parishes design the list and detail pages in Jellycube; core does not ship list markup.
- Add a **host island** (`packages/web-components`) only for a write (form, donate, RSVP, join) or a live value (campaign total). The spec names the write or value.
- Add a **host block pack** (`packages/website-blocks`) only when the spec explains why a collection binding cannot express it.
- Projections are allow-lists of `public`-class columns, never "row minus hidden fields". Every collection has a must-fail test with a `restricted` field and a minor fixture. Children never appear (§1 rule 4).
- Nothing core ships is added to a site project's `package.json`.
- `website.source.changed.v1` carries IDs, the source key and a content version only. Deep links to "Edit in Community Hub" carry opaque IDs only.
- Islands POST only to regional core hostnames, carry no card fields (PCI SAQ-A), use Turnstile on public writes, and meet WCAG 2.2 AA.

**API and UI**

- Contracts first: Zod in `packages/contracts`, OpenAPI regenerated, breaking change → `/v2` plus deprecation window.
- No personal data in paths or query strings.
- Web UI composes `packages/ui` (shadcn/ui). Mobile will compose `packages/ui-native` (React Native Reusables) on these tokens. No third catalogue; WCAG 2.2 AA is a merge gate (D16).
- Entitlement-gated features hide or show an upgrade prompt — never render a control that only 403s.

**Tests**

- Unit for domain rules; integration for routes and repositories; **tenant-isolation and residency suites are not optional** for anything touching data.
- Every bug fix starts with a failing regression test.
- Synthetic data only. Fixtures never contain real people, real children, or production exports.

---

## 7. Database migrations

- **Expand → migrate → contract**, always. A migration must be backward compatible with the deployed service.
- Destructive DDL (`DROP`, `NOT NULL` on existing data, type narrowing) goes in a **later PR** than the code that stopped using the column.
- Every migration is reversible or has a written recovery note in the plan.
- Long backfills are resumable jobs in the regional service, in batches — never inside a migration. They are not Cloudflare Workflows. That product was superseded by ADR 0009.
- Migrations run before deployment. A migration that requires downtime needs human scheduling.

---

## 8. Definition of done

**Per task (local gate, before reporting):**

```bash
pnpm gate
```

- [ ] Test written first and proves the behaviour
- [ ] No non-negotiable from §1 touched (or explicitly justified)
- [ ] Manifest updated if keys/permissions/events changed
- [ ] Commit message follows §9
- [ ] Commit contains only files named in the task (no `*-report.md`, no `.superpowers/`)

**Per chunk (before requesting merge):**

- [ ] All plan tasks done or consciously dropped with a note
- [ ] Full CI green (§10)
- [ ] Tenant-isolation and residency suites green
- [ ] Spec's behaviour verified on the staging hostname, not just tests
- [ ] `architecture.md` updated in the same PR if the chunk changed a documented decision, plus an ADR in `docs/adr/` for anything at decision level
- [ ] `docs/roadmap.md` updated in the **same PR**, last commit on this branch: this chunk **done**, snapshot (last shipped / next chunk / counts) current. Not a follow-up chore after merge.
- [ ] Reviewer agent sign-off recorded in the PR; second independent review for sensitive chunks (§2)
- [ ] Session scratch cleaned up (§5): no `docs/plans/*-report.md` on disk; nothing under `.superpowers/` staged

---

## 9. Commits and pull requests

**Commits** — Conventional Commits, one task per commit, imperative mood:

```
feat(giving): record donation intent before provider redirect

Ledger row is written with status=pending and the reference passed to
GivingJar metadata, so a webhook can be matched tenant-scoped.

Refs: docs/plans/2026-09-19-giving-checkout.md task 3
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `build`, `ci`. Scope is the module or package.

Never stage `docs/plans/*-report.md`, `.superpowers/`, or other session scratch. If an implementer wrote a report next to the plan, delete it before committing — do not `git add` it. The durable review record is the PR body, not a markdown dump beside the plan.

**One PR implements exactly one spec**, except the no-spec lane in §3. If chunk work grows past its spec, stop: either narrow the PR, or write a second spec and open a second branch.

**PR description** uses `.github/PULL_REQUEST_TEMPLATE.md` and states:

- `Spec: docs/specs/<spec-date>-<slug>.md` and `Plan: docs/plans/<plan-date>-<slug>.md` (both required, both must be `approved`) — or, for the no-spec lane, `No spec:` and why. Plan `Status:` must be a plain line (not `**Status:**`) so the traceability check can see `approved`.
- What changed, in behaviour terms
- Data classification changes and migration wave
- Which of §1 the chunk could plausibly have broken, and how it doesn't
- Review record: implementer configuration; reviewer agent configuration; Owner's check assisted by, with the tool, the model, and what it ran; and the second-review line
- Screenshots or a preview link for UI, test evidence for backend

**Merge policy**

- Required checks must pass. No exceptions, no admin override without a written reason in the PR.
- **Agents never merge.** The human owner merges.
- The pull request merges with a merge commit.
- After the first apply on a branch there is no rebase, no amend, and no force-push. When origin/main moves after that apply, it comes in by a merge commit.
- Delete the branch after merge.

---

## 10. CI/CD

`main` is always releasable. CI runs on every push to a PR; the heavier suites run before deploy.

**Stage 1 — Static (fast, every push)**

- format, lint, typecheck
- `check:boundaries` — schema-rls, terraform-invariants, sql-session-ban, event-names, check-tokens (each checker has must-fail fixtures exercised in Stage 2). Encrypted columns: ESLint `@community-hub/no-encrypted-column-query`, `@community-hub/no-event-payload`, `@community-hub/no-kms-port-outside-crypto`, `@community-hub/no-restricted-disable`, `@community-hub/no-ts-ignore`, and `@community-hub/no-crypto-testing-import`; fixture-tested via `pnpm test` on `@community-hub/check-encrypted-column`, not `run.ts`.
- secret scanning, dependency audit (fail on high/critical)
- traceability (pull requests only): branch matches `<type>/<YYYY-MM-DD>-<slug>`; PR body links one spec and one plan with the same slug, both `approved`, or `No spec:` on `chore/` / `fix/` branches
- **offline Terraform** (every root and every module under `infra/`): `terraform init -backend=false -lockfile=readonly`, `fmt -check -recursive`, `validate`, `tflint --init && tflint`, `terraform test`. Missing Terraform or a failed `init` fails the job. No live `plan`. No cloud provider secrets. `GITHUB_TOKEN` is passed so `tflint --init` does not hit unauthenticated GitHub rate limits.

A CI check is added only when it has a real input **and** a must-fail fixture — never stubbed always-green. Omitted until then: dependency-cruiser module boundaries, manifest and plan-catalogue checks, identity/platform schema ownership scans beyond the provisional schema-rls checker, OpenAPI diff, live Terraform `plan`. A job is present and fail-closed, or absent — never present and silently skipping.

**Stage 2 — Tests (every push)**

- `pnpm test` — unit tests for `packages/kernel` and `packages/observability`; checker self-tests including `@community-hub/check-event-names` (must-fail fixtures must still fail). `apps/api` and `packages/crypto` run on the Node runner, and no package test script runs the Workers pool.
- axe runs in `@community-hub/ui` (Button plus a missing-name fixture)

Omitted until first real input plus a must-fail fixture: tenant-isolation suite, residency integration suite, contract tests.

**Stage 3 — Build and preview (every PR)**

- A pull request still builds this ARM image and does not push it. A push to `main` publishes the digest. Stage 3 does not call Wrangler or require a Cloudflare token. Live Terraform `plan` stays absent. The image publish role is not a plan role. Verification of a running task stays the staging hostname.
- A pull request builds the admin shell and does not upload it, and a push to `main` publishes it.
- OpenAPI diff comments apply only once those artefacts exist in the repo. Live Terraform `plan` comments wait on CI identities (AWS OIDC).

**Stage 4 — Deploy**

- merge to `main` → migrations → deploy the container to `staging-au` → smoke tests + critical-journey e2e (sign-in, donate, RSVP, check-in, consent)
- production is a **human-triggered** promotion of that exact build: migrations → gradual deployment → automatic rollback on error-rate alert
- Terraform apply on `infra/` changes requires human approval
- nightly on `main`: full e2e, restore drill check, dependency and licence report

**Required for merge:** Stages 1–3 green. Flaky test? Fix or quarantine with an issue and an owner in the same PR — never re-run until green.

---

## 11. Review checklist (reviewer agent)

Beyond "does it work":

- [ ] Does the diff match the approved plan, or did scope creep in?
- [ ] Session scratch: no implementer reports, task briefs, or `.superpowers/` in the commit.
- [ ] Tenancy: could any query return another organisation's row?
- [ ] Residency: does any personal data leave the regional service, SQS, or the logs for an offshore call, other than rule 1's three cases? Stripe calls come from the regional service.
- [ ] Children: any new path where a minor's data could become public, searchable, or reach a third party? Are a minor's `confidential*` fields household-keyed, with household-scoped indexes only?
- [ ] Money: are amounts integer minor units, idempotency keys present, ledger tenant-scoped? Stripe Billing traffic comes from the regional service, and webhooks arrive on the Sydney hostname.
- [ ] Cost: a chunk that adds a resource billed by the hour or the month names it and its monthly cost in its spec. No NAT gateway, load balancer, or extra interface endpoint appears without that.
- [ ] Does this chunk leave staging parked? If it unparks, does the spec say why, for how long, and at what cost, and does the last apply re-park?
- [ ] Encryption: right classification, right key, and nothing encrypted that SQL must query?
- [ ] Entitlements and permissions checked in the API, the UI, and jobs? Jobs are work the regional service runs.
- [ ] Public website: is a new surface a collection (not an island or block without a stated reason)? Is the projection a `public`-only allow-list, with a must-fail minor test?
- [ ] Failure modes: what happens on provider timeout, replayed webhook, partial batch?
- [ ] Tests actually fail without the fix (spot-check by reverting the source change)?
- [ ] Is this simpler than it looks, or is the plan over-built for a first customer?

Findings are specific, actionable and ranked. "Consider refactoring" is not a finding.

---

## 12. When an agent must stop and ask

Stop, do not improvise, and ask the human:

- A rule in §1 blocks the task
- The spec or plan turns out to be wrong or ambiguous mid-implementation
- The change needs a new subprocessor, a legal opinion, or a privacy/ADR decision
- Anything touching production data, secrets, billing, or a live customer's tenant
- Cost or lock-in decisions (a new AWS service or vendor, a new paid service)
- Two consecutive failed attempts at the same problem — report what you learned instead of a third guess
- Something looks like a security issue, however small

Report progress honestly. "Tests fail, here is the output" is worth more than a confident summary that hides it.

---

## 13. Documentation duties

- `architecture.md` is the source of truth. Change it **in the same PR** as the behaviour change, not later.
- Decisions at architecture level get an ADR in `docs/adr/NNNN-title.md`: context, decision, consequences, alternatives.
- Runbooks in `docs/runbooks/` for anything operable: incidents, breach assessment, restores, key rotation, provider outages.
- Specs and plans stay in the repo after merge. They are the record of why the code looks like this. Implementer reports do not.

---

## 14. Security rules for agents

- Never print, log, echo or commit a secret, token, key, connection string or customer identifier.
- Never paste production data into a prompt, test, fixture or issue.
- Never disable a security check, RLS policy, or CI gate to make something pass. Fix the cause.
- New dependency: justify it in the PR (what it replaces, licence, maintenance, size). Prefer the platform and the standard library.
- Report suspected key exposure immediately and stop work on that branch.

---

## 15. What we deliberately do **not** require

Speed matters. These are common practices we have consciously skipped for now; do not reintroduce them without a decision:

- ❌ A second **human** reviewer on every PR. The reviewer agent plus CI plus the merging human is the gate.
- ❌ Ticket numbers, story points, estimates, burndown, or a status field to update in three places.
- ❌ 100% coverage targets or coverage gates. Cover behaviour and risk, not lines.
- ❌ Perfect commit-message poetry or changelog entries per commit.
- ❌ Design documents for routine CRUD. A spec for a chunk is enough.
- ❌ Manual QA sign-off for changes the e2e suite already covers.
- ❌ RFCs for reversible decisions. Write the ADR when it is hard to undo.
- ❌ Waiting for a daily standup to unblock: ask in the PR or the session and keep moving.

If a rule in this file is slowing work without preventing a real failure, propose removing it — with the evidence.

---

## 16. Quick reference

```
Naming              docs/specs/YYYY-MM-DD-<slug>.md   (date created)
                    docs/plans/YYYY-MM-DD-<slug>.md   (date created, same slug)
                    branch  <type>/<spec-date>-<slug> → one PR, one spec
                    chore/<today>-<slug> + No spec:  → bump, quarantine, CI fix

New work            → spec (brainstorming) → HUMAN APPROVES
                    → plan (writing-plans) → HUMAN APPROVES
                    → tasks (subagent-driven-development, TDD, one commit each)
                    → last task: docs/roadmap.md on this branch (done + snapshot)
                    → each task reviewed by the reviewer agent
                      (single-agent tool: the HUMAN reviews each task diff)
                    → PR (finishing-a-development-branch) → HUMAN MERGES
Root docs           → architecture.md / AGENTS.md still go through a branch + PR
                    → no spec: if they do not change a decision; spec + ADR if they do

Never               → commit or merge to main except by merging a PR
                    → merge your own work · personal data outside AU · prod data anywhere else
                    → encrypted column in a WHERE/ORDER BY/aggregate · secrets in the repo
                    → analytics SDK on any surface
                    → a non-public field or a minor in a website collection
                    → the platform role holding privileges on app
                    → implementer reports in docs/plans/ or in a commit

Stuck twice         → stop and report
Rule in the way     → say so in the PR, do not silently break it
```
