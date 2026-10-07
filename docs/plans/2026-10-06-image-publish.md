Spec: docs/specs/2026-10-06-image-publish.md

# Image publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CI on `main` pushes the ARM image by digest with a GitHub OpenID Connect role, and pull requests still only build and test.

**Architecture:** Five agent commits. One commit adds the scan decision the publish job runs. One commit adds the staging role and pins it with synthetic GitHub ids. One commit adds the workflow. The human applies and creates the two secrets. One commit records that apply. The last commit updates the catalogue and the two delivery sentences. Nothing in an agent task calls AWS.

**Tech Stack:** Terraform 1.11.4, `terraform test`, Node on the existing runner, the AWS CLI already installed on `ubuntu-24.04-arm`. No new dependency. No new GitHub Action.

Status: draft

**Branch:** `feat/2026-10-06-image-publish` · one PR · 5 agent commits

## Global Constraints

- The spec is approved. Do not edit `docs/specs/2026-10-06-image-publish.md`.
- The agent does not run `terraform apply`, `docker push`, `aws`, or any command in a **Human** section.
- `env/staging.tfvars` gains `github_repository_id = "1374054927"` and `github_repository_owner_id = "41717792"`. They are not written to the gitignored file. `env/prod.tfvars` is not edited.
- Terraform tests set `github_repository_id = "100000000001"` and `github_repository_owner_id = "100000000002"` in the `variables` block of every run in `infra/regions/au/tests/cell.tftest.hcl`. `terraform test` does not load `env/staging.tfvars`. No run reads `1374054927` or `41717792` from that file. The test file does not contain those two numbers. Account `123456789012` stays the synthetic account.
- The workflow file contains no 12-digit account id. The role ARN and the registry hostname are the secret names `ECR_PUSH_ROLE_ARN` and `ECR_REGISTRY` only.
- Staging stays parked. Do not change `enable_database`, `desired_count`, or add `service_image` or `enable_kms_endpoint`.
- Do not edit the Dockerfile, the image-test assertions, the ECR lifecycle policy, or `failure_threshold`.
- Production is a separate account. This role is staging-only and is not reused. Do not add a prod provider.
- The scan fixtures import the module the publish job executes. That file is `tooling/checks/image-publish/scan-decision.mjs`.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Do not mark this plan approved yourself.
- Second fresh-context review is required. This chunk adds an IAM role that can write the image. Leave that line open in the PR. Do not write the second review.
- Agent tasks run `pnpm lint && pnpm typecheck && pnpm test && pnpm check:boundaries` before the commit, plus the Terraform sequence named in that task.

**Rollback:** Remove the provider, the role, and the role policy in a later commit and have the human apply that commit. The role cannot delete an image. A tag that was already pushed stays until a person deletes it with `ch-admin`. The agent does not run the apply.

**Cost:** No hourly resource. ECR storage after the first push stays under USD 1 a month inside the existing repository. The budget stays USD 50.

**AWS CLI:** The `ubuntu-24.04-arm` runner image ships the AWS CLI (GitHub's Ubuntu 24.04 ARM64 runner readme lists it). The publish job uses that binary. If `aws` is not on `PATH`, the job exits before any AWS call. It does not install a CLI.

## File map

| File                                                  | Responsibility                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `tooling/checks/image-publish/scan-decision.mjs`      | The decision the fixtures test and the publish job runs.                      |
| `tooling/checks/image-publish/scan-decision.test.ts`  | The spec's scan fixtures.                                                      |
| `tooling/checks/image-publish/workflow.test.ts`       | Workflow-level cancel rule and the publish job's own concurrency group.       |
| `infra/regions/au/main.tf`, `variables.tf`            | Provider, role, and policy. Staging only.                                      |
| `infra/regions/au/env/staging.tfvars`                 | The real GitHub ids.                                                           |
| `infra/regions/au/tests/cell.tftest.hcl`              | Synthetic ids set on every run. Trust and policy asserts.                     |
| `.github/workflows/ci.yml`                            | Publish job, attestation flags, concurrency.                                   |
| `docs/runbooks/apply-staging-au.md`                   | Apply record, and that `service_image` comes from a CI digest.                 |
| `docs/roadmap.md`, `AGENTS.md`, `architecture.md`     | Catalogue, Stage 3, and the §23.2 plan-role sentence.                          |

---

### Task 1: Scan decision

**Files:**

- Create: `tooling/checks/image-publish/package.json`
- Create: `tooling/checks/image-publish/vitest.config.ts`
- Create: `tooling/checks/image-publish/tsconfig.json`
- Create: `tooling/checks/image-publish/scan-decision.mjs`
- Create: `tooling/checks/image-publish/scan-decision.test.ts`

**Interfaces:**

- Produces: `export function decide(input)` from `scan-decision.mjs`. The same file is the CLI: it reads one JSON object from stdin, calls `decide`, and exits 0 when `pass` is true and 1 otherwise. Task 3's publish job runs `node tooling/checks/image-publish/scan-decision.mjs`. The fixtures import `decide` from that path. They do not reimplement it.

**Rule this must not break:** no AWS call, no account id, no token. Copy the ESLint, TypeScript, and Vitest setup from `tooling/checks/traceability` only as far as this package needs. Package name `@community-hub/image-publish`. `pnpm test` must run this package because it lives under `tooling/checks/*`.

`decide` takes `{ status, counts, mediaType, errorName, timedOut }` and returns `{ pass, retry }`.

- Pass when `status` is `COMPLETE`, `CRITICAL` is absent or 0, `timedOut` is false, `errorName` is null, and `mediaType` is not an index. `HIGH` 8 with no `CRITICAL` key passes.
- `retry` is true only for `ScanNotFoundException` or for a status other than `COMPLETE` that is not an immediate failure, and only when `timedOut` is false.
- Immediate failures set `pass` false and `retry` false: `CRITICAL` greater than 0; status `FAILED`, `UNSUPPORTED_IMAGE`, `SCAN_ELIGIBILITY_EXPIRED`, or `FINDINGS_UNAVAILABLE`; an `errorName` other than `ScanNotFoundException`; media type `application/vnd.oci.image.index.v1+json` or `application/vnd.docker.distribution.manifest.list.v2+json`.
- `timedOut` true sets `pass` false and `retry` false, including still in progress and `ScanNotFoundException`.
- `COMPLETE` with `CRITICAL` 0 passes.

- [ ] **Step 1: Write the failing fixtures**

`scan-decision.test.ts` imports `decide` from `./scan-decision.mjs`. One test per bullet in the spec's Tests section for the scan decision, plus `COMPLETE` with `CRITICAL` 0. Run `pnpm test --filter @community-hub/image-publish`. Expected: the import fails.

- [ ] **Step 2: Implement `decide` and the CLI**

The CLI writes nothing except a non-zero exit. It does not print the input.

- [ ] **Step 3: Gate and commit**

```bash
git add tooling/checks/image-publish
git commit -m "$(cat <<'EOF'
test(ci): decide the image scan from the job's module

The publish job runs this file. The fixtures import it, so a
clean run2 shape passes and a critical count fails.

EOF
)"
```

---

### Task 2: Staging publish role

**Files:**

- Modify: `infra/regions/au/tests/cell.tftest.hcl`
- Modify: `infra/regions/au/variables.tf`
- Modify: `infra/regions/au/main.tf`
- Modify: `infra/regions/au/env/staging.tfvars`

**Interfaces:**

- Consumes: `module.ingress.repository_arn`. The repository already exists when the image is null.
- Produces: `aws_iam_openid_connect_provider.github`, `aws_iam_role.image_publish`, and `aws_iam_role_policy.image_publish`, each with count 1 only when `var.environment == "staging"`.

**Rule this must not break:** prod plans zero of those three resources. `thumbprint_list` is unset. Trust is `StringEquals` only, on `aud`, the immutable `sub`, `job_workflow_ref`, `repository_id`, and `repository_owner_id`. No `StringLike`. The policy actions are exactly `ecr:GetAuthorizationToken` on `*`, and on `module.ingress.repository_arn` only: `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`, `ecr:BatchGetImage`, `ecr:DescribeImages`, `ecr:DescribeImageScanFindings`. No `ecr:GetDownloadUrlForLayer`. No delete, ECS, Secrets Manager, KMS, IAM, or S3 action.

Variables `github_repository_id` and `github_repository_owner_id` are optional strings, default `null`. A precondition rejects a staging plan when either is null. Prod does not need them. `env/prod.tfvars` stays unchanged.

`env/staging.tfvars` sets:

```hcl
github_repository_id       = "1374054927"
github_repository_owner_id = "41717792"
```

The trust `sub` is `repo:taftechnology@${var.github_repository_owner_id}/community-hub-core@${var.github_repository_id}:ref:refs/heads/main`. `job_workflow_ref` is `taftechnology/community-hub-core/.github/workflows/ci.yml@refs/heads/main`. `aud` is `sts.amazonaws.com`.

- [ ] **Step 1: Write the failing tests**

Add the two synthetic assignments to the `variables` block of every existing run:

```hcl
github_repository_id       = "100000000001"
github_repository_owner_id = "100000000002"
```

Do not read `env/staging.tfvars` for these values. Do not put `1374054927` or `41717792` in the test file.

Add run `staging_image_publish`. Staging variables as in `staging_happy`, plus those two synthetic ids. Assert:

- `length(aws_iam_openid_connect_provider.github) == 1`
- `length(aws_iam_role.image_publish) == 1`
- `length(aws_iam_role_policy.image_publish) == 1`
- the assume-role policy contains `100000000001` and `100000000002`, contains `StringEquals`, does not contain `StringLike`, and contains `repo:taftechnology@100000000002/community-hub-core@100000000001:ref:refs/heads/main`
- `GetAuthorizationToken` is the only action whose resource is `*`
- every other action is on `module.ingress.repository_arn`
- the action set is exactly the list above, including `ecr:BatchGetImage` and excluding `ecr:GetDownloadUrlForLayer`

On `prod_tfvars`, assert all three lengths are 0. Keep that run's variables on the synthetic ids too.

Keep the existing file assert that `env/staging.tfvars` does not contain `service_image` or `enable_kms_endpoint`, and that `enable_database` is false and `desired_count` is 0.

Run `terraform -chdir=infra/regions/au test`. Expected: `staging_image_publish` fails because the resources do not exist.

- [ ] **Step 2: Add the three resources**

Role name `ch-staging-image-publish`. Provider URL `https://token.actions.githubusercontent.com`. Audience `sts.amazonaws.com`.

- [ ] **Step 3: Gate and commit**

In `infra/regions/au`: `terraform init -backend=false -lockfile=readonly`, `terraform fmt -check`, `terraform validate`, `tflint --init`, `tflint`, `terraform test`.

```bash
git add infra/regions/au/tests/cell.tftest.hcl infra/regions/au/variables.tf infra/regions/au/main.tf infra/regions/au/env/staging.tfvars
git commit -m "$(cat <<'EOF'
feat(infra): add the staging image publish role

Tests pass synthetic GitHub ids and do not read the ids in
staging tfvars. Prod plans no provider and no role.

EOF
)"
```

---

### Task 3: Publish workflow

**Files:**

- Create: `tooling/checks/image-publish/workflow.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `tooling/checks/image-publish/scan-decision.mjs` from Task 1.
- Produces: job `publish` and the concurrency behaviour below. `build-preview` gains `--provenance=false --sbom=false` and still does not push.

**Rule this must not break:** `id-token: write` appears exactly once in `ci.yml`, on `publish`, not under the workflow `permissions`. The trust pin stays `.github/workflows/ci.yml`. The job does not print the token, the role ARN, or the account id.

**Concurrency mechanism:**

A job-level group cannot opt out of a workflow-level `cancel-in-progress: true`. Replace the workflow concurrency block with:

```yaml
concurrency:
  group: ${{ github.event_name == 'pull_request' && format('ci-{0}', github.ref) || format('ci-main-{0}', github.sha) }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

A pull request still cancels an older run of that same ref. A push to `main` gets its own group per SHA and `cancel-in-progress` is false, so it does not cancel a main run that is already in progress.

The publish job adds:

```yaml
concurrency:
  group: image-publish
  cancel-in-progress: false
```

GitHub keeps the in-progress run in a group when `cancel-in-progress` is false, and a newer queued run replaces the one that is only waiting. Publish jobs therefore run one at a time, a waiting publish can be replaced, and not every commit on `main` has an image.

- [ ] **Step 1: Write the failing workflow test**

`workflow.test.ts` reads `.github/workflows/ci.yml` as text. Assert all of:

- workflow-level `cancel-in-progress` is `${{ github.event_name == 'pull_request' }}`, not `true`
- the file contains no line `cancel-in-progress: true`
- the `publish` job contains `group: image-publish` and `cancel-in-progress: false` (this is the assert that the publish job's own group does not cancel a publish in progress)
- `id-token: write` occurs exactly once, and that occurrence is after the `publish:` job key and not in the workflow-level `permissions`
- `build-preview` has no `id-token` and no `docker push`
- both `docker build` lines contain `--provenance=false --sbom=false`
- the file matches no 12-digit account id
- `publish` is conditioned on a push to `refs/heads/main`
- the job command contains `node tooling/checks/image-publish/scan-decision.mjs`

Run the package test. Expected: fail, because `ci.yml` still has workflow-level `cancel-in-progress: true` and no publish job.

- [ ] **Step 2: Add the job**

`publish` runs on `ubuntu-24.04-arm` when `github.event_name == 'push'` and `github.ref == 'refs/heads/main'`. Job permissions are `contents: read` and `id-token: write` only.

Order inside the job:

1. Fail if `ECR_PUSH_ROLE_ARN` or `ECR_REGISTRY` is empty. Fail if `aws` is not on `PATH`.
2. Derive the account id as the first label of `ECR_REGISTRY`. Mask it with `::add-mask::` before any AWS call. Request the OpenID Connect token, write it only to a file under `RUNNER_TEMP`, mask it, and delete the file before the job ends. Never print the token. Before assuming the role, print only the decoded `sub`, `ref`, and `job_workflow_ref`.
3. Assume the role in `ap-southeast-2`. Then check the tag. The tag is `github.sha`. The repository name is `ch-staging/service`. Use `aws ecr batch-get-image` with `--query` limited to the digest, the manifest media type, and `failures[0].failureCode`. A missing tag is `ImageNotFound` in that result, not a `describe-images` error. Do not use `describe-images` to discover a missing tag. The account-id mask still covers a `describe-images` error if one is returned.
4. If the tag exists, skip the build, the image tests, and the push. The job summary says the tag was reused. Read that tag's digest from the query above and run the gate on it.
5. If the tag does not exist, build with `--platform linux/arm64 --provenance=false --sbom=false`, run `RUN_IMAGE_TESTS=1` on `src/image.test.ts`, and push the git SHA tag. Do not force the push. Then `batch-get-image` again and take the digest from that response.
6. Poll `aws ecr describe-image-scan-findings` for that digest, `--query` limited to `imageScanStatus.status` and `imageScanFindings.findingSeverityCounts`. Pass each response, plus the media type, to `node tooling/checks/image-publish/scan-decision.mjs`. Retry while `decide` returns `retry`. `ScanNotFoundException` is retried. Any other API error fails immediately. Stop at 10 minutes and call `decide` with `timedOut: true`.
7. The job summary records the digest and the severity counts. It does not record the registry hostname, the role ARN, or the account id.

Every AWS CLI invocation uses `--query`. `build-preview`'s `docker build` gains the same two attestation flags and is otherwise unchanged, including that it still runs on a push to `main`.

- [ ] **Step 3: Gate and commit**

```bash
git add tooling/checks/image-publish/workflow.test.ts .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci(api): publish the image from main

A push to main does not cancel a run in progress. The publish
group does not cancel the publish that is already running.

EOF
)"
```

---

## Human: apply the role and create the secrets

The agent stops. From `infra/regions/au` on this branch, profile `ch-admin`, both var files, the gitignored file last:

```bash
terraform init -backend-config=backend/staging.hcl -lockfile=readonly
terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
terraform plan -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
```

Expected: 3 added, 0 changed, 0 destroyed. The following plan shows no changes. Paste the SHA and the summary. Do not paste the role ARN, the registry hostname, or the account id.

Then create GitHub Actions secrets `ECR_PUSH_ROLE_ARN` and `ECR_REGISTRY` on this repository. Do not write the values into git. Set both before merge. The pull request checks do not assume the role.

---

### Task 4: Runbook

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Consumes: the human's paste from the apply.
- Produces: a section after Re-park. It records the apply SHA, the three additions, and the empty following plan. It says a later `service_image` is the digest from the publish job summary, not a laptop push. This chunk does not set `service_image`.

**Rule this must not break:** if the human has not pasted, stop. Do not invent an apply. Do not record a role ARN, a registry hostname, or an account id.

- [ ] **Step 1: Write the section from the paste**

- [ ] **Step 2: Gate and commit**

```bash
git add docs/runbooks/apply-staging-au.md
git commit -m "$(cat <<'EOF'
docs(runbooks): record the image publish role

The apply added the provider, the role, and the policy. A later
service image comes from the CI digest.

EOF
)"
```

---

### Task 5: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`
- Modify: `architecture.md`

**Interfaces:**

- Produces: `image-publish` **done**, linking `docs/specs/2026-10-06-image-publish.md`. Snapshot last shipped `image-publish`, next chunk `kms-mrk-replica`. Phase 0 stays `23 rows: 21 done, 1 superseded (api-au-hostname), 1 not started`. The repository-state sentence matches. `kms-mrk-replica` stays last. The sentence under the Phase 0 table names `kms-mrk-replica`.

**Rule this must not break:** do not edit any other AGENTS.md sentence. Prettier may reflow the header table. Do not mark this plan approved.

Replace the Stage 3 sentence that says the image is not pushed. A pull request still builds and does not push. A push to `main` publishes the digest. Live Terraform `plan` stays absent. This role is not a plan role.

In `architecture.md` §23.2, change the live-plan sentence so it waits until a GitHub OIDC **plan** role exists, not until any OIDC role exists. Do not add an ADR.

- [ ] **Step 1: Update the row, the snapshot, the repository-state sentence, Stage 3, and §23.2**

- [ ] **Step 2: Gate and commit**

```bash
pnpm exec prettier --write docs/roadmap.md AGENTS.md architecture.md
git add docs/roadmap.md AGENTS.md architecture.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark image publish done

Phase 0 is 23 rows: 21 done, 1 superseded, 1 not started. Next is
kms-mrk-replica. Live plan still waits on a plan role.

EOF
)"
```

Push. Open the PR only after this commit is on the remote. Second review line stays open.

---

## Rollback

The agent does not apply.

1. A later commit deletes `aws_iam_openid_connect_provider.github`, `aws_iam_role.image_publish`, and `aws_iam_role_policy.image_publish`, and removes the two ids from `env/staging.tfvars`.
2. The human applies that commit. The plan shows those three resources destroyed and nothing else.
3. Remove the two GitHub Actions secrets. Disable or delete the `publish` job if a push to `main` should stop publishing. Tags already in the repository stay. The role cannot delete them.
