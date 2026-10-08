Spec: docs/specs/2026-10-07-review-workflow.md

# Review workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new owner can learn the independent check, parking, and the local gate from the repo, and a Mac runs the same Terraform script CI runs.

**Architecture:** Six commits. One pins provider lock hashes. One adds `pnpm gate` and the single `ci.yml` line it compares. One adds the Cursor human-gates sentences. One updates the pull request template. One edits `AGENTS.md` by the sentences named below. The last records the catalogue row. No task edits `docs/owner-review-brief.md`.

**Tech Stack:** TypeScript, Vitest, Terraform 1.11.4. `pnpm gate` shells the `Terraform checks` script from `.github/workflows/ci.yml`.

Status: draft

**Branch:** `docs/2026-10-07-review-workflow` · one PR · 6 task commits, after the spec and this plan

## Global Constraints

- The spec is approved. Do not edit `docs/specs/2026-10-07-review-workflow.md`.
- `docs/owner-review-brief.md` is already committed with the spec, in `7cf1606`. No task edits it.
- Do not edit `architecture.md`, `docs/runbooks/apply-staging-au.md`, `env/staging.tfvars`, or `env/prod.tfvars`. No ADR. No infra resource.
- This chunk has no apply. It is not on the sensitive list: it does not touch children's data, payments, authentication, encryption, residency, or tenancy. There is no second fresh-context review. The pull request line says not required. The agent does not merge and does not apply.
- This plan adds no Terraform assert, so there is no scratch probe.
- The pull request opens after Task 6, not before. Push each task commit as it lands. A branch push with no pull request does not run CI. After the pull request is open, run `pnpm gate` and push related fix commits together. The pull request merges with a merge commit.
- The `publish` job, the `admin-publish` job, and `tooling/checks/image-publish/` stay untouched.
- `AGENTS.md` §10 stays untouched, including its `fmt -check` phrase. The executable change is the one `ci.yml` line in Task 2.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Do not mark this plan approved yourself.
- Prettier formats Markdown, TypeScript, and YAML. Run it on the files in the commit before every commit. On `AGENTS.md`, prettier may reflow padding only inside a table this task edits. Any other hunk is reverted.

**Rollback:** Revert the six commits. Nothing was applied.

**Cost:** None. No resource is added.

## Already committed

| File                                       | What                                                       |
| ------------------------------------------ | ---------------------------------------------------------- |
| `docs/owner-review-brief.md`               | Abdus's wording, committed in `7cf1606`. No task edits it. |
| `docs/specs/2026-10-07-review-workflow.md` | Approved in the commit before this plan. No task edits it. |

## Settings this spec names

Rules touched, Contracts, and Risks name these. The implementer runs each source change once, sees the named test fail, restores the file, and reports that. The weakened tree is never committed. The report is session scratch.

| Setting                                       | Test that pins it                                       | Source change that makes that test fail                        |
| --------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| Same provider version, same hash set          | `lock-hash-mismatch` fixture, `ok` is false             | In Task 1, give both fixture `hashes` lists the same one hash  |
| `Terraform checks` is the six lines           | Real `ci.yml` matches; `fmt-not-recursive.yml` does not | In Task 2, change the real line back to `terraform fmt -check` |
| A module path also selects `infra/regions/au` | The module-only mapping case                            | In Task 2, stop adding `infra/regions/au` for a module path    |

Parking, and "the agent does not apply", are prose. No test pins them.

## File map

| File                                           | Responsibility                                        |
| ---------------------------------------------- | ----------------------------------------------------- |
| `tooling/checks/terraform-invariants/`         | Hash-set rule and `lock-hash-mismatch`.               |
| `tooling/checks/gate/`                         | `pnpm gate`, the script comparison, the path mapping. |
| `.github/workflows/ci.yml`                     | One line in the `terraform` job.                      |
| `.cursor/rules/agent-models-and-execution.mdc` | Three human-gate sentences.                           |
| `.github/PULL_REQUEST_TEMPLATE.md`             | Four review-record lines.                             |
| `AGENTS.md`                                    | The sentences named in Task 5. Nothing else.          |
| `docs/roadmap.md`                              | One process row. The snapshot stays.                  |

---

### Task 1: Pin provider lock hashes

**Files:**

- Modify: `tooling/checks/terraform-invariants/check.ts`
- Modify: `tooling/checks/terraform-invariants/selftest.ts`
- Create: `tooling/checks/terraform-invariants/fixtures/lock-hash-mismatch/infra/modules/one/.terraform.lock.hcl`
- Create: `tooling/checks/terraform-invariants/fixtures/lock-hash-mismatch/infra/modules/two/.terraform.lock.hcl`

**Proves:** Two lock files for one provider version with different hash sets fail the checker. The real `infra/` tree still passes.

- [ ] **Step 1: Write the failing test**

Add `lock-hash-mismatch` to `mustFail` in `selftest.ts`. Add one assertion that a violation message contains both lock-file paths, `registry.terraform.io/hashicorp/aws`, and `9.9.9`.

Both fixture files use that provider and version `9.9.9`. File `one` lists two `h1:` hashes. File `two` lists only the first of those hashes. Use synthetic hashes. Do not copy a lock file from `infra/`.

Run: `pnpm test --filter @community-hub/check-terraform-invariants`

Expected: FAIL. The fixture is not rejected, because the rule does not exist yet.

- [ ] **Step 2: Run the source change once**

After Step 3 is green, set both `hashes` lists to the same one hash. Run the same test. Expected: the `lock-hash-mismatch` test FAIL, because `ok` is true. Restore the two different lists. Do not commit the equal lists.

- [ ] **Step 3: Write the minimum rule**

In `check.ts`, for each `.terraform.lock.hcl` under `infra/`, read each `provider` block. The key is the provider source plus the `version` attribute. Compare the `hashes` lists as sets. Order does not matter. A provider version that appears in only one file passes. A mismatch appends one violation that names both files, the source, and the version. Skip `.terraform` directories, as the walker already does. Do not add a rule for a missing `.terraform.lock.hcl`.

- [ ] **Step 4: Real tree**

Run: `pnpm check:boundaries`

Expected: `terraform-invariants: ok`, and the other checkers ok.

- [ ] **Step 5: Gate and commit**

`pnpm gate` does not exist yet. Run:

```bash
pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/check-terraform-invariants && pnpm check:boundaries
```

```bash
git commit -m "$(cat <<'EOF'
test(checks): reject mismatched provider lock hashes

A Mac cannot see a missing Linux provider hash. The checker compares hash sets for one provider version.

EOF
)"
```

---

### Task 2: Add `pnpm gate`

**Files:**

- Create: `tooling/checks/gate/package.json`
- Create: `tooling/checks/gate/tsconfig.json`
- Create: `tooling/checks/gate/vitest.config.ts`
- Create: `tooling/checks/gate/gate.ts`
- Create: `tooling/checks/gate/gate.test.ts`
- Create: `tooling/checks/gate/fixtures/fmt-not-recursive.yml`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.github/workflows/ci.yml`

**Proves:** The real Terraform script is the six lines, a script without `-recursive` fails that test, and a module-only path also selects the Sydney cell.

- [ ] **Step 1: Package**

Copy the `package.json` script shape and `tsconfig.json` from `@community-hub/check-terraform-invariants`. Name the package `@community-hub/check-gate`. Point Vitest at `gate.test.ts`. The workspace glob `tooling/checks/*` already includes it. Run `pnpm install` so `pnpm-lock.yaml` records the package. No new dependency.

- [ ] **Step 2: Write the failing tests**

Export `terraformChecksScript(workflowYaml: string): string`. It finds the job named `terraform`, the step named `Terraform checks`, and returns that `run:` block with each line trimmed and blank lines dropped.

Export `TERRAFORM_CHECKS` as exactly these six lines:

```bash
terraform init -backend=false -lockfile=readonly
terraform fmt -check -recursive
terraform validate
tflint --init
tflint
terraform test
```

Export `touchedTerraformDirs(changedPaths: readonly string[], matrix: readonly string[]): string[]`. A path selects a matrix directory when the path is that directory or is inside it. A path under `infra/modules/` also selects `infra/regions/au`. Return the selected directories in matrix order, once each.

Tests:

- The script of the real `.github/workflows/ci.yml` equals `TERRAFORM_CHECKS`.
- `fixtures/fmt-not-recursive.yml` is a workflow with a `terraform` job and a `Terraform checks` step whose script is those six lines except `terraform fmt -check` has no `-recursive`. The test asserts that script does not equal `TERRAFORM_CHECKS`. That fixture is the must-fail.
- `touchedTerraformDirs(["infra/modules/aws-budgets/main.tf"], matrix)` returns `["infra/modules/aws-budgets", "infra/regions/au"]`. `matrix` is the real `dir` list. This is the module-only case.
- `["infra/regions/au/main.tf"]` returns `["infra/regions/au"]` only.
- `["infra/bootstrap/main.tf"]` returns `["infra/bootstrap"]` only.
- `["AGENTS.md", ".github/workflows/ci.yml", "tooling/checks/gate/gate.ts", "package.json"]` returns `[]`.
- Two module paths return both module directories and `infra/regions/au` once.

Run: `pnpm test --filter @community-hub/check-gate`

Expected: FAIL. The real script still says `terraform fmt -check`.

- [ ] **Step 3: Run the source changes once**

After Step 4 is green, change the real `ci.yml` line back to `terraform fmt -check`. Run the test. Expected: the real-script test FAIL. Restore `-recursive`.

Then stop adding `infra/regions/au` for a module path. Run the test. Expected: the module-only test FAIL. Restore the addition.

Do not commit either weakened change.

- [ ] **Step 4: Make the tests pass**

In `.github/workflows/ci.yml`, in the `terraform` job only, replace `terraform fmt -check` with `terraform fmt -check -recursive`. No other line of that job changes. Do not edit `publish` or `admin-publish`.

`package.json` gains `"gate": "tsx tooling/checks/gate.ts"`.

`pnpm gate` runs, in order, `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm check:boundaries`. It then resolves `git merge-base HEAD origin/main`. If that command exits non-zero, `pnpm gate` exits non-zero. Changed paths are that diff, plus staged and unstaged diffs. For each directory from `touchedTerraformDirs`, it runs `terraformChecksScript` of the real workflow with that working directory. The script text is read from `ci.yml`. It is not copied into `gate.ts` except as `TERRAFORM_CHECKS`, which the test compares. When the directory list is empty, it prints `terraform: none` and does not run Terraform.

- [ ] **Step 5: Run `pnpm gate`**

Expected: the five pnpm commands pass, and the output contains `terraform: none`.

- [ ] **Step 6: Commit**

```bash
git commit -m "$(cat <<'EOF'
ci(gate): run the CI checks before pushing a fix

pnpm gate uses the workflow's Terraform script, and a module change also runs the cell tests.

EOF
)"
```

---

### Task 3: Stop the agent at apply and merge

**Files:**

- Modify: `.cursor/rules/agent-models-and-execution.mdc`

**Proves:** The rule file still has Models, Commit before review, and Approved plan, and it gains the three human-gate sentences.

- [ ] **Step 1: Add the sentences**

Leave the three existing sections as they are. Add:

```markdown
## Human gates

The agent does not merge. The agent does not apply. The agent stops at every Human section.
```

- [ ] **Step 2: Run `pnpm gate` and commit**

```bash
git commit -m "$(cat <<'EOF'
docs(agents): stop the agent at apply and merge

The session rule now says the agent does not merge, does not apply, and stops at every Human section.

EOF
)"
```

---

### Task 4: Record the owner's check

**Files:**

- Modify: `.github/PULL_REQUEST_TEMPLATE.md`

**Proves:** The review record has the four lines. The second-review line stays.

- [ ] **Step 1: Replace the review record**

Remove these three lines:

```markdown
- Implementer:
- Reviewer: human (single-agent) / agent configuration:
- Second independent review: not required / required because:
```

Add these four lines in their place:

```markdown
- Implementer:
- Reviewer agent:
- Owner's check assisted by: <tool>, <model>, and what it ran
- Second independent review: not required / required because:
```

No other line of the template changes.

- [ ] **Step 2: Run `pnpm gate` and commit**

```bash
git commit -m "$(cat <<'EOF'
docs(pr): record the owner's check

The review record names the implementer, the reviewer agent, and the assistant that checked the work.

EOF
)"
```

---

### Task 5: Write the process into `AGENTS.md`

**Files:**

- Modify: `AGENTS.md`

**Proves:** The diff is only the sentences below. `pnpm gate` passes.

Do not edit any other sentence. Prettier may reflow padding only inside a table this task edits.

- [ ] **Step 1: §2 Roles — add two paragraphs**

After the three-role table, and before `**If the tool has no subagent capability**`, add:

`Before approving a spec or a plan, and before merging, the owner has the work checked by an independent assistant. The assistant is in a different tool, and on a different model family, from the implementer and reviewer agents. The owner decides. The assistant reviews by diff, verifies by running, and never writes repo files, never applies, and never merges.`

`There are still three roles. The assistant is how the owner checks. It is not a fourth role, and it is not one of the repo's agents.`

The sentence `**No model names are pinned in this file.**` stays. Do not add a model name.

- [ ] **Step 2: §2 Roles — replace the sensitive-chunks table cells**

In the single-agent comparison table, replace the Multi-agent cell `Second fresh-context reviewer` with `Owner's assistant, in a fresh session. The reviewer agent may add its own.`

Replace the Single-agent cell `Human review, and a fresh session re-reads the final diff with no memory of writing it` with `Owner's assistant, in a fresh session`.

- [ ] **Step 3: §2 Roles — replace the sensitive-chunks bullet**

Remove:

`For chunks touching **children's data, payments, authentication, encryption, residency or tenancy**, the reviewer spawns a **second, fresh-context reviewer** that has not seen the implementation discussion. Two independent passes, or it does not merge.`

Add:

`For chunks touching **children's data, payments, authentication, encryption, residency or tenancy**, the owner's assistant runs the second fresh-context review in a fresh session that has not seen the implementation discussion. The reviewer agent may add its own. It starts when the pull request opens, alongside the final review, and it does not wait until the final review has finished. The pull request's second-review line stays open until that review is written.`

- [ ] **Step 4: §4 lifecycle diagram — replace the footer**

Remove the diagram lines `squash or merge` and `per §8`. The footer becomes:

```text
  docs/specs/          docs/plans/            one commit per task    merge commit
  <chunk>.md           <chunk>.md             + reviewer sign-off
```

- [ ] **Step 5: §4 Phase 2 — add two bullets**

After the existing rollback bullet, add:

`For each security-relevant setting the spec names under Rules touched, Contracts, or Risks, the plan lists the test that pins it and the source change that makes that test fail. The implementer runs each change once, sees that test fail, restores the source, and reports the failure. The weakened tree is never committed. This is limited to those named settings, not every line. The report is session scratch, not a file under docs/plans/.`

`The plan's Terraform asserts are run in a scratch probe before the plan is sent for approval. The probe uses the plan's proposed test with override_during = plan. The probe is outside the repo, or in a scratch worktree, and it is not committed. An assert that errors or cannot pass is rewritten before the plan is sent. The probe does not apply and does not read a real var file.`

- [ ] **Step 6: §4 Phase 4 — add one paragraph**

After `Agents do not merge.`, add:

`Push task commits as usual. The pull request opens only when every plan task is done, including the catalogue commit. CI triggers only on pull_request and on push to main, so pushing a branch with no pull request costs no Actions minutes. The runbook requires the applied SHA to be on origin. After the pull request is open, run pnpm gate and push related fix commits together. One fix is not one push. Each fix is still its own commit.`

- [ ] **Step 7: §5 — replace one bullet and add one bullet**

Remove:

`Rebase on origin/main before opening the PR; keep history linear.`

Add:

`Before the first apply on a branch, rebase on origin/main and keep history linear. After the first apply there is no rebase, no amend, and no force-push. When origin/main moves after that apply, bring it in with a merge commit.`

Add:

`Push task commits as usual. The pull request opens only when every plan task is done, including the catalogue commit. CI triggers only on pull_request and on push to main, so pushing a branch with no pull request costs no Actions minutes. The runbook requires the applied SHA to be on origin. After the pull request is open, run pnpm gate and push related fix commits together. One fix is not one push. Each fix is still its own commit.`

The earlier sentence `Never force-push a shared branch.` stays.

- [ ] **Step 8: §6 Cost — add two bullets**

Leave the existing cost bullet. After it, add:

`Staging is parked by default. Parked means enable_database = false and desired_count = 0 in the committed infra/regions/au/env/staging.tfvars, and no service_image in any committed var file under infra/regions/au/env/. Parking removes the database and runs zero tasks. Stopping a database is not parking, because RDS starts a stopped instance again after seven days.`

`Staging is unparked only inside a chunk whose approved spec says so. That spec names why, the expected extra monthly cost, and how long it stays up. The same chunk re-parks before its pull request is merged, and docs/runbooks/apply-staging-au.md records both applies. The human runs every park and unpark apply. An agent never does. The steps are in that runbook and are not copied here.`

- [ ] **Step 9: §8 — replace the gate command**

Remove:

```bash
pnpm lint && pnpm typecheck && pnpm test --filter <touched-packages> && pnpm check:boundaries
```

Add:

```bash
pnpm gate
```

The five checklist items under that command stay.

- [ ] **Step 10: §9 — replace two bullets and add one**

Remove:

`Review record: implementer configuration, reviewer configuration, second review if required`

Add:

`Review record: implementer configuration; reviewer agent configuration; Owner's check assisted by, with the tool, the model, and what it ran; and the second-review line`

Remove:

`Squash when the commits are noise; merge commit when the task history is worth keeping (it usually is — the plan maps to it).`

Add:

`The pull request merges with a merge commit.`

Under **Merge policy**, add:

`After the first apply on a branch there is no rebase, no amend, and no force-push. When origin/main moves after that apply, it comes in by a merge commit.`

`**Agents never merge.**` stays.

- [ ] **Step 11: §11 — add one checklist item**

After the existing Cost checkbox, add:

`Does this chunk leave staging parked? If it unparks, does the spec say why, for how long, and at what cost, and does the last apply re-park?`

- [ ] **Step 12: §15 — replace one bullet**

Remove:

`Perfect commit-message poetry, changelog entries per commit, or squash-vs-merge debates.`

Add:

`Perfect commit-message poetry or changelog entries per commit.`

The `❌` prefix stays on that bullet.

- [ ] **Step 13: Run `pnpm gate` and commit**

```bash
git commit -m "$(cat <<'EOF'
docs(agents): write down parking, review, and the local gate

The owner check, the parked staging rule, and pnpm gate are in the process a new owner reads.

EOF
)"
```

---

### Task 6: Record the chunk

**Files:**

- Modify: `docs/roadmap.md`

**Proves:** One new row. The snapshot sentences are unchanged.

- [ ] **Step 1: Add the process section**

After the Architecture decisions table and its `---`, and before `## Phase 0 — Foundations`, add:

```markdown
## Process

Chunks that change how work is reviewed. They do not count toward phase totals.

| Status | Chunk             | What                                                                                                                        |
| ------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| done   | `review-workflow` | Parking, the owner's check, the local gate, and when a pull request opens. Spec `docs/specs/2026-10-07-review-workflow.md`. |
```

Do not change the snapshot. Phase stays `1 — Core platform`. Last shipped stays `admin-shell`. Next chunk stays `tenancy-implicit-org`. The Phase 0 counts stay `23 rows: 22 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stay `not started`. The sentence under the Phase 0 table and the Next spec section still name `tenancy-implicit-org`.

- [ ] **Step 2: Run `pnpm gate` and commit**

```bash
git commit -m "$(cat <<'EOF'
docs(roadmap): mark the review workflow done

The process row is outside the phase tables. The next chunk stays tenancy-implicit-org.

EOF
)"
```

- [ ] **Step 3: Stop**

Do not open the pull request inside this task. After this commit is pushed, open the pull request. It merges with a merge commit. There is no apply and no second fresh-context review.
