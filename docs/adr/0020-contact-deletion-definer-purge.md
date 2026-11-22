# ADR 0020: Contact deletion through a definer purge function

- Status: accepted (2026-11-22, Abdus Salam)
- Date: 2026-11-22
- Spec: docs/specs/2026-11-22-contact-delete.md

## Context

The owner decided that deleting a contact hides it first, that staff with the delete permission can restore it for 30 days, and that after that it is deleted permanently with its group memberships, guardian links, tags, history and life events, keeping audit rows with ids only. Core could not delete a contact at all. Every foreign key to `app.persons` is `ON DELETE RESTRICT` (eight of them), and the `app` role has no `DELETE` on `app.persons`, `app.person_activity`, `app.life_events` or `app.households` (migrations `0005`, `0017`). Architecture §12.4 says retention runs as a scheduled job in the regional service, and that scheduler does not exist yet.

## Decision

1. **Hide, then purge.** `app.persons` gains `deleted_at` and `deleted_by`. A hidden contact is left out of every read and refused by every write. A trigger allows `deleted_at` to be set only to the database's `now()`, or cleared, and never on a minor, so the `app` role cannot back-date a hide.
2. **One `SECURITY DEFINER` function is the only way a contact is deleted.** `app.purge_deleted_persons(p_limit)` is owned by the migrator, runs with `SET search_path = pg_catalog, app`, and has `EXECUTE` revoked from `PUBLIC` and granted to `app`. The `app` role gets no new `DELETE` grant. The function raises without a tenant scope or with a limit outside 1 to 50. It selects adults of the scoped organisation and community hidden for 720 hours or more by the database clock, skips anyone with a user link, a live pending invitation, or a child for whom they are the only guardian, and deletes the dependants explicitly before the persons rows. The tables keep `FORCE ROW LEVEL SECURITY` and the migrator has no `BYPASSRLS`, so the function is tenant-scoped by its own predicates and by RLS.
3. **Opportunistic sweep until the scheduler exists.** The API calls the function, at most 50 contacts per run, after a successful contact list, delete or restore in a writable community, in its own transaction. One `people.person.purged` audit event, actor `system`, lists the purged ids.
4. **Fail closed.** Delete is refused for a contact linked to a user account, with a live pending invitation, or who is a child's only guardian. Deleting a child is deferred to `Family Records parity`.

## Consequences

- A community with no contact list, delete or restore keeps a hidden contact past 30 days. The regional scheduler chunk replaces the opportunistic sweep with a scheduled job that calls the same function.
- Any future table with a foreign key to `app.persons` must be handled in the function, or the purge raises. A test reads the catalog and fails on an unhandled foreign key.
- The foreign keys stay `RESTRICT`, so a delete nobody planned is still blocked.
- Purged rows remain in backups until backup retention ends. `identity.invitation_emails` may hold the address of a closed or expired contact invitation until the invitation sweep erases it.
- Unlike Laravel, contacts that are linked to a user, invited, or a child's only guardian cannot be deleted until that is resolved.

## Alternatives considered

- **`DELETE` grants to the `app` role.** Simpler, but any code path could hard-delete any contact of the tenant, visible or not. Rejected.
- **`ON DELETE CASCADE` foreign keys.** Fewer statements in the function, but re-adding the keys under FORCE RLS needs `NOT VALID` (as in `Membership foreign keys`), and a cascade widens every future accidental delete. Rejected.
- **Wait for the regional scheduler.** Would ship hide without purge, a delete that never deletes, against the owner's 30-day rule. Rejected.
