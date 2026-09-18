# ADR 0002: Terraform roots follow failure domains

- Status: accepted
- Date: 2026-09-18
- Spec: `docs/specs/2026-09-18-terraform-au-cell.md`

## Context

Architecture §8.1 previously split Terraform by vendor (`infra/cloudflare/` vs `infra/regions/au/`). That layout would share one Cloudflare state file across future cells and force Tunnel (Cloudflare) and Hyperdrive (needs the RDS hostname from AWS) to resolve across two applies.

Wrangler already owns Worker scripts, routes and bindings. Putting those in Terraform would fight Wrangler for DNS records on Worker custom domains.

## Decision

- One cell is one Terraform root: `infra/regions/<region>/`. Australia is `infra/regions/au/`. Adding Canada is a new root with its own state; Australia's state does not change.
- Account-level zone lives in `infra/global/`. Bootstrap (state bucket + KMS) is `infra/bootstrap/`.
- Wiring from global to a cell is zone ID and account ID as variables, not `terraform_remote_state`.
- Wrangler owns Worker scripts, routes and bindings. Terraform owns zones, DNS except records Wrangler creates for Worker custom domains, Regional Services settings, Tunnel, Hyperdrive, Workers VPC services, and AWS.
- For Worker custom-domain hostnames, Terraform owns only the Regional Services setting (`cloudflare_regional_hostname`). It does not declare competing DNS records.

## Consequences

- The AU cell graph can resolve Tunnel token → ECS and RDS hostname → Hyperdrive in one apply.
- `infra/cloudflare/` and empty `ca` / `eu` / `us` Terraform roots are not created.
- A vendor-split alternative would reintroduce the Tunnel ↔ Hyperdrive cycle and share Cloudflare blast radius across cells.

## Alternatives rejected

- **Vendor split (`infra/cloudflare` + `infra/regions/au`).** Shared Cloudflare state; two-apply cycle between Tunnel and Hyperdrive.
- **One root for the whole account.** A Canadian cell would share blast radius and state locking with Australia.
- **Terraform owns Worker routes.** Duplicate ownership with Wrangler; DNS fights on custom domains.
