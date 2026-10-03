# ADR 0009: Community Hub core runs in AWS Sydney

- Status: accepted
- Date: 2026-10-03
- Spec: `docs/specs/2026-10-03-personal-data-on-aws.md`
- Supersedes: ADR 0001, ADR 0003, and ADR 0008. ADR 0003 is the staging TLS-verification exception for Workers VPC and Hyperdrive. Those files are not edited.
- Supersedes in part: the Cloudflare ownership in ADR 0002 (Regional Services, Tunnel, Hyperdrive, and Workers VPC). ADR 0002 is not edited. Architecture §23.2 already says this.
- Amends: the form path in ADR 0006, by statement. ADR 0006 is not edited.

## Context

The architecture kept personal data in Australia with Cloudflare Regional Services on every regional hostname. The account does not have Regional Services. It is an Enterprise add-on, priced by contract, and the DNS form has no Region option. Without it, a Worker runs in whichever data centre the visitor reaches. The documented limits are that Regional Services does not cover outbound subrequests, Queue consumers, Cron Triggers, or `workers.dev`, and log-location control is US or EU only. Staging has never been applied. ADR 0003, the staging TLS-verification exception for Workers VPC and Hyperdrive, is superseded, and ADR 0002's Cloudflare ownership is superseded in part. Neither file is edited.

## Decision

Community Hub core runs entirely in AWS Sydney (`ap-southeast-2`). Nothing of ours runs on Cloudflare Workers. There is no global tier until a second region exists. One ECS Fargate service, ARM, serves the API, sign-in, webhooks, background jobs, and the ops console. Ingress is a regional HTTP API with a VPC link to Cloud Map, `SRV` records, a `$default` stage, and a VPC link created on two private subnets from the first apply. DNS is Route 53. Turnstile is the only remaining Cloudflare product, and Terraform does not manage it. The envelope key is a multi-Region primary key. The task role calls KMS. The broker is removed. The database is RDS PostgreSQL `db.t4g.micro`, single-AZ, with the production protections in the spec. Passwords are in Secrets Manager, write-only, and the master user is bootstrap only.

## Rule 1

Personal data is stored and processed in Australia. The service, the database, the keys that wrap personal data, and the logs are in `ap-southeast-2`. Backups are in `ap-southeast-2` only. Any future copy of personal data, including a backup, must stay in Australia. The Melbourne roadmap row, `kms-mrk-replica`, is a replica of the envelope key, not a copy of the database.

The region check allows these resources outside `ap-southeast-2`, and no others. None of them holds personal data.

- The CloudFront viewer certificate. AWS requires it in `us-east-1`.
- The global services: CloudFront, Route 53, and IAM.
- The DNSSEC signing key in `us-east-1`, when that open item is done. Route 53 requires the customer managed key in that region.
- The Melbourne replica of the envelope key, in `ap-southeast-4`. That region is still in Australia.

Personal data leaves Australia only in these cases:

(a) A tenant's own signed-in user opens it, wherever they are. A parishioner or a priest travelling overseas still sees their data.

(b) A support operator reads it under a grant or break-glass.

(c) It is sent to a named subprocessor, and only the fields that subprocessor needs for its function.

## Non-negotiable map

Old 2 and old 6 are removed. Old 3 becomes new 2. The others are unchanged apart from their numbers. Merged specs and plans keep the old numbers and are not edited.

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

## Cost

Prices are USD, checked on 2026-10-03, for a 730-hour month. Each environment has its own state key (`ch-tfstate-staging-au`, `ch-tfstate-prod-au`), so two environments are the plain sum. GST is not in the five infrastructure totals. The realistic months include 10 percent GST. Request volumes are estimates.

| Mode                                                 | Total     |
| ---------------------------------------------------- | --------- |
| 1. Nothing deployed                                  | USD 0.00  |
| 2. Staging parked, database deleted, task count zero | USD 6.60  |
| 3. Staging running a full month, on-demand ceiling   | USD 40.40 |
| 4. Production at launch, one zone, production alone  | USD 62.28 |
| 5. Production in two zones, plus the Melbourne key   | USD 94.51 |

Production at launch with staging parked is USD 68.88, before requests, logs, and GST.

All four keys rotate, and the Melbourne replica follows the same steps once it exists. The [KMS pricing page](https://aws.amazon.com/kms/pricing/) charges USD 1 a month for the key, then USD 1 a month more for the first rotation and USD 1 a month more for the second. The increase stops at the second rotation.

| When                            | Four keys | Five keys, with the replica |
| ------------------------------- | --------- | --------------------------- |
| Before the first rotation       | USD 4     | USD 5                       |
| After one year                  | USD 8     | USD 10                      |
| After two years, and after that | USD 12    | USD 15                      |

Budgets, one per environment, email at 80 percent: staging USD 50 (alert USD 40), production at launch USD 110 (alert USD 88), production in two zones USD 165 (alert USD 132). Staging defaults stay cheap. Every resource is tagged `environment` and `project`. A later chunk that adds a resource billed by the hour or the month names it and its monthly cost. No NAT gateway, no load balancer, and no extra interface endpoint appears without that. Savings Plans and a reserved database stay an open item until the sizes are stable.

## Consequences

What we lose: Cloudflare's edge protection in front of the API, and a ready-made global routing layer. A second region will need a small directory, built then. Single-AZ recovery is a restore, not a failover. The latest restorable time is typically the last five minutes. The targets stay at most 15 minutes of data lost and 4 hours to restore. Operators in Australia, Canada, and Bangladesh can see data under a grant. That is case (b), not a second stored copy.

This decision leaves four mechanisms open. Each leaning is a starting point. It is not a decision.

- **Entitlement visibility.** How a request sees a plan, an entitlement, an allocation, or an override. Leaning: the request reads them from the `platform` schema, with a short in-process cache, and the Stripe webhook recomputes them in one transaction. No snapshot and no propagation step. Decided by the `entitlements-plans` chunk, which must state how stale a cached entitlement may be.
- **Hard usage limits.** Where an exact counter lives. Leaning: a counter row in Postgres per organisation and limit, updated in the same transaction as the action, with a condition that refuses to go over the limit. Counts only, no personal data. Decided by the first chunk that enforces a limit, which must say which schema the counters live in and why.
- **Partner code.** Where a partner's code runs. This is a product decision for the owner. Leaning: partner code does not run on our platform. Partners use the API, OAuth scopes, and signed webhooks, and they host their own code. Decided in the partner-apps phase. This design does not include a hosted runtime for partner code.
- **Usage aggregates for the ops console.** Where the ops console reads daily usage counts. The `platform` role still has no privileges on the `app` schema. Leaning: a scheduled job in the regional service reads each organisation's daily usage counts under that organisation's tenant scope and writes totals to a `platform` table. The copy is an allow-list of count columns. Decided by the `usage-facts` and `ops-console` chunks.

## Alternatives rejected

- Buying Regional Services. No public price. The product does not cover outbound calls, queues, cron, or `workers.dev`. No quote is being sought.
- Keeping a split: personal data on AWS, and Workers that hold no personal data on Cloudflare. The owner closed this on 2026-10-03.
- An Application Load Balancer in front of the API. The HTTP API is enough until WAF or a request longer than 30 seconds is required.
- Keeping the KMS broker. A Worker cannot hold an AWS credential; that reason is gone. ADR 0008's endpoint price of about USD 7–8 is not reused. The checked price is USD 0.013 an hour in each zone.
- IAM database authentication on `db.t4g.micro`. The RDS user guide requires 300 to 1,000 MiB of extra memory.
- A second service with no KMS permission, and a separate staff directory.

## Q13

A form, a donation, or an RSVP posts from the browser to the Sydney hostname. It does not pass through a Jellycube Worker. Editor actions are attributed to the OIDC `sub`. Personal data is not sent to Jellycube. The old reason, that Durable Objects have no Australian jurisdiction, is replaced. ADR 0006 is not edited.
