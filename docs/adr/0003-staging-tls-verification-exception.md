# ADR 0003: Staging-only TLS verification exception on Workers VPC

- Status: accepted
- Date: 2026-09-18
- Spec: `docs/specs/2026-09-18-terraform-au-cell.md`
- Expires when: Cloudflare Workers VPC services accept a custom CA, **or** a later spec moves production Hyperdrive to the Access + service-token origin.

## Context

Hyperdrive to private RDS uses a Workers VPC TCP service, not a public hostname. VPC services trust public CAs and Cloudflare Origin CA; they do not accept a custom CA upload. Amazon RDS certificates are issued by Amazon's CA, which is not in that set. `cert_verification_mode = verify_full` therefore fails Hyperdrive's create-time test connection against RDS.

`verify_full` is what stops a Tunnel-token holder from pointing their own `cloudflared` at their own Postgres, receiving Hyperdrive connections, collecting the application-role password, and accepting writes.

Sources checked 2026-09-18: [Workers VPC services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/), [Connect Hyperdrive via Workers VPC](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database-vpc/), [Hyperdrive SSL/TLS certificates](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/) (custom CA is Hyperdrive-native, not VPC), [`cloudflare_hyperdrive_config`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/hyperdrive_config) (`mtls` cannot combine with `origin.service_id`).

## Decision

- Keep Workers VPC. Do not switch this cell to Access + service token.
- Staging may set `cert_verification_mode = disabled`. Staging holds synthetic data only. The Tunnel token is still a top-tier secret (Secrets Manager, rotation, unexpected-connector alert).
- `environment = "prod"` must set `verify_full`. Terraform fails the plan otherwise. A production apply is blocked until this ADR expires.
- Do not upload the RDS CA to Hyperdrive. Pin `ca_cert_identifier` on the instance. RDS still requires SSL (`rds.force_ssl = 1`).

## Consequences

- First `staging-au` Hyperdrive apply can succeed. Production cannot, on purpose.
- A leaked staging Tunnel token is a staging-database impersonation, not a residency breach (no real people). Treat it as an incident anyway.
- Expiry is a product/architecture decision, not a silent flip of the staging tfvars.

## Alternatives rejected

- **Access + service-token origin now.** Would get `verify_full` via Hyperdrive's own TLS to a public hostname. Rejected for this chunk so we keep Workers VPC as the architecture default (D2).
- **`verify_full` on staging anyway.** Hyperdrive create fails against RDS until custom CA exists on VPC services. The cell would not come up.
- **`disabled` in production.** A Tunnel-token holder impersonates the database that holds real people. Forbidden.
