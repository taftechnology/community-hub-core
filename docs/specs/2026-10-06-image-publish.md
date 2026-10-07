# Spec: Image publish

Slug: image-publish
Status: approved (2026-10-06, Abdus)
Architecture refs: §7.3, §23.2, ADR 0009, AGENTS.md §8 and §10. Implements the `image-publish` row. Depends on `docs/specs/2026-10-06-first-running-task.md`, which is on `main`. Staging stays parked.

## Problem

The image that ran the first staging task was built on a laptop and pushed with a person logged in as `ch-admin`. CI builds the same ARM image on every pull request and does not push it. Nothing on `main` publishes a digest that production can later promote. There is no GitHub OpenID Connect role, so a workflow cannot push without a long-lived key.

## Scope

**In**

- An OpenID Connect provider for `https://token.actions.githubusercontent.com` and one IAM role, in the AU cell, created only when `environment` is `staging`.
- The role can push to the existing staging service repository and read that repository's scan findings. `ecr:BatchGetImage` is included because AWS's documented push policy requires it. `ecr:GetDownloadUrlForLayer` is not included, so the role still cannot pull layers. It cannot delete an image, change ECS, read a secret, or call KMS.
- A publish job on `main` only. When the git SHA tag is absent, it builds `linux/arm64` with provenance and SBOM attestations off, runs the existing image tests, and pushes that tag. When the tag already exists, it skips the build, the tests, and the push. Either way it passes the scan only when `imageScanStatus.status` is `COMPLETE` and `CRITICAL` is absent or 0.
- Pull-request `build-preview` keeps building and testing. It gains the same provenance and SBOM flags so the tested image is a single manifest. It does not push and it does not receive `id-token: write`. It already runs on a push to `main` as well, because `.github/workflows/ci.yml` triggers on `pull_request` and on `push` to `main`, and this chunk does not remove that. Publish does its own build. It does not reuse the `build-preview` docker daemon.
- The role ARN and the registry hostname are GitHub Actions secrets. Neither is committed. Tests keep account `123456789012` and synthetic GitHub ids. `env/staging.tfvars` holds repository id `1374054927` and owner id `41717792`. They are not in the gitignored file.
- The catalogue commit marks this row done. Next is `kms-mrk-replica`. Phase 0 stays 23 rows: 21 done, 1 superseded (`api-au-hostname`), 1 not started.
- The same PR updates the AGENTS.md Stage 3 sentence: a pull request still does not push; a push to `main` publishes the digest. Live Terraform `plan` stays absent. This role is not a plan role.
- The same PR updates the architecture.md §23.2 sentence that now says live `terraform plan` waits until a GitHub OIDC role exists. The revised sentence waits until a GitHub OIDC **plan** role exists. This publish role does not satisfy that wait.
- The same PR adds a runbook section: the apply record, and that a later `service_image` comes from a CI digest.

**Out**

- Unparking staging. `enable_database` stays false. `desired_count` stays 0. `service_image` stays unset in git. The publish does not apply Terraform and does not update a service.
- Production is a separate AWS account. It gets its own provider when a production chunk needs one. This role pushes only `ch-staging/service` and is not reused. How production obtains the digest is the promotion chunk's decision. No prod repository, no prod role, and no prod apply in this chunk.
- `kms-mrk-replica`. `ap-southeast-4` stays disabled.
- A live Terraform `plan` in CI, an apply role, or any permission outside the list below.
- Deleting an image from CI, including one that later scans as `CRITICAL`. The role has no delete action. A person deletes with `ch-admin` if a bad tag must go.
- Changing the Dockerfile, the base-image pin, the image tests' assertions, or the ECR lifecycle policy.
- A new GitHub Action. The job uses the AWS CLI on `ubuntu-24.04-arm` and the workflow's OpenID Connect token. The plan confirms that CLI is on the runner image. The job fails closed if `aws` is missing. It does not install another CLI.
- A NAT gateway, a load balancer, or an interface endpoint.
- An ADR. The §23.2 edit names the existing plan-role wait. It does not make a new decision.

## Behaviour

### Who applies

The human applies the AU cell from this branch, with both var files, the gitignored file last, profile `ch-admin`. The agent does not run `terraform apply`, `docker push`, or an AWS command.

The apply adds three resources and changes nothing else: the OpenID Connect provider, the role, and the role policy. The database, the cluster, the service, and the task definitions stay absent. A following plan shows no changes. The runbook records that apply: the SHA, the three additions, and the empty following plan.

The human then creates two GitHub Actions secrets on this repository. The values are not written into the repo, the plan, the tests, or the runbook.

| Secret              | Value                                                        |
| ------------------- | ------------------------------------------------------------ |
| `ECR_PUSH_ROLE_ARN` | The role ARN                                                 |
| `ECR_REGISTRY`      | The registry hostname, with no repository path and no scheme |

The pull request does not need those secrets. Its checks do not assume the role. The human sets both secrets before merging, so the merge push is the first publish.

AGENTS.md §8 says a chunk's behaviour is verified on the staging hostname. That check does not apply here. The publish does not serve traffic. The first `main` run is the proof: the job summary has a digest and severity counts, and the scan decision passed.

If that run fails, the fix is a `fix/` branch from `main`. A second apply happens only when the trust or the policy changes. A failed scan or a missing CLI does not get another apply.

### Trust

The provider URL is `https://token.actions.githubusercontent.com`. The audience is `sts.amazonaws.com`. `thumbprint_list` stays unset so the provider manages the certificate.

This repository uses GitHub's immutable subject. `gh api repos/taftechnology/community-hub-core/actions/oidc/customization/sub` returned `use_immutable_subject: true` and this prefix:

`repo:taftechnology@41717792/community-hub-core@1374054927`

The role trust is `StringEquals` on all five of these, not `StringLike`:

- `token.actions.githubusercontent.com:aud` is `sts.amazonaws.com`
- `token.actions.githubusercontent.com:sub` is `repo:taftechnology@41717792/community-hub-core@1374054927:ref:refs/heads/main`
- `token.actions.githubusercontent.com:job_workflow_ref` is `taftechnology/community-hub-core/.github/workflows/ci.yml@refs/heads/main`
- `token.actions.githubusercontent.com:repository_id` is `1374054927`
- `token.actions.githubusercontent.com:repository_owner_id` is `41717792`

A pull request, a tag, another branch, and any other workflow file cannot assume the role. The count is `environment == "staging"`. A prod plan has no provider and no role.

Tests use synthetic ids. They do not use `41717792` or `1374054927`. `env/staging.tfvars` holds repository id `1374054927` and owner id `41717792`. They are not in the gitignored file.

### Permissions

`ecr:GetAuthorizationToken` is on `*`. That action has no resource.

These actions are on the staging service repository ARN only:

- `ecr:BatchCheckLayerAvailability`
- `ecr:InitiateLayerUpload`
- `ecr:UploadLayerPart`
- `ecr:CompleteLayerUpload`
- `ecr:PutImage`
- `ecr:BatchGetImage`
- `ecr:DescribeImages`
- `ecr:DescribeImageScanFindings`

`ecr:BatchGetImage` is there because AWS's documented push policy requires it. `ecr:GetDownloadUrlForLayer` stays out, so the role still cannot pull layers.

No other action. No `ecr:GetDownloadUrlForLayer`, no `ecr:BatchDeleteImage`, no `ecs:*`, no `secretsmanager:*`, no `kms:*`, no `iam:*`, no `s3:*`.

### Publish job

The job runs on `ubuntu-24.04-arm` only when `github.event_name == 'push'` and `github.ref == 'refs/heads/main'`. Its permissions are `contents: read` and `id-token: write`. It does not have `pull-requests: write`. The string `id-token: write` appears exactly once in the workflow file, on this job, and not under the workflow-level `permissions`.

A job-level concurrency group cannot exempt a job from the workflow-level one. With `cancel-in-progress: true` at workflow level, a second push to `main` cancels the whole earlier run, publish included. The required behaviour is:

- A push to `main` never cancels a run already in progress on `main`.
- Pull-request runs still cancel their own older runs.
- Publish jobs run one at a time in the group `image-publish`.
- A publish that is waiting can be replaced by a newer one, so not every commit on `main` has an image.

The plan chooses the mechanism. The trust pin stays `.github/workflows/ci.yml`. The workflow test fails if the workflow-level setting cancels a push to `main`.

If either secret is empty, the job fails before an AWS call. If `aws` is not on `PATH`, the job fails before an AWS call.

Before the first AWS call, the job derives the account id as the first label of `ECR_REGISTRY` and masks that bare id. It masks the OpenID Connect token. The token is written only to a file under `RUNNER_TEMP` and that file is removed before the job ends. The job never prints the token. Before it assumes the role, it prints only the decoded `sub`, `ref`, and `job_workflow_ref` claims.

Every AWS CLI call uses `--query`. `describe-images` and `describe-image-scan-findings` both return `registryId`, and an `AccessDenied` message prints the assumed-role ARN. The queries return only the fields named below, so those values are not printed. The masked account id covers the account portion of an error that still slips through. A missing tag makes `describe-images` return an error that names the registry id, and that mask covers it. The plan picks a tag-existence check that does not depend on that error.

The role is assumed first. The tag check is next, before any build. The tag is the full `github.sha`. The repository name in the workflow is `ch-staging/service`. The hostname comes from `ECR_REGISTRY`. The repository is already `IMMUTABLE` with scan-on-push. The push is not forced.

If the tag exists, the job skips the build, the image tests, and the push. It reads the digest for that tag and runs the gate. The job summary says the tag was reused. A re-run must not test a new build and then gate an older digest. The Dockerfile runs `apt-get upgrade`, so a later build of the same commit is not the same image.

If the tag does not exist, the job builds, tests, and pushes, then reads the digest and runs the gate:

```bash
docker build --platform linux/arm64 --provenance=false --sbom=false -f apps/api/Dockerfile -t community-hub-api:local .
```

`RUN_IMAGE_TESTS=1` runs `src/image.test.ts` against that local image. A failed test does not push.

The digest in the job summary is read back from ECR for that tag, with `--query` limited to the digest. The gate reads `describe-image-scan-findings` for that digest. It does not read findings from `describe-images`.

The scan decision is a pure function, and the job executes that same function. The fixtures test it, not a copy. ECR omits a severity whose count is zero. run2 was `COMPLETE` with `HIGH` 8, `MEDIUM` 2, `LOW` 3, and no `CRITICAL` key, and that shape passes.

Pass only when `imageScanStatus.status` is `COMPLETE` and `CRITICAL` is absent or 0. `HIGH` does not fail the job. The first running task shipped with 8 HIGH. This chunk does not raise that bar and does not waive a critical finding.

Fail when:

- `CRITICAL` is greater than 0
- the status is `FAILED`, `UNSUPPORTED_IMAGE`, `SCAN_ELIGIBILITY_EXPIRED`, or `FINDINGS_UNAVAILABLE` (these four fail at once, without waiting out the timeout)
- the status is anything other than `COMPLETE` once the timeout has been reached, including still in progress
- the API returns an error other than `ScanNotFoundException`
- the manifest media type is an index (`application/vnd.oci.image.index.v1+json` or `application/vnd.docker.distribution.manifest.list.v2+json`)

`ScanNotFoundException` immediately after the push is retried. A status that is not yet `COMPLETE` is retried. The timeout is 10 minutes from the start of the wait. At 10 minutes the job fails. A scan timeout is fixed by re-running the job, which skips to the gate when the tag exists, or by the next merge if the tag was never pushed.

A failed scan does not deploy anything. Staging is parked either way. The tag remains. The role cannot delete it.

The job summary records the digest and the severity counts. When the tag was reused, it says so. It does not record the registry hostname, the role ARN, or the account id.

### Pull requests

`build-preview` adds `--provenance=false --sbom=false` and still does not log in or push. It has no `id-token: write`. A fork or a branch cannot publish. On a push to `main`, `build-preview` still runs, and the publish job runs as well.

## Data

No new table and no new column. The image is built from the repository. It contains no tenant data, no password, and no secret. The GitHub-hosted runner is not in Australia. That is allowed because the build has no personal data. The registry is the existing repository in `ap-southeast-2`. The image is not replicated.

## Rules touched

Residency. The pushed image is stored in `ap-southeast-2`. The job does not copy a database, a log, or a key. The role cannot read secrets or call KMS.

Secrets. The role ARN and the registry hostname stay in GitHub Actions secrets. The committed workflow names the secrets and does not contain a 12-digit account id. Tests use `123456789012`. The token is not logged.

Tenancy, children, and encryption. No query, no public path, and no new encrypted column.

## Contracts

| Contract      | Value                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| Provider      | `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`, staging cell only             |
| Trust         | Immutable `sub` for `refs/heads/main`, plus `repository_id`, `repository_owner_id`, and `job_workflow_ref` |
| Push          | `ch-staging/service`, tag is the full git SHA, immutable                                                   |
| Scan          | `describe-image-scan-findings`. Pass on `COMPLETE` with `CRITICAL` absent or 0. Timeout 10 minutes.        |
| Secrets       | `ECR_PUSH_ROLE_ARN` and `ECR_REGISTRY`. Not committed.                                                     |
| Staging flags | `enable_database` false, `desired_count` 0, no `service_image`, no `enable_kms_endpoint`                   |

## Cost

No new hourly resource. The OpenID Connect provider and the IAM role have no charge.

The registry already exists. Empty, it has no monthly charge. After the first push, ECR storage is about USD 0.10 per GB-month. The lifecycle policy already keeps the 10 newest tagged images. This line stays under USD 1 a month while those 10 exist. It is not in the parked USD 6.30 figure, which counted an empty repository. The budget stays USD 50. No NAT gateway, no load balancer, and no interface endpoint.

## Risks

A trust policy wider than `main`, or a `sub` that still uses the mutable `repo:taftechnology/community-hub-core:ref:...` form, would not match the tokens this repository issues. The test pins `StringEquals` on the five claims above.

A policy with `ecr:*`, `ecr:GetDownloadUrlForLayer`, or a delete action would let CI pull layers or remove images. The test lists the allowed actions and fails on any other. `ecr:BatchGetImage` is allowed. `ecr:GetDownloadUrlForLayer` is not.

Publishing before the secrets exist fails the first `main` job and pushes nothing. The human sets both secrets before merge.

A critical scan fails the job after the tag exists. The role cannot delete it. The tag is not a release. Staging is not pointed at it.

Leaving the provenance attestation on makes an index that ECR basic scan does not scan. Both the pull-request build and the publish build turn attestations off. An index media type fails the gate.

`failure_threshold` on Cloud Map stays. This chunk does not edit that resource.

The lifecycle policy keeps the 10 newest tagged images. run1 and run2 already count. A push on every merge expires a tagged digest once 10 newer tagged images exist, including a digest a later human might still want. This chunk does not change that policy. Owner: Abdus, before any apply that sets `service_image` to a published digest.

`main` has no branch protection on this GitHub plan, and two accounts can push. Anyone who can push to `main` can publish an image. Nothing deploys without a later human apply that sets `service_image` to a digest.

## Out-of-band

- The second fresh-context review. This chunk adds an IAM role that can write the image the regional service runs. The review that writes this spec does not count.
- The human applies, then creates the two secrets, then merges.
- No account id, role ARN, registry hostname, password, or key in this spec, the plan, the tests, or the job summary. The GitHub repository id and owner id in the trust section are the values the customization API returned. They are not an AWS account id.
- Production is a separate AWS account. It gets its own provider when a production chunk needs one. This role pushes only `ch-staging/service` and is not reused. How production obtains the digest is the promotion chunk's decision.

## Tests

Terraform tests are mocked plans. No test uses a real account id or the real GitHub ids. Synthetic GitHub ids are `100000000001` and `100000000002`.

- Staging plans one OpenID Connect provider and one role. Prod plans neither.
- The trust policy contains `StringEquals` for `aud`, the immutable `sub` shape, `job_workflow_ref`, `repository_id`, and `repository_owner_id`. It does not contain `StringLike`. The test `sub` uses the synthetic ids.
- The role policy's actions are exactly the list in Permissions, including `ecr:BatchGetImage` and excluding `ecr:GetDownloadUrlForLayer`. `GetAuthorizationToken` is the only action on `*`. Every other action is on the staging service repository ARN built from account `123456789012`.
- `env/staging.tfvars` still does not contain `service_image` or `enable_kms_endpoint`, and still has `enable_database = false` and `desired_count = 0`.
- The workflow file has a publish job conditioned on a push to `refs/heads/main`. `id-token: write` appears exactly once, on that job, and not at workflow level. `build-preview` has no `id-token` and no `docker push`. The workflow file contains no 12-digit account id. Both builds pass `--provenance=false --sbom=false`. The workflow-level concurrency setting does not cancel a push to `main`. Pull-request runs still cancel their own older runs. The publish job uses the group `image-publish`.

The scan decision is a pure function with fixtures. These must fail or pass as written:

- run2's shape passes: status `COMPLETE`, counts `HIGH` 8, `MEDIUM` 2, `LOW` 3, and no `CRITICAL` key.
- `COMPLETE` with `CRITICAL` greater than 0 fails.
- Status `FAILED`, `UNSUPPORTED_IMAGE`, `SCAN_ELIGIBILITY_EXPIRED`, or `FINDINGS_UNAVAILABLE` fails at once.
- Still in progress when the 10-minute timeout is reached fails.
- `ScanNotFoundException` at the timeout fails.
- An index manifest media type fails.
- `COMPLETE` with `CRITICAL` 0 passes.
- An API error that is not `ScanNotFoundException` fails without waiting out the timeout.

## Catalogue

The last commit on this branch updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`. `image-publish` is **done** and links this spec. Phase 0 stays 23 rows: 21 done, 1 superseded (`api-au-hostname`), 1 not started. The snapshot's next chunk is `kms-mrk-replica`. That row stays last and not started. The sentence under the Phase 0 table names `kms-mrk-replica`. The Stage 3 sentence and the §23.2 sentence are updated as in Scope. The runbook section records the apply and says `service_image` comes from a CI digest. No other AGENTS.md sentence changes. Prettier may reflow the header table.
