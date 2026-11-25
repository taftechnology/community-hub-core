# ADR 0021: Family deletion and household key purge

- Status: accepted (2026-11-24, Abdus Salam)
- Date: 2026-11-24
- Spec: docs/specs/2026-11-24-family-records-parity.md
- Extends: [ADR 0020](docs/adr/0020-contact-deletion-definer-purge.md)

## Context

Staff need to delete a family. Core cannot: the `app` role has no `DELETE` on `app.households` or `app.household_keys`, and all three foreign keys to `app.households` are `ON DELETE RESTRICT`. The household key seals the family label, the emergency contacts, and every restricted field and life event of a minor in the family. ADR 0020 set the pattern for contacts (hide, restore for 720 hours, purge through a definer function) and left deleting a child to `Family Records parity`. The owner decided on 2026-11-24 that a family with a child cannot be deleted, that its adults stay as contacts, that the family and its key are purged 720 hours after it is hidden, and that moving, editing and deleting a child wait for `Two-factor for staff` and `Children's data access`.

## Decision

1. **Hide, then purge.** `app.households` gains `deleted_at` and `deleted_by`. A hidden family is left out of every read and refused as a target by every write. Its adults keep `household_id` while it is hidden, so a restore brings them back, and they behave as contacts without a family until then. Restore is refused at 720 hours.
2. **Never with a child.** A family with any person whose `is_minor` is true cannot be hidden or purged. The delete checks after locking the household, a trigger refuses `deleted_at` while a minor is in the household, a trigger refuses placing a person in a hidden household, and the purge rechecks for a minor after locking the household and skips it.
3. **A second `SECURITY DEFINER` function is the only way a family and its key are erased.** `app.purge_deleted_households(p_limit)` has the same owner, search path, grants, scope checks and limit as `app.purge_deleted_persons`. It clears `household_id` on the remaining adults, then deletes the family's guardian links, key and row. The `app` role gets no `DELETE`.
4. **Same opportunistic sweep.** The API calls it after a successful family list, delete or restore in a writable community, in its own transaction, until the regional scheduler exists.
5. **Child items are deferred.** Moving, editing and deleting a child become their own chunk. ADR 0017 is not amended. Where ADR 0020 point 4 says deleting a child is deferred to `Family Records parity`, read that chunk instead; ADR 0020 itself is not edited.
6. **Emergency contacts are adult data.** The owner decided on 2026-11-24 that an emergency contact is by definition a designated adult responder, reached when guardians are unavailable. They are `restricted`, sealed under the household key, readable with `people.restricted.read` (each read audited), with a fixed relationship list that has no value for a child. The name is free text, so a child's name typed there would be misuse of an adult field. ADR 0017 governs a minor's details and does not apply to them.
7. **One lock order.** Household, then person, in every path that places, moves or links a person, or hides, restores or purges a family.

## Consequences

- A purged family's label and emergency contacts are gone from the live database. Backups taken before the purge hold the ciphertext and the wrapped household key, so they stay readable to a holder of the backup and use of the envelope key until backup retention ends. Architecture §12.2 is corrected to say so.
- A community with no family list, delete or restore keeps a hidden family past 720 hours until the scheduler exists.
- The purge is safe only while `is_minor` is written once. The planned turned-18 job must re-key a person's fields and life events from the household key before it changes `is_minor`. A test pins that `app` has no `UPDATE` on `is_minor`.
- A future foreign key to `app.households`, or a new column sealed under the household key for someone other than a minor, must be handled in the function. A test reads the catalog and fails on an unhandled foreign key.
- The Admin UI handoff (2 Nov 2026) lists "delete a family" without a condition. A family with a child cannot be deleted in this chunk.

## Alternatives considered

- **`DELETE` grants to the `app` role.** Rejected, as in ADR 0020.
- **Hide and never purge.** Keeps restricted data and its key for ever. Rejected.
- **Delete a family with its children, or move them first.** Needs re-encryption under another household key, and staff access to a minor's record that ADR 0017 does not allow yet. Rejected.
- **Clear `household_id` on the adults when the family is hidden.** A restore could not bring them back. Rejected.
