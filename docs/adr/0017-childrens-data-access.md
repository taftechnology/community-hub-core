# ADR 0017: Children's data access

- Status: accepted (2026-11-04, Abdus Salam)
- Date: 2026-11-04
- Spec: `docs/specs/2026-11-04-owner-decisions.md`
- Amends: architecture §7.6 (check-in polling example), §11.3, §11.4, §12.3, and the safeguarding feature scope in §8.1

## Context

Family Records and Life events on `main` let any caller with `people.restricted.read` read minors' details. Platform support access can read tenant data under a grant or break-glass. Architecture §12.3 still described check-in and check-out. The owner decided on 2026-11-04 that check-in is not built and that minor visibility is much narrower.

## Decision

1. **No check-in.** Core does not build check-in, check-out, pickup codes, or a kiosk.
2. **Guardian entry.** A child's details are entered by their parent or guardian through member surfaces (portal / Parish Hub).
3. **Who may read a minor's details.** Only the child's guardian (`guardian_of(person)`) and a user holding the `community_admin` role. No other staff role or permission (including `people.restricted.read`) grants access to a minor's details.
4. **Support and break-glass.** Support operators never read a minor's details, even under a time-boxed support grant or break-glass.
5. **Community Admin UX.** For `community_admin`, each restricted field is hidden by default. The admin reveals one field at a time with a View control. Every View requires a fresh second-factor check. Every View writes an audit event with target ids only (no field values).
6. **Second factor.** Tenant identity does not yet expose a second-factor step for staff View actions. The method (authenticator app or email code) is open (architecture §26 Q20). The children's data access chunk is blocked until that decision lands.
7. **Known gap.** Until this chunk ships, `main` remains broader than this rule (for example Family Records and Life events). No client data may be imported until the gap closes.

## Consequences

- Family Records and Life events must change: they cannot treat `people.restricted.read` as sufficient to show minors to non-guardian staff.
- `people.restricted.read` no longer reveals a minor's details to roles that are not the guardian or `community_admin` under the View rules above.
- Support grant and break-glass flows must exclude minors' details from scope and from implementation.
- Identity must gain a second-factor verification path for tenant users before Community Admin View ships.
- Audit must record one event per View with ids only.
- Architecture §10.2 example entitlement `safeguarding.checkin` should not be read as a commitment to ship check-in.
- Compliance text that mentioned check-in controls is updated to match (architecture §21).

## Alternatives considered

- **Keep check-in.** Rejected: owner decision 2026-11-04; Laravel had no check-in and core will not add it.
- **Let `people.restricted.read` see minors for safeguarding or staff roles.** Rejected: only guardian and `community_admin` (with per-field View) may see minors' details.
- **Let break-glass or support grants read minors for emergencies.** Rejected: support operators never read minors' details, even under grant or break-glass.

## Architecture sections amended

| Section                       | Change                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| §7.6 Live screens poll        | Remove check-in as an example; live attendance and dashboards may still poll                      |
| §8.1 `safeguarding/`          | Incidents and messaging rules only; no check-in/out                                               |
| §11.3 Roles                   | Minor visibility limited to guardian and `community_admin` with View + second factor              |
| §11.4 Platform support access | Grants and break-glass exclude minors' details                                                    |
| §12.3 Children product rules  | Replace check-in rule with guardian entry and Community Admin View rules                          |
| §12.2 / §12.4                 | Align adult/minor read rules with this ADR where they mention `people.restricted.read` for minors |
