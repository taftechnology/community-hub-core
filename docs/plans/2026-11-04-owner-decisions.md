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
