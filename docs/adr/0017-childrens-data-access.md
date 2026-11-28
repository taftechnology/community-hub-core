# ADR 0017: Children's data access

- Status: accepted (2026-11-04, Abdus Salam)
- Date: 2026-11-04
- Spec: `docs/specs/2026-11-04-owner-decisions.md`
- Implemented: 2026-11-28 by `Children's data access` (spec `docs/specs/2026-11-28-childrens-data-access.md`, plan `docs/plans/2026-11-28-childrens-data-access.md`)
- Amends: architecture §7.6 (check-in polling example), §11.1, §11.3, §11.4, §12.3, and the safeguarding feature scope in §8.1

## Context

Family Records and Life events on `main` let any caller with `people.restricted.read` read minors' details. Platform support access can read tenant data under a grant or break-glass. Architecture §12.3 still described check-in and check-out. The owner decided on 2026-11-04 that check-in is not built and that minor visibility is much narrower.

## Decision

1. **No check-in.** Core does not build check-in, check-out, pickup codes, or a kiosk.
2. **Guardian entry.** A child's details are entered by their parent or guardian through member surfaces (portal / Parish Hub).
   - Status note (O2, project owner, 2026-11-28): member surfaces do not exist yet. Until they ship, the admin's Add minor is allowed to a `community_admin` only. Guardian self-entry ships with the member portal / Parish Hub.
3. **Who may read a minor's details.** Only the child's guardian (`guardian_of(person)`) and a user holding the `community_admin` role. No other staff role or permission (including `people.restricted.read`) grants access to a minor's details.
   - Status note (O4, project owner, 2026-11-28): this chunk ships the Community Admin part only. A child's fields are removed from `readPersonForActor` and every other reader, so there is no guardian read path until the member-portal chunk builds one against this point. That also closes the path on `main` where a guardian holding `people.view` reached a child through `POST /v1/people/read`. It is narrower than this point allows, never wider. `org_owner` and `org_admin` read a child's details only in a community where they also hold `community_admin`; bootstrap grants that role in the first community. `people.restricted.read` now means adults only.
4. **Support and break-glass.** Support operators never read a minor's details, even under a time-boxed support grant or break-glass. This narrows the support-operator case in [ADR 0009](docs/adr/0009-personal-data-on-aws.md); architecture §7.3 states it by reference.
5. **Community Admin UX.** For `community_admin`, each field is hidden by default. The admin reveals one field at a time with a View control. Every View requires a fresh second-factor check. Every View writes an audit event with target ids only (no field values).
6. **Second factor (refined later on 2026-11-04).** Every user of the admin app must set up a second factor — an authenticator app (for example Google Authenticator), a passkey, or a code sent by email — during sign-up before they can use the admin. Users who already exist or arrive through the Laravel import must set one up at their next sign-in before they can continue. The fresh check before a Community Admin views a child's field uses whichever second factor that admin has enrolled.
   - Status note: Refined by [ADR 0022](docs/adr/0022-second-factor-for-staff.md) (2026-11-26): email code is not a second factor; the fresh check uses an authenticator app or a user-verified passkey, never a backup code.
7. **Other staff and child presence (refined later on 2026-11-04).** Staff other than the child's guardian and `community_admin` may see that a household has a child, but no information about the child: no name, no date of birth, and no other field.
   - Status note (O3, project owner, 2026-11-28): a family's label is an adult-level field and must not carry a child's given name. In a family that has a child (a hidden child counts), only a `community_admin` may rename it. The server refuses a label that contains a child's given name as a whole word (NFKC, accents folded, given names only, a name shared with an adult member of the family skipped) with `422 label_contains_child_name`, on rename, on add-minor and on a direct create. Both family forms say "Use the family name. Don't include a child's name." Nicknames and other free-text forms of a child's name are a residual the check cannot see.
8. **Known gap.** Until this chunk ships, `main` remains broader than this rule (for example Family Records and Life events). No client data may be imported until the gap closes.
   - Status note (2026-11-28): the gap is closed by `Children's data access`. See the implementation note below.

## Implementation note (2026-11-28)

`Children's data access` implements points 3, 5 and 7 as follows (decisions D1 to D6 of its spec).

- **Who views.** A Community Admin only: the `community_admin` role in that community, checked before the check is used up and again before the value is read. `org_owner`, `org_admin`, `safeguarding_officer` and custom roles holding `people.restricted.read` do not. Everyone else who can see a household sees a child count only, and no id, label, name, date of birth, email, phone, guardian link, group membership or life event of a child.
- **The View.** Each field has its own View (the name too, and each life-event field). Each View needs a fresh second-factor check and uses it up, so the next View needs a new check. A backup-code (recovery) session never views. A refusal before the check (entitlement, role, unknown child) never uses the check up. A correct check gives back its attempt, so only refused codes count ([ADR 0022](docs/adr/0022-second-factor-for-staff.md) point 2). The answer carries `Cache-Control: no-store`.
- **Audit.** One ids-only row per View, action `people.minor.field_viewed`, with the purpose `people.minor_view.<field>`. A refused View writes a denial row.
- **Entitlement.** The View routes answer the shared empty 403 when `people.households` is off, as every household route does.
- **Writes about a child.** Add minor, guardian link and unlink, life-event create and update, and the rename of a family with a child need `community_admin`. A child's id answers as a missing person to a caller who guesses it, on every route.
- **The admin.** The capabilities answer carries `roles.communityAdmin`, and the admin uses it to show the Minors tab, Add minor, the rename control and the child rows.

## Consequences

- Family Records and Life events must change: they cannot treat `people.restricted.read` as sufficient to show minors to non-guardian staff.
- `people.restricted.read` no longer reveals a minor's details to roles that are not the guardian or `community_admin` under the View rules above.
- Support grant and break-glass flows must exclude minors' details from scope and from implementation.
- A **Two-factor for staff** chunk (sensitive, authentication) must ship before or with the children's data access chunk so every admin user completes mandatory second-factor enrolment at sign-up (or at next sign-in for existing and imported users) and Community Admin View can verify it.
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
| §11.1 Identity                | Mandatory second factor at admin sign-up; existing and imported users at next sign-in             |
| §11.3 / §12.3                 | Other staff may see child presence in a household only, with no child fields                      |
| §11.3 Roles                   | Minor visibility limited to guardian and `community_admin` with View + second factor              |
| §11.4 Platform support access | Grants and break-glass exclude minors' details                                                    |
| §12.3 Children product rules  | Replace check-in rule with guardian entry and Community Admin View rules                          |
| §12.2 / §12.4                 | Align adult/minor read rules with this ADR where they mention `people.restricted.read` for minors |
