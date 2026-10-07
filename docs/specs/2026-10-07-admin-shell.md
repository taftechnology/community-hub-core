# Spec: Admin shell

Slug: admin-shell
Status: approved (2026-10-07, Abdus)
Architecture refs: §7.1, §7.2, §7.3, §8.5, §12.2, §21, ADR 0009. Implements the `admin-shell` row. Depends on `packages-ui` and `image-publish`, both on `main`. Staging stays parked.

## Problem

There is no tenant admin. Staff have no shell, and the frozen sidebar does not exist. Admin static files have nowhere to live: architecture already names S3 and CloudFront, and this is the chunk that adds them.

## Scope

**In**

- `apps/admin`, package `@community-hub/admin`. Vite builds static files. React Router v7 is a library (`react-router`), not the framework package `@react-router/dev`. The framework build writes inline scripts into `index.html`, and a nonce cannot be added to a static file. The built `index.html` has only `script` tags with `src`. No server process. The root stylesheet is, in this order:

```css
@import "tailwindcss";
@import "@community-hub/tokens/tokens.css";
@import "@community-hub/ui/theme.css";
```

Vite transpiles the TypeScript source of `@community-hub/ui`. The app imports `Button` from `@community-hub/ui` and does not add shadcn components under `apps/admin`.

- One route, `/`. The page has one `h1`, `Dashboard`. It renders one `Button` from `@community-hub/ui` with the accessible name `Refresh`. Activating that button reloads the document. It does not call `fetch`.
- The sidebar is a `nav` with accessible name `Admin`. Its items are the frozen 16 labels, in this order: Dashboard, Enquires, Engagement, Contacts & Members, Family Records, Membership, Records, Certifications, Volunteers, Forms, Communication, Mobile App, Website & CMS, Donations, E-commerce, Settings. Only Dashboard is rendered, as a link to `/`. The other 15 are absent from the document, not visually hidden and not disabled. The spelling `Enquires` stays. There is no Website top-bar link, no community switcher, no organisation chrome, and no person name.
- The app makes no data call. It does not read the Sydney hostname.
- `infra/modules/aws-admin-static`, count 1 only when `environment` is `staging`. Public access is blocked. Ownership is `BucketOwnerEnforced`. Encryption is SSE-S3 (`AES256`). No versioning. The bucket policy allows `s3:GetObject` only to the distribution's origin access control. The distribution is pay-as-you-go, `PriceClass_All`, `is_ipv6_enabled` false, HTTPS only, minimum TLS 1.2, default root object `index.html`, no WAF, no access logs, no CloudFront function, and no Lambda@Edge. A missing object stays a 403 or 404. It is not rewritten to `index.html`. The hostname is `admin.${var.zone_name}` on the existing public zone. No new hosted zone. There is one alias, type A. There is no AAAA record.
- `region = var.aws_region` on each of `aws_s3_bucket.admin`, `aws_s3_bucket_public_access_block.admin`, `aws_s3_bucket_server_side_encryption_configuration.admin`, `aws_s3_bucket_ownership_controls.admin`, and `aws_s3_bucket_policy.admin`. The viewer certificate and its DNS validation set `region = "us-east-1"`. Those are `aws_acm_certificate.admin` and `aws_acm_certificate_validation.admin`. The CloudFront resources, the Route 53 records, and the IAM role and role policy set no `region`. There is no provider block whose region is `us-east-1`.
- The region check stays an allow-list. `"us-east-1"` is allowed only on those two certificate resources. `"ap-southeast-4"` stays allowed only on the two envelope replica resources. Every other `region` argument on a resource or a provider is exactly `var.aws_region`. A bucket, a provider, or any other resource with `"us-east-1"` fails, including one placed in the admin-static module. The existing `region-us-east-1` fixture still fails.
- Response headers, exact values. Tests assert these strings. `Content-Security-Policy` is `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'`. `Strict-Transport-Security` is `max-age=31536000; includeSubDomains`. `X-Content-Type-Options` is `nosniff`. `Referrer-Policy` is `no-referrer`. `X-Robots-Tag` is `noindex`.
- An IAM role `admin_publish`, count 1 only when `environment` is `staging`, on the existing GitHub OIDC provider. It is not the image publish role. The trust is one statement. The principal is that provider. `StringEquals` is the only condition operator, on the same five claims as the image publish role: `aud`, the immutable `sub` for `refs/heads/main`, `job_workflow_ref` for `.github/workflows/ci.yml` on `main`, `repository_id`, and `repository_owner_id`. The cell test decodes the assume-role policy and compares that `StringEquals` object with an exact map. Tests use synthetic ids `100000000001` and `100000000002`. The GitHub ids in `env/staging.tfvars` are not copied into tests. The role policy can list, put, and delete objects in this bucket only, and can create an invalidation for this distribution only.
- Job `admin-publish` in `.github/workflows/ci.yml`. It runs only when `github.event_name == 'push'` and `github.ref == 'refs/heads/main'`. `needs: [static, test]`. Permissions are `contents: read` and `id-token: write`. Its concurrency group is `admin-publish` and `cancel-in-progress` is false. Every `uses:` in that job is pinned to a 40-character commit SHA. The workflow-level cancel rule is unchanged: a push to `main` does not cancel an in-progress main run.
- The job's secrets are `ADMIN_PUBLISH_ROLE_ARN`, `ADMIN_BUCKET`, and `ADMIN_DISTRIBUTION_ID`. The human sets those three after the apply and before merge. Their values are not written into the repo, the runbook, or the pull request. The account id is the role ARN's account segment, masked with `::add-mask::` before any AWS call. The token is masked. The token file and the credential file are removed on exit. The job does not print the token, the role ARN, the bucket name, the distribution id, or the account id.
- `aws s3 sync` of the hashed assets uses `--only-show-errors` and `Cache-Control: public, max-age=31536000, immutable`. `aws s3 cp` of `index.html` uses `--only-show-errors` and `Cache-Control: no-cache`. Every other AWS call uses `--query`, including assume-role and the invalidation of `/` and `/index.html`. A pull request builds the app in the test job and does not assume the role.
- `checkWorkflow` gains rules for `admin-publish`, each with a must-fail fixture that is a passing workflow plus one defect. The real `ci.yml` stays the must-pass. The rule that `id-token: write` appears exactly once changes to exactly twice: once in `publish` and once in `admin-publish`, and not under the workflow `permissions`. The new violation ids are `admin-publish-without-needs`, `admin-publish-floating-uses`, `admin-publish-concurrency`, `admin-publish-sync`, and `admin-publish-query`.
- `infra/modules/aws-admin-static` is added to the Terraform matrix in `.github/workflows/ci.yml`.
- One new sentence in AGENTS.md §10: a pull request builds the admin shell and does not upload it, and a push to `main` publishes it. The catalogue commit also updates the repository-state sentence. Those are the two AGENTS.md edits.
- The catalogue commit marks this row done and links this spec. The snapshot stays on Phase `1 — Core platform`. Last shipped becomes `admin-shell`. Next chunk becomes `tenancy-implicit-org`. The Phase 0 count stays `23 rows: 22 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stays `not started`. The sentence under the Phase 0 table names `tenancy-implicit-org`. The Next spec section names `tenancy-implicit-org`.

**Out**

- Sign-in, sessions, and `identity-otp`. The page is a static shell.
- Entitlements, permissions, and any nav item other than Dashboard. Unhiding a label is the chunk that fills it.
- A data call, a health check against the API, and any use of the Sydney hostname. The API stays parked: `enable_database` false, `desired_count` 0, no `service_image`, no `enable_kms_endpoint`.
- `@react-router/dev` and any framework build that emits an inline script.
- Production. The module and the role are staging only. This chunk does not apply production and does not write the production apply runbook.
- A flat-rate CloudFront plan. Those plans bundle WAF. This distribution has no WAF.
- A new hosted zone, a NAT gateway, a load balancer, an interface endpoint, or a second OIDC provider.
- `apps/portal`, `apps/mobile`, and `packages/ui-native`.
- An ADR, and any edit to `architecture.md`. §7.1 and §8.5 already name this surface. §7.3 already allows the viewer certificate in `us-east-1`. §12.2's KMS sentence stays. This bucket is the exception named under Encryption.

## Behaviour

The sidebar shows Dashboard and nothing else. The heading reads Dashboard. Refresh reloads the page and does not request the API. Direct requests for the other labels, such as `/enquires`, are not routes. Before any object is uploaded, the distribution answers 403 or 404 for `/`.

The reviewer runs a read-only plan before the apply, from `infra/regions/au` on the commit this spec's plan names, profile `ch-admin`, both var files, the gitignored file last:

```bash
terraform init -backend-config=backend/staging.hcl -lockfile=readonly
terraform plan -lock=false -detailed-exitcode -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
```

The reviewer does not apply. Detailed exit code 2 is expected. Exit 0 or 1 is a stop. The change set is exactly the 14 addresses below. `is_ipv6_enabled` is false. There is no AAAA alias. There is no `terraform_data` resource.

The human then applies, profile `ch-admin`, both var files, the gitignored file last. The agent does not apply.

| Address                                                                           |
| --------------------------------------------------------------------------------- |
| `module.admin_static[0].aws_s3_bucket.admin`                                      |
| `module.admin_static[0].aws_s3_bucket_public_access_block.admin`                  |
| `module.admin_static[0].aws_s3_bucket_server_side_encryption_configuration.admin` |
| `module.admin_static[0].aws_s3_bucket_ownership_controls.admin`                   |
| `module.admin_static[0].aws_s3_bucket_policy.admin`                               |
| `module.admin_static[0].aws_cloudfront_origin_access_control.admin`               |
| `module.admin_static[0].aws_cloudfront_response_headers_policy.admin`             |
| `module.admin_static[0].aws_cloudfront_distribution.admin`                        |
| `module.admin_static[0].aws_acm_certificate.admin`                                |
| `module.admin_static[0].aws_route53_record.validation["admin.<zone>"]`            |
| `module.admin_static[0].aws_acm_certificate_validation.admin`                     |
| `module.admin_static[0].aws_route53_record.admin`                                 |
| `aws_iam_role.admin_publish[0]`                                                   |
| `aws_iam_role_policy.admin_publish[0]`                                            |

The validation record's key is the certificate domain name: `admin.` concatenated with `var.zone_name`. That is 14 to add, 0 to change, 0 to destroy. Any other address is a stop. The API, the database, the task, and the envelope key are not in the change set.

After the apply, the human checks out that same SHA, builds `@community-hub/admin`, and syncs the files with profile `ch-admin`. The reviewer, not the agent, loads `https://admin.<zone>/` and checks four things: the heading is Dashboard, the nav has one link, the response headers match the five values above, and the console shows no policy violation. The pull request records that check and includes a screenshot of the page. The first push to `main` publishes the same files through `admin-publish` and the reviewer repeats the four checks.

The human sets `ADMIN_PUBLISH_ROLE_ARN`, `ADMIN_BUCKET`, and `ADMIN_DISTRIBUTION_ID` after the apply and before merge.

The runbook records the SHA, the 14 addresses, that IPv6 is off, that there is no AAAA record and no `terraform_data`, and the reviewer's four checks. It does not record a certificate ARN, a distribution id, a bucket name, a role ARN, or an account id.

## Data

No new table and no new column. The bucket holds the built HTML, CSS, and JavaScript. Those files contain no personal data. Viewer IP addresses are not logged.

## Rules touched

Residency. The bucket and the objects are in `ap-southeast-2`. The objects contain no personal data, so an edge cache outside Australia is the distribution's `PriceClass_All` behaviour, not a copy of personal data. The only new `region` literal outside `ap-southeast-2` and the Melbourne replica is `"us-east-1"` on the two viewer-certificate resources. Logs do not record viewer IPs.

Children, tenancy, and money. No minor fields, no tenant rows, and no payment fields. The shell does not call the API.

Analytics. No third-party script. The content security policy is the exact string above.

## Contracts

| Contract     | Value                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| App          | `@community-hub/admin`. Vite static build. `react-router` as a library. One route, `/`.                                       |
| Styles       | The three imports above, in that order. `Button` comes from `@community-hub/ui`.                                              |
| Navigation   | The 16 frozen labels, in that order. Only Dashboard is rendered.                                                              |
| API          | No `fetch`. The parked API flags stay as they are.                                                                            |
| Hostname     | `admin.${zone_name}` on the existing zone.                                                                                    |
| Bucket       | `region = var.aws_region` on the bucket and its four attached resources. Private, SSE-S3, origin access control only.         |
| Distribution | Pay-as-you-go, `PriceClass_All`, IPv6 off, no AAAA, no WAF, no access logs, TLS 1.2, no custom error rewrite to `index.html`. |
| Certificate  | `region = "us-east-1"` on `aws_acm_certificate.admin` and `aws_acm_certificate_validation.admin` only.                        |
| Headers      | The five exact values under Scope.                                                                                            |
| Publish      | Role trust is the five `StringEquals` claims. Job `admin-publish` on `main` only. A pull request builds and does not upload.  |
| Apply        | Staging only. 14 to add, 0 to change, 0 to destroy. Indexes and the validation key are the table above. No `terraform_data`.  |

## Dependencies

Runtime, in `@community-hub/admin`:

| Package                | Why                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `react`                | `@community-hub/ui` peers on React 19. The shell needs the same runtime. Version `19.3.0`, already in the repo.              |
| `react-dom`            | Renders the shell. Version `19.3.0`, already in the repo.                                                                    |
| `react-router`         | Architecture requires React Router v7. Used as a library so the build does not emit inline scripts. Not `@react-router/dev`. |
| `vite`                 | Builds the static files. `@community-hub/ui` already says Vite transpiles its TypeScript.                                    |
| `@vitejs/plugin-react` | Vite does not compile JSX on its own.                                                                                        |
| `tailwindcss`          | The stylesheet starts with `@import "tailwindcss"`. Version `4.3.3`, already in the repo.                                    |
| `@tailwindcss/vite`    | Tailwind 4's Vite plugin, so those three imports are compiled. Same Tailwind 4 line as `4.3.3`.                              |

Dev, for the shell's tests: `vitest`, `jsdom`, `@testing-library/react`, and `axe-core`. The repo already uses those. The plan pins every new version exactly. No other dependency.

## Encryption

§12.2 says storage is encrypted at rest with KMS. This bucket uses SSE-S3 instead. The objects are the public build output. They hold no personal data. The only reader is the distribution, through the origin access control. The envelope key stays the wrapping key for personal data. `architecture.md` is not edited.

## Cost

Checked on 2026-10-07 against the CloudFront FAQ. Pay-as-you-go CloudFront has no hourly charge. The account free tier covers 1 TB of data transfer out and 10 million HTTPS requests a month. This shell stays inside that tier, so the distribution's charge for this chunk is USD 0. S3 has no minimum charge. The built files are well under 1 GB of Standard storage in `ap-southeast-2`. The public certificate has no charge. The Route 53 record uses the zone this account already pays for. No flat-rate plan, so no USD 15 Pro plan and no bundled WAF. The staging budget stays USD 50. No NAT gateway, no load balancer, and no interface endpoint.

## Risks

| Risk                                                                | Mitigation                                                                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `us-east-1` exception is wide enough for a bucket               | The literal is allowed only on the two named certificate resources. A bucket in that module with `"us-east-1"` fails. The existing `region-us-east-1` fixture still fails. |
| The bucket is public, or the policy allows `Principal: "*"`         | Public access block, and a plan-time assert that the policy grants `s3:GetObject` only through the origin access control.                                                  |
| A flat-rate plan turns WAF on                                       | No pricing-plan argument. A plan-time assert that the distribution has no web ACL and no logging config.                                                                   |
| An inline script survives and the content security policy blocks it | Vite plus `react-router` as a library. The built `index.html` test fails on an inline script or an inline style.                                                           |
| A custom error maps every path to the dashboard                     | No custom error response. `/enquires` is not `index.html`.                                                                                                                 |
| `index.html` is cached across a publish                             | `Cache-Control: no-cache` on `index.html`, and the publish invalidates `/` and `/index.html`.                                                                              |
| The publish role can write the image repository or another bucket   | The policy names this bucket and this distribution only. It is a different role from image publish. The trust map is exact.                                                |
| The shell calls the parked API or puts a person in the bundle       | The runtime spy and the source fixture. No name, email, or identifier in the page. Synthetic tests only.                                                                   |
| Production apply creates a public shell before sign-in exists       | The module and the role exist only when `environment` is `staging`.                                                                                                        |

## Tests

- The rendered nav contains one link, Dashboard, to `/`. A constant holds the 16 labels in the frozen order, and a test asserts that constant and that the other 15 labels are absent.
- The page has one `h1`, Dashboard. The Refresh button's accessible name is Refresh. Axe reports no violations. A fixture with no accessible name fails.
- A runtime test replaces `fetch` with a spy that fails the test when called, renders the page, and activates Refresh. A source check fails a must-fail fixture that calls `fetch(`, and passes a fixture that does not.
- The built `index.html` contains no inline script and no inline style: every `script` tag has `src`, and there is no `style` element and no `style` attribute. It has no third-party script URL.
- `terraform test` for the module: the five bucket resources have `region = var.aws_region`, public access block on, encryption `AES256`, distribution price class `PriceClass_All`, `is_ipv6_enabled` false, no web ACL, no logging, the response-headers policy equals the five header strings, certificate region `us-east-1`, one A alias, no AAAA. Account `123456789012` in tests. CloudFront, Route 53, and IAM resources have no `region` argument.
- The region checker passes the two certificate resources and fails a bucket, a provider, and any other resource with `"us-east-1"`. The Melbourne replica literals still pass. `var.aws_region` still passes.
- The cell test decodes `aws_iam_role.admin_publish[0].assume_role_policy`. One statement. Effect `Allow`. Action `sts:AssumeRoleWithWebIdentity`. Principal `Federated` is the GitHub provider ARN. `keys(Condition)` equals `["StringEquals"]`. `Condition.StringEquals` equals this map, with the synthetic ids:

```hcl
{
  "token.actions.githubusercontent.com:aud"                 = "sts.amazonaws.com"
  "token.actions.githubusercontent.com:sub"                 = "repo:taftechnology@100000000002/community-hub-core@100000000001:ref:refs/heads/main"
  "token.actions.githubusercontent.com:job_workflow_ref"    = "taftechnology/community-hub-core/.github/workflows/ci.yml@refs/heads/main"
  "token.actions.githubusercontent.com:repository_id"       = "100000000001"
  "token.actions.githubusercontent.com:repository_owner_id" = "100000000002"
}
```

- The role policy's actions and resource ARNs are the bucket and the distribution invalidation only.
- `checkWorkflow` on `ci.yml` passes with `id-token: write` exactly twice. Each new must-fail fixture fails with only its own violation id. A pull-request job does not assume the publish role.

## Out-of-band

- Legal: none. New subprocessor: none. S3 and CloudFront are AWS, which ADR 0009 already names.
- No ADR. `architecture.md` is not edited. The SSE-S3 exception is this bucket only, for the reason under Encryption.
- The second fresh-context review. This chunk adds a `us-east-1` exception to the region check. The review that writes this spec does not count. The pull request is not merged until that line is closed.
- The human applies staging. The agent does not apply and does not upload. After the apply, the human syncs the built files with `ch-admin`, and the reviewer loads the page before merge. The first `main` publish repeats that check.

## Next spec after this lands

`tenancy-implicit-org`, unless the human picks another Phase 1 row.
