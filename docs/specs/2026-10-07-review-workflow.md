# Spec: Review workflow

Slug: review-workflow
Status: draft
Architecture refs: none. This chunk does not edit `architecture.md` and does not add an ADR.

## Problem

`AGENTS.md` says the human owner approves specs and plans and merges. In practice the owner has each of those checked first by an independent assistant in a different tool. That practice is not written down, so a new owner cannot learn it from the repo.

Three recent chunks also lost review rounds to the same causes. The local gate did not match CI. Plans carried Terraform asserts that could not pass, or left security settings unpinned. The second fresh-context review started only after everything else was done.

## Scope

**In**

- Parking, in `AGENTS.md` §6 Cost and §11.
- The owner's independent check, in `AGENTS.md` §2, in a new `docs/owner-review-brief.md`, and in `.cursor/rules/agent-models-and-execution.mdc`.
- When a pull request opens, how fixes are pushed, and how history moves after the first apply, in `AGENTS.md` §4, §5, and §9.
- When the second fresh-context review starts, in `AGENTS.md` §2. This draft does not choose who runs it.
- The review record in `.github/PULL_REQUEST_TEMPLATE.md`.
- One local command, `pnpm gate`, and `AGENTS.md` §8 pointing the per-task gate at it.
- One terraform-invariants rule for provider lock hashes.
- What a plan must pin, and a scratch probe of its Terraform asserts, in `AGENTS.md` §4 Phase 2.
- The catalogue row for this chunk. The snapshot does not change.

**Out**

- Any change to `architecture.md`, any ADR, and any infra resource.
- How GitHub enforces merges: required status checks, and a coding-agent token that cannot merge. That is a setting and a cost decision for Abdus.
- Merging the ten Terraform CI jobs into one. That is a separate CI chunk if Abdus wants it.
- Editing `docs/runbooks/apply-staging-au.md`. This chunk points at it and does not copy its steps.
- Unparking staging. This chunk leaves it parked.

## Behaviour

### Parking

`AGENTS.md` §6 Cost gains this rule. Staging is parked by default. Parked means `enable_database = false` and `desired_count = 0` in the committed `infra/regions/au/env/staging.tfvars`, and no `service_image` assignment in any file git tracks. Parking removes the database and runs zero tasks. Stopping a database is not parking, because RDS starts a stopped instance again after seven days.

Staging is unparked only inside a chunk whose approved spec says so. That spec names why, the expected extra monthly cost, and how long it stays up. The same chunk re-parks before its pull request is merged, and the runbook records both applies. The committed `staging.tfvars` is back to the parked values in that pull request. `service_image` stays out of git while unparked; it belongs in the gitignored var file, and that assignment is removed before the re-park apply.

The human runs every park and unpark apply. An agent never does.

`AGENTS.md` §6 points to `docs/runbooks/apply-staging-au.md` for the steps. The steps are not copied into `AGENTS.md`.

`AGENTS.md` §11 gains this checklist item: "Does this chunk leave staging parked? If it unparks, does the spec say why, for how long, and at what cost, and does the last apply re-park?"

### Roles

`AGENTS.md` §2, Human owner, gains this duty. Before approving a spec or a plan, and before merging, the owner has the work checked by an independent assistant. The assistant is in a different tool, and on a different model family, from the implementer and reviewer agents. The owner decides. The assistant reviews by diff, verifies by running, and never writes repo files, never applies, and never merges.

There are still three roles. The assistant is how the owner checks. It is not a fourth role, and it is not one of the repo's agents. `AGENTS.md` still pins no model name.

`docs/owner-review-brief.md` is the assistant's standing rules. Abdus supplies the wording. The agent commits that text and does not draft a substitute. The supplied text covers all of these, and the file contains nothing else:

- Read-only on the repo. The assistant does not write, stage, or commit files in the repository.
- AWS is read-only. The assistant does not apply and does not merge.
- Never print account ids, ARNs, zone ids, hostnames, or secrets.
- Scratch work stays outside the repo.
- Spot-check tests by weakening the source in a scratch worktree.
- A read-only Terraform plan before every apply, checked by address.
- Paste-ready messages for the agent.

If that wording is not in the session when the brief task starts, the task stops.

`.cursor/rules/agent-models-and-execution.mdc` keeps its Models, Commit before review, and Approved plan sections. It gains three sentences: the agent does not merge, the agent does not apply, and the agent stops at every Human section.

### Pull requests and history

`AGENTS.md` §4 and §5: commits stay on the local branch until every plan task is done, including the catalogue commit. The pull request opens then, with one push. CI minutes are not spent on each task commit. After the pull request is open, the agent runs `pnpm gate` and then pushes related fix commits together. One fix is not one push. Each fix is still its own commit.

`AGENTS.md` §5 and §9: after the first apply on a branch there is no rebase, no amend, and no force-push. When `origin/main` moves after that apply, it comes in by a merge commit. The pull request merges with a merge commit. The lifecycle diagram says merge commit. The §9 choice between squash and merge commit is removed. The §15 bullet that lists squash-versus-merge debates drops that clause, because the choice is made. Before the first apply, rebasing on `origin/main` stays allowed.

`AGENTS.md` §2: for a sensitive chunk, the second fresh-context review starts when the pull request opens, alongside the final review. It does not wait until the final review has finished. Sensitive stays the existing list: children's data, payments, authentication, encryption, residency, or tenancy.

This draft does not choose who runs that second review. The choices are the reviewer agent, the owner's assistant, or both. Abdus decides before this spec is approved. The pull request's second-review line stays, and it stays open until that review is written.

### Review record

`.github/PULL_REQUEST_TEMPLATE.md` review record is these four lines:

- Implementer configuration.
- Reviewer agent configuration.
- `Owner's check assisted by`, with the tool, the model, and what it ran.
- The second-review line, still present.

`AGENTS.md` §9 names the same four lines.

### Local gate

The command is `pnpm gate`, a script in the root `package.json`. It runs, in order:

1. `pnpm format`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm check:boundaries`
6. For each Terraform directory the change touches, the `Terraform checks` script of the `terraform` job in `.github/workflows/ci.yml`, with the working directory set to that directory.

A directory is touched when a path under it differs from the merge base of `HEAD` and `origin/main`, including staged and unstaged changes. The directory list is the `dir` matrix of that job. A directory that did not change is not initialized. If `origin/main` cannot be resolved, `pnpm gate` fails.

`pnpm gate` executes that workflow script. It does not keep a second copy of the lines. A test, run by `pnpm test`, fails when the script is not exactly these lines:

```bash
terraform init -backend=false -lockfile=readonly
terraform fmt -check -recursive
terraform validate
tflint --init
tflint
terraform test
```

`.github/workflows/ci.yml` changes `terraform fmt -check` to `terraform fmt -check -recursive` so the script and this list are the same text. No other line of that job changes. The `publish` job and the `admin-publish` job do not change.

`pnpm gate` does not run secret scanning, the dependency audit, traceability, the ARM image build, or either publish job. Those stay in CI.

`AGENTS.md` §8 replaces the per-task gate with `pnpm gate`. The rest of the per-task checklist stays.

### Lock hashes

`tooling/checks/terraform-invariants` gains one rule. For each provider source and version, every `.terraform.lock.hcl` under `infra/` lists the same set of hashes. The set is the `hashes` list on that provider block. Order does not matter. A provider version that appears in only one lock file passes. A missing lock file still fails the existing missing-lockfile rule.

The must-fail fixture is two lock files for the same provider version whose hash sets differ. The repository's own `infra/` tree passes, which is what `pnpm check:boundaries` already runs. This is the case a Mac cannot reproduce by running Terraform: a new module's lock file lacked the Linux hash and failed only in CI.

### Plans

`AGENTS.md` §4 Phase 2 gains two rules.

For each security-relevant setting the spec names under Rules touched, Contracts, or Risks, the plan lists the test that pins it and the source change that makes that test fail. The implementer runs each change once, sees that test fail, restores the source, and reports the failure. The weakened tree is never committed. This is limited to those named settings, not every line. The report is session scratch, not a file under `docs/plans/`.

The plan's Terraform asserts are run in a scratch probe before the plan is sent for approval. The probe uses the plan's proposed test with the existing `override_during = plan` mock. The probe is outside the repo, or in a scratch worktree, and it is not committed. An assert that errors or cannot pass is rewritten before the plan is sent. The probe does not apply and does not read a real var file.

### Catalogue

The last commit on this branch records `review-workflow` as done in `docs/roadmap.md`. The row sits outside the phase tables and does not count toward a phase. The snapshot stays: Phase `1 — Core platform`, last shipped `admin-shell`, next chunk `tenancy-implicit-org`. The Phase 0 counts stay `23 rows: 22 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stay `not started`. The sentence under the Phase 0 table and the Next spec section still name `tenancy-implicit-org`.

## Data

No new table, column, or migration.

## Rules touched

Process only. No entitlement, permission, consent, retention, or safeguarding rule. Residency and tenancy are unchanged. The parking rule is the cost rule above. Staging stays parked: `enable_database = false`, `desired_count = 0`, and no tracked `service_image`.

## Contracts

No API route, event, or website collection. The new command is `pnpm gate`. The new checker input is `.terraform.lock.hcl` files under `infra/`.

## Risks

A plan could still name an assert that fails only on Linux. The lock-hash rule compares hash sets on any machine, and `pnpm gate` runs the same Terraform script CI runs for each directory the change touches.

A scratch probe could be committed, or a weakened source change could be committed. Both are forbidden above, and the commit contains only the files the task names.

An agent could apply or merge from habit. `AGENTS.md` and the Cursor rule both say the agent does not. This chunk has no apply.

Two modules could intentionally carry different hashes for one provider version. They fail the check until the sets match. Updating one lock file means updating the others that pin that same version.

## Out-of-band

No legal sign-off. No architecture change. No new subprocessor. No new AWS resource and no monthly cost.

Abdus decides, before approval, who runs the second fresh-context review: the reviewer agent, the owner's assistant, or both.

Abdus supplies the wording of `docs/owner-review-brief.md`.

## Cost

None. No resource is added.
