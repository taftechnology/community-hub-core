# Owner decisions 2026-11-04 implementation plan

**Goal:** Record the owner's 2026-11-04 decisions in ADRs and living documents without changing code or infrastructure.

**Tech stack:** Markdown, Prettier. No application code, Terraform, or migrations.

Spec: docs/specs/2026-11-04-owner-decisions.md

Status: draft

**Branch:** `docs/2026-11-04-owner-decisions` · one PR · six tasks, one commit each

## Global constraints

- Documents only. Do not change application code, tests, CI workflows, migrations, or Terraform.
- Do not push, open a PR, merge, or touch AWS.
- Do not edit the "Where we are" snapshot in `docs/roadmap.md`.
- Run `pnpm exec prettier --write` on every Markdown file touched, then `pnpm exec prettier --check .` before finishing.
- Session scratch is never committed.

**Rollback:** Revert the PR. No migration or cloud state.

---

### Task 2: ADR 0017 children's data access

**Files:** Create `docs/adr/0017-childrens-data-access.md`

**Check:** File exists; links from `architecture.md` §11.3–11.4 and `AGENTS.md` rule 4; prettier on the file.

**Commit:** `docs(adr): 0017 children's data access`

---

### Task 3: ADR 0018 client migration preview

**Files:** Create `docs/adr/0018-client-migration-preview.md`

**Check:** File exists; `architecture.md` §24 cites it; grep finds no "securely delete the self-hosted"; prettier on the file.

**Commit:** `docs(adr): 0018 client migration through a production preview`

---

### Task 4: architecture.md

**Files:** Modify `architecture.md` (sections listed in spec coverage table and brief Task 4 list)

**Check:**

- `grep -n -i "check-in\|check in\|checkin" architecture.md` — remaining hits state check-in is not built or removed from scope.
- `grep -n "Email Settings" architecture.md` — dropped.
- `grep -n -i "staging" architecture.md | grep -i -E "import|migrat|parallel|client"` — no real client data on staging.
- Prettier on `architecture.md`.

**Commit:** `docs(architecture): record the 2026-11-04 owner decisions`

---

### Task 5: AGENTS.md

**Files:** Modify `AGENTS.md` only §1 rule 4 and §10 Stage 4 critical journeys.

**Check:** `grep check-in AGENTS.md` — journey list has no check-in; rule 4 links ADR 0017; prettier.

**Commit:** `docs(agents): minors' access rule and no check-in journey`

---

### Task 6: roadmap.md

**Files:** Modify `docs/roadmap.md` per brief Task 6 (not the Where we are snapshot).

**Check:** Email Settings and check-in grep rules; open questions aligned with architecture §26; prettier.

**Commit:** `docs(roadmap): record the 2026-11-04 owner decisions`

---

## Final verification (report in impl-report.md)

From worktree root:

```bash
grep -n -i "check-in\|check in\|checkin" architecture.md AGENTS.md docs/roadmap.md
grep -n "Email Settings" architecture.md docs/roadmap.md
grep -n -i "staging" architecture.md | grep -i -E "import|migrat|parallel|client"
grep -n -i "securely delete the self-hosted" architecture.md
pnpm exec prettier --check .
git status --short
git log --oneline origin/main..HEAD
```

Expect exactly six commits and a clean working tree.

---

## Brief 2 — later owner answers (2026-11-04)

Four additional commits on the same branch. Do not rewrite the first six commits.

### Task 7: ADR 0017 second-factor answer

**Files:** `docs/adr/0017-childrens-data-access.md`

**Check:** Decision 6 matches owner answer B; "Two-factor for staff" in consequences; interpretations section; "each field" wording; prettier.

**Commit:** `docs(adr): record the second-factor answer in ADR 0017`

---

### Task 8: architecture.md (brief 2)

**Files:** `architecture.md`

**Check:**

- Plan pricing grep (see brief-2 checks): no United States dollar amounts for the 200 / 500 / 1,500 launch prices in the four listed files (AUD, excluding GST).
- `without checking which tenant` restored (line ~82).
- Q9 original SES/Cloudflare/OtpMail text plus Email Settings dropped append.
- Q18–Q22 closed per owner; Q23 open.
- §11.1, §14, §19, §22 backup row per answer D.
- Prettier on `architecture.md`.

**Commit:** `docs(architecture): GST, second factor, receipt default and restore answers`

---

### Task 9: roadmap.md (brief 2)

**Files:** `docs/roadmap.md`

**Check:** Two-factor row; restore row renamed; AUD/GST; open questions Q18–Q22; inventory line; prettier.

**Commit:** `docs(roadmap): GST, two-factor, receipt default and restore answers`

---

### Task 10: spec and plan (brief 2)

**Files:** `docs/specs/2026-11-04-owner-decisions.md`, `docs/plans/2026-11-04-owner-decisions.md`

**Check:** Decisions 13–16 (or refined 4, 6, 7, 9); open points; coverage; plan tasks 7–10; prettier.

**Commit:** `docs: update the owner decisions spec and plan`

---

## Final verification (brief 2 — report in impl-report-2.md)

```bash
grep -n -E "USD (200|500|1,500)" architecture.md docs/roadmap.md docs/specs/2026-11-04-owner-decisions.md docs/plans/2026-11-04-owner-decisions.md
grep -n -i "can see that backups exist\|admins see backups\|view and restore" architecture.md docs/roadmap.md docs/adr/0017-childrens-data-access.md docs/specs/2026-11-04-owner-decisions.md
grep -n "without checking which tenant" architecture.md
grep -n -E "^\| Q(18|19|20|21|22|23) " architecture.md docs/roadmap.md
pnpm exec prettier --check .
git status --short
git log --oneline origin/main..HEAD
```

Expect ten commits and a clean working tree.

---

## Brief 3 — GivingJar is our own platform (2026-11-04)

One additional commit on the same branch. Do not amend earlier commits.

### Task 11: GivingJar platform decision

**Files:** `architecture.md`, `docs/roadmap.md`, `docs/specs/2026-11-04-owner-decisions.md`, `docs/plans/2026-11-04-owner-decisions.md`

**Check:**

- `grep -n -i "confirm" architecture.md docs/roadmap.md docs/specs/2026-11-04-owner-decisions.md docs/plans/2026-11-04-owner-decisions.md | grep -i givingjar` — no hit.
- `grep -n -E "^\| Q1 " architecture.md docs/roadmap.md` — both closed.
- §14 GivingJar own-platform sentence; §10 "an AUD 1,500"; Phase 3 GivingJar capabilities row; spec decision 3 refined; open points and coverage updated.
- Prettier on every Markdown file touched; `pnpm exec prettier --check .`.

**Commit:** `docs: GivingJar is our own platform on Stripe Connect`

---

## Final verification (brief 3 — report in impl-report-3.md)

```bash
grep -n -i "confirm" architecture.md docs/roadmap.md docs/specs/2026-11-04-owner-decisions.md docs/plans/2026-11-04-owner-decisions.md | grep -i givingjar
grep -n -E "^\| Q1 " architecture.md docs/roadmap.md
pnpm exec prettier --check .
git status --short
git log --oneline origin/main..HEAD
```

Expect eleven commits and a clean working tree.
