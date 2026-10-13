# ADR 0012: Entitlement visibility

- Status: accepted
- Date: 2026-10-12
- Spec: `docs/specs/2026-10-12-entitlements-plans.md`

## Context

Q14 asked how a request sees a plan, an entitlement, an allocation, or an override. The `platform` schema had one owner, `core/tenancy`.

## Decision

A request reads those rows from the `platform` schema on the platform login. The process cache is at most 60 seconds, keyed by organisation id and community id. The writer deletes its own key. There is no snapshot table and no propagation job. `core/tenancy` may query the schema for directory rows. `core/entitlements` may query it for plans, add-ons, entitlements, allocations, overrides, community toggles, and feature flags. No other module may.

## Consequences

`stripe-billing` writes the same tables from the webhook and does not publish a snapshot. Q8, plan contents and pricing, stays open. Q15, hard usage limits, stays open.

## Alternatives rejected

- **A snapshot table.** A second copy would need its own freshness rule.
- **A propagation job.** The writer would have to push a copy to every reader.
- **A feature-flag vendor.** Flags stay `platform` tables. Q12 is already closed.
