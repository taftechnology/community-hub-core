# Spec: Personal data is processed in AWS Sydney

Slug: `personal-data-on-aws`
Status: draft
Supersedes: the Cloudflare Workers runtime for personal data, as decided in `docs/specs/2026-09-26-api-au-skeleton.md`, the Cloudflare data path in `docs/specs/2026-09-18-terraform-au-cell.md`, `docs/specs/2026-10-01-kms-broker-service.md`, and `docs/specs/2026-10-01-kms-worker-adapter.md`. Those files are not edited. The paused branch `feat/2026-10-02-api-au-hostname` is superseded and is not merged, continued, or deleted.
Architecture refs: §5, §7, §11.4, §15, §22, §26 Q13; D1, D2, D5, D8, D9; ADR 0001, ADR 0002, ADR 0006, ADR 0008
Branch: `docs/2026-10-03-personal-data-on-aws`, created from `origin/main`. Not stacked on another open PR.

## Problem

The architecture says personal data is processed only in Australia, and it keeps that promise with Cloudflare Regional Services on every regional hostname. The account does not have Regional Services. It is an Enterprise add-on, priced by contract, and the DNS form has no Region option. Without it, a Worker runs in whichever data centre the visitor reaches.

The owner has decided, and this spec does not reopen it: Community Hub core runs entirely in AWS Sydney (`ap-southeast-2`). Nothing of ours runs on Cloudflare Workers. There is no global tier until a second region exists. Workers that hold no personal data do not stay on Cloudflare either. This replaces the narrower idea that only personal-data services would move.

Staging has never been applied. There is no Terraform state bucket, no ECS cluster, and no ECR repository from the old design.

## Scope

**In**

Documents only, in this chunk:

- ADR 0009. Context, decision, consequences, rejected alternatives, the old-to-new non-negotiable number map, the cost totals and cost rules below, and unit prices checked on 2026-10-03.
- `architecture.md`, so it describes this design only.
- `AGENTS.md` in every place the old design is named. The list and the disposition of each place are under Rules touched.
- `docs/roadmap.md`: finished rows stay **done**, with a note where later work supersedes them; `api-au-hostname` is the only Phase 0 row superseded; `kms-mrk-replica` stays, reworded, after the first staging apply; new rows are added; Phase 1 wording for the control plane, ops console, and admin shell is updated.
- `docs/runbooks/apply-staging-au.md`: a note that the existing steps are the old design and must not be applied, plus the human prerequisites this decision already knows.

**Out**

- Application code, Terraform, and any command that creates, changes, or deletes a cloud resource.
- Deleting the paused branch.
- Editing a merged spec, plan, or ADR. ADR 0001 and ADR 0008 are superseded by ADR 0009. ADR 0006 is amended by ADR 0009's statement of the form path. None of those files is edited.
- The cleanup, the container, and the first staging apply. This spec names them as later chunks. It does not start them.
- A privacy-lawyer opinion. The questions are listed under Out-of-band.
- Buying Regional Services, or running Workers without it.
- DNSSEC signing. Open item, cost recorded.
- An in-memory cache of unwrapped organisation keys. Open item for the chunk that builds the service.
- Automatic rotation of database passwords. Open item. This design uses a runbook.
- IAM database authentication.
- A second region, and the small directory that region will need.
- Savings Plans, and a reserved database. Open item for when the task size and the instance class have stayed put.
- Parish website design. Jellycube stays a separate product. One rule changes, under Q13.

## Behaviour

### Where the system runs

One combined service in ECS Fargate, ARM (Graviton), in `ap-southeast-2`. The API, sign-in, webhooks, background jobs, and the ops console are one process. The image build and the task definition say ARM. The broker image today is pinned to x86; that image is superseded.

Task count is a variable and zero is allowed. The starting task size is the Fargate minimum, 0.25 vCPU and 0.5 GB. The service chunk raises it only by naming the new monthly cost in that chunk's spec. Staging runs one task on Fargate Spot, in the existing public subnet. Production runs two tasks, one in each of two availability zones, which needs a second public subnet. No NAT gateway. Tasks have a public address for outbound calls. Their security group allows inbound traffic only from the VPC link. Staging defaults are the cheap ones: one Spot task, the KMS endpoint off, task count variable with zero allowed, and a database that can be deleted. Production defaults are mode 4 in Cost.

The code keeps running offline: local Postgres, the fake KMS port, and no live cloud call in CI.

There is no gateway Worker. Clients call the Sydney hostname. There is no separate control plane: organisations, plans, entitlements, and feature flags are tables in the existing Postgres `platform` schema. There is no Cloudflare Access gate.

Queues and schedules are SQS and EventBridge in Sydney. Files, including what used to be R2, are S3 in Sydney. Admin static files are served from S3 through CloudFront. Those files hold no personal data. Every data call goes to the Sydney API hostname. The CloudFront certificate is in `us-east-1` because AWS requires that for CloudFront. That certificate is not personal data.

Turnstile stays a standalone bot check on public forms. It verifies a token. It does not sit in front of our traffic. A person creates the site key and the secret in the Cloudflare dashboard. The secret goes in Secrets Manager. Terraform does not manage Turnstile. The Cloudflare Terraform provider leaves core, and so does any Cloudflare API token in secrets, CI, or runbooks.

### Ingress

A regional HTTP API in `ap-southeast-2`. Its integration is a VPC link to Cloud Map. There is no load balancer. Tasks register with an `SRV` record and the container port. API Gateway requires that. Its private-integration page says an ECS task that fills Cloud Map must use `SRV` records, because the discovered attributes have to include an IP address and a port ([Create private integrations for HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-private.html)). The first staging apply proves `DiscoverInstances` returns the task private IP and port, and that the HTTP API reaches only a healthy task, before anything else is built on it. It also proves the VPC link can reach tasks that sit in a public subnet. That reach is not assumed.

The VPC link is created with private subnets in two availability zones on the first apply, in staging as well as production. The network module already places its private subnets in two `ap-southeast-2` zones. A VPC link's subnets and security groups cannot be changed after it is created ([Set up VPC links V2](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vpc-links.html)). Staging tasks still use the one existing public subnet. Production tasks need the second public subnet.

The stage is `$default`, served from the base of the API URL, so the stage name is not added to the path the service receives ([Stages for HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-stages.html)). If a later change uses a named stage, the integration overwrites the path with `$request.path`, which is the request path without the stage name. The same private-integration page says API Gateway otherwise includes the stage name in the request to the backend.

Only the custom domain answers. The default `execute-api` endpoint is disabled. The certificate is AWS Certificate Manager in `ap-southeast-2`. Minimum TLS is 1.2.

Throttle caps are shared by every caller. They cap cost. They do not isolate one parish from another. Per-client limits belong in the service, and the numbers are re-measured when there is real traffic.

| Scope                                             | Steady                 | Burst |
| ------------------------------------------------- | ---------------------- | ----- |
| Stage                                             | 50 requests per second | 100   |
| Write routes, including public forms and webhooks | 10 requests per second | 20    |

The hop from API Gateway to the task is plain HTTP inside the VPC. That is an accepted risk. A certificate API Gateway would verify on the task needs a private CA, which costs more than the rest of this design. The hop does not cross the public internet.

Deploys have no load-balancer draining. The process finishes in-flight requests on SIGTERM before it exits. Tasks are registered in Cloud Map only once the container health check is healthy. ECS does register the instance as unhealthy until that check passes, and `DiscoverInstances` must be shown, on the first apply, not to send traffic there. Clients retry writes with the same `Idempotency-Key`. The kernel reads that header and `withChangeKey` folds it into the outbox key.

Access logs are method, matched route, status, latency, response size, and request id. No query string. No client IP address.

No streaming and no WebSockets. Live screens poll. An Application Load Balancer is the later move if we need AWS WAF, or if a request must stay open past 30 seconds. The HTTP API integration timeout is 30 seconds and AWS does not allow it to be raised. The payload limit is 10 MB. Restricted files stay on short-lived S3 URLs.

Ops routes use their own hostname on the same service, so they can be throttled, logged, and later restricted separately from tenant traffic.

### DNS

Public zones are Route 53. Staging and production are separate hosted zones on separate domains.

`communityhub-staging.net` is not registered. A person registers it through Route 53 before the first staging apply. Registration creates the hosted zone. Terraform uses that zone and does not create a second one. Route 53 `ListPrices`, read on 2026-10-03 with the `ch-admin` profile, lists `.net` registration, renewal, and transfer at USD 17.00 per year, and restoration at USD 74.00. The hosted zone is a further USD 0.50 per month.

`communityhub.one` is not registered through Cloudflare Registrar. Terraform creates its hosted zone. A person changes the nameservers at the current registrar. The runbook says to check the registrar first: a domain at Cloudflare Registrar has to be transferred out before any nameserver change. The new nameservers must be shown to answer before the old zone is removed.

Alias records for the API Gateway custom domain and the CloudFront distribution. Queries for those aliases are not charged. Every other record the production zone has when the cutover happens, including SPF, DKIM, and verification records, is listed in the plan for that chunk so none is lost. I checked `infra/` on 2026-10-03: no DNS records are declared in Terraform yet. CAA records allow only the certificate authorities we use.

DNSSEC is an open item, after both zones are answering. Route 53 charges nothing to turn signing on. The signing key has to be a customer-managed KMS key in `us-east-1` ([Working with customer managed keys for DNSSEC](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-configuring-dnssec-cmk-requirements.html)), and one key can sign both zones. That key is USD 1 per month. Sign calls are USD 0.15 per 10,000 in that region. Route 53 makes about 15 per zone per day, inside the 20,000-request monthly allowance. Signing during the nameserver change can take a zone offline if the DS record is wrong.

### KMS

The envelope key is created as a multi-Region primary key. AWS does not allow a single-Region key to be converted later, and the Melbourne replica depends on that property ([Multi-Region keys in AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html)). Checked `infra/modules/aws-kms-envelope/main.tf` on 2026-10-03: `aws_kms_key.envelope` does not set `multi_region`, so the key would be single-Region. The foundations chunk sets `multi_region = true` and adds a Terraform test that the attribute is true. That change is merged before any apply of the key.

The broker's HTTP server is removed. The service's task role calls `kms:GenerateDataKey` and `kms:Decrypt`. The key policy keeps today's encryption-context conditions. The in-process `KmsPort` is the reviewed logic in `apps/kms-broker/src/aws-kms-adapter.ts` and `packages/kms-broker/src/context.ts`, not a later rewrite. That is `KeyId` on `Decrypt` as well as `GenerateDataKey`, `maxAttempts` 1, a 3000 ms abort, zeroing of returned bytes, one generic error with no ARN or context, three log fields only, and the key ARN validated at startup. Cleanup moves those two files and their tests to `apps/api/src/kms/`, which is where the service chunk builds the port. The only change to the adapter in that chunk is its import of the deleted server's `BrokerKms` type, which becomes the `KmsPort` type already in `packages/crypto`.

The KMS interface endpoint is on in production. A validation fails when the environment is prod and the flag is false. Staging defaults the flag off, because the task can reach `kms.ap-southeast-2.amazonaws.com` on its public address. A staging key with the flag off cannot require `aws:SourceVpce`. Staging is run at least once with the flag on before the first production apply, so the production key-policy shape is proven end to end. Both shapes stay exactly the expected statements and the allowed actions only, with `aws:SourceVpce` present if and only if the flag is on.

The only cryptographic principal is the regional service's task role. That role is broader than the broker's was. The `cloudflared` sidecar risk in ADR 0008 disappears, because there is no sidecar.

Endpoint zones follow the database: one while the database is single-zone, two when production moves to two zones. Sydney price, from the offer file on 2026-10-03: USD 0.013 per endpoint-hour in each availability zone, plus USD 0.01 per GB for the first petabyte. One zone is about USD 9.49 over a 730-hour month. Two zones are about USD 18.98.

Symmetric KMS requests in Sydney, which cover `GenerateDataKey` and `Decrypt`, are USD 0.03 per 10,000. The offer includes 20,000 requests a month at no charge. Every unwrap is a billed call. A short-lived in-memory cache of unwrapped organisation keys is an open item for the service chunk.

### Database

RDS for PostgreSQL, `db.t4g.micro`, single availability zone. Class and Multi-AZ are variables. Those values are the defaults. The module today turns Multi-AZ on for prod. That hard-coding is removed in the foundations chunk. Production cannot turn off the protections below, whatever the size.

Production protections, independent of size: automated backups with at least 7 days of point-in-time recovery, deletion protection, encryption with the storage key, TLS required, no public address. The instance is reached directly inside the VPC. No Cloudflare tunnel and no Hyperdrive. The task security group is the only source allowed to connect.

With one zone, backups are the only recovery path. Amazon RDS uploads transaction logs every five minutes, so the latest restorable time is typically the last five minutes. Architecture §22 already sets the target: at most 15 minutes of data lost, and 4 hours to restore. There is no standby promotion. The runbook gains a restore drill.

Storage starts at 20 GB and autoscales to a ceiling of 100 GB. Files live in S3, so this ceiling is for rows and indexes. The gp3 storage price in Sydney is USD 0.138 per GB-month. The instance hour for `db.t4g.micro`, single-AZ, PostgreSQL, is USD 0.025.

The class is burstable. Alarms for CPU credit balance, free memory, free storage, and connection count. Sustained load past the baseline can be charged extra. The ADR says so.

Maintenance window is weekly, Tuesday 15:00–16:00 UTC. That is Wednesday 01:00–02:00 in Sydney while AEST is in force (UTC+10), and Wednesday 02:00–03:00 while AEDT is in force (UTC+11). It is not Saturday evening or Sunday in Sydney. Automated backups run every day, not once a week. The daily backup window is 17:00–18:00 UTC, which is 03:00–04:00 the next calendar day while AEST is in force, and 04:00–05:00 the next calendar day while AEDT is in force. On Tuesday the maintenance window ends at 16:00 UTC and the backup window starts at 17:00 UTC, so they do not overlap. Other days have no maintenance window.

Move to `db.t4g.small` when CPU-credit or free-memory alarms fire through ordinary parish use over two weeks, or when connections sit above half this budget for that long. Move production to two zones at the first paying parish, or when an availability commitment is agreed, whichever comes first. The KMS endpoint gains its second zone in that same change.

`max_connections` defaults to `LEAST(DBInstanceClassMemory/9531392, 5000)`. `DBInstanceClassMemory` is less than the 1 GiB class size, because RDS reserves memory. The first staging apply reads `SHOW max_connections` and writes it in the runbook. The service must not be raised to two tasks until that value is at least 60.

Connection budget, four connections per role per task:

| Case                              | Tasks | Role connections | Migration | Total |
| --------------------------------- | ----- | ---------------- | --------- | ----- |
| Staging, one task, deploy at 200% | 2     | 24               | 2         | 26    |
| Production, steady                | 2     | 24               | 2         | 26    |
| Production, rolling deploy        | 4     | 48               | 2         | 50    |

Deployment settings that hold this cap: production desired count 2, `maximumPercent` 200, `minimumHealthyPercent` 100. The pool size is 4 per role and is not raised on this instance class. Fifty leaves at least ten connections under a `max_connections` of 60, for RDS itself and a human session.

### Database credentials

Three passwords in Secrets Manager, one for each of `app`, `identity`, and `platform`. IAM database authentication is deferred. [IAM database authentication for MariaDB, MySQL, and PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html) says it needs between 300 and 1,000 MiB of extra memory on the database for reliable connectivity, and this class has 1 GiB before RDS reserves any of it.

Terraform is `~> 1.11.0`. The locked AWS provider in `infra/regions/au` is 6.65.0 under `~> 6.0`. `aws_secretsmanager_secret_version.secret_string_wo` is a write-only argument in that provider line, and it is not stored in state. `secret_string_wo_version` is stored and is what triggers a new write. The random provider is not locked in this repo today. Ephemeral `random_password` exists from random provider 3.7.0. The foundations chunk adds `hashicorp/random` at `~> 3.7` and generates each password that way. A later apply does not rewrite the secret while `secret_string_wo_version` stays unchanged.

The master user uses the RDS-managed master secret (`manage_master_user_password` is already true). Terraform state holds that secret's ARN, not the password. The master user is used only for bootstrap and for the password runbook. The service never connects as master.

A person sets each role password. They read the master secret and the role secret in a session, connect as master, and run `ALTER ROLE`. They do not write either value into the repo, a log, or Terraform. Rotation is the same procedure: bump `secret_string_wo_version` in a reviewed change, then `ALTER ROLE` as master. There is no rotation Lambda. Automatic rotation is an open item.

The three role secrets use their own customer-managed KMS key in `ap-southeast-2`, not the envelope key and not the storage key. Decrypt is allowed only through `secretsmanager.ap-southeast-2.amazonaws.com`, and only when the encryption context secret ARN is one of these three.

The execution role may `GetSecretValue` on those three ARNs, for injection at task start, with the same KMS condition. The task role may `GetSecretValue` on those same three ARNs, so a new connection that fails authentication can re-read the current and previous versions. Running connections stay up. The task role's decrypt on this key is limited to these secrets. It does not extend to the envelope key.

TLS to Postgres is `verify-full` against the RDS certificate bundle shipped in the image. The parameter group already sets `rds.force_ssl` to 1.

### Operators

Operators sign in on the regional identity service. Every `platform_*` role requires a passkey. Email one-time codes cannot start or recover a platform session. Each operator registers at least two passkeys. Recovery of a lost passkey needs two `platform_security` people and writes an audit row.

`platform_support` has no tenant data by default. A grant still needs a ticket and a reason, approval by the tenant's administrator, four hours by default, a scope of named modules, and an audit row the tenant can see. Break-glass stays two `platform_security` people, and the tenant is told afterwards. There is no country filter and no masking. Staff may be in Australia, Canada, or Bangladesh.

What replaces the separate Worker: platform routes use the `platform` database role, which has no privileges on the `app` schema. A granted read uses the `app` role with the tenant scope set to the granted organisation, so row-level security applies even if the handler is wrong. I checked `packages/db/drizzle/0000_schemas.sql`: each of `app`, `identity`, and `platform` is granted its own schema only.

The platform and ops modules must not import `@community-hub/crypto`, including `import type`. The single granted-read function lives in its own module, and that is the only import that may. Enforcement is the existing `no-restricted-imports` rule in `eslint.config.js`, which already rejects a gateway import of `@community-hub/crypto`. The must-fail fixture is added beside the one `@community-hub/check-encrypted-column` already asserts. The granted-read module is the passing case.

Platform sessions are shorter than tenant sessions. A grant or a break-glass needs a fresh passkey check. The token audience is one the ops routes accept and tenant routes do not. Tokens issued to a relying party, including Jellycube, cannot carry a platform role. A test covers that.

The first `platform_security` operator is created by a one-off step a person runs, and that step writes an audit row. There is no default account and no migration that contains a credential.

A test with a `platform_support` session and no live grant must fail at the database when it touches the `app` schema, not only at the decrypt call.

Rejected, and said so in the ADR: a second service with no KMS permission, because it is another always-on task; a separate staff directory, because it is a second identity system for a few operators.

### Jobs and files

SQS and EventBridge in Sydney. The default convention, not a non-negotiable: a message carries IDs, and the job loads what it needs. Copies of personal fields in queues and dead-letter queues are hard to correct or delete. Where a message must carry a personal field, that spec says so. Every queue and dead-letter queue has encryption and a retention period.

### Public website

Jellycube remains a separate product. The new answer to Q13: a form, a donation, or an RSVP posts from the browser to the Sydney hostname. It does not pass through a Jellycube Worker. The Public Content API is still an allow-list of `public` columns, and children still never appear. ADR 0006 is not edited. ADR 0009 states this, and replaces the reason in ADR 0006's sentence about editor identity. That sentence currently says Jellycube must not see an email because Durable Objects have no Australian jurisdiction. The rule that remains is: editor actions are attributed to the OIDC `sub`, and personal data is not sent to Jellycube. Durable Objects are gone.

### Rule 1

Personal data is stored and processed in Australia. The service, the database, the keys that wrap personal data, and the logs are in `ap-southeast-2`. Backups are in `ap-southeast-2` only. Any future copy of personal data, including a backup, must stay in Australia. The Melbourne roadmap row is a replica of the envelope key, not a copy of the database.

The region check allows these resources outside `ap-southeast-2`, and no others. None of them holds personal data.

- The CloudFront viewer certificate. AWS requires it in `us-east-1` ([Requirements for using SSL/TLS certificates with CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)).
- The global services: CloudFront, Route 53, and IAM.
- The DNSSEC signing key in `us-east-1`, when that open item is done. Route 53 requires the customer managed key in that region.
- The Melbourne replica of the envelope key, in `ap-southeast-4`. That region is still in Australia. It is an opt-in Region ([AWS Regions](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html)), and it is disabled in this account.

The Terraform state backend stays in `ap-southeast-2`. A module that creates one of these exceptions does not reuse the `aws_region == "ap-southeast-2"` validation for that resource. Any other resource outside `ap-southeast-2` fails the check.

Personal data leaves Australia only in these cases:

(a) A tenant's own signed-in user opens it, wherever they are. A parishioner or a priest travelling overseas still sees their data.

(b) A support operator reads it under a grant or break-glass, as in Operators above.

(c) It is sent to a named subprocessor, and only the fields that subprocessor needs for its function.

### The eight non-negotiables

Old 2 (jobs never handle personal data) and old 6 (Durable Objects never hold personal data) are removed. The others are unchanged, and renumbered. ADR 0009 carries this map because merged specs and plans keep citing the old numbers. Those files are not edited.

| Old                                                               | New                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1 No personal data outside Australia                              | 1 Personal data is stored and processed in Australia, with the three cases above |
| 2 Jobs never handle personal data                                 | removed                                                                          |
| 3 `app` tables have `org_id`, RLS, and `FORCE ROW LEVEL SECURITY` | 2                                                                                |
| 4 A field SQL must filter, sort, or aggregate is not encrypted    | 3                                                                                |
| 5 Minors' data is restricted by default                           | 4                                                                                |
| 6 Durable Objects never hold personal data                        | removed                                                                          |
| 7 No personal data in URLs, logs, traces, analytics, or AI calls  | 5                                                                                |
| 8 No third-party analytics SDK or session replay                  | 6                                                                                |
| 9 Nothing touches production data outside production              | 7                                                                                |
| 10 Secrets never enter the repo, a prompt, a log, or a commit     | 8                                                                                |

AGENTS.md §6's sentence that children never appear, which cites §1 rule 5, cites rule 4. `tooling/checks/schema-rls` still enforces RLS. Its readme's "non-negotiable 3" becomes non-negotiable 2 in the cleanup chunk, when that readme is next touched. This chunk updates AGENTS.md. It does not rewrite the checker's readme ahead of the check.

### What happens to the old residency machinery

Checked on 2026-10-03. No `package.json` outside `packages/residency` depends on `@community-hub/residency`. `getCell` and `parseRegionId` are referenced only by that package's own tests. `residency-cell` reads `catalog.json` from disk. Nothing in an application reads the catalog at build or run time. Each current module's `aws_region` validation, and `terraform-invariants` for the state backend, already require `ap-southeast-2`. The named exceptions in rule 1 are the only resources allowed elsewhere, and none of them holds personal data. The package and the checker are removed, not reworded. That removal is the cleanup row, not this chunk.

This chunk's `architecture.md` edit stops telling anyone to enable a region by editing `catalog.json`. The region check it describes is Terraform and `terraform-invariants`. The package may still be on disk until the cleanup row, and the architecture does not describe it as part of the design.

| Piece                                                                                                                                                                                                                   | Disposition                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/residency` and `residency-cell`                                                                                                                                                                               | Remove in the cleanup row. No application consumer. Region enforcement stays in Terraform and `terraform-invariants`.                                                         |
| `residency-payload`                                                                                                                                                                                                     | Remove in the cleanup row. The IDs-only practice stays a convention, under Jobs and files.                                                                                    |
| `worker.meta.json` on both apps, `worker-config`, and the gateway app                                                                                                                                                   | Remove in the cleanup row. `apps/api` stays. Cleanup removes its Wrangler files, its Worker class file, and the `KMS_BROKER` binding. The service chunk converts it in place. |
| ADR 0001                                                                                                                                                                                                                | Superseded by ADR 0009. Not edited.                                                                                                                                           |
| Architecture §22 "No out-of-country failover"                                                                                                                                                                           | Reworded in this chunk. A request Sydney cannot serve fails. It is not served from another country. A grant, a travelling user, and a subprocessor call are not failover.     |
| `eslint.config.js` crypto import ban                                                                                                                                                                                    | Reworded, in the cleanup row, from `apps/gateway` to the platform and ops modules.                                                                                            |
| `cf-regional-hostname` and the other Cloudflare modules, the broker HTTP server, `main.ts`, the Dockerfile, the `kms-port-v1` contract, `@community-hub/kms-aws`, `kms-broker-binding`, and the `kms-aws` catalog entry | Remove in the cleanup row. `aws-kms-adapter.ts`, `context.ts`, and their tests move to `apps/api/src/kms/` first. They are not deleted.                                       |
| ADR 0008                                                                                                                                                                                                                | Superseded by ADR 0009. Not edited.                                                                                                                                           |

### Subprocessors

The documents gain a list. Each row is a provider, the data it receives, and where it processes that data. Countries the architecture does not state are left blank until they are verified. They are not guessed.

| Provider                                   | Data                                                           | Where, as the architecture states it                                                 |
| ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| AWS                                        | The service, database, keys, files, queues, logs, and backups  | `ap-southeast-2`. Backups are there only, until a future Australian copy is decided. |
| GivingJar                                  | Donor payment data                                             | Hosted in Australia.                                                                 |
| Stripe Billing                             | A customer call can return a name, email, or address           | Not stated.                                                                          |
| Twilio                                     | SMS recipients and message bodies                              | Not stated. Australian sender IDs.                                                   |
| OneSignal, and through it Apple and Google | Device tokens and generic push text                            | Not stated. Push delivery reaches Apple and Google.                                  |
| Email provider                             | Not chosen (Q9)                                                | In-region, or a named subprocessor.                                                  |
| Cloudflare Turnstile                       | The bot-check token                                            | Not stated. Not in front of our traffic.                                             |
| Jellycube                                  | Editor identity as an OIDC `sub`. Public content only on read. | Not stated. Forms do not pass through it.                                            |

Optional later adapters (Xero, MYOB, Mailchimp) stay off by default, as architecture §16 already says. They are not on this list until a community opts in.

## Cost

Lowest long-term cost is the priority. ADR 0009 carries this section. Prices are USD, from the public offer files on 2026-10-03, for a 730-hour month. `infra/bootstrap` creates one state bucket and one state key per environment (`ch-tfstate-staging-au` and `ch-tfstate-prod-au`). Two environments are the plain sum.

### Unit prices

| Line                                                  | Price                                                         | Offer                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Customer managed KMS key version, Sydney or Melbourne | USD 1.00 a month                                              | `ap-southeast-2-KMS-Keys`, `ap-southeast-4-KMS-Keys`                   |
| Secrets Manager secret                                | USD 0.40 a month                                              | checked earlier the same day                                           |
| Route 53 hosted zone, public or private               | USD 0.50 a month                                              | checked earlier the same day                                           |
| Cloud Map registered resource                         | USD 0.10 a month                                              | `APS2-Cloud-Map-Resources`. Zero tasks means zero registered resources |
| In-use public IPv4                                    | USD 0.005 an hour, USD 3.65 a month                           | `APS2-PublicIPv4:InUseAddress`                                         |
| Fargate ARM, on demand                                | USD 0.03885 a vCPU-hour, USD 0.00426 a GB-hour                | `APS2-Fargate-ARM-vCPU-Hours:perCPU`, `APS2-Fargate-ARM-GB-Hours`      |
| RDS `db.t4g.micro`, PostgreSQL                        | USD 0.025 an hour single-AZ, USD 0.051 an hour Multi-AZ       | `APS2-InstanceUsage:db.t4g.micro`, `APS2-Multi-AZUsage:db.t4g.micro`   |
| RDS gp3 storage, PostgreSQL                           | USD 0.138 a GB-month single-AZ, USD 0.276 a GB-month Multi-AZ | `APS2-RDS:GP3-Storage`, `APS2-RDS:Multi-AZ-GP3-Storage`                |
| KMS interface endpoint                                | USD 0.013 an hour in each zone, USD 9.49 a zone-month         | `APS2-VpcEndpoint-Hours`                                               |

One minimum task, on demand: 0.25 × 0.03885 × 730 = USD 7.09 of vCPU, and 0.5 × 0.00426 × 730 = USD 1.55 of memory, USD 8.64 together. Fargate Spot is not in the offer file. AWS describes the discount as up to 70 percent and does not publish a rate. The staging totals below use the on-demand price, so they are a ceiling. The Spot discount is an estimate that can only lower that line.

Keys in one environment: the state key, the storage key, the envelope primary, and the secrets key. Four keys, USD 4.00 before any rotation. The Melbourne replica is a fifth key, only in mode 5. Secrets while the database exists: three role secrets, the RDS-managed master, and Turnstile. Five secrets, USD 2.00. With the database deleted the master secret goes and four remain, USD 1.60. DNS while ingress exists: the public zone and the private zone Cloud Map creates, USD 1.00.

All four keys rotate. The state key sets `enable_key_rotation` true in `infra/bootstrap/main.tf`. The storage and envelope modules reject `enable_key_rotation = false`. The secrets key, which does not exist yet, gets the same validation in the foundations chunk. Rotation stays on the default annual period. The [KMS pricing page](https://aws.amazon.com/kms/pricing/) charges USD 1 a month for the key, then USD 1 a month more for the first rotation and USD 1 a month more for the second. The increase stops at the second rotation. Later rotations are not billed. Each replica is priced as its own key, so the Melbourne replica follows the same steps once it exists.

| When                                                          | One environment, four keys | Production with the replica, five keys |
| ------------------------------------------------------------- | -------------------------- | -------------------------------------- |
| Before the first rotation, which is what the tables below use | 4 × 1 = USD 4.00           | 5 × 1 = USD 5.00                       |
| After one year                                                | 4 × 2 = USD 8.00           | 5 × 2 = USD 10.00                      |
| After two years, and after that                               | 4 × 3 = USD 12.00          | 5 × 3 = USD 15.00                      |

### Monthly totals

**1. Nothing deployed.** Today, and offline development. USD 0.00. Staging has never been applied, so none of these resources exist. Local Postgres is not an AWS bill.

**2. Staging parked.** Task count zero, database deleted. This is the long park.

| Line                                                             | Arithmetic | USD  |
| ---------------------------------------------------------------- | ---------- | ---- |
| Four KMS key versions                                            | 4 × 1.00   | 4.00 |
| Four secrets                                                     | 4 × 0.40   | 1.60 |
| Two hosted zones                                                 | 2 × 0.50   | 1.00 |
| Tasks, public addresses, database, endpoint, Cloud Map instances | none       | 0.00 |
| Total                                                            |            | 6.60 |

USD 6.60 is 18 percent under the USD 8 estimate. The line that closes it is the staging domain registration, USD 17.00 a year. Spread over twelve months that is USD 1.42, and 6.60 + 1.42 = 8.02. That fee is yearly, so it is not in the monthly total. A stopped database is not this mode: storage would add 20 × 0.138 = USD 2.76 and the master secret would add USD 0.40, USD 9.76, and RDS starts the instance again after seven days.

**3. Staging running a full month.** One task, database on, KMS endpoint off.

| Line                    | Arithmetic  | USD   |
| ----------------------- | ----------- | ----- |
| Four KMS key versions   | 4 × 1.00    | 4.00  |
| Five secrets            | 5 × 0.40    | 2.00  |
| Two hosted zones        | 2 × 0.50    | 1.00  |
| One Cloud Map resource  | 1 × 0.10    | 0.10  |
| One public IPv4         | 0.005 × 730 | 3.65  |
| One task, on demand     | 8.64        | 8.64  |
| Database instance       | 0.025 × 730 | 18.25 |
| Database storage, 20 GB | 20 × 0.138  | 2.76  |
| KMS endpoint            | off         | 0.00  |
| Total                   |             | 40.40 |

USD 40.40 is 12 percent over the USD 36 estimate, inside 15 percent. The line that moves is the task: the total uses on-demand USD 8.64 because Spot has no list price.

**4. Production at launch.** Two tasks, `db.t4g.micro` in one zone, KMS endpoint in one zone. This picture does not include a running staging environment.

| Line                              | Arithmetic  | USD   |
| --------------------------------- | ----------- | ----- |
| Four KMS key versions             | 4 × 1.00    | 4.00  |
| Five secrets                      | 5 × 0.40    | 2.00  |
| Two hosted zones                  | 2 × 0.50    | 1.00  |
| Two Cloud Map resources           | 2 × 0.10    | 0.20  |
| Two public IPv4 addresses         | 2 × 3.65    | 7.30  |
| Two tasks, on demand              | 2 × 8.64    | 17.28 |
| Database instance, single-AZ      | 0.025 × 730 | 18.25 |
| Database storage, 20 GB single-AZ | 20 × 0.138  | 2.76  |
| KMS endpoint, one zone            | 0.013 × 730 | 9.49  |
| Total                             |             | 62.28 |

USD 62.28 is 7 percent under the USD 67 estimate, inside 15 percent. Production at launch with staging parked is 62.28 + 6.60 = USD 68.88, before requests, logs, and GST. Each environment already includes its own state key.

**5. Production once a parish depends on it.** Database and KMS endpoint in two zones, plus the Melbourne replica of the envelope key.

| Line                                     | Arithmetic            | USD   |
| ---------------------------------------- | --------------------- | ----- |
| Mode 4                                   |                       | 62.28 |
| Database instance, single-AZ to Multi-AZ | (0.051 − 0.025) × 730 | 18.98 |
| Database storage, single-AZ to Multi-AZ  | 20 × (0.276 − 0.138)  | 2.76  |
| KMS endpoint, second zone                | 0.013 × 730           | 9.49  |
| Melbourne key version                    | 1 × 1.00              | 1.00  |
| Total                                    |                       | 94.51 |

USD 94.51 is 5 percent under the USD 99 estimate, inside 15 percent.

### Requests, logs, and GST

The five totals above leave these out. The production budgets use an estimate so the alert sits on a realistic month. The volumes are assumptions, not measurements. Nothing is deployed, so there is no traffic to count. The prices are checked.

A launch month, mode 4, before a parish depends on it:

| Line                                           | Arithmetic           | USD   |
| ---------------------------------------------- | -------------------- | ----- |
| HTTP API, 200,000 requests                     | 0.2 × 1.29           | 0.26  |
| Cloud Map, one `DiscoverInstances` per request | 0.2 × 1.00           | 0.20  |
| KMS requests, inside the 20,000 included       | 0                    | 0.00  |
| Logs, 1 GB ingested and stored                 | 1 × 0.67 + 1 × 0.033 | 0.70  |
| Requests and logs                              |                      | 1.16  |
| Mode 4 plus that estimate                      | 62.28 + 1.16         | 63.44 |
| GST at 10 percent                              | 63.44 × 0.10         | 6.34  |
| Realistic month                                | 63.44 + 6.34         | 69.78 |

The Cloud Map call rate was not found. One call per HTTP request is the assumption behind the USD 0.20. Log ingestion is `APS2-DataProcessing-Bytes` at USD 0.67 a GB for custom logs in the standard class, and storage is `APS2-TimedStorage-ByteHrs` at USD 0.033 a GB-month. The 5 GB log allowance on new accounts is not used here, so the figure still holds after that allowance ends.

A month with four tasks left running, instead of two, adds 2 × (8.64 + 3.65) = USD 24.58 before GST. The realistic bill becomes (63.44 + 24.58) × 1.10 = USD 96.82. That is the overrun the launch budget has to notice.

Once a parish depends on it, mode 5, the same method at a still-small volume:

| Line                                   | Arithmetic                         | USD    |
| -------------------------------------- | ---------------------------------- | ------ |
| HTTP API, 1,000,000 requests           | 1 × 1.29                           | 1.29   |
| Cloud Map, one call per request        | 1 × 1.00                           | 1.00   |
| KMS, 100,000 requests, no unwrap cache | (100,000 − 20,000) / 10,000 × 0.03 | 0.24   |
| Logs, 3 GB ingested and stored         | 3 × 0.67 + 3 × 0.033               | 2.11   |
| Requests and logs                      |                                    | 4.64   |
| Mode 5 plus that estimate              | 94.51 + 4.64                       | 99.15  |
| GST at 10 percent                      | 99.15 × 1.10                       | 109.07 |

Four tasks left running for that month: (99.15 + 24.58) × 1.10 = USD 136.10.

After two years the key line is USD 8.00 higher in one environment and USD 10.00 higher once the replica exists. With GST that is USD 8.80 and USD 11.00. A launch month is then about USD 78.58, and a two-zone month about USD 120.07. The budgets below clear those figures. They still fire for the four-task month.

Still not in these figures: data transfer, including the endpoint's USD 0.01 a GB. Route 53 queries beyond aliases, which are not charged. Per-use providers: GivingJar, Stripe, Twilio, OneSignal, Apple, Google, Turnstile beyond the secret's storage, and the email provider. The `.net` registration at USD 17.00 a year. ECR storage, USD 0.10 a GB-month; a 1 GB image is USD 0.10. Backup storage inside the provisioned database size. Fargate's included 20 GB of ephemeral disk.

### Cost rules

- Staging defaults are the cheap ones, as in Where the system runs. Production defaults are mode 4.
- Every resource is tagged with `environment` and `project`, so the bill separates staging from production.
- The foundations chunk creates one AWS Budget per environment, with an email alert at 80 percent. Staging's budget is USD 50, so the alert is at USD 40. That is just under mode 3's ceiling of USD 40.40, so it fires only if staging is left running all month. Production's budget is USD 110, so the alert is at USD 88. That is above the realistic launch month of USD 69.78 and above the same month after two key rotations, about USD 78.58, and below the four-task overrun of USD 96.82. The chunk that moves production to two zones raises that budget to USD 165 before the change, so the alert is at USD 132. That is above the realistic two-zone month of USD 109.07 and above that month after two key rotations, about USD 120.07, and below the four-task overrun of USD 136.10. The alert address is a human prerequisite. The budget's own charge is not in the offer files checked here; the foundations chunk confirms it and, if there is a charge, names it.
- From now on, a chunk that adds a resource billed by the hour or the month names it and its monthly cost in that chunk's spec. No NAT gateway, no load balancer, and no extra interface endpoint appears without that.
- Savings Plans and a reserved database stay an open item until the sizes are stable.

## Roadmap

Finished rows stay **done**. Where a later row supersedes them, the row gains a note. History is not rewritten.

Superseded, not started, and not deleted from the record:

- `api-au-hostname` only. The branch `feat/2026-10-02-api-au-hostname` is paused at task 3 and is not merged.

`kms-mrk-replica` stays a later row, reworded, after the first staging apply. It is a replica of the envelope key in `ap-southeast-4`, not a database backup. `ap-southeast-4` is an opt-in Region and is disabled in this account. Enabling it is a human prerequisite of that chunk, written in the runbook. The replica cannot be created until the envelope key is a multi-Region key.

New and reordered rows, not started:

1. Cleanup. The gateway app, Cloudflare and broker Terraform modules, and the Worker-only checks (`worker-config`, `kms-broker-binding`, `residency-cell`, `residency-payload`, `packages/residency`). `apps/api` is not deleted. Cleanup removes its Wrangler files, its Worker class file, and the `KMS_BROKER` binding, and moves its tests off the Workers pool, because that pool reads `wrangler.jsonc`. On the broker, cleanup deletes the HTTP server, `server.test.ts`, `main.ts`, the Dockerfile, `contract/kms-port-v1.json`, `@community-hub/kms-aws`, and `kms-broker-binding`. It first moves `apps/kms-broker/src/aws-kms-adapter.ts`, `packages/kms-broker/src/context.ts`, and their tests to `apps/api/src/kms/`. The service chunk uses those files. It does not rewrite them.
2. Foundations. Only what the later rows need before the first apply, and still small enough to be one chunk: tags and the two budgets, the second public subnet, the database changes, the secrets and their key, the task role and the execution role, and the multi-Region envelope key with its policy for that role and its test. No apply of the key before that test is merged.
3. Ingress. Route 53 and the API certificate, Cloud Map with `SRV` records, the VPC link on two private subnets, the HTTP API with a `$default` stage, and the ECS service module. Split out of foundations because the two together are about twelve tasks.
4. The regional service. Converts `apps/api` in place. ARM, one process, the `KmsPort` carry-over, TLS `verify-full`. It does not create a second app.
5. First staging apply. Live proof of health, a database round trip, and a KMS round trip, including the Cloud Map proof and the proof that the VPC link reaches tasks in a public subnet. Staging is run once with the KMS endpoint flag on before any production apply. The apply reads `SHOW max_connections` into the runbook.
6. `kms-mrk-replica`, as above.

SQS and EventBridge wait for the first chunk that runs a job. S3 for files waits for the first chunk that stores one. S3 with CloudFront waits for the admin-shell chunk. Each of those names the monthly cost.

Between cleanup and the service chunk, Stage 3 no longer runs `wrangler deploy --dry-run`, no longer uploads a gateway version, no longer comments a `workers.dev` URL, and no longer requires a Cloudflare token. It builds `@community-hub/api` and does not deploy. The service chunk replaces that build with the ARM image build. Stage 2 keeps testing `apps/api` on the Node runner the cleanup chunk switched it to. That is what keeps `main` releasable in the gap.

Phase 1 wording changes in this chunk, not new chunks: the control plane is platform-schema tables; the ops console is routes on this service; the admin shell's static files come from S3 and CloudFront, and its data calls go to the Sydney hostname.

Phase 0 snapshot this chunk writes: 19 rows, 12 done, 1 superseded (`api-au-hostname`), 6 not started. Next is cleanup.

## Runbook

The top of `docs/runbooks/apply-staging-au.md` says the steps below it build the old design and must not be applied. Above that warning, the human prerequisites:

- Every apply uses an IAM Identity Center administrator profile. It never uses the root user.
- The budget alert address, for both environments.
- Register `communityhub-staging.net` in Route 53, at the price above, and give Terraform the hosted zone it creates.
- For `communityhub.one`, confirm the registrar is not Cloudflare Registrar, change nameservers to the zone Terraform creates, and confirm the new nameservers answer before the old zone is removed.
- Do not apply the envelope key until `multi_region` is true and the Terraform test for that attribute is in the module.
- Before the Melbourne replica chunk, enable `ap-southeast-4`. It is an opt-in Region, and a check of this account on 2026-10-03 found it disabled. The replica chunk does not enable it itself.

The restore drill and the `ALTER ROLE` procedure are added as new sections. They are not part of the old apply.

Park and unpark is its own short procedure, not a step of the old apply.

- A long park sets the staging task count to zero and deletes the staging database. A stopped database is only a short pause: storage is still billed, and RDS starts the instance again after seven consecutive days ([Stopping an Amazon RDS DB instance temporarily](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html)).
- Unpark recreates the database if it was deleted, runs the `ALTER ROLE` procedure, and sets the task count back to one.
- A VPC link with no traffic for 60 days becomes `INACTIVE`. API Gateway deletes its network interfaces, and bringing it back takes a few minutes ([Set up VPC links V2](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vpc-links.html)). Unpark waits until the link is `AVAILABLE` before treating a failed health check as a fault in the task.

## Data

This chunk adds no table and no column.

Later chunks, not this one, put directory, plan, entitlement, and feature-flag rows in the `platform` schema. Those columns are ids, slugs, counts, and config. They are classified when that chunk is specified. Personal data stays in `app` and `identity`, under the classifications architecture §12.1 already has.

## Rules touched

AGENTS.md §1 becomes the eight non-negotiables above. Until the cleanup row merges, CI still runs the checks that row removes. This chunk does not pretend they are already gone.

Every place the old design is named, and what this chunk does with it:

| Place                         | What it says today                                                                                                                     | Disposition                                                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top, Repository state         | Phase 0 on `main`, `apps/gateway`, CI Stages 1–3                                                                                       | Rewritten to the Phase 0 snapshot in Roadmap. It names `apps/gateway` and the Worker shell of `apps/api` as still on `main` until cleanup, and it does not describe them as the design.                                |
| §1 rules 1, 2, and 6          | Global Workers, jobs/`exec`, Durable Objects                                                                                           | Replaced by the eight non-negotiables. Rules 2 and 6 are removed.                                                                                                                                                      |
| §6 Residency, new Worker      | `preview_urls`, `worker.meta.json`, Regional Services, proxy to `api-au`                                                               | Removed. Personal data stays in Australia by running in `ap-southeast-2`, with rule 1's exceptions.                                                                                                                    |
| §6 Residency, queue path      | IDs in, status out, `exec` does the work                                                                                               | Rewritten as the convention under Jobs and files. Not a non-negotiable.                                                                                                                                                |
| §6 Residency, outbound call   | Originates from `exec`, not a global Worker. Control-plane never calls Stripe                                                          | Originates from the regional service. There is no control plane and no `exec`.                                                                                                                                         |
| §6 Residency, inbound webhook | `webhooks-au`, then nothing global sees the payload                                                                                    | The Sydney hostname. There is no global tier to strip the payload for.                                                                                                                                                 |
| §6 Public website             | Children never appear, citing §1 rule 5                                                                                                | The citation becomes rule 4. The rule is unchanged.                                                                                                                                                                    |
| §7                            | Backward compatible with the currently deployed Worker. Long backfills are Workflows through `exec`                                    | The deployed service. Long backfills are resumable jobs in the regional service, not Cloudflare Workflows.                                                                                                             |
| §8                            | Behaviour verified against a running preview                                                                                           | The staging hostname. Not a `workers.dev` preview.                                                                                                                                                                     |
| §10 Stage 1                   | Lists `worker-config`, `kms-broker-binding`, `residency-payload`, `residency-cell`                                                     | Names those as removed by cleanup, and says CI still runs them until that row merges.                                                                                                                                  |
| §10 Stage 2                   | `@cloudflare/vitest-pool-workers` for `apps/gateway`                                                                                   | Removed with the gateway app in cleanup. `apps/api` leaves that pool in the same row. The gap is described in Roadmap.                                                                                                 |
| §10 Stage 3                   | `wrangler deploy --dry-run`, `workers.dev` preview, Regional Services hostname                                                         | The gap between cleanup and the service chunk is the `apps/api` package build, with no Wrangler and no Cloudflare token. The service chunk replaces it with the ARM image build. Verification is the staging hostname. |
| §10 Stage 4                   | Merge deploys `staging-au` as the old cell                                                                                             | Merge deploys the container to staging. Migrations still run first. Terraform apply still needs a person.                                                                                                              |
| §11 Residency                 | Global Worker, KV, a global Worker calling Stripe                                                                                      | The regional service, SQS, logs, and an offshore call. Stripe calls come from the regional service.                                                                                                                    |
| §11 Jobs                      | Entitlements checked in API, UI, and jobs                                                                                              | Kept. Jobs are work the regional service runs.                                                                                                                                                                         |
| §16 Never                     | Personal data outside AU. A Durable Object holding personal data. Control-plane calling Stripe. Ops console reading tenant rows itself | The first stays, as rule 1. The Durable Object line is removed. The control-plane line is removed. The ops line becomes: the `platform` role has no privileges on `app`.                                               |

The intent that stays: tenant isolation in the database, no querying encrypted columns, minors restricted, nothing personal in logs or analytics, no production data outside production, no secrets in the repo.

## Contracts

This chunk publishes no route and no event.

The documents record the hostnames the later service chunk will serve: the API, sign-in, webhooks, and a separate ops hostname, all on the one service, DNS-only at Route 53, alias to the regional HTTP API. Deep links and website events stay ids only, as ADR 0006 already requires.

## Risks

Tenancy. Platform routes could read another organisation's rows if they used the `app` role without a grant. The `platform` role has no `app` privileges. A granted read sets the tenant scope. The test is that an ungranted `platform_support` session fails in the database.

Residency of hosting. A proxied DNS record, a Worker, or a failover region would put personal data outside Australia again. DNS is Route 53. There is no Worker. Failover outside Australia is not a switch.

Residency of access. Operators and travelling users see data from outside Australia. That is rule 1, cases (a) and (b). It is not a second stored copy. The lawyer questions below are unresolved.

Children. A granted read can include a minor's fields. The grant, the audit row, and the household key still apply. The lawyer questions cover whether that is enough.

Money. Amounts stay integer minor units. No new payment path in this chunk.

The task role can call KMS and can read the three database secrets. Both are scoped: KMS by the existing encryption-context key policy, secrets by ARN and a separate key. A compromised task can still decrypt what the process can decrypt. That is accepted. A second broker or a second service is rejected.

Cloud Map is the least proven hop. The first staging apply proves discovery, healthy-task routing, and that the VPC link reaches tasks in a public subnet, before other work depends on it.

Single-AZ database. A failure is a restore of up to about five minutes of transactions, with a four-hour target. That is accepted until the first paying parish or an availability commitment.

## Out-of-band

A privacy lawyer, before the first real parish. This spec does not decide:

- The privacy policy and the parishes' collection notices must say that support staff in Canada and Bangladesh may access data, and must name the countries and the subprocessors.
- We remain accountable for what overseas operators do with it.
- Religious affiliation is sensitive information, and children's records need particular care.
- Whether any diocese or parish contract requires more than rule 1 gives.

DNSSEC, after the zones are answering. Automatic password rotation. An unwrap cache, in the service chunk. Savings Plans and a reserved database, once the sizes are stable. Stripe, Twilio, OneSignal, Turnstile, and Jellycube processing countries, when they are verified. The email provider (Q9). The identity library (Q3).
