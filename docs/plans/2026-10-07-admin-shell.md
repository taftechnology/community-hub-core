Spec: docs/specs/2026-10-07-admin-shell.md

# Admin shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff get a static Dashboard shell, and a push to `main` publishes it to the staging hostname.

**Architecture:** Five agent commits before the human applies. One commit adds the Vite app. One commit extends the region allow-list. One commit adds the static-site module and its plan-time tests. One commit wires that module and the publish role into the Sydney cell. One commit adds the `admin-publish` job. The human applies, then syncs. One commit records that apply. The last commit updates the catalogue. Nothing in an agent task calls AWS.

**Tech Stack:** Terraform 1.11.4, AWS provider 6.67.0, Vite 8.3.3, React 19.3.0, `react-router` 7.18.4 as a library. `terraform test` with `override_during = plan`.

Status: approved (2026-10-07, Abdus)

**Branch:** `feat/2026-10-07-admin-shell` · one PR · 7 agent commits

## Global Constraints

- The spec is approved. Do not edit `docs/specs/2026-10-07-admin-shell.md`.
- The agent does not run `terraform apply`, `aws`, or any command in the **Human** section. The agent does not upload the built files.
- Staging stays parked. Do not change `enable_database`, `desired_count`, or add `service_image` or `enable_kms_endpoint`. Do not edit `env/staging.tfvars` or `env/prod.tfvars`.
- Do not edit `architecture.md`. No ADR. The SSE-S3 exception is this bucket only.
- No sign-in, no data call, no `fetch`, and no read of the Sydney hostname. Do not add `@react-router/dev`. Do not run `npx shadcn add` into `apps/admin`.
- The module call has `count`. Resources inside the module do not. A second index would change the 14 addresses.
- Tests use account `123456789012` and GitHub ids `100000000001` and `100000000002`. Do not copy the ids from `env/staging.tfvars`. Do not write a certificate ARN, a distribution id, a bucket name, a role ARN, or an account id into the runbook, the repo, or the pull request.
- The apply change set is the 14 addresses in the Human section. Any other address is a stop. `is_ipv6_enabled` is false. There is no AAAA record and no `terraform_data`.
- Any rebase onto `origin/main` happens before the human applies. From the applied commit on: no rebase, no amend, and no force-push. If `origin/main` moves after that, bring it in with a merge commit. The pull request merges with a merge commit, never a squash, and the PR body says so.
- The pull request is not merged until the second fresh-context review line is closed. This chunk adds a `us-east-1` exception to the region check. Leave that line open. Do not write the second review. The agent does not merge.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Do not mark this plan approved yourself.
- Prettier formats Markdown, TypeScript, YAML, and CSS. It has no parser for `.tf` or `.tftest.hcl` and exits 2, so those files are not passed to it. Terraform files use `terraform fmt -recursive`. A non-recursive `terraform fmt -check` misses `tests/`. Run the matching formatter on the files in the commit before every commit, then the gate. The plan file is formatted before its own commit. A code fence inside a list item is indented so Prettier does not join the list.

**Rollback:** A later commit removes `module.admin_static`, `aws_iam_role.admin_publish`, and `aws_iam_role_policy.admin_publish`. The human empties the bucket first. `force_destroy` stays unset, so Terraform will not delete a bucket that still has objects. That plan then destroys the 14 addresses and nothing else. The agent does not run the apply.

**Cost:** Pay-as-you-go CloudFront, no hourly charge, and no flat-rate plan. Checked on 2026-10-07 against the CloudFront FAQ: the free tier covers 1 TB of data transfer out and 10 million HTTPS requests a month, so this chunk's distribution charge is USD 0. S3 has no minimum. The public certificate is free. The alias uses the zone the account already pays for. The staging budget stays USD 50. No NAT gateway, no load balancer, and no interface endpoint.

## File map

| File                                     | Responsibility                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `apps/admin/`                            | Vite shell, one route, the frozen labels, and the tests.               |
| `tooling/checks/terraform-invariants/`   | `us-east-1` only on the two certificate resources.                     |
| `infra/modules/aws-admin-static/`        | Bucket, distribution, certificate, alias. Mocks live in its test file. |
| `infra/regions/au/main.tf`               | Module call and the publish role. No new provider.                     |
| `infra/regions/au/outputs.tf`            | `admin_bucket` and `admin_distribution_id`, both sensitive.            |
| `infra/regions/au/tests/cell.tftest.hcl` | Trust map. No new mock defaults.                                       |
| `.github/workflows/ci.yml`               | Matrix entry and job `admin-publish`.                                  |
| `tooling/checks/image-publish/`          | `checkWorkflow` rules and fixtures.                                    |
| `docs/runbooks/apply-staging-au.md`      | Apply record. No bucket name and no distribution id.                   |
| `docs/roadmap.md`, `AGENTS.md`           | Catalogue, the repository-state sentence, and one Stage 3 sentence.    |

## Dependencies

Pin these in `apps/admin`. No other dependency. Do not add `@types/react-router`: `5.1.20` is the v5 types package, and `react-router` 7 ships its own types.

npm's current `react-router` is `8.4.0`. The spec requires React Router v7 as a library. Pin `7.18.4`, the latest 7 release on 2026-10-07. Import `createBrowserRouter` and `RouterProvider` from `react-router`. Do not add `react-router-dom` or `@react-router/dev`.

| Package                  | Version  |
| ------------------------ | -------- |
| `react`                  | `19.3.0` |
| `react-dom`              | `19.3.0` |
| `react-router`           | `7.18.4` |
| `vite`                   | `8.3.3`  |
| `@vitejs/plugin-react`   | `6.1.2`  |
| `tailwindcss`            | `4.3.3`  |
| `@tailwindcss/vite`      | `4.3.3`  |
| `vitest`                 | `4.1.11` |
| `jsdom`                  | `30.1.1` |
| `@testing-library/react` | `16.3.3` |
| `@testing-library/dom`   | `10.4.2` |
| `axe-core`               | `4.13.0` |
| `@types/react`           | `19.3.0` |
| `@types/react-dom`       | `19.3.0` |

`@community-hub/ui` and `@community-hub/tokens` are `workspace:*`. `@testing-library/dom` is the peer `@community-hub/ui` already pins. `typescript` and `@types/node` match `packages/ui` (`^5.8.2` and `^22.13.10`). Dev dependencies are exact except those two ranges.

## Mock defaults

Provider 6.67.0 has no `region` attribute on `aws_cloudfront_origin_access_control`, `aws_cloudfront_response_headers_policy`, `aws_cloudfront_distribution`, `aws_route53_record`, `aws_iam_role`, or `aws_iam_role_policy`. Do not read `.region` on those. The absence of a `region` argument is the checker in Task 2, not a plan attribute.

These defaults fill computed attributes that other resources read, so `override_during = plan` can evaluate the asserts. They live only in `infra/modules/aws-admin-static/tests/admin.tftest.hcl`. Do not copy them into `infra/regions/au/tests/cell.tftest.hcl`. The cell already mocks `aws_acm_certificate` for the API certificate. Do not edit that block. If a cell run fails because `for_each` sees an unknown value, stop and report. Do not add these mocks to the cell file.

Do not default `bucket`, `id`, or `region` on the bucket. Do not default `name` on the origin access control. Do not default `domain_name` or `region` on the certificate. Do not default `price_class`, `is_ipv6_enabled`, `aliases`, `web_acl_id`, or `id` on the distribution. Do not add `mock_resource "aws_acm_certificate_validation"`: `certificate_arn` is an argument, and a default would hide a wrong value. The validation options below are an attribute of `aws_acm_certificate`.

```hcl
mock_provider "aws" {
  override_during = plan

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::mock-admin"
      bucket_regional_domain_name = "mock-admin.s3.ap-southeast-2.amazonaws.com"
    }
  }

  mock_resource "aws_cloudfront_origin_access_control" {
    defaults = {
      id = "E123MOCKOAC"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn            = "arn:aws:cloudfront::123456789012:distribution/MOCKDIST"
      domain_name    = "d111111abcdef8.cloudfront.net"
      hosted_zone_id = "Z2FDTNDATAQYW2"
    }
  }

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/mock-admin"
      domain_validation_options = [
        {
          domain_name           = "admin.example.net"
          resource_record_name  = "_mock.admin.example.net."
          resource_record_type  = "CNAME"
          resource_record_value = "_mock.acm-validations.aws."
        },
      ]
    }
  }
}
```

`hosted_zone_id` is CloudFront's published global zone id. The alias assert compares the record to the distribution attribute, so both sides are this mock value. It is not an account id.

The module test sets `zone_name = "example.net"`, so the certificate domain is `admin.example.net`. That string is the validation record's `for_each` key. `for_each` is `toset([local.hostname])`, not the certificate's `domain_validation_options`. Those options are unknown on a real plan, and `for_each` cannot take an unknown value. The cell plan stays known without the mocks above. The record name and records still read `one(aws_acm_certificate.admin.domain_validation_options)`.

## Comparisons

`keys()` returns a list. Compare it with `== ["StringEquals"]`, not with `toset`.

Set-typed attributes use `toset` or `one()`. Do not index a set with `[0]`.

- `aliases` is a set of strings. Compare with `toset`.
- `origin`, `custom_error_response`, `domain_validation_options`, `custom_headers_config.items`, the encryption `rule`, and the ownership `rule` are sets. Use `one()` or `toset`.
- `default_cache_behavior`, `security_headers_config`, and Route 53 `alias` are lists. `[0]` is valid there.
- `Action` may be a string when it has one element. Use `try(toset(action), toset([action]))`.
- Tags stay a map. Compare `tags["environment"]` and `tags["project"]`.

The response-headers resource does not store every header as one string. Assert the provider fields that serialize to the spec's strings. The reviewer's live check asserts the serialized headers.

| Header                      | Plan assert                                                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | `content_security_policy[0].content_security_policy` equals `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'`. `override` is true. |
| `Strict-Transport-Security` | `access_control_max_age_sec` is `31536000`, `include_subdomains` is true, `preload` is false, `override` is true. That is `max-age=31536000; includeSubDomains`.                                                                                            |
| `X-Content-Type-Options`    | The `content_type_options` block is present and `override` is true. Provider 6.67.0 has no string attribute for `nosniff`. The live check asserts `nosniff`.                                                                                                |
| `Referrer-Policy`           | `referrer_policy` equals `no-referrer` and `override` is true.                                                                                                                                                                                              |
| `X-Robots-Tag`              | `one(custom_headers_config[0].items)` has `header` `X-Robots-Tag`, `value` `noindex`, and `override` true.                                                                                                                                                  |

Do not set `frame_options`. `frame-ancestors` is inside the CSP string.

---

### Task 1: Static shell

**Files:**

- Create: `apps/admin/` (`package.json`, `vite.config.ts`, `index.html`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `src/index.css`, `src/main.tsx`, `src/labels.ts`, `src/shell.tsx`, `src/shell.test.tsx`, `src/fetch-source.test.ts`, `src/build-html.test.ts`)
- Create: `apps/admin/fixtures/calls-fetch.ts` and `apps/admin/fixtures/no-fetch.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: package `@community-hub/admin`. Scripts `lint`, `typecheck`, `test`, and `build` (`vite build`).
- Produces: `src/index.css` is `@import "tailwindcss";`, then `@import "@community-hub/tokens/tokens.css";`, then `@import "@community-hub/ui/theme.css";`.
- Produces: one route, `/`, from `createBrowserRouter`. One `h1`, `Dashboard`. One `Button` from `@community-hub/ui` with accessible name `Refresh`. Its click handler calls `window.location.reload` and does not call `fetch`.
- Produces: `nav` with accessible name `Admin`. `labels` is the 16 frozen strings in order, including the spelling `Enquires`. Only Dashboard is rendered, as a link to `/`.

**Rule this must not break:** the built `index.html` has no inline script and no inline style. The app does not call `fetch` and does not name a person.

- [ ] **Step 1: Write the failing tests**

`shell.test.tsx` renders the shell in jsdom:

- The nav has one link, Dashboard, to `/`.
- `labels` equals the 16 strings in the spec, in that order. Each of the other 15 is absent from the document.
- There is one `h1`, Dashboard.
- The button's accessible name is Refresh.
- Axe reports no violations. Disable `color-contrast`, the same way `packages/ui/src/button.a11y.test.tsx` does. A button fixture with no accessible name fails `button-name`.
- Replace `fetch` with a spy that throws. Render, then `fireEvent.click` the Refresh button. The spy was not called. Stub `window.location.reload` and assert it was called. Do not add `@testing-library/user-event`.

`fetch-source.test.ts` lives in `apps/admin/src`, the directory it scans. The scan skips `*.test.ts` and `*.test.tsx`, and fails if any other file there contains `fetch(`. The fixtures prove the rule: `fixtures/calls-fetch.ts` fails and `fixtures/no-fetch.ts` passes.

`build-html.test.ts` runs `vite build` and reads `dist/index.html`. Every `script` has `src`. No `src` contains `://`. There is no `style` element and no `style` attribute.

A source test reads `src/index.css` and asserts the three import lines, in that order.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm --filter @community-hub/admin test`

Expected: fail because the app does not exist yet.

- [ ] **Step 3: Implement the shell**

Vite config uses `@vitejs/plugin-react` and `@tailwindcss/vite` only. `index.html` has one module script whose `src` is `/src/main.tsx`, and no inline script or style.

Do not put `fetch(` in `src`, including comments, except in `*.test.ts` and `*.test.tsx`. The scan skips those two suffixes. Fixtures stay under `apps/admin/fixtures/` so the root ESLint ignore skips them.

- [ ] **Step 4: Format, gate, and commit**

Prettier on the TypeScript and CSS. Then:

`pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/admin && pnpm check:boundaries`

```
feat(admin): add the static shell
```

---

### Task 2: Viewer-certificate region

**Files:**

- Modify: `tooling/checks/terraform-invariants/check.ts`
- Modify: `tooling/checks/terraform-invariants/selftest.ts`
- Create: fixtures under `tooling/checks/terraform-invariants/fixtures/`

**Interfaces:**

- Produces: `"us-east-1"` is allowed only when the file is under `infra/modules/aws-admin-static` and the resource is `aws_acm_certificate.admin` or `aws_acm_certificate_validation.admin`. `"ap-southeast-4"` stays allowed only on the two envelope replica resources. Every other `region` argument on a resource or a provider is exactly `var.aws_region`. The message stays `region argument must be var.aws_region`.

**Rule this must not break:** `region-us-east-1` still fails. The Melbourne replica fixture still passes. A provider region is never `us-east-1`.

- [ ] **Step 1: Write the failing fixtures**

Add must-pass `viewer-certificate`: under `infra/modules/aws-admin-static`, the two certificate resources set `region = "us-east-1"`, a bucket sets `region = var.aws_region`, and a `aws_cloudfront_distribution` sets no `region`.

Add these to `mustFail` and to `regionFixtures`:

- `admin-bucket-us-east-1`: a bucket in that module with `region = "us-east-1"`.
- `admin-cloudfront-us-east-1`: a distribution in that module with `region = "us-east-1"`. The provider schema has no such attribute. The checker still rejects the argument.
- `region-provider-us-east-1`: `provider "aws"` with `region = "us-east-1"`.

- [ ] **Step 2: Run the self-test and confirm the new must-pass fails**

Run: `pnpm --filter @community-hub/check-terraform-invariants test`

Expected: `viewer-certificate` fails before the allow-list exists. The three new must-fail fixtures already fail.

- [ ] **Step 3: Allow the two certificate resources**

Mirror `isMelbourneReplica`. Do not allow `"us-east-1"` on a bucket, a provider, a CloudFront resource, a Route 53 record, or an IAM resource.

- [ ] **Step 4: Format, gate, and commit**

Prettier on the TypeScript. Then the gate, with `--filter @community-hub/check-terraform-invariants`.

```
feat(checks): allow-list the viewer certificate region
```

---

### Task 3: Static site module

**Files:**

- Create: `infra/modules/aws-admin-static/` (`versions.tf`, `variables.tf`, `main.tf`, `outputs.tf`, `.tflint.hcl`, `.terraform.lock.hcl`, `tests/admin.tftest.hcl`)

**Interfaces:**

- Produces: `local.hostname` is `admin.${var.zone_name}`.
- Produces: `aws_s3_bucket.admin` named `${var.name}-admin`, `region = var.aws_region`, no versioning, `force_destroy` unset. Public access block all four flags true. Ownership `BucketOwnerEnforced`. Encryption `AES256` and `kms_master_key_id` null. The same `region = var.aws_region` on the public access block, the encryption configuration, the ownership controls, and the bucket policy.
- Produces: origin access control type `s3`, signing behavior `always`, protocol `sigv4`. The bucket policy is one statement: `s3:GetObject` only, principal service `cloudfront.amazonaws.com`, condition `AWS:SourceArn` the distribution ARN. `keys(Condition)` equals `["StringEquals"]`.
- Produces: distribution `PriceClass_All`, `is_ipv6_enabled` false, `default_root_object` `index.html`, HTTPS redirect, `minimum_protocol_version` `TLSv1.2_2021`, aliases the hostname. No `web_acl_id`, no `logging_config`, no `custom_error_response`, no function association, and no Lambda association.
- Produces: `aws_acm_certificate.admin` and `aws_acm_certificate_validation.admin` set `region = "us-east-1"`. Validation record `for_each = toset([local.hostname])`, so the address key is the hostname. Alias `aws_route53_record.admin` is type A. No AAAA resource. CloudFront, Route 53, and IAM set no `region`. No provider block in this module.
- Produces: output `publish_policy`, the role document in Task 4. Output `bucket_name`, `distribution_id`, and `distribution_arn`.

**Rule this must not break:** the bucket is not public and is not encrypted with the envelope key. A missing object is not rewritten to `index.html`.

Copy `versions.tf` and `.tflint.hcl` from `infra/modules/aws-budgets`. `aws_region` validates `ap-southeast-2`, the same shape as the envelope module. Tags `environment` and `project` go on the bucket, the distribution, and the certificate only.

- [ ] **Step 1: Write the failing asserts**

Run `happy` is `command = plan` with `name = "ch-staging"`, `environment = "staging"`, `project = "community-hub"`, `aws_region = "ap-southeast-2"`, `zone_name = "example.net"`, and `zone_id = "ZMOCKZONE"`.

Add the mock provider from Mock defaults. Assert:

- `aws_s3_bucket.admin.bucket` is `ch-staging-admin` and `region` is `ap-southeast-2`. The four attached S3 resources also have `region` `ap-southeast-2`.
- Public access flags are true. `one(ownership.rule).object_ownership` is `BucketOwnerEnforced`. `one(encryption.rule)` uses `AES256` and a null KMS key.
- The bucket policy action set equals `toset(["s3:GetObject"])`. The principal is not `"*"`. `keys(Condition)` equals `["StringEquals"]` and `keys(Condition.StringEquals)` equals `["AWS:SourceArn"]`. The value equals the mock distribution ARN.
- Origin is a set: `one(origin).domain_name` equals the mock regional domain, and `one(origin).origin_access_control_id` equals `E123MOCKOAC`.
- `aliases` equals `toset(["admin.example.net"])`. `price_class` is `PriceClass_All`. `is_ipv6_enabled` is false. `web_acl_id` is null. `length(logging_config)` is 0. `length(custom_error_response)` is 0.
- The five header asserts in Comparisons. `override` is true on each.
- Certificate `region` is `us-east-1` and `domain_name` is `admin.example.net`. Validation `region` is `us-east-1` and `certificate_arn` equals the mock certificate ARN.
- `aws_route53_record.validation["admin.example.net"].name` is `_mock.admin.example.net.`. Its type is `CNAME`. Its records equal `toset(["_mock.acm-validations.aws."])`.
- `aws_route53_record.admin.type` is `A`. `alias[0].name` equals the mock distribution domain. `alias[0].zone_id` equals `Z2FDTNDATAQYW2`. `records` is null.
- `jsondecode(output.publish_policy)` has three statements. The action set equals `toset(["s3:ListBucket", "s3:PutObject", "s3:DeleteObject", "cloudfront:CreateInvalidation"])`. List uses the mock bucket ARN. Put and delete use that ARN plus `/*`. Invalidation uses the mock distribution ARN. There is no other action.

Do not read `.region` on the distribution, the origin access control, the headers policy, or either Route 53 record.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `terraform -chdir=infra/modules/aws-admin-static init -backend=false && terraform -chdir=infra/modules/aws-admin-static test`

Expected: fail because the resources do not exist yet. Commit the lockfile `init` writes.

- [ ] **Step 3: Add the module**

`publish_policy` is `jsonencode` of the three statements, using `aws_s3_bucket.admin.arn` and `aws_cloudfront_distribution.admin.arn`. No condition block.

The validation record's name, type, and records come from `one(aws_acm_certificate.admin.domain_validation_options)`. The `for_each` key stays `local.hostname`.

- [ ] **Step 4: Format, gate, and commit**

`terraform fmt -recursive` under `infra/modules/aws-admin-static`. Then `terraform test` in that module, and `pnpm check:boundaries`.

```
feat(admin): add the static site module
```

---

### Task 4: Cell and publish role

**Files:**

- Modify: `infra/regions/au/main.tf`
- Modify: `infra/regions/au/outputs.tf`
- Modify: `infra/regions/au/tests/cell.tftest.hcl`
- Modify: `tooling/checks/terraform-invariants/selftest.ts`

**Interfaces:**

- Produces: `module.admin_static` with `count = local.image_publish_count`, source `../../modules/aws-admin-static`. `zone_name` is the same expression the ingress module already uses. `zone_id` is `var.staging_zone_id`. `name` is `local.name`. No new hosted zone and no second OIDC provider.
- Produces: `aws_iam_role.admin_publish` and `aws_iam_role_policy.admin_publish`, same count. Role name `ch-staging-admin-publish`. The trust principal is `aws_iam_openid_connect_provider.github[count.index].arn`. The role policy is `module.admin_static[count.index].publish_policy`.
- Produces: output `admin_bucket` is `one(module.admin_static[*].bucket_name)`. Output `admin_distribution_id` is `one(module.admin_static[*].distribution_id)`. Both set `sensitive = true`, so `terraform apply` does not print them. `terraform output -raw` still returns each value.

**Rule this must not break:** the image publish role, its trust, and the GitHub provider are unchanged. Prod still plans zero of these resources.

The cell test decodes the trust policy only. It does not decode `aws_iam_role_policy.admin_publish[0].policy`. That document contains the distribution ARN, which is computed, and the cell file has no distribution mock. An unknown policy fails the assert. Task 3 already decodes `publish_policy` under the module mock, and the role attaches that output.

- [ ] **Step 1: Write the failing asserts**

On `staging_image_publish`, assert length 1 for the module, the role, and the role policy. Decode `assume_role_policy`. One statement. Effect `Allow`. Action `sts:AssumeRoleWithWebIdentity`. Principal `Federated` equals the GitHub provider ARN. `keys(Condition)` equals `["StringEquals"]`. `Condition.StringEquals` equals the map in the spec, with `100000000001` and `100000000002`.

On `prod_tfvars`, assert those three lengths are 0.

Terraform test cannot see the sensitive flag. A file assert in `tooling/checks/terraform-invariants/selftest.ts` reads `infra/regions/au/outputs.tf` and requires `sensitive = true` inside the `admin_bucket` block and inside the `admin_distribution_id` block.

Do not add a mock block.

- [ ] **Step 2: Run the cell test and confirm the new asserts fail**

Run: `terraform -chdir=infra/regions/au test -filter=tests/cell.tftest.hcl`

Expected: the new asserts fail. Existing runs stay green except where they now plan a missing module. If a run fails for an unknown `for_each`, stop.

Run: `pnpm --filter @community-hub/check-terraform-invariants test`

Expected: the `outputs.tf` assert fails because the two outputs do not exist yet.

- [ ] **Step 3: Wire the cell**

Do not set `region` on the role or the role policy. Do not add a provider.

- [ ] **Step 4: Format, gate, and commit**

`terraform fmt -recursive` under `infra/regions/au`. Then `terraform test` in `infra/regions/au` and in the module, `pnpm test --filter @community-hub/check-terraform-invariants`, and `pnpm check:boundaries`.

```
feat(admin): attach the publish role in the cell
```

---

### Task 5: Publish job

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `tooling/checks/image-publish/workflow-check.ts`
- Modify: `tooling/checks/image-publish/workflow.test.ts`
- Modify: every existing file in `tooling/checks/image-publish/fixtures/`
- Create: the five new fixtures named below

**Interfaces:**

- Produces: job `admin-publish`. `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`. `needs: [static, test]`. Permissions `contents: read` and `id-token: write`. Concurrency group `admin-publish`, `cancel-in-progress: false`. `runs-on: ubuntu-latest`.
- Produces: `uses` pinned to the same SHAs as job `publish`: `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` and `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`. Then `corepack enable`. No `pnpm/action-setup`.
- Produces: `id-token: write` exactly twice in the file, once in `publish` and once in `admin-publish`, and not under the workflow `permissions`.
- Produces: the Terraform matrix includes `infra/modules/aws-admin-static`. The workflow-level cancel rule is unchanged.

**Rule this must not break:** a pull request does not assume the role. Job `test` does not contain `ADMIN_PUBLISH_ROLE_ARN` or `assume-role-with-web-identity`. The image publish job is unchanged.

The two upload commands, assets first:

```bash
aws s3 sync apps/admin/dist/assets "s3://${ADMIN_BUCKET}/assets" --delete --only-show-errors --cache-control "public, max-age=31536000, immutable" --region ap-southeast-2
aws s3 cp apps/admin/dist/index.html "s3://${ADMIN_BUCKET}/index.html" --only-show-errors --cache-control "no-cache" --region ap-southeast-2
```

`--delete` removes stale objects under `assets/` only. The `index.html` copy does not delete anything. A stale object outside that prefix stays.

Every other `aws` call in the job uses `--query`, including assume-role and `aws cloudfront create-invalidation` of `/` and `/index.html`. Mask the role ARN's account segment with `::add-mask::` before any AWS call. Mask the token. The `EXIT` trap removes the token file, the response file, and the credential file. Do not print the token, the role ARN, the bucket name, the distribution id, or the account id. Printing `sub`, `ref`, and `job_workflow_ref` matches the image job.

Build with `pnpm --filter @community-hub/admin build` on that runner. Do not download an artifact from the test job. A pull request already builds the app because Task 1's build test runs inside `pnpm test`.

- [ ] **Step 1: Write the failing checker tests**

Change the id-token rule to: the workflow header does not contain `id-token: write`, the file contains it exactly twice, `publish` contains it once, and `admin-publish` contains it once. Otherwise `workflow-id-token`.

Add:

- `admin-publish-without-needs` when the job block does not contain `needs: [static, test]`.
- `admin-publish-floating-uses` when a `uses:` in that job is not `owner/repo` plus a 40-character SHA.
- `admin-publish-concurrency` when the group is not `admin-publish` or `cancel-in-progress` is not false.
- `admin-publish-sync` when the sync line is missing `dist/assets`, `--delete`, `--only-show-errors`, or `public, max-age=31536000, immutable`, or the cp line is missing `index.html`, `--only-show-errors`, or `no-cache`, or the cp line contains `--delete`, or the sync line does not appear before the cp line.
- `admin-publish-query` inside the `admin-publish` job only. Join lines that end with a backslash, then flag a logical command where `aws` is the command word (the start of the command, or after `$(` or a pipe), that is not `aws s3 sync` or `aws s3 cp`, and that has no `--query`.

Each new fixture is a passing workflow plus that one defect. Add a valid `admin-publish` job to every existing fixture so each still fails with exactly one id. Assert the real `ci.yml` passes, and assert job `test` does not mention the admin role.

Add a must-pass case. It contains `command -v aws >/dev/null` and one multi-line `aws` command whose `--query` is on a later line. That case does not report `admin-publish-query`.

- [ ] **Step 2: Run the checker tests and confirm they fail**

Run: `pnpm --filter @community-hub/image-publish test`

Expected: the real workflow fails `workflow-id-token` until the job exists. Each new fixture fails only its own id.

- [ ] **Step 3: Add the job and the matrix entry**

Secrets are `ADMIN_PUBLISH_ROLE_ARN`, `ADMIN_BUCKET`, and `ADMIN_DISTRIBUTION_ID`. If either is empty, exit 1 with a fixed sentence that does not include the value. `command -v aws >/dev/null` must succeed. Assume-role session name `admin-publish`, `--region ap-southeast-2`, and a `--query` on the credentials. A multi-line `aws` command may put `--query` on a continuation line. Do not write a 12-digit account id into the workflow. The account-id rule fails the file if one appears.

- [ ] **Step 4: Format, gate, and commit**

Prettier on the TypeScript and YAML. Then the gate, with `--filter @community-hub/image-publish`.

```
ci(admin): publish the shell on main
```

The human applies the commit this task produces, unless a review fix lands on top. Task 6 records the SHA that was actually applied. Do not write a SHA into this plan.

---

## Human

The reviewer runs this read-only plan before the apply, from `infra/regions/au`, profile `ch-admin`, both var files, the gitignored file last. The reviewer does not apply.

```bash
terraform init -backend-config=backend/staging.hcl -lockfile=readonly
```

```bash
terraform plan -lock=false -detailed-exitcode -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
```

Detailed exit code 2 is expected. Exit 0 or 1 is a stop. The change set is exactly these 14 addresses, all added, 0 changed, 0 destroyed. `is_ipv6_enabled` is false. There is no AAAA alias. There is no `terraform_data`. Any other address is a stop.

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

The validation key is `admin.` concatenated with the zone name the cell passes. The API, the database, the task, and the envelope key are not in the change set.

The human then applies that same plan, profile `ch-admin`, both var files, the gitignored file last. The agent does not apply.

After the apply, the human checks out that SHA in the apply worktree and syncs with `ch-admin`. From that worktree root, build first. Capture the bucket and do not print it. Do not run `terraform output` without a capture. The output commands read the state bucket, so they set `AWS_PROFILE=ch-admin`.

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm --filter @community-hub/admin build
```

```bash
bucket=$(AWS_PROFILE=ch-admin terraform -chdir=infra/regions/au output -raw admin_bucket)
```

```bash
aws s3 sync apps/admin/dist/assets "s3://${bucket}/assets" --delete --only-show-errors --cache-control "public, max-age=31536000, immutable" --region ap-southeast-2 --profile ch-admin
```

```bash
aws s3 cp apps/admin/dist/index.html "s3://${bucket}/index.html" --only-show-errors --cache-control "no-cache" --region ap-southeast-2 --profile ch-admin
```

Those are the job's two commands. `--profile ch-admin` and the captured bucket are the only differences. Assets run before `index.html`. The sync deletes stale objects under `assets/` because of `--delete`. The `index.html` copy does not delete anything.

The reviewer, not the agent, then loads `https://admin.<zone>/`. If the first response is still the pre-upload 403, wait out CloudFront's short error cache and reload once. Do not add an invalidation command here. Check the heading Dashboard, one nav link, the five response headers, and a console with no policy violation.

The human sets `ADMIN_PUBLISH_ROLE_ARN`, `ADMIN_BUCKET`, and `ADMIN_DISTRIBUTION_ID` after the apply and before merge. Capture the distribution id the same way as the bucket, and do not print it.

```bash
distribution_id=$(AWS_PROFILE=ch-admin terraform -chdir=infra/regions/au output -raw admin_distribution_id)
```

The values are not written into the repo, the runbook, or the pull request.

From this applied commit on: no rebase, no amend, and no force-push.

---

### Task 6: Record the apply

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Produces: a section after the Melbourne key replica. It records the SHA that was applied, the 14 addresses, that IPv6 is off, that there is no AAAA record and no `terraform_data`, and the reviewer's four checks.

**Rule this must not break:** the section does not record a certificate ARN, a distribution id, a bucket name, a role ARN, or an account id.

- [ ] **Step 1: Stop if the human has not pasted the apply**

The paste names the SHA, `14 added, 0 changed, 0 destroyed`, and the four checks. If it is missing, stop. Do not invent it.

- [ ] **Step 2: Write the section and commit**

Prettier on the Markdown.

```
docs(runbooks): record the admin shell
```

---

### Task 7: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Produces: the `admin-shell` row is done and links `docs/specs/2026-10-07-admin-shell.md`. The row says the shell is static, Dashboard only, and makes no data call.
- Produces: snapshot Phase stays `1 — Core platform`. Last shipped becomes `admin-shell`. Next chunk becomes `tenancy-implicit-org`. Phase 0 stays `23 rows: 22 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stays `not started`. The sentence under the Phase 0 table names `tenancy-implicit-org`. The Next spec section names `tenancy-implicit-org`.
- Produces: two AGENTS.md edits. The repository-state sentence names `tenancy-implicit-org` and leaves the Phase 0 counts unchanged. §10 Stage 3 gains one sentence: a pull request builds the admin shell and does not upload it, and a push to `main` publishes it.

**Rule this must not break:** no other AGENTS.md sentence changes. `architecture.md` is not edited.

- [ ] **Step 1: Update the catalogue and commit**

Prettier on the Markdown. Then open the pull request and stop.

The PR body says it merges with a merge commit. It includes the screenshot and the reviewer's four checks. The second fresh-context review line stays open. The agent does not merge.

```
docs(roadmap): mark the admin shell done
```
