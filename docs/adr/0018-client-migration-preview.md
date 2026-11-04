# ADR 0018: Client migration through a production preview

- Status: accepted (2026-11-04, Abdus Salam)
- Date: 2026-11-04
- Spec: `docs/specs/2026-11-04-owner-decisions.md`
- Supersedes: architecture §24.2 steps that run the imported tenant in parallel on staging with Laravel still live, and §24.2 step 6 that securely deletes the self-hosted database and files

## Context

Architecture §24.2 had staff verify imports on staging, run core in parallel on staging while Laravel stayed live, and delete the client's self-hosted database after cutover. Staging holds synthetic or anonymised data only (architecture §23.1, AGENTS.md rule 7). A migration rehearsal on staging cannot use real client data.

## Decision

1. **Import all client data** into core in the production account (`prod-au`), in Australia only.
2. **Preview hostname.** After import, the client runs on a dedicated preview hostname in the production account so the client and the team can validate admin, mobile, and public behaviour against real data. The preview is production under AGENTS.md rule 7: real client data, production account, `ap-southeast-2` only, never staging.
3. **Cutover.** When the client signs off, switch public hostname, mobile, portal, and staff admin to core in one window. Take Laravel offline.
4. **Laravel backup.** Keep Laravel's backup after cutover, **encrypted in our AWS account in Sydney (`ap-southeast-2`)**, for **1 year after the client's switch-over**, then delete it. It does not leave Australia.
5. **No parallel staging production.** Real client data is not imported to or exercised on `staging-au`.
6. **No mandated delete of self-hosted data.** Decommission no longer requires securely deleting the self-hosted database as a platform step; Laravel's backup retention is decided in decision 4 (architecture §26 Q23 closed).

## Consequences

- The legacy importer runs against the production account for real migrations, with operational controls appropriate to production data.
- Staging remains synthetic or anonymised; migration proof on staging is limited to importer mechanics, not a client's live rows.
- Roadmap gates that assumed donate, form submit, and RSVP on staging with real-like data must be read in light of preview validation on production.
- Architecture §24.3 principles are updated: idempotent import rehearsal may use non-production data; sign-off uses the preview hostname.

## Alternatives considered

- **Parallel run on staging with a MySQL dump of the client.** Rejected: real client data must not run on staging (rule 7).
- **Delete self-hosted database immediately after cutover.** Rejected: owner keeps Laravel's backup in our Sydney AWS account for one year after switch-over, then deletes it.
