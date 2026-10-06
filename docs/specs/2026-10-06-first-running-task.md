# Spec: First running task

Slug: first-running-task
Status: draft
Architecture refs: §7.3, ADR 0009. Implements the `first-running-task` row. Depends on `docs/specs/2026-10-06-db-ops-task.md`, which is on `main` before this image is built. `docs/specs/2026-10-05-staging-base.md` is not edited.

## Problem

Staging is parked. `enable_database` is false, `desired_count` is 0, and `service_image` is null, so there is no database and no task. Health on the tenant hostname returns 500 because Cloud Map has no instances. The database round trip, the KMS round trip, the VPC link path, the `/tmp` write, the probe, `SHOW max_connections`, the deploy and steady-traffic 5xx counts, and a run with the KMS endpoint on have not been recorded against a running task.

## Scope

**In**

- Unpark staging for the proofs: `enable_database = true` and `desired_count = 1` in the committed staging tfvars. The database, its storage, the RDS-managed master secret, and the four RDS alarms come back. The topic, the email subscription, the hostname alarm, and the budget stay.
- The image is built from the merged `main` that contains `db-ops-task`. `service_image` is set only in the gitignored tfvars.
- Bootstrap and `ALTER ROLE` run as the ops task from that chunk, not as a person in a master session.
- The proofs below, recorded in `docs/runbooks/apply-staging-au.md`.
- Re-park. The last Terraform commit sets `enable_database = false` and `desired_count = 0`. The person sets `service_image` back to null in the gitignored file and applies. The runbook records that apply and a following plan with no changes.
- The catalogue commit marks this row done. Next is `image-publish`. Phase 0 stays 23 rows: 20 done, 1 superseded (`api-au-hostname`), 2 not started.

**Out**

- `image-publish`. CI does not log in, push, or gain an IAM role or an OIDC provider.
- `kms-mrk-replica`. `ap-southeast-4` stays disabled.
- `db-ops-task`. This chunk does not add the ops task definition, the bootstrap program, or the `CMD` change.
- Production. This runbook does not apply `environment = "prod"`.
- The password re-read, pooled checkout, and a startup check of the database or KMS. `GET /health` does not open a database connection or call KMS. Those open items stay open.
- A product journal, a product table, or a tenant query.
- Changing `failure_threshold` on the Cloud Map service. It is create-only. Validate warns that it is deprecated. It stays.
- Raising the budget.
- ECS Exec. It stays off.
- Opening port 8080 to the internet.
- A NAT gateway, a load balancer, or a second interface endpoint.
- Leaving the database or the task running after the proofs.

## Behaviour

### Who applies

The human applies. The agent does not run `terraform apply`, `docker push`, or an AWS command. Every apply uses the `ch-admin` profile, never the root user. Both var files are passed, the gitignored file last.

`service_image` contains the account id in the registry hostname. It is never committed. The runbook records the image digest and the scan result, not the registry hostname.

### Image

A person builds from a clean checkout of the merged `main` that contains `db-ops-task`, for `linux/arm64`. `RUN_IMAGE_TESTS=1` passes against that exact local image before the push. The push uses `ch-admin` and the existing repository. Tags are immutable and scan-on-push is already on. CI does not do this push.

If the scan reports a critical finding, stop. Do not set `service_image`. Do not apply the task.

The committed staging file does not gain a `service_image` line. Tests that need a digest keep using account `123456789012`.

Command overrides in the proofs below pass `command` only. They do not set `entryPoint`. That works because `db-ops-task` replaced `ENTRYPOINT` with `CMD`.

### Order

1. Commit `enable_database = true` and `desired_count = 1`. Apply with no `service_image`. That recreates the database and does not create the cluster, the task definition, the service, or the ops task definition.
2. Put the digest URI in the gitignored tfvars. Apply again. This creates the service at count 1 and the ops task definition.
3. Read the VPC link status. If it is `INACTIVE`, wait until it is `AVAILABLE`. A failed health check before that is not a fault in the task.
4. Run the ops task once: the ops task definition, command `["node", "/app/db-bootstrap.js"]`, the task security group, the staging public subnet, and a public address. Exit 0. Stdout is the integer from `SHOW max_connections` and nothing else. Do not run the probe until this exits 0.
5. Run the proofs. Then run the endpoint proof, and apply once more so the endpoint is gone.
6. Commit `enable_database = false` and `desired_count = 0`. Set `service_image` to null in the gitignored file. Apply. Record that apply. A following `terraform plan` shows no changes. `enable_kms_endpoint` is still false.

### Proofs

Recorded against the apply that started the task, except the endpoint proof and the re-park, which name their own applies. Redact the account id, the hosted zone id, the alarm email, every key ARN, every secret ARN, every password, every task address, and every VPC endpoint id.

1. `GET /health` on the tenant hostname returns 200. Cloud Map has one healthy instance. The earlier empty-map result was 500, not 503. A 500 during a deploy counts as a 5xx from that cause.
2. The live security-group rules match the parked set, plus inbound TCP 8080 on the task group from the VPC link group. No other new rule.
3. A one-off task, same image, command that writes one file under `/tmp` and exits 0. The service's `desired_count` stays 1. ECS Exec stays off. The evidence is the exit code.
4. The probe is a one-off task: container `service`, command `["node", "/app/probe.js"]`, the staging public subnet, the task security group, and a public address. Stdout is `pass`. Stderr is empty. Exit code is 0. This is the database round trip and the KMS round trip, with the endpoint off.
5. `SHOW max_connections` is the ops task's stdout from step 4 of the order. The evidence is that integer and nothing else. There is no master session.
6. Rolling deploy of the same task definition. Count 5xx responses to `GET /health` on the tenant hostname from the start of the deployment until the new task is healthy. No body, no query string, no personal data.
7. Steady traffic: 60 requests over 60 seconds, `GET /health` on the tenant hostname, same restrictions. Record the 5xx count. That count confirms `keepAliveTimeout` 65000 and `requestTimeout` 30000. Change those two numbers only when the count is not zero and the log shows a timeout. Otherwise leave them. A change is one commit, and the steady count is run again.
8. Hostname alarm. API Gateway always sets the hostname header, so the public hostname cannot fire this alarm. A one-off task uses both the task security group and the VPC link security group, in the staging public subnet, with a public address, and fetches the service task's private address on port 8080 once, without the hostname header. Then that task is stopped. The service log records `missing_hostname_header`. The alarm enters ALARM. The evidence is the reason and the alarm state, not the address. Port 8080 is not opened to the internet.
9. Set `enable_kms_endpoint` true for one apply, run the probe again, and record `pass`. The probe's `GenerateDataKey` event in CloudTrail has a `vpcEndpointId`. The evidence says present. It does not record the id. Then apply with the flag false. The endpoint and its security group are destroyed.
10. The re-park apply and the following plan. The plan shows no changes. The database, the service, and the ops task definition are gone. The topic, the subscription, the hostname alarm, and the budget remain.

### What stays parked-shaped

`enable_budgets` stays true. `turnstile_secret_arn` stays null. Staging stays `FARGATE_SPOT`. A Spot interruption during a proof is retried. Staging is not switched to `FARGATE`. Deletion protection stays false and backup retention stays 0. Production still refuses `enable_database` false, and a set image with the database off still fails the plan. After step 6 the committed file matches the parked cell again.

## Data

No new table and no new column. The ops task creates roles and empty schemas on the new instance and drops them again when the re-park deletes the instance. The probe's `SELECT 1` is not a tenant query. `SHOW max_connections` reads a server setting. The metric filter still matches `reason` only.

## Rules touched

Residency. The task, the database, the logs, and the keys stay in `ap-southeast-2`. The KMS endpoint, while it exists, is in that VPC. CloudTrail for that call stays in the same account and region. The evidence does not copy the endpoint id out. The budget stays on the `us-east-1` billing endpoint ADR 0010 already allows. The image build pulls a public base image and copies no tenant data.

Children. No new public path.

Tenancy. No query of an `app` row.

Encryption. Storage encryption stays on, with the storage key. The probe's data key is compared and zeroed in the task. The evidence does not record the key ARN.

Secrets. The registry hostname, the passwords, and the secret ARNs stay out of git and out of the evidence. Bootstrap runs inside the ops task.

Rule 5. The steady and deploy requests carry no body, no query string, and no personal data. The hostname alarm proof does not record the task address. The endpoint proof does not record the endpoint id.

## Contracts

| Contract              | Value                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------- |
| `enable_database`     | True for the proofs, then false in the re-park commit. Production still refuses false. |
| `desired_count`       | 1 for the proofs, then 0 in the re-park commit. Ignored while `service_image` is null. |
| `service_image`       | Gitignored tfvars only. Digest URI during the proofs, then null.                       |
| `enable_kms_endpoint` | Committed value stays false. True for one apply, then false again.                     |
| `enable_budgets`      | Stays true. Limit stays USD 50. Filter stays `user:environment$staging`.               |
| Ops task              | Runs `db-bootstrap.js` before the probe. Stdout is `SHOW max_connections`.             |
| Task network          | Staging uses the first public subnet, a public address, and the task security group.   |
| Task ingress          | TCP 8080 from the VPC link group, and only when the image is set.                      |
| Probe                 | One-off task. Command override only. Not the container health check.                   |

## Cost

Figures are the ones already approved. Staging-base's parked month is USD 6.30. Foundations prices the KMS endpoint at about USD 9.49 a month for one zone. The parent task line is USD 8.64, the public address USD 3.65, and one Cloud Map registration USD 0.10. Staging uses Fargate Spot, so the task line is not higher than USD 8.64.

Running month, while the proofs are in progress and the endpoint is off:

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

The lasting result after the re-park is the parked month, USD 6.30. The database, the task, the public address, and the Cloud Map registration are gone.

The budget stays USD 50. The 80 percent alert is USD 40, so the running window can alert. This chunk does not change the budget. Turnstile stays unset.

The endpoint proof adds the one-zone interface endpoint for the hours it exists, at the USD 9.49 monthly rate, and then removes it. It is not part of either monthly total above.

One-off tasks for `/tmp`, the probe, the ops task, and the alarm are billed per second and stay outside the monthly totals. No NAT gateway, no load balancer, and no second interface endpoint.

## Risks

The VPC link may be `INACTIVE`. Health is not judged until it is `AVAILABLE`.

The probe before the ops task fails on the database roles. The ops task exits 0 first.

A committed `service_image` would put the account id in git. The variable stays in the gitignored file.

Applying the image while the database is off fails the existing precondition, and it also plans no ops task definition. The database apply comes first.

Deploy 5xx responses include the empty-Cloud-Map 500. That count is not by itself a failed task.

Leaving the KMS endpoint on adds about USD 9.49 a month. The flag returns to false before the re-park.

Forgetting the re-park leaves the USD 40.50 month in place. The last Terraform commit and the null image are both required. The following plan must show no changes.

A critical image scan stops the chunk. There is no waiver in this spec.

`failure_threshold` stays. Editing it would replace the Cloud Map service again.

## Out-of-band

- The second fresh-context review. This chunk unparks the database, starts the task, runs the ops task, and runs the probe against KMS. The review that writes this spec does not count.
- The human builds, tests, pushes, and applies.
- The human runs the ops task. A person does not connect as master.
- No password, alarm email, real account id, hosted zone id, key ARN, secret ARN, or VPC endpoint id in this spec, the plan, the tests, the runbook evidence, or the logs.

## Tests

Terraform tests are mocked plans. No test uses a real account id.

- Staging with `enable_database` true, `desired_count` 1, and a synthetic digest: the plan has the database, the service at count 1, the ops task definition, a public address, and the task on the staging public subnet. The KMS endpoint is absent.
- Staging with `enable_database` true, `desired_count` 1, and `service_image` null: the plan has the database, no ECS service, and no ops task definition.
- The re-park tfvars set `enable_database` false and `desired_count` 0, and have no `service_image` line. The plan has no database and no ECS service.
- Production with `enable_database` false still fails.
- `enable_database` false with a digest set still fails.
- `enable_kms_endpoint` true plans the endpoint. The committed staging file does not set it.

## Catalogue

The last commit on this branch updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`. `first-running-task` is **done** and links this spec. Phase 0 stays 23 rows: 20 done, 1 superseded (`api-au-hostname`), 2 not started. The snapshot's next chunk is `image-publish`. `kms-mrk-replica` stays last.
