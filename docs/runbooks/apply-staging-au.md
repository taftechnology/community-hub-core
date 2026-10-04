# Runbook: apply staging-au

This chunk never applies. The steps under **Apply order** are the previous design. Do not run them. A later chunk rewrites this runbook before anyone applies staging.

## Human prerequisites

These come before any apply. They are not steps of the old apply below.

1. Every apply uses an IAM Identity Center administrator profile, never the root user.
2. A budget alert address, for both environments. The address is chosen by the owner. This runbook does not invent one.
3. Register `communityhub-staging.net` in Route 53 at USD 17 a year. Restoration is USD 74. Terraform uses the hosted zone that registration creates. It does not create a second zone.
4. For `communityhub.one`, confirm the registrar is not Cloudflare Registrar, change the name servers to the zone Terraform creates, and confirm the new name servers answer before the old zone is removed.
5. Do not apply the envelope key until `multi_region` is true on that key and the Terraform test is in the module.
6. Before the Melbourne replica chunk, enable `ap-southeast-4`. It is disabled in this account. The replica chunk does not enable it.
7. After apply, confirm the RDS alarm SNS email subscription. Until that confirmation, alarms are visible in the console only and email does not arrive.
8. Activate the `environment` cost-allocation tag after it appears. The tag can take up to 24 hours to appear and up to 24 hours more to activate.
9. Apply again with `enable_budgets = true`.

## Do not apply the steps below

The current apply order, the connector image, the tunnel token, the broker tunnel, and the feature-flag table are the previous design (a Cloudflare zone, Regional Services, a tunnel, Hyperdrive, a connector, and a broker). They must not be applied. They stay here so a reader can see what was withdrawn. ADR 0009 superseded them. They are not safe to run.

## Preconditions

- AWS account in `ap-southeast-2` and a Cloudflare account.
- Dedicated staging zone registered (not `communityhub.one`). Confirm the zone plan can set Regional Services = Australia.
- Terraform `~> 1.11` locally.
- No production data anywhere near this account.

## Apply order

1. **Bootstrap** with local state, then migrate into the bucket:

   ```bash
   cd infra/bootstrap
   terraform init
   terraform apply -var-file=env/staging.tfvars
   terraform init -backend-config=backend/staging.hcl -migrate-state
   ```

   The state bucket and KMS key have `prevent_destroy = true`. A `destroy` of bootstrap after migration deletes every root's state. Do not.

2. **Global staging zone**

   ```bash
   cd infra/global
   terraform init -backend-config=backend/staging.hcl
   terraform apply -var-file=env/staging.tfvars
   ```

   Pass the resulting `zone_id` into `infra/regions/au/env/staging.tfvars`.

3. **AU cell, flags off**

   ```bash
   cd infra/regions/au
   terraform init -backend-config=backend/staging.hcl
   terraform apply -var-file=env/staging.tfvars
   ```

   `enable_hyperdrive = false` and `enable_regional_hostnames = false` on this first apply. Cloudflare tests the Hyperdrive origin with a real connection; the tunnel and RDS are not ready to be that origin yet.

   A plan diff on `aws_kms_key.storage`'s policy means the live policy differs from the AWS default. Stop and report. Do not overwrite it.

4. **Application role** (when `packages-db` exists): create the non-`BYPASSRLS` role via SQL. Not Terraform.

5. **Re-apply Hyperdrive** with `enable_hyperdrive = true` and `hyperdrive_origin_password` set (sensitive). Do not log or echo it.

6. **Regional hostname** after the first regional Worker custom domain: Wrangler creates the DNS record. Then set `enable_regional_hostnames = true` and re-apply. Terraform must not create a competing DNS record.

## `cloudflared` image

The ECS task pins `cloudflared` **by digest**. Anonymous Docker Hub pulls from Fargate fail under rate limits. Prefer an **ECR pull-through cache** for `docker.io/cloudflare/cloudflared` and point `cloudflared_image` at that URI, still digest-pinned.

## Tunnel token

Top-tier secret. It sits in Secrets Manager and in Terraform state (KMS-encrypted in `ap-southeast-2`). Never a task environment variable.

**Rotation:** create a new tunnel (or rotate the token in Zero Trust), write the new token to Secrets Manager, force a new ECS deployment, confirm the expected connector is `HEALTHY`, then revoke the old token.

**Unexpected connector:** alert when a connector registers against this tunnel that is not the ECS service. That is the staging impersonation path in ADR 0003.

## Envelope key and broker tunnel

The AU apply creates the envelope key (`prevent_destroy`, `depends_on` the task role), the KMS interface endpoint (about US$7–8 per month from this apply), the broker security group, the task role, and the broker tunnel plus its secret.

If the first apply fails with an invalid principal, the key was created before `aws_iam_role.task`. The module sets `depends_on`. Do not remove it to make a plan look simpler.

The flag-off apply creates the ECR repository `${name}/kms-broker` and no task. From a clean checkout of the merged commit:

1. Build `apps/kms-broker` with `org.opencontainers.image.revision` set to that SHA, push it to that repository, and set `kms_broker_image` to the `@sha256:` digest. `cloudflared` stays on the Docker Hub digest.
2. Set `enable_kms_broker_tasks`.
3. Apply. If that apply rejects the loopback service, stop and report. The service is HTTP to `127.0.0.1:8080`, not the tunnel's catch-all ingress.
4. Replace `REPLACE_AFTER_APPLY` in `apps/api` with the Workers VPC service id.
5. Deploy `apps/api`.

The live unwrap is `api-au-hostname`. Do not apply prod from this runbook.

The broker tunnel token rotates the same way as the connector token, and it is a different secret (`<name>/kms-broker-tunnel-token`). Revoking the connector token does not rotate the broker token.

Do not apply prod from this runbook.

## Feature flags

| Flag                        | First apply | Later                                    |
| --------------------------- | ----------- | ---------------------------------------- |
| `enable_hyperdrive`         | `false`     | `true` after the application role exists |
| `enable_regional_hostnames` | `false`     | `true` after Wrangler custom domain DNS  |

## Never

- Apply `environment = "prod"` from this runbook.
- `terraform destroy` bootstrap after state has been migrated.
- Print `tunnel_token` or `hyperdrive_origin_password` in CI, logs, or a plan comment.

## Park and unpark

These are the staging rules for the Sydney runtime. They are not steps of the old apply.

Parking staging sets the task count to zero and deletes the staging database. A stopped database still bills for storage, and AWS starts it again after 7 days, so a stop is not parking. A VPC link with no traffic for 60 days becomes `INACTIVE`. Unparking waits until that link is `AVAILABLE`, then creates the database again. Before the task starts, run the bootstrap, then the migrations, then the role-password procedure, in that order.

## Change a database role

When a role's password changes, an operator runs `ALTER ROLE` for that role. The password comes from the secret's current version. This procedure does not record the password, the secret ARN, or a connection string. The master user is used only for bootstrap and for `ALTER ROLE`. There is no rotation function.

## Restore drill

Quarterly, and only against staging. Restore the staging database to a new instance from point-in-time recovery. Record the time taken against the 4-hour target. Then delete the restored instance, because it bills by the hour. This drill does not restore production. Reading `SHOW max_connections` belongs to the first staging apply, not to this drill.
