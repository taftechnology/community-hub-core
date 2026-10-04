# ADR 0010: AWS Budgets is a global billing exception

- Status: accepted
- Date: 2026-10-03
- Spec: `docs/specs/2026-10-03-foundations.md`
- Amends: the exception list in ADR 0009. ADR 0009 is not edited.

## Context

ADR 0009 allows four kinds of resource outside `ap-southeast-2`, and it says no others. AWS Budgets uses `https://budgets.amazonaws.com`, which AWS routes to `us-east-1`. The budget holds an amount and an alert address. It does not hold tenant data.

## Decision

AWS Budgets is allowed outside `ap-southeast-2`. The budgets module does not reuse the Sydney region validation for that API. The Sydney resources keep theirs.

## Consequences

Architecture §7.3 lists this exception. A filtered budget still waits until the `environment` cost-allocation tag is active.

## Alternatives rejected

- **Edit ADR 0009 in place.** That ADR is merged, and its list says "and no others."
- **An unfiltered account-wide budget.** One amount cannot be both the staging line and the production line.
