# Spec: First running task

Slug: first-running-task
Status: draft
Architecture refs: §7.3, ADR 0009. Implements the `first-running-task` row. `docs/specs/2026-10-05-staging-base.md` assigned this scope and is not edited.

## Problem

Staging is parked. `enable_database` is false, `desired_count` is 0, and `service_image` is null, so there is no database and no task. Health on the tenant hostname returns 500 because Cloud Map has no instances. The database round trip, the KMS round trip, the VPC link path, the `/tmp` write, the probe, `SHOW max_connections`, the deploy and steady-traffic 5xx counts, a run with the KMS endpoint on, and the hostname alarm have not been recorded against a running task.

## Scope

**In**

- Unpark staging: `enable_database = true` in the committed staging tfvars. The database, its storage, the RDS-managed master secret, and the four RDS alarms come back. The topic, the email subscription, the hostname alarm, and the budget stay.
- After the instance is available, a person runs `packages/db/sql/bootstrap.sql` as the RDS master, then the existing `ALTER ROLE` procedure for `app`, `identity`, and `platform`. A new instance has none of those roles. `ALTER ROLE` alone cannot create them.
- One task. `desired_count = 1` in the committed staging tfvars. `service_image` is set only in the gitignored tfvars, to the digest URI of an image a person pushed. The service plans only when that value is set.
- The proofs below, recorded in `docs/runbooks/apply-staging-au.md`.
- The last commit marks this row done. Next is `image-publish`. Phase 0 becomes 22 rows: 19 done, 1 superseded (`api-au-hostname`), 2 not started.

**Out**

- `image-publish`. CI does not log in, push, or gain an IAM role or an OIDC provider.
- `kms-mrk-replica`. `ap-southeast-4` stays disabled.
- Production. This runbook does not apply `environment = "prod"`.
- The password re-read, pooled checkout, and a startup check of the database or KMS. `GET /health` does not open a database connection or call KMS. Those open items stay open.
- A product journal, a product table, or a tenant query. Bootstrap creates the roles and the empty schemas. It does not apply the journal.
- Changing `failure_threshold` on the Cloud Map service. It is create-only. Validate warns that it is deprecated. It stays.
- Raising the budget. The alert may fire. That is the gap foundations already accepted.
- ECS Exec. It stays off.
- Opening port 8080 to the internet. The task ingress stays the VPC link group only.
- A NAT gateway, a load balancer, or a second interface endpoint.

## Behaviour

### Who applies

The human applies. The agent does not run `terraform apply`, `docker push`, or an AWS command. Every apply uses the `ch-admin` profile, never the root user. Both var files are passed, the gitignored file last.

`service_image` contains the account id in the registry hostname. It is never committed. The runbook records the image digest and the scan result, not the registry hostname.

### Image

A person builds from a clean checkout of a merged `main` commit, for `linux/arm64`. `RUN_IMAGE_TESTS=1` passes against that exact local image before the push. The push uses `ch-admin` and the existing repository. Tags are immutable and scan-on-push is already on. CI does not do this push.

If the scan reports a critical finding, stop. Do not set `service_image`. Do not apply the task.

The committed staging file does not gain a `service_image` line. Tests that need a digest keep using account `123456789012`.

### Order

1. Commit `enable_database = true` and `desired_count = 1`. Apply with no `service_image`. That recreates the database and does not create the cluster, the task definition, or the service. `desired_count` is ignored while the image is null.
2. When the instance is available, run bootstrap as master, then `ALTER ROLE` for the three login roles. The passwords come from the current secret versions. They are not written into the repo, the runbook, a log, or Terraform.
3. Read the VPC link status. If it is `INACTIVE`, wait until it is `AVAILABLE`. A failed health check before that is not a fault in the task.
4. Put the digest URI in the gitignored tfvars. Apply again. This creates the cluster, the task definition, the service at count 1, Cloud Map registration, the task's public address, and inbound TCP 8080 on the task group from the VPC link group.
5. Run the proofs. Then run the endpoint proof, and apply once more so the endpoint is gone.
6. A final `terraform plan` shows no changes. The committed flag `enable_kms_endpoint` is still false.

### Proofs

Recorded against the apply that started the task, except the endpoint proof, which names its own apply. Redact the account id, the hosted zone id, the alarm email, every key ARN, every secret ARN, every password, and every task address.

1. `GET /health` on the tenant hostname returns 200. Cloud Map has one healthy instance. The earlier empty-map result was 500, not 503. A 500 during a deploy counts as a 5xx from that cause.
2. The live security-group rules match the parked set, plus inbound TCP 8080 on the task group from the VPC link group. No other new rule.
3. A one-off task, same image, command that writes one file under `/tmp` and exits 0. The service's `desired_count` stays 1. ECS Exec stays off. The evidence is the exit code.
4. The probe is a one-off task: container `service`, command `["node", "/app/probe.js"]`, the staging public subnet, the task security group, and a public address. Stdout is `pass`. Stderr is empty. Exit code is 0. This is the database round trip and the KMS round trip, with the endpoint off.
5. In the same master session as `ALTER ROLE`, `SHOW max_connections`. The evidence is that integer and nothing else.
6. Rolling deploy of the same task definition. Count 5xx responses to `GET /health` on the tenant hostname from the start of the deployment until the new task is healthy. No body, no query string, no personal data.
7. Steady traffic: 60 requests over 60 seconds, `GET /health` on the tenant hostname, same restrictions. Record the 5xx count. That count confirms `keepAliveTimeout` 65000 and `requestTimeout` 30000. Change those two numbers only when the count is not zero and the log shows a timeout. Otherwise leave them. A change is one commit, and the steady count is run again.
8. Hostname alarm. API Gateway always sets the hostname header, so the public hostname cannot fire this alarm. A one-off task uses both the task security group and the VPC link security group, in the staging public subnet, with a public address, and fetches the service task's private address on port 8080 once, without the hostname header. Then that task is stopped. The service log records `missing_hostname_header`. The alarm enters ALARM. The evidence is the reason and the alarm state, not the address. Port 8080 is not opened to the internet.
9. Set `enable_kms_endpoint` true for one apply, run the probe again, and record `pass`. Then apply with the flag false. The endpoint and its security group are destroyed. The lasting plan does not contain them.

### What stays parked-shaped

`enable_budgets` stays true. `turnstile_secret_arn` stays null. Staging stays `FARGATE_SPOT`. A Spot interruption during a proof is retried. Staging is not switched to `FARGATE`. Deletion protection stays false and backup retention stays 0. Production still refuses `enable_database` false, and a set image with the database off still fails the plan.

## Data

No new table and no new column. Bootstrap creates roles and empty schemas on the new instance. The probe's `SELECT 1` is not a tenant query. `SHOW max_connections` reads a server setting. The metric filter still matches `reason` only.

## Rules touched

Residency. The task, the database, the logs, and the keys stay in `ap-southeast-2`. The KMS endpoint, while it exists, is in that VPC. The budget stays on the `us-east-1` billing endpoint ADR 0010 already allows. The image build pulls a public base image and copies no tenant data.

Children. No new public path.

Tenancy. No query of an `app` row.

Encryption. Storage encryption stays on, with the storage key. The probe's data key is compared and zeroed in the task. The evidence does not record the key ARN.

Secrets. The registry hostname, the passwords, and the secret ARNs stay out of git and out of the evidence.

Rule 5. The steady and deploy requests carry no body, no query string, and no personal data. The hostname alarm proof does not record the task address.

## Contracts

| Contract              | Value                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- |
| `enable_database`     | True in committed staging tfvars. Production still refuses false.                       |
| `desired_count`       | 1 in committed staging tfvars. Ignored while `service_image` is null.                   |
| `service_image`       | Gitignored tfvars only. Digest URI. Null plans no cluster, task definition, or service. |
| `enable_kms_endpoint` | Committed value stays false. True for one apply, then false again.                      |
| `enable_budgets`      | Stays true. Limit stays USD 50. Filter stays `user:environment$staging`.                |
| Task network          | Staging uses the first public subnet, a public address, and the task security group.    |
| Task ingress          | TCP 8080 from the VPC link group, and only when the image is set.                       |
| Probe                 | One-off task. Not the service command. Not the container health check.                  |

## Cost

Figures are the ones already approved. Staging-base's parked month is USD 6.30. Foundations prices the KMS endpoint at about USD 9.49 a month for one zone. The parent task line is USD 8.64, the public address USD 3.65, and one Cloud Map registration USD 0.10. Staging uses Fargate Spot, so the task line is not higher than USD 8.64.

Lasting month, endpoint off:

| Line                      |   USD |
| ------------------------- | ----: |
| Parked cell               |  6.30 |
| Database instance         | 18.25 |
| 20 GB storage             |  2.76 |
| RDS master secret         |  0.40 |
| Four RDS alarms           |  0.40 |
| Task, at the approved cap |  8.64 |
| Public IPv4               |  3.65 |
| Cloud Map registration    |  0.10 |
| Total                     | 40.50 |

The budget stays USD 50. The 80 percent alert is USD 40, so a full month can alert. This chunk does not change the budget. Turnstile stays unset, so its USD 0.40 is not added.

The endpoint proof adds the one-zone interface endpoint for the hours it exists, at the USD 9.49 monthly rate, and then removes it. It is not part of the lasting total.

One-off tasks for `/tmp`, the probe, and the alarm are billed per second and stay outside the monthly total. No NAT gateway, no load balancer, and no second interface endpoint.

## Risks

The VPC link may be `INACTIVE`. Health is not judged until it is `AVAILABLE`.

`ALTER ROLE` on a missing role fails. Bootstrap runs first.

A committed `service_image` would put the account id in git. The variable stays in the gitignored file.

Applying the image while the database is off fails the existing precondition. The database apply comes first.

Deploy 5xx responses include the empty-Cloud-Map 500. That count is not by itself a failed task.

Leaving the KMS endpoint on adds about USD 9.49 a month and can push the tagged spend through the budget. The flag returns to false in this chunk.

A critical image scan stops the chunk. There is no waiver in this spec.

`failure_threshold` stays. Editing it would replace the Cloud Map service again.

## Out-of-band

- The second fresh-context review. This chunk unparks the database, starts the task, and runs the probe against KMS. The review that writes this spec does not count.
- The human builds, tests, pushes, and applies.
- The human runs bootstrap and `ALTER ROLE`.
- No password, alarm email, real account id, hosted zone id, key ARN, or secret ARN in this spec, the plan, the tests, the runbook evidence, or the logs.

## Tests

Terraform tests are mocked plans. No test uses a real account id.

- Staging with `enable_database` true, `desired_count` 1, and a synthetic digest: the plan has the database, the service at count 1, a public address, and the task on the staging public subnet. The KMS endpoint is absent.
- Staging with `enable_database` true, `desired_count` 1, and `service_image` null: the plan has the database and no ECS service.
- The committed staging tfvars set `enable_database` true and `desired_count` 1, and have no `service_image` line.
- Production with `enable_database` false still fails.
- `enable_database` false with a digest set still fails.
- `enable_kms_endpoint` true plans the endpoint. The committed staging file does not set it.

## Catalogue

The last commit on this branch updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`. Phase 0 becomes 22 rows: 19 done, 1 superseded (`api-au-hostname`), 2 not started.

`first-running-task` is **done** and links this spec. The snapshot's next chunk is `image-publish`. `kms-mrk-replica` stays last.
