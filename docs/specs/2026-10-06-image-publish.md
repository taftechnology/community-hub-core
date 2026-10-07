# Spec: Image publish

Slug: image-publish
Status: draft
Architecture refs: §7.3, ADR 0009, AGENTS.md §10. Implements the `image-publish` row. Depends on `docs/specs/2026-10-06-first-running-task.md`, which is on `main`. Staging stays parked.

## Problem

The image that ran the first staging task was built on a laptop and pushed with a person logged in as `ch-admin`. CI builds the same ARM image on every pull request and does not push it. Nothing on `main` publishes a digest that production can later promote. There is no GitHub OpenID Connect role, so a workflow cannot push without a long-lived key.

## Scope

**In**

- An OpenID Connect provider for `https://token.actions.githubusercontent.com` and one IAM role, in the AU cell, created only when `environment` is `staging`.
- The role can push to the existing staging service repository and read that repository's scan findings. It cannot pull image layers, delete an image, change ECS, read a secret, or call KMS.
- A publish job on `main` only. It builds `linux/arm64` with provenance and SBOM attestations off, runs the existing image tests, pushes by the git SHA tag, waits for the basic scan, and fails if `CRITICAL` is greater than 0.
- Pull-request `build-preview` keeps building and testing. It gains the same provenance and SBOM flags so the tested image is a single manifest. It does not push and it does not receive `id-token: write`.
- The role ARN and the registry hostname are GitHub Actions secrets. Neither is committed. Tests keep account `123456789012`.
- The catalogue commit marks this row done. Next is `kms-mrk-replica`. Phase 0 stays 23 rows: 21 done, 1 superseded (`api-au-hostname`), 1 not started.
- The same PR updates the AGENTS.md Stage 3 sentence: a pull request still does not push; a push to `main` publishes the digest. Live Terraform `plan` stays absent. This role is not a plan role.

**Out**

- Unparking staging. `enable_database` stays false. `desired_count` stays 0. `service_image` stays unset in git. The publish does not apply Terraform and does not update a service.
- Production. No prod repository, no prod role, and no prod apply. Production later promotes the digest this job pushed. That promotion is not this chunk.
- `kms-mrk-replica`. `ap-southeast-4` stays disabled.
- A live Terraform `plan` in CI, an apply role, or any permission outside the list below.
- Deleting an image from CI, including one that later scans as `CRITICAL`. The role has no delete action. A person deletes with `ch-admin` if a bad tag must go.
- Changing the Dockerfile, the base-image pin, or the image tests' assertions.
- A new GitHub Action. The job uses the AWS CLI on `ubuntu-24.04-arm` and the workflow's OpenID Connect token.
- A NAT gateway, a load balancer, or an interface endpoint.
- An ADR. `architecture.md` is not changed.

## Behaviour

### Who applies

The human applies the AU cell from this branch, with both var files, the gitignored file last, profile `ch-admin`. The agent does not run `terraform apply`, `docker push`, or an AWS command.

The apply adds three resources and changes nothing else: the OpenID Connect provider, the role, and the role policy. The database, the cluster, the service, and the task definitions stay absent. A following plan shows no changes.

The human then creates two GitHub Actions secrets on this repository. The values are not written into the repo, the plan, the tests, or the runbook.

| Secret              | Value                                                        |
| ------------------- | ------------------------------------------------------------ |
| `ECR_PUSH_ROLE_ARN` | The role ARN                                                 |
| `ECR_REGISTRY`      | The registry hostname, with no repository path and no scheme |

The pull request does not need those secrets. Its checks do not assume the role. The human sets both secrets before merging, so the merge push is the first publish.

### Trust

The provider URL is `https://token.actions.githubusercontent.com`. The audience is `sts.amazonaws.com`. `thumbprint_list` stays unset so the provider manages the certificate.

The role trust is `StringEquals` on all three of these, not `StringLike`:

- `token.actions.githubusercontent.com:aud` is `sts.amazonaws.com`
- `token.actions.githubusercontent.com:sub` is `repo:taftechnology/community-hub-core:ref:refs/heads/main`
- `token.actions.githubusercontent.com:job_workflow_ref` is `taftechnology/community-hub-core/.github/workflows/ci.yml@refs/heads/main`

A pull request, a tag, another branch, and any other workflow file cannot assume the role. The count is `environment == "staging"`. A prod plan has no provider and no role.

### Permissions

`ecr:GetAuthorizationToken` is on `*`. That action has no resource.

These actions are on the staging service repository ARN only:

- `ecr:BatchCheckLayerAvailability`
- `ecr:InitiateLayerUpload`
- `ecr:UploadLayerPart`
- `ecr:CompleteLayerUpload`
- `ecr:PutImage`
- `ecr:DescribeImages`
- `ecr:DescribeImageScanFindings`

No other action. No `ecr:BatchGetImage`, no `ecr:BatchDeleteImage`, no `ecs:*`, no `secretsmanager:*`, no `kms:*`, no `iam:*`, no `s3:*`.

### Publish job

The job runs on `ubuntu-24.04-arm` only when `github.event_name == 'push'` and `github.ref == 'refs/heads/main'`. Its permissions are `contents: read` and `id-token: write`. It does not have `pull-requests: write`.

If either secret is empty, the job fails before an AWS call.

The build matches the pull-request build, plus the flags that keep a single manifest:

```bash
docker build --platform linux/arm64 --provenance=false --sbom=false -f apps/api/Dockerfile -t community-hub-api:local .
```

`RUN_IMAGE_TESTS=1` runs `src/image.test.ts` against that local image. A failed test does not push.

The tag is the full `github.sha`. The repository name in the workflow is `ch-staging/service`. The hostname comes from `ECR_REGISTRY`. The login and the push use the secret so the log masks the hostname. The job does not echo the role ARN or the account id.

The push is not forced. The repository is already `IMMUTABLE` with scan-on-push. A re-run of a commit that already has a tag fails on that tag and does not overwrite it.

After the push, the job waits until the basic scan is complete and reads `findingSeverityCounts`. The job fails when the `CRITICAL` count is missing or greater than 0. `HIGH` does not fail the job. The first running task shipped with 8 HIGH. This chunk does not raise that bar and does not waive a critical finding.

A failed scan does not deploy anything. Staging is parked either way. The tag remains. The role cannot delete it.

The job summary records the digest and the severity counts. It does not record the registry hostname, the role ARN, or the account id.

### Pull requests

`build-preview` adds `--provenance=false --sbom=false` and still does not log in or push. It has no `id-token: write`. A fork or a branch cannot publish.

## Data

No new table and no new column. The image is built from the repository. It contains no tenant data, no password, and no secret. The GitHub-hosted runner is not in Australia. That is allowed because the build has no personal data. The registry is the existing repository in `ap-southeast-2`. The image is not replicated.

## Rules touched

Residency. The pushed image is stored in `ap-southeast-2`. The job does not copy a database, a log, or a key. The role cannot read secrets or call KMS.

Secrets. The role ARN and the registry hostname stay in GitHub Actions secrets. The committed workflow names the secrets and does not contain a 12-digit account id. Tests use `123456789012`.

Tenancy, children, and encryption. No query, no public path, and no new encrypted column.

## Contracts

| Contract      | Value                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Provider      | `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`, staging cell only |
| Trust         | This repository, `refs/heads/main`, and `.github/workflows/ci.yml` only                        |
| Push          | `ch-staging/service`, tag is the full git SHA, immutable                                       |
| Scan          | Basic scan on push. The job fails on `CRITICAL`.                                               |
| Secrets       | `ECR_PUSH_ROLE_ARN` and `ECR_REGISTRY`. Not committed.                                         |
| Staging flags | `enable_database` false, `desired_count` 0, no `service_image`, no `enable_kms_endpoint`       |

## Cost

No new hourly resource. The OpenID Connect provider and the IAM role have no charge.

The registry already exists. Empty, it has no monthly charge. After the first push, ECR storage is about USD 0.10 per GB-month. The lifecycle policy already keeps the 10 newest tagged images. This line stays under USD 1 a month. It is not in the parked USD 6.30 figure, which counted an empty repository. The budget stays USD 50. No NAT gateway, no load balancer, and no interface endpoint.

## Risks

A trust policy wider than `main` would let a pull request push. The test pins `StringEquals` on the three claims above.

A policy with `ecr:*` or a delete action would let CI remove or pull images. The test lists the allowed actions and fails on any other.

Publishing before the secrets exist fails the first `main` job and pushes nothing. The human sets both secrets before merge.

A critical scan fails the job after the tag exists. The role cannot delete it. The tag is not a release. Staging is not pointed at it.

Leaving the provenance attestation on makes an index that ECR basic scan does not scan. Both the pull-request build and the publish build turn attestations off.

`failure_threshold` on Cloud Map stays. This chunk does not edit that resource.

## Out-of-band

- The second fresh-context review. This chunk adds an IAM role that can write the image the regional service runs. The review that writes this spec does not count.
- The human applies, then creates the two secrets, then merges.
- No account id, role ARN, registry hostname, password, or key in this spec, the plan, the tests, or the job summary.

## Tests

Terraform tests are mocked plans. No test uses a real account id.

- Staging plans one OpenID Connect provider and one role. Prod plans neither.
- The trust policy contains the three `StringEquals` claims above and does not contain `StringLike`.
- The role policy's actions are exactly the list in Permissions. `GetAuthorizationToken` is the only action on `*`. Every other action is on the staging service repository ARN built from account `123456789012`.
- `env/staging.tfvars` still does not contain `service_image` or `enable_kms_endpoint`, and still has `enable_database = false` and `desired_count = 0`.
- The workflow file has a publish job conditioned on a push to `refs/heads/main`, that job has `id-token: write`, `build-preview` does not, the workflow file contains no 12-digit account id, and both builds pass `--provenance=false --sbom=false`.

## Catalogue

The last commit on this branch updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`. `image-publish` is **done** and links this spec. Phase 0 stays 23 rows: 21 done, 1 superseded (`api-au-hostname`), 1 not started. The snapshot's next chunk is `kms-mrk-replica`. That row stays last and not started. The sentence under the Phase 0 table names `kms-mrk-replica`. The Stage 3 sentence is updated as in Scope. No other AGENTS.md sentence changes. Prettier may reflow the header table.
