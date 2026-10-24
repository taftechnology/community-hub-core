# ADR 0015: Interim single-owner recovery for operator passkeys

- Status: proposed
- Date: 2026-10-24
- Spec: `docs/specs/2026-10-22-ops-operator-identity.md` (O14, O15)
- Departs from: architecture §11.4 (recovery by two `platform_security` people)
- Review by: 2027-04-30, or when a second `platform_security` person joins, whichever is first

## Context

Architecture §11.4 says a platform operator who loses passkeys is recovered by two `platform_security` people, so no single person can restore operator access. Today there is one `platform_security` person, the owner. `ops-operator-identity` needs a recovery path before the ops console is used in production, and a two-person path cannot be operated by one person.

## Decision

1. Until two-person recovery is built, the owner alone recovers an operator through the owner-run `ops-operator` one-off, which calls `recoverOperator(userId, roleKeys, enrolmentCode)`.
2. Recovery revokes every grant and every `operator` and `enrolment` session of the user, deletes the user's ops-hostname passkeys, and grants again with a new 24-hour enrolment window and a new owner-generated enrolment code, in one transaction. The operator then enrols two new passkeys with an email code and the enrolment code.
3. Every recovery writes a `recovery_regrant` row in `identity.operator_events`, alongside the `revoked` and `granted` rows.
4. The `ops-console-api` runbook section for recovery exists before the first production use.
5. Two-person recovery replaces this path. On the review date, or when a second `platform_security` person joins, whichever is first, this ADR is superseded by one that builds it or records a new review date with a reason.

## Consequences

- One person can grant or recover any operator. Whoever controls the owner's account and the provision secret controls operator access. That is a single-person compromise risk, accepted for now and named in the spec's Risks.
- Recoveries are visible: `recovery_regrant` rows can be listed and reviewed.
- A recovered operator never regains a lost passkey: old ops credentials are deleted, so a found device cannot sign in.

## Alternatives rejected

- **Build two-person recovery now.** Not operable with one `platform_security` person.
- **No recovery until two people exist.** An operator who loses passkeys would be locked out of the console with no supported way back.
- **Recovery by email code.** Breaks §11.4's rule that an email code never starts or recovers a platform session.
