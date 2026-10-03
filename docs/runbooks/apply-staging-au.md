# Runbook: apply staging-au

This chunk never applies. A human runs these steps later, with AWS and Cloudflare credentials, against **staging only**. Never apply prod from this runbook.

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

The flag-off apply creates the ECR repository `${name}/kms-broker` and no task. From a clean checkout of the merged commit, follow this order (still without doing it in this chunk):

1. Push the broker image.
2. Set `enable_kms_broker_tasks`.
3. Apply.
4. Replace `REPLACE_AFTER_APPLY` in `apps/api` with the Workers VPC service id.
5. Deploy `apps/api`.

The live unwrap is `api-au-hostname`, not a step this runbook performs. If that apply rejects the loopback service, stop and report. Do not apply prod from this runbook.

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
