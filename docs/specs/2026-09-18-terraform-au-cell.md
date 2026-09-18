# Spec: Terraform AU cell foundations

Slug: `terraform-au-cell`
Status: approved (2026-09-18, Abdus Salam)
Architecture refs: §6.3, §7.2–7.5, §8.1, §12.2, §22, §23.1–23.3; D2, D3; principle 9; ADR 0001; ADR 0002 (this PR); ADR 0003 (this PR); AGENTS.md §1, §8, §10

## Problem

Phase 0 has a workspace and a global no-PII gateway. There is no `infra/` tree. Architecture still shows a vendor split (`infra/cloudflare/` vs `infra/regions/au/`) that would share Cloudflare state across future cells and create a Tunnel ↔ Hyperdrive cycle across two applies. CI still promises a live Terraform `plan` that this repository cannot run without cloud credentials. Later chunks must not wait on a live cell: `packages-db` tests against Docker Postgres, not RDS.

## Scope

**In**

- Terraform roots: `infra/bootstrap/`, `infra/global/`, `infra/regions/au/`.
- Shared modules under `infra/modules/` for the resources those roots call (list below). No unused modules.
- Staging tfvars and backend files; prod tfvars and backend files as non-applied stubs that `terraform test` still loads.
- Offline CI: `terraform fmt -check`, `validate`, `tflint`, `terraform test` (`mock_provider`, `command = plan`) after `terraform init -backend=false -lockfile=readonly`. Matrix covers **every root and every module** (`infra/bootstrap`, `infra/global`, `infra/regions/au`, `infra/modules/*`). No live `plan` job.
- Terraform-invariants checker (must-fail fixtures required): every `backend/*.hcl` is `ap-southeast-2`, `encrypt = true`, names a KMS key, and sets `use_lockfile = true`; bootstrap bucket and key declare `prevent_destroy`; no ingress-rule resource targets the connector security group. Comment-stripping so a commented-out correct `region` cannot hide a wrong one.
- ADR 0002 (Terraform roots follow failure domains; Wrangler vs Terraform ownership).
- ADR 0003 (staging-only TLS verification exception on Workers VPC; expiry condition).
- Architecture §8.1 tree, §23.2 delivery, §23.3 testing (PgBouncer contract for `packages-db`).
- AGENTS.md §10: a CI job is present and fail-closed, or absent; Terraform offline checks land with must-fail fixtures; live `plan` stays omitted.
- Runbook stub `docs/runbooks/apply-staging-au.md` for a later human apply, including Tunnel-token rotation and unexpected-connector alert.

**Out** (explicitly)

- Apply of any root. This chunk never creates a live cell.
- Live Terraform `plan` in CI (AWS OIDC / Cloudflare token). Documented in Out-of-band.
- Production apply. Melbourne replica (ap-southeast-4). Multi-region KMS for application keys.
- Switching Hyperdrive to the Access + service-token origin. Workers VPC stays. Production `verify_full` is therefore blocked until Cloudflare ships custom CAs on VPC services, or a later spec changes origin (ADR 0003 expiry).
- S3 buckets (restricted files, Logpush), D1, KV, WAF, Access, SaaS custom hostnames, Queues, Workers for Platforms.
- Worker scripts, routes, bindings (Wrangler owns them). DNS records Wrangler creates for Worker custom domains.
- `auth.au` and `webhooks.au` hostnames (no consumer yet). Empty `ca` / `eu` / `us` Terraform roots.
- Schemas, RLS, application database role SQL (`packages-db`). Tenant data.
- `packages-db` waiting on this chunk, Hyperdrive, or any AWS account.

## Behaviour

### Roots (failure domains)

```
infra/
  modules/
    aws-network          VPC, public subnet (connector), private subnets (RDS), security groups
    aws-rds              empty Postgres, storage encryption, managed master password
    aws-kms-storage      storage KMS key only — not the envelope-wrapping key
    aws-ecs-tunnel       cloudflared on ECS Fargate; token from Secrets Manager
    cf-tunnel            Cloudflare Tunnel
    cf-vpc-service       TCP Workers VPC service → RDS via the tunnel
    cf-hyperdrive        Hyperdrive origin = VPC service; caching disabled
    cf-regional-hostname Regional Services setting only (no DNS record)
    cf-zone              dedicated staging zone (imported or created); not communityhub.one
  bootstrap/             state bucket + KMS + bucket policy; local state then migrated
  global/                staging zone only
    env/staging.tfvars · env/prod.tfvars
    backend/staging.hcl · backend/prod.hcl
  regions/au/            the cell: AWS + AU Cloudflare in one graph
    env/staging.tfvars · env/prod.tfvars
    backend/staging.hcl · backend/prod.hcl
```

Adding `ca` is a new `regions/ca/` with its own state. Australia's state does not change. Global → cell wiring is zone ID and account ID as variables, not `terraform_remote_state`.

**ADR 0002 line:** Wrangler owns Worker scripts, routes and bindings. Terraform owns zones, DNS except records Wrangler creates for Worker custom domains, Regional Services, Tunnel, Hyperdrive, Workers VPC services, and AWS. For Worker custom-domain hostnames Terraform owns only the Regional Services setting.

### Environments

- Staging is a **dedicated Cloudflare zone**. `zone_name` is a tfvars value. **`cf-zone` variable validation** normalises to lowercase, strips a trailing dot, and rejects `communityhub.one` and any subdomain of it. `staging.communityhub.one` and `CommunityHub.one.` are rejected.
- Prod tfvars may name `communityhub.one`. They are never applied in this chunk.
- Roots take an explicit `environment` variable, validated to `staging` or `prod`. Prod-only rules key off it: `cert_verification_mode = "verify_full"`, deletion protection, backup retention.
- Controls are identical across environments (region, private RDS, encryption, no public DB, connector with no inbound). The bill differs: staging uses a small instance class and may turn Multi-AZ, deletion protection and backup retention off; prod (`environment = "prod"`) must set deletion protection and backup retention on.
- **TLS verification is not identical.** Staging may set `cert_verification_mode = "disabled"`. `environment = "prod"` must set `verify_full`. ADR 0003.

### Bootstrap

Creates the S3 bucket and KMS key that `global/backend/staging.hcl` and `regions/au/backend/staging.hcl` point at. Versioning on, encryption required, public access blocked, bucket policy **denies non-TLS requests** (policy body via `jsonencode`, known at plan time). `lifecycle { prevent_destroy = true }` on the state bucket and its KMS key — after state is migrated into this bucket, a careless `destroy` would delete every root's state. `prevent_destroy` is **not** visible to `terraform test`; the invariants checker requires it, with a must-fail fixture. No tenant data. The only root that starts with local state. Runbook: apply once, then `terraform init -migrate-state` into that bucket under its own key. Prod bootstrap is tfvars-only. Backend files set `use_lockfile = true` (S3-native locking; Terraform **1.11+**).

### AU cell graph

Terraform resolves Tunnel token (Cloudflare → ECS) and RDS endpoint (AWS → Hyperdrive) inside one root.

1. **VPC** in `ap-southeast-2`. Connector in a **public subnet with a public IP and no inbound rules**. RDS in private subnets, no public IP.
2. **Egress.** Connector outbound: 7844 and 443 to the internet, 5432 only to the RDS security group. RDS inbound 5432 **only** from the connector security group.
3. **Storage KMS key** in `ap-southeast-2`, rotation enabled, named as storage. Application envelope keys are a later chunk.
4. **RDS Postgres** — encrypted with the storage key, `manage_master_user_password = true` (password never in state), `ca_cert_identifier` pinned to the current ap-southeast-2 RDS CA (`rds-ca-rsa2048-g1` unless AWS has superseded it in-region — pin the identifier, do not leave the default implicit). SSL required (`rds.force_ssl`). Empty: no schemas, no application role. Engine version is a variable (latest supported PostgreSQL in ap-southeast-2; `uuidv7()` is `packages-db`'s problem).
5. **Tunnel.** Cloudflare Tunnel in this cell. Token sits in state (narrowed secret rule) and reaches ECS through **Secrets Manager**, never a plaintext task environment variable. Treat it as a **top-tier secret**: runbook has a rotation procedure and an alert when an unexpected connector registers against the tunnel. `cloudflared` image pinned **by digest**, not a tag (prefer an ECR pull-through cache so Fargate does not hit Docker Hub anonymous limits — runbook line). CloudWatch log group `retention_in_days` **≥ 1** (`0` means never expire and is forbidden). **Execution role** (not task role) may `GetSecretValue` on that one secret, write to that one log group, and `kms:Decrypt` if the secret uses the customer key. **Task role is absent or has no permissions** — `cloudflared` needs none. Connector security group sets **`ingress = []` explicitly** (configured value, assertable; apply also removes hand-added rules).
6. **Workers VPC service** — type `tcp`, `app_protocol = postgresql`, host = RDS **hostname** (not private IP, so a future `verify_full` can match the cert SAN). `cloudflare_connectivity_directory_service` (provider `~> 5.13`).
7. **Hyperdrive** — origin `service_id` of that VPC service; `caching.disabled = true`. Gated by `enable_hyperdrive` (default `false`). Cloudflare tests the origin with a real connection and `;` before the config exists, so the first apply cannot enable it.
8. **Regional hostname** — `au.api.<staging-zone>`, `region_key = au`. Gated by `enable_regional_hostnames` (default `false`). Dashboard docs require a DNS record first; Wrangler creates that record on the first regional Worker custom domain. Do not declare competing DNS records in Terraform.

### Hyperdrive password

`hyperdrive_origin_password` is `sensitive = true`, `default = null`, nullable. A validation / precondition: **if `enable_hyperdrive` is true, the password must be non-null and non-empty.** First apply (flag false) plans with no password. The password is the SQL application role (non-`BYPASSRLS`, §6.3), created later by `packages-db`, not by Terraform. It may live in state because state is KMS-encrypted in `ap-southeast-2` with restricted access — the invariants checker (backend region / encrypt / KMS / `use_lockfile`) is what makes that sentence true. The RDS **master** password never enters state.

### TLS to RDS (Workers VPC)

Keep **Workers VPC**. Do not switch this chunk to Access + service token.

Sources (checked 2026-09-18):

| Claim                                                                                                                    | Where it is stated                                                                                                                                                                                                                                                                                                   | Where it is not                     |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Custom CA upload for Hyperdrive (`ca_certificate_id`, `verify-full`)                                                     | [Hyperdrive SSL/TLS certificates](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)                                                                                                                                                                                   | That page has no Workers VPC caveat |
| `mtls` cannot be used with VPC-service origins; TLS is on the VPC service                                                | [`cloudflare_hyperdrive_config` provider schema](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/hyperdrive_config)                                                                                                                                                              | Hyperdrive TLS page                 |
| `tls_settings.cert_verification_mode`; trusts public CAs and Cloudflare Origin CA; **custom CA upload is not supported** | [Workers VPC services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) and [Connect Hyperdrive via Workers VPC](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database-vpc/) (TLS section: private CA → `verify_ca` or `disabled` until custom CA exists) | Hyperdrive TLS page                 |

Amazon RDS CAs are not public CAs. `verify_full` against the RDS endpoint will fail Hyperdrive's create-time test connection until custom CA exists on VPC services.

**Exception (ADR 0003):** staging may set `cert_verification_mode = "disabled"`. A Tunnel token holder can run their own `cloudflared` pointed at their own Postgres, receive a share of Hyperdrive connections, collect the application-role password, and accept writes. `verify_full` is what defeats a rogue connector (it cannot present a cert signed by the RDS CA). Staging holds synthetic data only. **Production must set `verify_full`.** Cloudflare currently rejects that at create time, so a production apply is blocked until custom CAs ship on Workers VPC services, or a later spec moves production to the Access + service-token origin. That decision is made before real data flows.

This cell does **not** upload the RDS CA to Hyperdrive. Pin the RDS instance CA. RDS still requires SSL. A precondition forbids combining `origin.service_id` with `mtls`.

### CI

For **each root and each module**:

```
terraform init -backend=false -lockfile=readonly
terraform fmt -check
terraform validate
tflint --init && tflint
terraform test
```

- No cloud credentials. Plain `init` (with a backend) is forbidden in CI — it would need AWS. `-lockfile=readonly` fails if the lockfile does not match rather than regenerating it.
- `.terraform.lock.hcl` committed, locked for `linux_amd64` and `darwin_arm64`.
- `.tflint.hcl` pins the AWS ruleset **version**; `tflint --init` must not float. CI passes `GITHUB_TOKEN` so `--init` does not hit unauthenticated GitHub rate limits.
- No live `plan` job in this chunk. A job is present and fail-closed, or absent.
- **Invariants checker** (not `terraform test`): backend region / encrypt / KMS / `use_lockfile`; `prevent_destroy` on bootstrap bucket and key; no ingress-rule resource on the connector SG. Must-fail fixtures include a commented-out correct `region` beside a real wrong one.

### Tests (`terraform test`)

`mock_provider`, `command = plan`. Assert only **configured** values (arguments, `jsonencode` policy documents, AWS provider v6 per-resource `region`). Do not assert provider-computed attributes (`aws_s3_bucket.region`, `data.aws_iam_policy_document.json`) — they are unknown or fake under mocks.

**Happy path**

- Load `env/staging.tfvars` and `env/prod.tfvars` for each root that has them (so prod stubs cannot rot).
- `enable_hyperdrive = false` plans with **no** Hyperdrive password.
- `environment = "staging"` plans with `cert_verification_mode = "disabled"`; `environment = "prod"` requires `verify_full`, deletion protection, backup retention.
- Configured attributes: per-resource `region = "ap-southeast-2"`; RDS `publicly_accessible = false`; storage encrypted; master password managed; Hyperdrive caching disabled when the resource exists; KMS rotation on; connector SG `ingress = []`; `cloudflared` image is a digest; execution-role policy (`jsonencode`) is one secret + one log group (+ optional `kms:Decrypt`); task role empty/absent; deny-non-TLS bucket policy via `jsonencode`.

**`expect_failures`**

- AWS region ≠ `ap-southeast-2` (variable validation).
- Publicly accessible RDS.
- RDS ingress not limited to the connector security group.
- Connector SG `ingress` not `[]`.
- KMS rotation off.
- Hyperdrive caching enabled.
- `enable_hyperdrive = true` with null or empty password.
- Hyperdrive with both `service_id` and `mtls`.
- `zone_name` equal to `communityhub.one`, a case/trailing-dot variant, or a subdomain of it (`cf-zone` variable validation).
- Regional hostname `region_key` ≠ `au`.
- `environment = "prod"` without deletion protection or without backup retention.
- **`environment = "prod"` with `cert_verification_mode = "disabled"`.**

**Invariants checker must-fail fixtures** (not `terraform test`): backend wrong region; `encrypt = false`; no KMS key; no `use_lockfile`; commented-out correct region with a real wrong region; bootstrap missing `prevent_destroy`; an ingress-rule resource targeting the connector SG.

### Apply (not this PR)

Order in `docs/runbooks/apply-staging-au.md`:

1. Bootstrap with local state → migrate state into the bucket.
2. Apply `global/staging`.
3. Apply `regions/au` with `enable_hyperdrive = false` and `enable_regional_hostnames = false`.
4. When `packages-db` exists: create the application role via SQL.
5. Re-apply with `enable_hyperdrive = true` and the real password.
6. After the first regional Worker custom domain: `enable_regional_hostnames = true`.

Also in that runbook: Tunnel-token rotation; alert when an unexpected connector registers on the tunnel; ECR pull-through for `cloudflared` (digest-pinned) so Fargate does not depend on Docker Hub anonymous pulls. Sensitive outputs are marked `sensitive = true` from the start (later live `plan` comments must not print them). Never apply prod in this chunk.

### `packages-db` (this PR only documents it)

`packages-db` does not wait on a live cell. Its CI uses Docker Postgres behind **PgBouncer in transaction mode**, with a must-fail fixture that a session-level `SET app.org_id` bleeds into the next checkout. Live Tunnel → Workers VPC → Hyperdrive is a staging smoke test, not CI.

## Data

No application tables. No classified columns. RDS is empty. Terraform state (after a later apply) holds infrastructure identifiers, the Tunnel token, and — once Hyperdrive is enabled — the application-role password. State is not tenant personal data; it still stays in `ap-southeast-2` under KMS. The backend-residency checker is the enforcement.

## Rules touched

- Residency: AU cell only; Regional Services `region_key = au` on `au.api` when enabled; Terraform state and secrets in `ap-southeast-2`; no personal data in Terraform, logs, or CI.
- Principle 9: no console-only staging/production config — bootstrap is code with local-then-migrated state.
- Secrets: master password managed; Hyperdrive password and Tunnel token may sit in encrypted state; never plaintext in the ECS task definition; Tunnel token is top-tier (rotation + unexpected-connector alert).
- Children, entitlements, consent: none.
- `packages-db` tenancy: `SET LOCAL` only; proven in that chunk against PgBouncer, not against this RDS.

## Contracts

- No API routes, events, ports, or widgets.
- Hyperdrive configuration id is an output of `regions/au` once enabled; Worker bindings remain Wrangler (later `api-au-skeleton`).
- Module names are Terraform modules, not product modules; no `module.manifest.ts`.

## Risks

| Risk                                                                                                                                                                                                                                                                   | Mitigation                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **This code is never applied in this chunk.** Mocked plans catch invariant violations, not provider API errors or wrong Cloudflare assumptions. The first human apply is the first real test and may need a small fix PR.                                              | Stated here so that PR is expected.                                                                                                                                                                             |
| **A Tunnel-token holder can impersonate the database.** With `cert_verification_mode = disabled`, anyone holding the token can run `cloudflared` against their own Postgres, receive Hyperdrive connections, collect the application-role password, and accept writes. | Staging-only (synthetic data). Prod tfvars require `verify_full`; `expect_failures` if they set `disabled`. ADR 0003. Token treated as top-tier secret (Secrets Manager, rotation, unexpected-connector alert). |
| Vendor-split Terraform shares blast radius across cells                                                                                                                                                                                                                | ADR 0002: one cell = one root.                                                                                                                                                                                  |
| Live `plan` job appears and skip-greens without credentials                                                                                                                                                                                                            | Job absent until OIDC/token exist; AGENTS.md: present+fail-closed or absent.                                                                                                                                    |
| First Hyperdrive apply fails origin check                                                                                                                                                                                                                              | `enable_hyperdrive` default false; runbook order.                                                                                                                                                               |
| Regional Services before DNS                                                                                                                                                                                                                                           | `enable_regional_hostnames` default false; after Wrangler custom domain.                                                                                                                                        |
| Connector in a public subnet is attacked                                                                                                                                                                                                                               | `ingress = []` on the group (asserted); invariants checker fails any ingress-rule resource targeting it.                                                                                                        |
| Two operators apply at once                                                                                                                                                                                                                                            | `use_lockfile = true` in every backend file; checker must-fail fixture.                                                                                                                                         |
| State backend moved offshore; secrets follow                                                                                                                                                                                                                           | Invariants checker on backend region / encrypt / KMS.                                                                                                                                                           |
| Bootstrap `destroy` deletes every root's state                                                                                                                                                                                                                         | `prevent_destroy` on bucket and key; invariants checker (not `terraform test`).                                                                                                                                 |
| Staging apply mutates `communityhub.one`                                                                                                                                                                                                                               | Dedicated zone; normalised validation rejects the apex and subdomains.                                                                                                                                          |
| Prod tfvars rot                                                                                                                                                                                                                                                        | `terraform test` loads every tfvars file.                                                                                                                                                                       |
| `packages-db` blocked on staging-au                                                                                                                                                                                                                                    | Architecture §23.3: PgBouncer in CI; this chunk is not a gate.                                                                                                                                                  |
| Wrangler and Terraform fight over `au.api` DNS                                                                                                                                                                                                                         | Terraform does not create those records.                                                                                                                                                                        |
| Connector execution role widened during debugging                                                                                                                                                                                                                      | `jsonencode` policy asserted: one secret, one log group; task role empty.                                                                                                                                       |
| Concurrent apply corrupts state                                                                                                                                                                                                                                        | S3-native `use_lockfile` (Terraform 1.11).                                                                                                                                                                      |

## Out-of-band

- **Same PR, docs:** architecture §8.1 (`infra/global/` + `infra/regions/<region>/`, drop `infra/cloudflare/` and empty `ca/eu/us` copies); §23.2 (offline Terraform checks on every PR; live `plan` once CI identities exist; apply is a human-triggered operations step, never on merge); §23.3 (PgBouncer + session-`SET` must-fail fixture; live Hyperdrive path is staging smoke); ADR 0002; ADR 0003.
- **Same PR, AGENTS.md §10:** Stage 1 adds offline Terraform (`fmt`, `validate`, `tflint`, `terraform test` on **roots and modules**) and the terraform-invariants checker now that real input and must-fail fixtures exist. Live Terraform `plan` remains omitted. Principle: a CI job is present and fail-closed, or absent — never present and silently skipping. (Gateway preview secrets still fail-closed because that job is in scope for its chunk.)
- **Human, not this PR:** AWS account; Cloudflare account; register the dedicated staging zone; **confirm that zone’s plan can set Regional Services = Australia** (purchase; ADR 0001’s regional verification path depends on it).
- **Later live-`plan` job:** AWS via GitHub OIDC role (no long-lived keys). Cloudflare via a narrowly scoped API token secret — confirm at that time whether token OIDC exists; today it does not. Plan output must not print sensitive values.
- **Legal / subprocessors:** none new. AWS and Cloudflare are already in architecture.
- Scaffold waits until this spec and its plan are both `approved`.
- **Providers (this chunk):** Terraform `~> 1.11` (S3 `use_lockfile`); hashicorp/aws `~> 6.0` (per-resource `region` is a configured, assertable argument); cloudflare/cloudflare `~> 5.13` (not `>=`, so `init -upgrade` cannot pull 6.x).
