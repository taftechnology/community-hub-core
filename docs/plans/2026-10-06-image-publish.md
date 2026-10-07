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
- Staging Terraform runs set `github_repository_id = "100000000001"` and `github_repository_owner_id = "100000000002"` in the `variables` block. `terraform test` does not load `env/staging.tfvars`. No run reads `1374054927` or `41717792` from that file. The test file does not contain those two numbers. Account `123456789012` stays the synthetic account. `prod_tfvars`, `prod_endpoint_off_fails`, `prod_image_set`, and `prod_database_off_fails` leave both GitHub id variables unset.
- The workflow file contains no 12-digit account id. The role ARN and the registry hostname are the secret names `ECR_PUSH_ROLE_ARN` and `ECR_REGISTRY` only.
- Staging stays parked. Do not change `enable_database`, `desired_count`, or add `service_image` or `enable_kms_endpoint`.
- Do not edit the Dockerfile, the image-test assertions, the ECR lifecycle policy, or `failure_threshold`.
- Production is a separate account. This role is staging-only and is not reused. Do not add a prod provider.
- The scan fixtures import and spawn the module the publish job executes. That file is `tooling/checks/image-publish/scan-decision.js`.
- From the Task 3 commit on: no rebase, no amend, and no force-push. If `origin/main` moves, bring it in with a merge commit. The pull request merges with a merge commit, never a squash, and the PR body says so. Any rebase happens before Task 3 is pushed.
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
| `tooling/checks/image-publish/scan-decision.js`       | The decision the fixtures test and the publish job runs.                      |
| `tooling/checks/image-publish/scan-decision.test.ts`  | The spec's scan fixtures, including spawned exit codes.                       |
| `tooling/checks/image-publish/workflow-check.ts`      | Function over workflow text.                                                   |
| `tooling/checks/image-publish/workflow.test.ts`       | Must-fail workflow fixtures, and the real `ci.yml`.                            |
| `infra/regions/au/main.tf`, `variables.tf`            | Provider, role, and policy. Staging only.                                      |
| `infra/regions/au/env/staging.tfvars`                 | The real GitHub ids.                                                           |
| `infra/regions/au/tests/cell.tftest.hcl`              | Synthetic ids on staging runs. Trust and policy asserts.                      |
| `.github/workflows/ci.yml`                            | Publish job, attestation flags, concurrency.                                   |
| `docs/runbooks/apply-staging-au.md`                   | Apply record, and that `service_image` comes from a CI digest.                 |
| `docs/roadmap.md`, `AGENTS.md`, `architecture.md`     | Catalogue, Stage 3, and the §23.2 plan-role sentence.                          |

---

### Task 1: Scan decision

**Files:**

- Create: `tooling/checks/image-publish/package.json`
- Create: `tooling/checks/image-publish/vitest.config.ts`
- Create: `tooling/checks/image-publish/tsconfig.json`
- Create: `tooling/checks/image-publish/scan-decision.js`
- Create: `tooling/checks/image-publish/scan-decision.test.ts`

**Interfaces:**

- Produces: `export function decide(input)` and `export function errorNameFromStderr(stderr)` from `scan-decision.js`. The package is `"type": "module"`. The same file is the CLI. Task 3's publish job runs `node tooling/checks/image-publish/scan-decision.js`. The fixtures import `decide` from that path and spawn that file. They do not reimplement it.

**Rule this must not break:** no AWS call, no account id, no token. Copy the TypeScript and Vitest setup from `tooling/checks/traceability` only as far as this package needs. Package name `@community-hub/image-publish`. `pnpm test` must run this package because it lives under `tooling/checks/*`. The root ESLint glob is `**/*.{js,ts,tsx}`, so this file is `.js`, not `.mjs`. `tsconfig.json` sets `allowJs` and `checkJs` and includes `*.ts` and `*.js`. Task 3 does not edit it. Do not add a package ESLint config.

`decide` takes `{ status, counts, mediaType, errorName, timedOut }` and returns `{ pass, retry }`.

- Pass when `status` is `COMPLETE`, `counts` is null or an object, `CRITICAL` is absent or 0, `timedOut` is false, `errorName` is null, and `mediaType` is not an index. `HIGH` 8 with no `CRITICAL` key passes. `COMPLETE` with `CRITICAL` 0 passes.
- Fail when `counts` is present and not an object (a string, array, or number). `null` counts are absent, not a failure.
- Fail when `CRITICAL` is present and not a non-negative integer. `"0"`, `-1`, `1.5`, and `true` fail. `0` passes the type check.
- `retry` is true only for `errorName` `ScanNotFoundException` or for a status other than `COMPLETE` that is not an immediate failure, and only when `timedOut` is false.
- Immediate failures set `pass` false and `retry` false: `CRITICAL` greater than 0; status `FAILED`, `UNSUPPORTED_IMAGE`, `SCAN_ELIGIBILITY_EXPIRED`, or `FINDINGS_UNAVAILABLE`; an `errorName` other than null and other than `ScanNotFoundException`; media type `application/vnd.oci.image.index.v1+json` or `application/vnd.docker.distribution.manifest.list.v2+json`.
- `timedOut` true sets `pass` false and `retry` false, including still in progress and `ScanNotFoundException`.

`errorNameFromStderr` reads AWS CLI stderr. The name is the text in parentheses immediately after `An error occurred`. Empty stderr yields null. Any other non-empty stderr yields `Unknown`, which `decide` treats as an unknown error and fails.

The shell does not build JSON. The CLI prints nothing. It takes arguments and reads the files itself:

```text
node tooling/checks/image-publish/scan-decision.js --stdout <file> --stderr <file> --aws-exit <code> --media-type <type> [--timed-out]
```

Exit 0 is pass, 1 is fail, 2 is retry. It reads the stderr file only when `--aws-exit` is not 0, and then sets `errorName` from `errorNameFromStderr`. When `--aws-exit` is 0 it does not read stderr, it parses the stdout file as the query JSON, and stdout that is not JSON exits 1.

- [ ] **Step 1: Write the failing fixtures**

`scan-decision.test.ts` imports `decide` and `errorNameFromStderr` from `./scan-decision.js`. One imported test per bullet above, plus the spec's scan cases. It also spawns `node tooling/checks/image-publish/scan-decision.js` with the arguments above and asserts the exit code:

- `--aws-exit 0`, stdout file is the `COMPLETE` run2 shape (`HIGH` 8, no `CRITICAL` key), and the stderr file holds a warning: exit 0
- `--aws-exit 0` and a stdout file that is not JSON: exit 1
- `--aws-exit 0` and stdout `CRITICAL` greater than 0: exit 1
- `--aws-exit` not 0, no `--timed-out`, and a stderr file whose contents are exactly this line: exit 2

```text
aws: [ERROR]: An error occurred (ScanNotFoundException) when calling the DescribeImageScanFindings operation: Image scan does not exist for the image with '{imageDigest:'sha256:0000', imageTag:'null'}' in the repository with name 'ch-staging/service' in the registry with id '123456789012'
```

- `--aws-exit` not 0 and a stderr file that does not contain that phrase: exit 1

Run `pnpm test --filter @community-hub/image-publish`. Expected: the import fails.

- [ ] **Step 2: Implement `decide`, `errorNameFromStderr`, and the CLI**

- [ ] **Step 3: Gate and commit**

```bash
git add tooling/checks/image-publish
git commit -m "$(cat <<'EOF'
test(ci): decide the image scan from the job's module

The publish job runs this file. The fixtures import it and spawn
it, so a clean run2 shape exits 0 and a retry exits 2.

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
- Produces: `aws_iam_openid_connect_provider.github`, `aws_iam_role.image_publish`, and `aws_iam_role_policy.image_publish`. The count of each is 1 only when `var.environment == "staging"` and both GitHub ids are non-null. A staging plan with either id null does not interpolate those ids into `sub`. Also `terraform_data.github_ids` and `check "github_ids"`, the same pair as `staging_zone`. That pair still fails a staging plan that omits the ids.

**Rule this must not break:** prod plans zero of those three resources. The count is 1 only when the environment is staging and both ids are non-null, so a null id is never interpolated into `sub`. `thumbprint_list` is unset. Trust is `StringEquals` only, on `aud`, the immutable `sub`, `job_workflow_ref`, `repository_id`, and `repository_owner_id`. No `StringLike`. The policy actions are exactly `ecr:GetAuthorizationToken` on `*`, and on `module.ingress.repository_arn` only: `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`, `ecr:BatchGetImage`, `ecr:DescribeImages`, `ecr:DescribeImageScanFindings`. No `ecr:GetDownloadUrlForLayer`. No delete, ECS, Secrets Manager, KMS, IAM, or S3 action.

Variables `github_repository_id` and `github_repository_owner_id` are optional strings, default `null`. Prod does not need them. `env/prod.tfvars` stays unchanged.

`env/staging.tfvars` sets:

```hcl
github_repository_id       = "1374054927"
github_repository_owner_id = "41717792"
```

The trust `sub` is `repo:taftechnology@${var.github_repository_owner_id}/community-hub-core@${var.github_repository_id}:ref:refs/heads/main`. `job_workflow_ref` is `taftechnology/community-hub-core/.github/workflows/ci.yml@refs/heads/main`. `aud` is `sts.amazonaws.com`.

- [ ] **Step 1: Write the failing tests**

Add the two synthetic assignments to the `variables` block of every existing staging run: `staging_happy`, `budgets_on`, `staging_endpoint_on`, `wrong_region_fails`, `staging_without_zone_id_fails`, `staging_image_set`, `database_off`, `image_without_database_fails`, `staging_unpark`, and `staging_image_null`.

```hcl
github_repository_id       = "100000000001"
github_repository_owner_id = "100000000002"
```

Leave both unset on `prod_tfvars`, `prod_endpoint_off_fails`, `prod_image_set`, and `prod_database_off_fails`. Do not read `env/staging.tfvars` for these values. Do not put `1374054927` or `41717792` in the test file.

Add run `staging_without_github_ids_fails`. Copy the staging variables from `staging_happy` and omit both GitHub ids. `expect_failures` is `check.github_ids` and `terraform_data.github_ids` only, the same shape as `staging_without_zone_id_fails`.

In the existing `mock_provider "aws"` block (`override_during = plan`), add:

```hcl
mock_resource "aws_iam_openid_connect_provider" {
  defaults = {
    arn             = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    thumbprint_list = null
  }
}
```

`thumbprint_list == null` is unknown at plan on provider 6.67.0 without this mock. With the mock, that assert passes when the config leaves `thumbprint_list` unset and fails when the config sets it.

Add run `staging_image_publish`. Staging variables as in `staging_happy`, plus those two synthetic ids. `jsondecode` the assume-role policy and assert:

- `length(aws_iam_openid_connect_provider.github) == 1`
- `aws_iam_openid_connect_provider.github[0].url == "https://token.actions.githubusercontent.com"`
- `aws_iam_openid_connect_provider.github[0].client_id_list == toset(["sts.amazonaws.com"])`
- `aws_iam_openid_connect_provider.github[0].thumbprint_list == null`
- `length(aws_iam_role.image_publish) == 1`
- the decoded policy has exactly one statement
- that statement's `Effect` is `Allow`
- that statement's `Action` is `sts:AssumeRoleWithWebIdentity`
- that statement's `Principal` equals `{ Federated = aws_iam_openid_connect_provider.github[0].arn }`
- `keys(Condition)` equals `["StringEquals"]`
- `Condition.StringEquals` equals exactly these five entries:

```hcl
{
  "token.actions.githubusercontent.com:aud"                 = "sts.amazonaws.com"
  "token.actions.githubusercontent.com:sub"                 = "repo:taftechnology@100000000002/community-hub-core@100000000001:ref:refs/heads/main"
  "token.actions.githubusercontent.com:job_workflow_ref"    = "taftechnology/community-hub-core/.github/workflows/ci.yml@refs/heads/main"
  "token.actions.githubusercontent.com:repository_id"       = "100000000001"
  "token.actions.githubusercontent.com:repository_owner_id" = "100000000002"
}
```

`jsondecode` the role policy and assert exactly two statements, both `Effect` `Allow`. One statement's action is `ecr:GetAuthorizationToken` and its resource is `*`. The other statement's action set is exactly the eight repository actions above, including `ecr:BatchGetImage` and excluding `ecr:GetDownloadUrlForLayer`, and its resource is `module.ingress.repository_arn`.

On `prod_tfvars`, assert all three resource lengths are 0. That run still leaves the GitHub ids unset.

Keep the existing file assert that `env/staging.tfvars` does not contain `service_image` or `enable_kms_endpoint`, and that `enable_database` is false and `desired_count` is 0.

Run `terraform -chdir=infra/regions/au test`. Expected: `staging_image_publish` fails because the resources do not exist.

- [ ] **Step 2: Add the three resources and the id check**

Role name `ch-staging-image-publish`. Provider URL `https://token.actions.githubusercontent.com`. Audience `sts.amazonaws.com`. Do not set `thumbprint_list`.

One local, used as the count of the provider, the role, and the role policy:

```hcl
var.environment == "staging" && var.github_repository_id != null && var.github_repository_owner_id != null ? 1 : 0
```

Add `terraform_data.github_ids` and `check "github_ids"` with the same condition: staging requires both ids to be non-null. Match the `staging_zone` pair so `expect_failures` can name both. Those two still fail when the three resources have count 0.

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

- Create: `tooling/checks/image-publish/workflow-check.ts`
- Create: `tooling/checks/image-publish/workflow.test.ts`
- Create: `tooling/checks/image-publish/fixtures/` (one workflow file per must-fail case)
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `tooling/checks/image-publish/scan-decision.js` from Task 1. `tsconfig.json` already includes `*.ts` and `*.js`. Do not edit it.
- Produces: `checkWorkflow(text)` returning `{ ok, violations }`, job `publish` with `needs: [static, test]`, and the concurrency behaviour below. `build-preview` gains `--provenance=false --sbom=false` and still does not push.

**Rule this must not break:** `id-token: write` appears exactly once in `ci.yml`, on `publish`, not under the workflow `permissions`. The trust pin stays `.github/workflows/ci.yml`. The job does not print the token, the role ARN, the login password, or the account id. After this commit is pushed: no rebase, no amend, no force-push. Report this commit's full SHA in chat. Do not write it into this plan.

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

`workflow-check.ts` exports `checkWorkflow(text)`. `workflow.test.ts` calls that function. It does not reimplement the rules. Each must-fail fixture is a passing workflow with one defect. The test asserts `ok` is false and `violations` equals exactly that one rule.

- `workflow-id-token`: `id-token: write` under the workflow `permissions`
- `cancel-true`: a line `cancel-in-progress: true`
- `preview-push`: `docker push` in `build-preview`
- `missing-attestation`: a `docker build` missing `--provenance=false` or `--sbom=false`
- `account-id`: a 12-digit id
- `publish-without-main`: a `publish` job that is not conditioned on a push to `refs/heads/main`
- `publish-floating-uses`: a `uses:` in `publish` that is not a 40-hex SHA
- `publish-without-needs`: a `publish` job without `needs: [static, test]`

The real `.github/workflows/ci.yml` is the must-pass. `checkWorkflow` on that file returns `ok: true` only when all of these hold:

- workflow-level `cancel-in-progress` is `${{ github.event_name == 'pull_request' }}`
- the main concurrency group contains `github.sha`
- the file contains no line `cancel-in-progress: true`
- the `publish` job contains `group: image-publish` and `cancel-in-progress: false`
- `id-token: write` occurs exactly once, after the `publish:` job key
- `build-preview` has no `id-token` and no `docker push`
- every `docker build` contains `--provenance=false` and `--sbom=false`
- the file matches no 12-digit account id
- `publish` is conditioned on a push to `refs/heads/main`
- the job command contains `node tooling/checks/image-publish/scan-decision.js` with `--stdout`, `--stderr`, `--aws-exit`, and `--media-type`
- the scan query contains `imageScanStatus.status` and `imageScanFindings.findingSeverityCounts`
- every `uses:` in `publish` is `owner/repo@` plus 40 hex characters
- `publish` has `needs: [static, test]`

Run the package test. Expected: the real `ci.yml` fails, because it still has workflow-level `cancel-in-progress: true` and no publish job. The must-fail fixtures fail for the reason each name states.

- [ ] **Step 2: Add the job**

`publish` runs on `ubuntu-24.04-arm` with `timeout-minutes: 30` and `needs: [static, test]`, when `github.event_name == 'push'` and `github.ref == 'refs/heads/main'`. Job permissions are `contents: read` and `id-token: write` only.

Order inside the job:

1. Do not use `pnpm/action-setup`. `corepack enable` provides pnpm, because `packageManager` is `pnpm@10.26.0`. Pin each `uses:` to the v4 commit, with the version in a comment:

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
- uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  with:
    node-version: 24
```

Do not set `cache: pnpm`. `corepack enable` runs after setup-node.
2. Fail if `ECR_PUSH_ROLE_ARN` or `ECR_REGISTRY` is empty. Fail if `aws` is not on `PATH`.
3. Derive the account id as the first label of `ECR_REGISTRY`. Mask it with `::add-mask::` before any AWS call. Request the OpenID Connect token, write it only to a file under `RUNNER_TEMP`, mask it, and delete the file before the job ends. Never print the token. Before assuming the role, print only the decoded `sub`, `ref`, and `job_workflow_ref`.
4. Assume the role in `ap-southeast-2`. Then check the tag. The tag is `github.sha`. The repository name is `ch-staging/service`. Use `aws ecr batch-get-image` with `--query` limited to the digest, the manifest media type, and `failures[0].failureCode`. A missing tag is `ImageNotFound` in that result, not a `describe-images` error. Do not use `describe-images` to discover a missing tag.
5. If the tag exists, skip install, the build, the image tests, login, and the push. The job summary says the tag was reused. Read that tag's digest from the query above and run the gate on it.
6. If the tag does not exist, run `pnpm install --frozen-lockfile` on this path only. Build with `--platform linux/arm64 --provenance=false --sbom=false`, and run `RUN_IMAGE_TESTS=1` on `src/image.test.ts`. Log in with `aws ecr get-login-password` piped to `docker login --username AWS --password-stdin`. That is the one AWS call without `--query`. Do not print the password or the command output. Push the git SHA tag. Do not force the push. Then `batch-get-image` again and take the digest from that response.
7. Poll `aws ecr describe-image-scan-findings` for that digest every 15 seconds, for at most 10 minutes. `--query` is `imageScanStatus.status` and `imageScanFindings.findingSeverityCounts`. Write stdout and stderr to files. The shell does not build JSON. Call `node tooling/checks/image-publish/scan-decision.js` with `--stdout`, `--stderr`, `--aws-exit`, and `--media-type`. Exit 0 passes. Exit 2 retries. Exit 1 fails immediately. At 10 minutes, call the CLI once more with `--timed-out`.
8. The job summary records the digest and the severity counts. It does not record the registry hostname, the role ARN, or the account id.

Every other AWS CLI invocation uses `--query`. `build-preview`'s `docker build` gains the same two attestation flags and is otherwise unchanged, including that it still runs on a push to `main`.

- [ ] **Step 3: Gate and commit**

```bash
git add tooling/checks/image-publish/workflow-check.ts tooling/checks/image-publish/workflow.test.ts tooling/checks/image-publish/fixtures .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci(api): publish the image from main

A push to main does not cancel a run in progress. The publish
group does not cancel the publish that is already running.

EOF
)"
```

Push this commit. Do not rebase it afterwards.

---

## Human: apply the role and create the secrets

The agent stops. Apply the Task 3 commit, the one whose subject is `ci(api): publish the image from main`. The agent reports that SHA in chat when the commit is pushed. Do not write the SHA into this plan. Task 4 records it in the runbook. Do not apply a later commit.

From `docs/runbooks/apply-staging-au.md`, before each apply:

1. git status is clean.
2. git rev-parse HEAD equals the SHA named for that apply, and that SHA is on origin.
3. terraform init uses -lockfile=readonly.

From `infra/regions/au` on that SHA, profile `ch-admin`, both var files, the gitignored file last:

```bash
terraform init -backend-config=backend/staging.hcl -lockfile=readonly
terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
```

If the apply shows anything other than 3 to add, 0 to change, 0 to destroy, answer no and stop.

Then:

```bash
terraform plan -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
```

The following plan shows no changes. Paste the SHA and the summary. Do not paste the role ARN, the registry hostname, or the account id.

Then create GitHub Actions secrets `ECR_PUSH_ROLE_ARN` and `ECR_REGISTRY` on this repository. Do not write the values into git. Set both before merge. The pull request checks do not assume the role.

---

### Task 4: Runbook

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Consumes: the human's paste from the apply, and the Task 3 SHA reported in chat.
- Produces: a section after Re-park. It records that SHA, the three additions, and the empty following plan. It says a later `service_image` is the digest from the publish job summary, not a laptop push. This chunk does not set `service_image`. The SHA is not copied back into this plan.

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

**Rule this must not break:** do not edit any other AGENTS.md sentence. Prettier may reflow the header table. Do not mark this plan approved. Do not rebase.

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

Push with a normal push. Open the PR only after this commit is on the remote. The PR body says the pull request merges with a merge commit, never a squash. Second review line stays open.

---

## Rollback

The agent does not apply.

1. A later commit deletes `aws_iam_openid_connect_provider.github`, `aws_iam_role.image_publish`, and `aws_iam_role_policy.image_publish`, and removes the two ids from `env/staging.tfvars`.
2. The human applies that commit. The plan shows those three resources destroyed and nothing else. If it shows anything else, answer no and stop.
3. Remove the two GitHub Actions secrets. Disable or delete the `publish` job if a push to `main` should stop publishing. Tags already in the repository stay. The role cannot delete them.
