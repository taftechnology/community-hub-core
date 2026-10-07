# Spec: Admin shell

Slug: admin-shell
Status: draft
Architecture refs: §7.1, §7.2, §7.3, §8.5, §21, ADR 0009. Implements the `admin-shell` row. Depends on `packages-ui` and `image-publish`, both on `main`. Staging stays parked.

## Problem

There is no tenant admin. Staff have no shell, and the frozen sidebar does not exist. Admin static files have nowhere to live: architecture already names S3 and CloudFront, and this is the chunk that adds them.

## Scope

**In**

- `apps/admin`, package `@community-hub/admin`. React Router v7 in SPA mode, built by Vite to static files. No server process. The root stylesheet is, in this order:

```css
@import "tailwindcss";
@import "@community-hub/tokens/tokens.css";
@import "@community-hub/ui/theme.css";
```

Vite transpiles the TypeScript source of `@community-hub/ui`. The app imports `Button` from `@community-hub/ui` and does not add shadcn components under `apps/admin`.

- One route, `/`. The page has one `h1`, `Dashboard`. It renders one `Button` from `@community-hub/ui` with the accessible name `Refresh`. Activating that button reloads the document. It does not call `fetch`.
- The sidebar is a `nav` with accessible name `Admin`. Its items are the frozen 16 labels, in this order: Dashboard, Enquires, Engagement, Contacts & Members, Family Records, Membership, Records, Certifications, Volunteers, Forms, Communication, Mobile App, Website & CMS, Donations, E-commerce, Settings. Only Dashboard is rendered, as a link to `/`. The other 15 are absent from the document, not visually hidden and not disabled. The spelling `Enquires` stays. There is no Website top-bar link, no community switcher, no organisation chrome, and no person name.
- The app makes no data call. It does not read the Sydney hostname. A test fails if `apps/admin` calls `fetch`.
- `infra/modules/aws-admin-static`, created only when `environment` is `staging`. The bucket is in `ap-southeast-2` (`region = var.aws_region`). Public access is blocked. Ownership is `BucketOwnerEnforced`. Encryption is SSE-S3 (`AES256`), not the envelope key. No versioning. The bucket policy allows `s3:GetObject` only to the distribution's origin access control. The distribution is pay-as-you-go, `PriceClass_All`, HTTPS only, minimum TLS 1.2, default root object `index.html`, no WAF, no access logs, no CloudFront function, and no Lambda@Edge. A missing object stays a 403 or 404. It is not rewritten to `index.html`. The hostname is `admin.${var.zone_name}` on the existing public zone. No new hosted zone.
- The viewer certificate and its DNS validation set `region = "us-east-1"`. Those are `aws_acm_certificate.admin` and `aws_acm_certificate_validation.admin` in `infra/modules/aws-admin-static`. The distribution, the origin access control, the response-headers policy, the bucket, and the Route 53 records do not set `region`. There is no provider block whose region is `us-east-1`.
- The region check stays an allow-list. `"us-east-1"` is allowed only on those two certificate resources. `"ap-southeast-4"` stays allowed only on the two envelope replica resources. Every other `region` argument on a resource or a provider is exactly `var.aws_region`. A bucket, a provider, or any other resource with `"us-east-1"` fails, including one placed in the admin-static module. The existing `region-us-east-1` fixture still fails.
- Response headers: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy` that allows scripts and styles from `'self'` only. No third-party script, font, or analytics host.
- An IAM role `admin_publish`, staging only, on the existing GitHub OIDC provider. The trust subject matches the image publish role: this repository and `refs/heads/main` only. The policy can list, put, and delete objects in this bucket only, and can create an invalidation for this distribution only. It is not the image publish role. Tests use synthetic ids. The GitHub ids in `env/staging.tfvars` are not copied into tests.
- A push to `main` builds `@community-hub/admin` and syncs the files. `index.html` is uploaded with `Cache-Control: no-cache`. Hashed assets are immutable. The job then invalidates `/` and `/index.html`. A pull request builds the app and does not assume the role. The job prints neither the token, the bucket name, the distribution id, nor the account id.
- The catalogue commit marks this row done and links this spec. The snapshot stays on Phase `1 — Core platform`. Last shipped becomes `admin-shell`. Next chunk becomes `tenancy-implicit-org`. The Phase 0 count stays `23 rows: 22 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stays `not started`. The sentence under the Phase 0 table names `tenancy-implicit-org`. The Next spec section names `tenancy-implicit-org`. The repository-state sentence keeps that Phase 0 count and says next is `tenancy-implicit-org`. No other `AGENTS.md` sentence changes.

**Out**

- Sign-in, sessions, and `identity-otp`. The page is a static shell.
- Entitlements, permissions, and any nav item other than Dashboard. Unhiding a label is the chunk that fills it.
- A data call, a health check against the API, and any use of the Sydney hostname. The API stays parked: `enable_database` false, `desired_count` 0, no `service_image`, no `enable_kms_endpoint`.
- Production. The module and the role are staging only. This chunk does not apply production and does not write the production apply runbook.
- A flat-rate CloudFront plan. Those plans bundle WAF. This distribution has no WAF.
- A new hosted zone, a NAT gateway, a load balancer, an interface endpoint, or a second OIDC provider.
- `apps/portal`, `apps/mobile`, and `packages/ui-native`.
- An ADR, and any edit to `architecture.md`. §7.1 and §8.5 already name this surface. §7.3 already allows the viewer certificate in `us-east-1`.

## Behaviour

The sidebar shows Dashboard and nothing else. The heading reads Dashboard. Refresh reloads the page and does not request the API. Direct requests for the other labels, such as `/enquires`, are not routes. Before any object is uploaded, the distribution answers 403 or 404 for `/`.

The human applies the AU cell from the commit this spec's plan names, profile `ch-admin`, both var files, the gitignored file last. The agent does not apply.

The change set is exactly these 14 addresses, all added. Nothing changes and nothing is destroyed. The API, the database, the task, and the envelope key are not in it.

| Address                                                                        |
| ------------------------------------------------------------------------------ |
| `module.admin_static.aws_s3_bucket.admin`                                      |
| `module.admin_static.aws_s3_bucket_public_access_block.admin`                  |
| `module.admin_static.aws_s3_bucket_server_side_encryption_configuration.admin` |
| `module.admin_static.aws_s3_bucket_ownership_controls.admin`                   |
| `module.admin_static.aws_s3_bucket_policy.admin`                               |
| `module.admin_static.aws_cloudfront_origin_access_control.admin`               |
| `module.admin_static.aws_cloudfront_response_headers_policy.admin`             |
| `module.admin_static.aws_cloudfront_distribution.admin`                        |
| `module.admin_static.aws_acm_certificate.admin`                                |
| `module.admin_static.aws_route53_record.validation`                            |
| `module.admin_static.aws_acm_certificate_validation.admin`                     |
| `module.admin_static.aws_route53_record.admin`                                 |
| `aws_iam_role.admin_publish`                                                   |
| `aws_iam_role_policy.admin_publish`                                            |

That is 14 to add, 0 to change, 0 to destroy. Any other address is a stop. The bucket is empty after the apply, so `/` is not the dashboard yet.

The role trusts `refs/heads/main` only, so the pull request cannot upload. The first push to `main` after merge syncs the built files and invalidates `/` and `/index.html`. Opening `https://admin.<zone>/` then shows the dashboard. The pull request says that page check waits for that push. The apply of the 14 resources is the proof inside the pull request.

The runbook records the SHA, the 14 addresses, and that `/` was not the dashboard yet. It does not record a certificate ARN, a distribution id, a bucket name, or an account id.

## Data

No new table and no new column. The bucket holds the built HTML, CSS, and JavaScript. Those files contain no personal data. Viewer IP addresses are not logged.

## Rules touched

Residency. The bucket and the objects are in `ap-southeast-2`. The objects contain no personal data, so an edge cache outside Australia is the distribution's `PriceClass_All` behaviour, not a copy of personal data. The only new `region` literal outside `ap-southeast-2` and the Melbourne replica is `"us-east-1"` on the two viewer-certificate resources. Logs do not record viewer IPs.

Children, tenancy, and money. No minor fields, no tenant rows, and no payment fields. The shell does not call the API.

Analytics. No third-party script. The content security policy allows `'self'` only.

## Contracts

| Contract     | Value                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| App          | `@community-hub/admin`. Static SPA. One route, `/`.                                                        |
| Styles       | The three imports above, in that order. `Button` comes from `@community-hub/ui`.                           |
| Navigation   | The 16 frozen labels, in that order. Only Dashboard is rendered.                                           |
| API          | No `fetch`. The parked API flags stay as they are.                                                         |
| Hostname     | `admin.${zone_name}` on the existing zone.                                                                 |
| Bucket       | `ap-southeast-2`, private, SSE-S3, origin access control only.                                             |
| Distribution | Pay-as-you-go, `PriceClass_All`, no WAF, no access logs, TLS 1.2, no custom error rewrite to `index.html`. |
| Certificate  | `region = "us-east-1"` on `aws_acm_certificate.admin` and `aws_acm_certificate_validation.admin` only.     |
| Publish      | `main` only. The role is not the image publish role. A pull request builds and does not upload.            |
| Apply        | Staging only. 14 to add, 0 to change, 0 to destroy. The addresses are the table above.                     |

## Cost

Checked on 2026-10-07 against the CloudFront FAQ. Pay-as-you-go CloudFront has no hourly charge. The account free tier covers 1 TB of data transfer out and 10 million HTTPS requests a month. This shell stays inside that tier, so the distribution's charge for this chunk is USD 0. S3 has no minimum charge. The built files are well under 1 GB of Standard storage in `ap-southeast-2`. The public certificate has no charge. The Route 53 record uses the zone this account already pays for. No flat-rate plan, so no USD 15 Pro plan and no bundled WAF. The staging budget stays USD 50. No NAT gateway, no load balancer, and no interface endpoint.

## Risks

| Risk                                                              | Mitigation                                                                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `us-east-1` exception is wide enough for a bucket             | The literal is allowed only on the two named certificate resources. A bucket in that module with `"us-east-1"` fails. The existing `region-us-east-1` fixture still fails. |
| The bucket is public, or the policy allows `Principal: "*"`       | Public access block, and a plan-time assert that the policy grants `s3:GetObject` only through the origin access control.                                                  |
| A flat-rate plan turns WAF on                                     | No pricing-plan argument. A plan-time assert that the distribution has no web ACL and no logging config.                                                                   |
| A custom error maps every path to the dashboard                   | No custom error response. `/enquires` is not `index.html`.                                                                                                                 |
| `index.html` is cached across a publish                           | `Cache-Control: no-cache` on `index.html`, and the publish invalidates `/` and `/index.html`.                                                                              |
| The publish role can write the image repository or another bucket | The policy names this bucket and this distribution only. It is a different role from image publish.                                                                        |
| The shell calls the parked API or puts a person in the bundle     | No `fetch`. No name, email, or identifier in the page. Synthetic tests only.                                                                                               |
| Production apply creates a public shell before sign-in exists     | The module and the role exist only when `environment` is `staging`.                                                                                                        |

## Tests

- The rendered nav contains one link, Dashboard, to `/`. A constant holds the 16 labels in the frozen order, and a test asserts that constant and that the other 15 labels are absent.
- The page has one `h1`, Dashboard. The Refresh button's accessible name is Refresh. Axe reports no violations. A fixture with no accessible name fails.
- `apps/admin` does not call `fetch`. The built `index.html` has no third-party script URL.
- `terraform test` for the module: bucket region `ap-southeast-2`, public access block on, encryption `AES256`, distribution price class `PriceClass_All`, no web ACL, no logging, certificate region `us-east-1`, alias name `admin.` plus the zone. Account `123456789012` in tests.
- The region checker passes the two certificate resources and fails a bucket, a provider, and any other resource with `"us-east-1"`. The Melbourne replica literals still pass. `var.aws_region` still passes.
- The publish policy's actions and resource ARNs are the bucket and the distribution invalidation only. The trust subject is `refs/heads/main` for this repository. Tests use synthetic GitHub ids.
- The workflow file for a pull request does not assume the publish role.

## Out-of-band

- Legal: none. New subprocessor: none. S3 and CloudFront are AWS, which ADR 0009 already names.
- No ADR. `architecture.md` is not edited.
- The second fresh-context review. This chunk adds a `us-east-1` exception to the region check. The review that writes this spec does not count. The pull request is not merged until that line is closed.
- The human applies staging. The agent does not apply and does not upload. The page itself is the first `main` publish after merge.

## Next spec after this lands

`tenancy-implicit-org`, unless the human picks another Phase 1 row.
