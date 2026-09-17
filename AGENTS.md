# AGENTS.md — How work gets done in this repository

Applies to **every contributor: AI agents and humans**. If you are an agent, read this file before your first action in a session.

| | |
|---|---|
| **Companion document** | [`architecture.md`](architecture.md) — what we are building and why. This file is *how* we build it. |
| **Precedence** | `architecture.md` decisions (D1…) > this file > personal preference. If you must break a rule here, say so in the PR and why. |
| **Repository state** | Bootstrap. Only `architecture.md` and this file exist. Phase 0 of the roadmap creates the monorepo and the commands referenced below. |
| **Tooling** | [Superpowers](https://github.com/obra/superpowers) is required for agent sessions: `/plugin install superpowers@claude-plugins-official` |

---

## 1. The ten non-negotiables

Everything else in this file is process. These are correctness. A change that breaks one of them is reverted, not discussed.

1. **No personal data outside Australia.** Global Workers (`gateway`, `control-plane`), KV, D1 and feature flags hold IDs, slugs, counts and config — never names, emails, addresses, amounts or files (architecture §7.3).
2. **`jobs` never handles personal data, including in a response.** `exec` does the whole unit of work and returns `{processed, failed, skipped}` plus IDs (§7.3 rule 2, §18).
3. **Every `app`-schema table has `org_id`, RLS and `FORCE ROW LEVEL SECURITY`.** Tenant scope is set per transaction with `SET LOCAL`, never session-level (§6.3).
4. **A field that SQL must filter, sort or aggregate is not encrypted.** Use a blind index, a derived clear column, or reclassify (§12.2.1).
5. **Minors' data is restricted by default.** When `is_minor` is true, that person's `confidential*` columns are held under the household key. Children never appear in public content, directories or data sources (§12.1, §12.3).
6. **Durable Objects never hold personal data** — no Australian jurisdiction exists (§7.3 rule 7).
7. **No personal data in URLs, logs, traces, analytics or AI calls.** Ever (§12.3, §17, §19.1).
8. **No third-party analytics SDK or session replay on any surface** (D17).
9. **Nothing touches production data outside production.** No prod dumps in dev, staging, tests, fixtures or an agent's context (§23.1).
10. **Secrets never enter the repo, a prompt, a log or a commit.** If one leaks, stop and escalate immediately (§14).

CI enforces what it can. The rest is on the reviewer.

---

## 2. Roles

Three roles. **No agent both writes and signs off on the same work.**

| Role | Who | Does | Must not |
|---|---|---|---|
| **Human owner** | You | Approves specs and plans. Merges PRs. Decides trade-offs, scope, legal and product questions. | — |
| **Reviewer agent** | The session you talk to (where subagents exist) | Writes the spec, drafts the plan, spawns implementers, reviews every task and the final PR, keeps `architecture.md` honest | Write implementation code or tests for the chunk it is reviewing |
| **Implementer agent** | Spawned subagent(s), fresh context | Implements one task at a time, with tests, and reports back | Approve its own work, merge, or change the spec/plan unilaterally |

**If the tool has no subagent capability**

Single-agent tools (or a session where spawning is unavailable) collapse to **two roles, not one**: the agent implements, and **the human is the reviewer**. The principle does not bend — nobody signs off on their own work.

| | Multi-agent tool | Single-agent tool |
|---|---|---|
| Spec and plan | Reviewer agent drafts | Agent drafts |
| Approval of spec and plan | Human | Human |
| Implementation | Implementer agent(s) | The agent |
| Task review | Reviewer agent, diff only | **Human**, diff only |
| Sensitive chunks (§2) | Second fresh-context reviewer | Human review, and a fresh session re-reads the final diff with no memory of writing it |
| Merge | Human | Human |

In that mode, keep tasks small enough that a human can review each commit in a few minutes — that is the whole reason for one commit per task.

**Rules of separation**

- The reviewer agent and the implementer agent are **separate sessions with separate context**. The reviewer reads the diff, not the implementer's narration.
- An implementer that finds the plan wrong **stops and reports**. It does not redesign.
- For chunks touching **children's data, payments, authentication, encryption, residency or tenancy**, the reviewer spawns a **second, fresh-context reviewer** that has not seen the implementation discussion. Two independent passes, or it does not merge.
- **No model names are pinned in this file.** Use different model configurations for reviewer and implementer where available, so a single model never both produces and validates the same work. Record which configuration was used in the PR description.

---

## 3. The unit of work: a chunk

A **chunk** is one shippable slice of behaviour. **One spec = one plan = one branch = one PR = many small commits.** That chain is 1:1 in both directions: a PR that implements two specs is split, and a spec that needs two PRs was two chunks.

**Naming — the slug and date tie the chain together**

| Artifact | Form | Example |
|---|---|---|
| Spec | `docs/specs/YYYY-MM-DD-<slug>.md` | `docs/specs/2026-09-17-giving-checkout.md` |
| Plan | `docs/plans/YYYY-MM-DD-<slug>.md` | `docs/plans/2026-09-19-giving-checkout.md` |
| Branch | `<type>/<spec-date>-<slug>` | `feat/2026-09-17-giving-checkout` |
| PR title | `<type>(<scope>): <summary>` + spec link in the body | `feat(giving): checkout through GivingJar` |

- The **date is the date that document was created** — a plan written two days after its spec keeps its own date. The **slug is identical** across spec, plan and branch; that is what pairs them.
- The branch carries the **spec's** date, so the branch always points back to the document that authorised the work.
- Superseding a spec means a new file with a new date and a `Supersedes:` line, not an edit to a merged one.

**Right-sized chunk**
- Delivers something a user or another module can actually use (a vertical slice, not "the schema layer").
- 3–10 tasks, each 1 commit.
- Reviewable in one sitting: aim for **under ~800 changed lines** excluding generated files, lockfiles and migrations.

**Split the chunk if** it spans more than two modules, mixes a refactor with a feature, or needs more than one database migration wave.

**Do not split** so far that a PR cannot be tested end to end. "Add a column" is not a chunk.

---

## 4. The lifecycle

```
  ┌──────────┐  human   ┌──────────┐  human   ┌──────────────┐        ┌──────────┐
  │ 1. SPEC  │ ───────► │ 2. PLAN  │ ───────► │ 3. TASKS     │ ─────► │ 4. PR    │
  │ reviewer │ approves │ reviewer │ approves │ implementer  │ review │ human    │
  │  agent   │          │  agent   │          │ + reviewer   │        │ merges   │
  └──────────┘          └──────────┘          └──────────────┘        └──────────┘
       │                     │                       │                     │
  docs/specs/          docs/plans/            one commit per task    squash or merge
  <chunk>.md           <chunk>.md             + reviewer sign-off    per §8
```

Both gates are **human**. An agent never advances past a gate on its own judgement.

### Phase 1 — Spec (reviewer agent)

Use superpowers **`brainstorming`** to pressure-test the idea before writing anything.

Write `docs/specs/YYYY-MM-DD-<slug>.md`:

```markdown
# Spec: <chunk name>
Slug: <slug>                     # identical in the plan and the branch name
Status: draft | approved (YYYY-MM-DD, approver)
Supersedes: docs/specs/…  (only when replacing an earlier spec)
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
API routes, events published/consumed, port changes, widget keys.

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

**Approval criteria:** tasks are genuinely sequential, no task is "and then wire everything together", and the last task leaves the system releasable.

### Phase 3 — Tasks (implementer agents, reviewed one by one)

Use superpowers **`executing-plans`** and **`subagent-driven-development`** to dispatch, **`test-driven-development`** inside each task, **`systematic-debugging`** when something fails, and **`verification-before-completion`** before reporting done.

Per task:

1. Implementer writes the failing test (RED), the minimum code (GREEN), then refactors.
2. Implementer runs the local gate (§8) and reports: what changed, what the test proves, what it did **not** do.
3. Reviewer agent reviews the **diff** against the plan, the spec and §1 — using superpowers **`requesting-code-review`** for an independent pass on sensitive chunks.
4. Reviewer either accepts (commit stands) or returns it with specific findings. Returned work is fixed by the implementer, not by the reviewer.

A task is not done because the implementer says so. It is done when the reviewer accepts it and CI is green.

### Phase 4 — PR (human merges)

Use superpowers **`finishing-a-development-branch`**. Open the PR with the template in §9, then **stop**. Agents do not merge.

---

## 5. Working environment

- **Branch per spec**, named `<type>/<spec-date>-<slug>` — `feat/`, `fix/`, `chore/`, `docs/`. No branch is opened before its spec is approved; a branch with no spec has nothing authorising it.
- Use superpowers **`using-git-worktrees`** so parallel chunks never share a working tree.
- Never commit directly to `main`. Never force-push a shared branch.
- Rebase on `main` before opening the PR; keep history linear.
- Parallel implementers are allowed (**`dispatching-parallel-agents`**) only when tasks touch disjoint files. Two agents in one module at once is a merge conflict factory.

---

## 6. Implementation rules

Architecture-specific rules that reviewers check on every diff. Most map to a CI check; all of them are your responsibility.

**Tenancy and data**
- Every new `app` table: `org_id`, `community_id` (unless organisation-level), RLS + FORCE RLS, classification on every column.
- Queries go through `packages/db` helpers. No raw pool access, no session-level `SET`.
- Identity-schema work uses the identity role and does not set `app.org_id`.
- New encrypted column? Prove nothing filters, sorts or aggregates on it.

**Residency**
- New Worker: `workers_dev = false`, regional hostname registered with Regional Services if it touches personal data.
- New queue/workflow/cron path: IDs in, status out, `exec` does the work.
- New outbound call carrying personal data (provider, email, SMS, push): it originates from `exec`, not from a global Worker or a job.

**Modules**
- Cross-module access only through `public/`; prefer events.
- `domain/` stays framework-free.
- Modules never import adapters; they depend on ports.
- New entitlement key, permission, event or widget: declare it in `module.manifest.ts`. Plans reference manifest keys only.

**API and UI**
- Contracts first: Zod in `packages/contracts`, OpenAPI regenerated, breaking change → `/v2` plus deprecation window.
- No personal data in paths or query strings.
- UI composes `packages/ui`; no second component library; WCAG 2.2 AA is a merge gate.
- Entitlement-gated features hide or show an upgrade prompt — never render a control that only 403s.

**Tests**
- Unit for domain rules; integration for routes and repositories; **tenant-isolation and residency suites are not optional** for anything touching data.
- Every bug fix starts with a failing regression test.
- Synthetic data only. Fixtures never contain real people, real children, or production exports.

---

## 7. Database migrations

- **Expand → migrate → contract**, always. A migration must be backward compatible with the currently deployed Worker.
- Destructive DDL (`DROP`, `NOT NULL` on existing data, type narrowing) goes in a **later PR** than the code that stopped using the column.
- Every migration is reversible or has a written recovery note in the plan.
- Long backfills run as Workflows through `exec`, in batches, resumable — never inside a migration.
- Migrations run before deployment. A migration that requires downtime needs human scheduling.

---

## 8. Definition of done

**Per task (local gate, before reporting):**

```bash
pnpm lint && pnpm typecheck && pnpm test --filter <touched-packages> && pnpm check:boundaries
```

- [ ] Test written first and proves the behaviour
- [ ] No non-negotiable from §1 touched (or explicitly justified)
- [ ] Manifest updated if keys/permissions/events changed
- [ ] Commit message follows §9

**Per chunk (before requesting merge):**

- [ ] All plan tasks done or consciously dropped with a note
- [ ] Full CI green (§10)
- [ ] Tenant-isolation and residency suites green
- [ ] Spec's behaviour verified against a running preview, not just tests
- [ ] `architecture.md` updated in the same PR if the chunk changed a documented decision, plus an ADR in `docs/adr/` for anything at decision level
- [ ] Reviewer agent sign-off recorded in the PR; second independent review for sensitive chunks (§2)

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

**One PR implements exactly one spec.** If work grows past its spec, stop: either narrow the PR, or write a second spec and open a second branch.

**PR description** states:
- `Spec: docs/specs/<spec-date>-<slug>.md` and `Plan: docs/plans/<plan-date>-<slug>.md` (both required, both must be `approved`)
- What changed, in behaviour terms
- Data classification changes and migration wave
- Which of §1 the chunk could plausibly have broken, and how it doesn't
- Review record: implementer configuration, reviewer configuration, second review if required
- Screenshots or a preview link for UI, test evidence for backend

**Merge policy**
- Required checks must pass. No exceptions, no admin override without a written reason in the PR.
- **Agents never merge.** The human owner merges.
- Squash when the commits are noise; merge commit when the task history is worth keeping (it usually is — the plan maps to it).
- Delete the branch after merge.

---

## 10. CI/CD

`main` is always releasable. CI runs on every push to a PR; the heavier suites run before deploy.

**Stage 1 — Static (fast, every push)**
- format, lint, typecheck
- module boundaries (dependency-cruiser)
- manifest checks: entitlement/permission/event keys exist and are declared; plan catalogue keys resolve
- traceability check: the branch name matches `<type>/<YYYY-MM-DD>-<slug>`; the PR body links a spec and a plan that exist, share that slug, and are marked `approved`; exactly one spec is referenced
- schema checks: `app` tables have `org_id` + RLS + FORCE RLS; no module outside `core/identity` touches the identity schema; every column carries a classification
- encryption/queryability check: no encrypted column used in a `WHERE`, `ORDER BY`, `GROUP BY` or aggregate
- secret scanning, dependency audit (fail on high/critical)

**Stage 2 — Tests (every push)**
- unit + module integration (`@cloudflare/vitest-pool-workers` + Postgres)
- **tenant isolation**: every endpoint called with another organisation's and community's token must fail
- **residency**: no personal data in queue payloads, workflow step results, KV writes or log output; `exec` routes return status shapes only
- contract tests: mobile API, `PaymentProvider`, `JellycubeHost`
- accessibility (axe) on changed surfaces

**Stage 3 — Build and preview (every PR)**
- build all Workers and apps; publish OpenAPI diff as a comment
- per-PR preview deployment seeded with synthetic data only
- Terraform plan posted to the PR when `infra/` changed

**Stage 4 — Deploy**
- merge to `main` → migrations → deploy `staging-au` → smoke tests + critical-journey e2e (sign-in, donate, RSVP, check-in, consent)
- production is a **human-triggered** promotion of that exact build: migrations → gradual deployment → automatic rollback on error-rate alert
- Terraform apply on `infra/` changes requires human approval
- nightly on `main`: full e2e, restore drill check, dependency and licence report

**Required for merge:** Stages 1–3 green. Flaky test? Fix or quarantine with an issue and an owner in the same PR — never re-run until green.

---

## 11. Review checklist (reviewer agent)

Beyond "does it work":

- [ ] Does the diff match the approved plan, or did scope creep in?
- [ ] Tenancy: could any query return another organisation's row?
- [ ] Residency: does any personal data reach a global Worker, queue, KV, log, or offshore service?
- [ ] Children: any new path where a minor's data could become public, searchable, or reach a third party?
- [ ] Money: are amounts integer minor units, idempotency keys present, ledger tenant-scoped?
- [ ] Encryption: right classification, right key, and nothing encrypted that SQL must query?
- [ ] Entitlements and permissions checked in API, UI **and** jobs?
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
- Cost or lock-in decisions (a new vendor, a new Cloudflare product, a new paid service)
- Two consecutive failed attempts at the same problem — report what you learned instead of a third guess
- Something looks like a security issue, however small

Report progress honestly. "Tests fail, here is the output" is worth more than a confident summary that hides it.

---

## 13. Documentation duties

- `architecture.md` is the source of truth. Change it **in the same PR** as the behaviour change, not later.
- Decisions at architecture level get an ADR in `docs/adr/NNNN-title.md`: context, decision, consequences, alternatives.
- Runbooks in `docs/runbooks/` for anything operable: incidents, breach assessment, restores, key rotation, provider outages.
- Specs and plans stay in the repo after merge. They are the record of why the code looks like this.

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
- ❌ Perfect commit-message poetry, changelog entries per commit, or squash-vs-merge debates.
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

New work            → spec (brainstorming) → HUMAN APPROVES
                    → plan (writing-plans) → HUMAN APPROVES
                    → tasks (subagent-driven-development, TDD, one commit each)
                    → each task reviewed by the reviewer agent
                      (single-agent tool: the HUMAN reviews each task diff)
                    → PR (finishing-a-development-branch) → HUMAN MERGES

Never               → merge your own work · personal data outside AU · prod data anywhere else
                    → encrypted column in a WHERE/ORDER BY/aggregate · secrets in the repo
                    → a Durable Object holding personal data · analytics SDK on any surface

Stuck twice         → stop and report
Rule in the way     → say so in the PR, do not silently break it
```
