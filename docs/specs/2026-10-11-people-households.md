# Spec: People and households

Slug: people-households
Status: draft
Architecture refs: §8.1, §8.2, §8.3, §9, §11.2, §12.1, §12.2, §12.2.1, §12.3, D8. Implements the `people-households` row. Depends on `packages-crypto`, `packages-db`, `kernel-runtime`, `audit-log`, `tenancy-implicit-org`, and `identity-otp`, all on `main`. Staging stays parked.

## Problem

A community cannot record a person, a household, or a guardian link, and it cannot mark a child. Architecture already splits a Laravel contact into Person, Household, and GuardianLink, derives `is_minor`, and encrypts a minor's confidential fields under the household key. The crypto package can wrap a household key and encrypt a field. Nothing persists those keys, nothing chooses the household key when `is_minor` is true, and the `app` schema has no person table. Tags and the contact activity log are part of this row. The groups module is a later journey.

`core/tenancy` must not import `@community-hub/crypto`, so the organisation key and the community key were not created with the organisation row. This chunk is the first one that unwraps an organisation key. The roadmap leaves the cache of that key to this chunk.

## Scope

**In**

- `modules/core/people`, package `@community-hub/people`. `pnpm-workspace.yaml` gains the line `modules/core/people`. No other workspace glob.
- `module.manifest.ts` calls `defineModule` with `key` `core.people`, `version` 1, empty `requires`, `publishes`, `subscribes`, `ports`, `permissions`, and `features`. No `entitlement`. No `website`. `dataClasses` lists every column in [Data](#data).
- Tables in the `app` schema, contributed from `modules/core/people/db/schema.ts` as `peopleTables(app)`. That function does not call `pgSchema`. `packages/db` keeps the only product journal. `packages/db/drizzle.schema.ts` imports `app` from `packages/db/src/namespaces.ts` and calls `peopleTables`. `packages/db/src` does not import `@community-hub/people`.
- One new product journal entry after `0004_solid_the_twelve`. Drizzle Kit generates it. Kit does not emit `FORCE ROW LEVEL SECURITY`. After generate, the same migration hand-adds `FORCE ROW LEVEL SECURITY` on every new `app` table, and the `REVOKE` statements named below. The migration is additive. It does not drop, and it does not alter `app.audit_events` or `app.outbox`.
- Ids are minted with `newId()` from `@community-hub/db`. The SQL has no `DEFAULT` for `id`. `org_id` and `community_id` are written from `current_setting`, not from a function argument.
- Every new `app` table has `org_id`, row level security, and `FORCE ROW LEVEL SECURITY`. `app.organisation_keys` is organisation-level: it has no `community_id`. Every other new table has `community_id`. Policies are `FOR ALL TO public`, with `USING` and `WITH CHECK` the same predicate. The organisation-key predicate is `org_id = current_setting('app.org_id')::uuid`. Every other predicate is that comparison and `community_id = current_setting('app.community_id')::uuid`. `schema-rls` is not changed.
- Grants stay the default privileges from `0000_schemas.sql`, then this migration revokes. `app.organisation_keys`, `app.community_keys`, `app.household_keys`, `app.households`, `app.persons`, `app.person_tags`, and `app.person_activity`: `REVOKE UPDATE, DELETE, TRUNCATE` from `app`. `app.guardian_links` and `app.person_tag_links`: `REVOKE UPDATE, TRUNCATE` from `app`. `identity` and `platform` receive none of these tables.
- Foreign keys stay inside `app`. They use `ON DELETE RESTRICT`. There is no foreign key to `platform` or `identity`. `app` cannot read those schemas.
- The public functions take `tx: AppTransaction` from `@community-hub/db` first. The caller has already entered `withAppTransaction`. The functions do not open a connection, do not call `set_config`, and do not call `sql.begin`. A unique-key race uses a savepoint on `tx`. The savepoint rolls back. The caller's transaction does not.
- Domain code under `modules/core/people/domain/` imports no framework, no Drizzle, and no `@community-hub/crypto`.
- One organisation key, one community key, and one household key, created on first use. No process cache. The unwrapped root is derived for that operation and then dropped.
- The field-key resolver: an adult's confidential and restricted fields use the community key; a minor's use the household key.
- Person, Household, GuardianLink, `is_minor`, tags, and the activity log, as specified under Behaviour.
- `appendAuditEvent` accepts `OrgTransaction | AppTransaction`. Its SQL is unchanged. It still reads `app.org_id` and the request id from `withRequest`.
- The catalogue commit updates `docs/roadmap.md`, the one sentence in architecture §12.2, and the repository-state sentence in `AGENTS.md`.

**Out**

- HTTP routes, `apps/api`, and `apps/admin`. All Contacts and Family Records are Phase 2. This chunk has no list of every person and no list of every household.
- Groups, rosters, and group membership. Tags here are labels on a person, not membership of a group.
- Custom fields, consent records, photos, medical notes, and the jurisdiction table for capacity to consent.
- `people.age_band`. The band edges are not decided. This chunk does not add the column.
- A link from a person to `identity.users`. That belongs with roles. No `user_id` column on `app.persons`.
- Updating a person, recomputing `is_minor` after insert, and the move from the household key to the community key when someone turns 18.
- Merge, `people.person.merged.v1`, erasure, and household-key destruction.
- Entitlement checks. `people.directory`, `people.households`, and `people.custom_fields` stay with `entitlements-plans`. This module declares no entitlement.
- Permission checks. `people.restricted.read` stays with `access-roles`. This module declares no permission.
- A cache of unwrapped organisation keys. The decision is that there is none.
- Unparking staging. `enable_database` stays false, `desired_count` stays 0, and no committed var file gains `service_image`. No Terraform change.
- A new dependency. No phone library, no identity import, and no edit to `@community-hub/crypto`.

## Behaviour

The caller passes an `AppTransaction` that already has `app.org_id` and `app.community_id` set for this transaction only. `now` is an argument. The functions do not read the clock, except `newId()`, which already embeds the current time.

A command that fails throws `PeopleError` and writes nothing. The caller's transaction rolls the command back. `PeopleError` extends `Error`. Its discriminating property is `code`.

### Keys

`ensureOrganisationKey(tx, kms, keyArn)` returns the existing row for `current_setting('app.org_id')` or inserts one. The insert calls `generateKmsRoot` once. The KMS context is `{ key_kind: "org", org_id, key_version: "1" }`, with `org_id` read from that setting. `keyArn` is the envelope key id the caller passes. The row stores the blob, `key_version` `1`, and the minted id. A second caller that loses the unique insert rolls back the savepoint, reads the winner, calls `unwrapKmsRoot` on the stored blob, and does not write a second root. The plaintext root is not stored, not logged, and not returned.

`ensureCommunityKey(tx, kms, keyArn)` ensures the organisation key, unwraps it, and derives `chub/v1/wrap`. It returns the existing community row or inserts one. The wrap AAD is `{ tag: "chub/wrap/v1", childKind: "community", childId, childKeyId, parentKeyId }`. `childId` is the 16-byte form of `app.community_id`. `childKeyId` is the 16-byte form of the new key row id. `parentKeyId` is the 16-byte form of the organisation key row id. The 16-byte form is the UUID with the hyphens removed, parsed as sixteen hex bytes. A lost unique insert follows the same savepoint rule and unwraps the winner under the organisation wrap key. The function returns `{ keyId }` and does not return a `CryptoKey`.

`createHousehold` ensures the community key and then inserts `app.households` and `app.household_keys` in the same transaction. The household wrap uses `childKind: "household"`, `childId` the household id, `parentKeyId` the community key row id. One household has one key.

No function stores a `CryptoKey` beyond the call that needs it. There is no module-level map of unwrapped keys.

### Age

The Sydney civil date of `now` comes from `Intl.DateTimeFormat` with `timeZone: "Australia/Sydney"` and calendar `gregory`. Age is completed years. The person is a minor when that age is under 18. A birthday of 29 February is still a minor on 28 February of a non-leap year, and is not a minor on 1 March. A missing date of birth is a minor. `birthday_md` is `month * 100 + day` when a date of birth is stored, and null when it is not.

`2008-10-12` is a minor on Sydney civil date `2026-10-11`. `2008-10-11` is not a minor on `2026-10-11`. `null` is a minor. A future date, a date that is not a real calendar day, and a string that is not `YYYY-MM-DD` are `invalid_date`, and nothing is written. The year is four digits from `0001` to `9999`.

`is_minor` and `birthday_md` are written once, on insert. This chunk has no command that changes them.

### Person

`createPerson(tx, kms, keyArn, input)` inserts one person.

`input` is `{ now, householdId, dateOfBirth, givenName, familyName, email, phone, actorUserId }`. `householdId`, `dateOfBirth`, `email`, `phone`, and `actorUserId` may be null.

A minor requires `householdId`. A missing household is `household_required` when `householdId` is null, and `not_found` when the id is not in this community. An adult may omit `householdId`. An adult's `householdId`, when present, must be a household in this community.

Names are trimmed. Empty, longer than 80 characters, or containing an ASCII control character is `invalid_name`. An adult's names are stored in `given_name` and `family_name`. The restricted name columns are null. A minor's names are encrypted into `given_name_restricted` and `family_name_restricted`. The clear name columns are null. The checks in [Data](#data) enforce that split.

Email uses the identity address rule, implemented in this module. Trim leading and trailing ASCII spaces, then lowercase. Accept only `local@domain` where `local` is 1 to 64 characters from `a-z`, `0-9`, and `.`, `_`, `%`, `+`, `-`, and `domain` is 1 to 253 characters, labels separated by `.`, each label 1 to 63 characters from `a-z`, `0-9`, and `-`, not starting or ending with `-`. Anything else is `invalid_email`. Null is allowed. The ciphertext uses label `people.email`. The blind index uses purpose `people.email` over the UTF-8 normalised address. An adult index is computed with the community `bidx` key and is unique per community among adults. A minor index is computed with the household `bidx` key and is unique per household. A duplicate throws `duplicate_email` and inserts nothing. A community-key lookup does not find a minor's index.

Phone strips ASCII spaces. One leading `+` is removed. The rest must be 8 to 15 ASCII digits. Anything else is `invalid_phone`. Null is allowed. The stored value is those digits. Label and purpose are `people.phone`. Adult and minor indexes follow the email rule. A duplicate throws `duplicate_phone`.

Date of birth is encrypted with label `people.date_of_birth`. An adult uses the community `enc` key. A minor uses the household `enc` key. Field AAD is `{ tag: "chub/field/v1", label, rowId, communityId }`. `rowId` is the new person id. SQL does not filter, sort, or aggregate any ciphertext column.

The insert also writes one `app.person_activity` row, kind `created`, `occurred_at` equal to `now`, `actor_user_id` equal to `actorUserId`. It appends one audit event, action `people.person.created`, purpose `people.person.created`, `targetIds` the person id. `actorUserId` null uses actor kind `system` and a null actor id. A UUID uses actor kind `user`. The call runs inside `withRequest`. The function does not enter request context itself.

### Household label

`createHousehold(tx, kms, keyArn, input)` takes `{ now, label, actorUserId }`. `label` null stores null. A non-null label uses the name rule and is encrypted with the household `enc` key, label `people.household_label`, `rowId` the household id. The command appends audit action `people.household.created`, purpose `people.household.created`, target the household id. It does not write a person activity row.

`readHousehold(tx, kms, keyArn, input)` takes `{ householdId, actorUserId }`. An unknown id returns null and writes no audit row. A known id returns `{ householdId, label }`, with `label` decrypted or null, and appends `people.household.read` / `people.household.read`.

### Guardian link

`linkGuardian(tx, input)` takes `{ now, householdId, guardianPersonId, childPersonId, consent, pickup, view, manage, actorUserId }`. The four rights are booleans. At least one is true. Otherwise `invalid_guardian`.

The guardian's `is_minor` is false. The child's `is_minor` is true. Both `household_id` values equal `householdId`. A failed check is `invalid_guardian` when both rows exist, and `not_found` when either row or the household does not. A second link of the same three ids is `duplicate_guardian_link`. The insert writes activity kind `guardian_linked` on the child. It does not encrypt and it does not take a KMS port.

`unlinkGuardian(tx, input)` deletes that link. A missing link is `not_found` and writes no activity. A deleted link writes activity kind `guardian_unlinked` on the child.

### Tags

`createTag(tx, { label })` trims and lowercases. The stored label matches `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`. Anything else is `invalid_tag`. A duplicate label in the community is `duplicate_tag`. The label is a category. It is clear text.

`attachTag(tx, input)` takes `{ now, personId, tagId, actorUserId }`. A missing person or tag is `not_found`. A second attach of the same pair is `duplicate_tag` and writes no second activity row. Success writes activity kind `tagged` on that person.

`detachTag` deletes the pair. A missing pair is `not_found`. Success writes activity kind `untagged`.

`listPersonTags(tx, personId)` returns `{ tagId, label }[]` in label order. An unknown person returns null. A person with no tags returns an empty array. The function does not decrypt and does not append an audit event.

### Activity

`listPersonActivity(tx, personId)` returns `{ id, kind, actorUserId, occurredAt }[]` ordered by `occurred_at`, then `id`. An unknown person returns null. The rows contain no name, no email, and no phone. The function does not append an audit event.

Kinds are only `created`, `tagged`, `untagged`, `guardian_linked`, and `guardian_unlinked`.

### Read and resolver

`readPerson(tx, kms, keyArn, input)` takes `{ personId, actorUserId }`. An unknown id returns null and writes no audit row. A known id returns `{ personId, householdId, isMinor, birthdayMd, givenName, familyName, email, phone, dateOfBirth }`. Names, email, phone, and date of birth are the clear values. Ciphertext is not returned. `dateOfBirth` is `YYYY-MM-DD` or null. Email and phone are the normalised values or null. The function appends `people.person.read` / `people.person.read` with target the person id. It uses the resolver below.

`openPersonFieldKeys(tx, kms, keyArn, input)` takes `{ personId, actorUserId }`. An unknown id returns null and writes no audit row. A known adult returns the community `enc` and `bidx` keys. A known minor returns the household `enc` and `bidx` keys. The wrap key and the root are not returned. `exportKey` on the returned keys throws, which `@community-hub/crypto` already guarantees. The function appends the same `people.person.read` audit. It does not cache the keys.

The audit names are registered with `defineAuditAction` and `defineAuditPurpose` when `@community-hub/people` is imported. The names are `people.person.created`, `people.person.read`, `people.household.created`, and `people.household.read`. Each string is both an action and a purpose. No name ends in `.v1`.

### Catalogue

The last commit marks the Phase 1 row done and links this spec. The snapshot stays on Phase `1 — Core platform`. Last shipped becomes `people-households`. Next chunk becomes `access-roles`. The Phase 0 count stays `24 rows: 23 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stays `not started`. The sentence under the Phase 0 table names `access-roles`. The Next spec section names `access-roles`.

In `AGENTS.md`, the repository-state cell names `access-roles` as next. The Phase 0 counts in that cell stay as they are. That is the only `AGENTS.md` edit.

Architecture §12.2, the sentence that a short-lived cache of unwrapped organisation keys is an open item, becomes: unwrapped organisation, community, and household keys are not cached; the operation that needs one unwraps it and drops it; decided in `people-households`. The roadmap open-items paragraph keeps the startup sentence from `identity-otp`. The cache sentence becomes: unwrapped organisation keys are not cached; each operation unwraps and drops them, decided in `people-households`. The Fargate sentence stays.

## Data

Primary key of every table except `app.person_tag_links` is `(org_id, id)`. `app.person_tag_links` primary key is `(org_id, person_id, tag_id)`.

| Table                    | Column                   | Classification           | Notes                                                                                          |
| ------------------------ | ------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `app.organisation_keys`  | `id`                     | `internal`               | UUIDv7. Also the KMS key id in this row's blob.                                                |
| `app.organisation_keys`  | `org_id`                 | `internal`               | Unique. From `current_setting('app.org_id')`. No `community_id`.                               |
| `app.organisation_keys`  | `wrapped`                | `internal`               | KMS blob. Not a personal field.                                                                |
| `app.organisation_keys`  | `key_version`            | `internal`               | The text `1`.                                                                                  |
| `app.community_keys`     | `id`                     | `internal`               | UUIDv7. `child_key_id` in the wrap AAD.                                                        |
| `app.community_keys`     | `org_id`                 | `internal`               | From the setting.                                                                              |
| `app.community_keys`     | `community_id`           | `internal`               | Unique. From `current_setting('app.community_id')`.                                            |
| `app.community_keys`     | `wrapped`                | `internal`               | Application wrap under the organisation key.                                                   |
| `app.community_keys`     | `key_version`            | `internal`               | The text `1`.                                                                                  |
| `app.community_keys`     | `parent_key_id`          | `internal`               | The organisation key row id.                                                                   |
| `app.household_keys`     | `id`                     | `internal`               | UUIDv7.                                                                                        |
| `app.household_keys`     | `org_id`                 | `internal`               | From the setting.                                                                              |
| `app.household_keys`     | `community_id`           | `internal`               | From the setting.                                                                              |
| `app.household_keys`     | `household_id`           | `internal`               | Unique. References `app.households (org_id, id)`.                                              |
| `app.household_keys`     | `wrapped`                | `internal`               | Application wrap under the community key.                                                      |
| `app.household_keys`     | `key_version`            | `internal`               | The text `1`.                                                                                  |
| `app.household_keys`     | `parent_key_id`          | `internal`               | The community key row id.                                                                      |
| `app.households`         | `id`                     | `internal`               | UUIDv7.                                                                                        |
| `app.households`         | `org_id`                 | `internal`               | From the setting.                                                                              |
| `app.households`         | `community_id`           | `internal`               | From the setting.                                                                              |
| `app.households`         | `label`                  | `restricted`             | Ciphertext or null. Label `people.household_label`. Not filtered.                              |
| `app.persons`            | `id`                     | `internal`               | UUIDv7. Minted before encrypt.                                                                 |
| `app.persons`            | `org_id`                 | `internal`               | From the setting.                                                                              |
| `app.persons`            | `community_id`           | `internal`               | From the setting.                                                                              |
| `app.persons`            | `household_id`           | `internal`               | Null only when `is_minor` is false. References `app.households (org_id, id)`.                 |
| `app.persons`            | `is_minor`               | `confidential-queryable` | Clear boolean. Equality filter is allowed. Not encrypted.                                      |
| `app.persons`            | `birthday_md`            | `confidential-queryable` | Clear smallint or null. `month * 100 + day`. Not encrypted.                                    |
| `app.persons`            | `given_name`             | `internal`               | Clear. Null when `is_minor` is true. Not a minor's name.                                       |
| `app.persons`            | `family_name`            | `internal`               | Clear. Null when `is_minor` is true.                                                           |
| `app.persons`            | `given_name_restricted`  | `restricted`             | Ciphertext. Label `people.given_name`. Null when `is_minor` is false. Not filtered.            |
| `app.persons`            | `family_name_restricted` | `restricted`             | Ciphertext. Label `people.family_name`. Null when `is_minor` is false. Not filtered.           |
| `app.persons`            | `date_of_birth`          | `restricted`             | Ciphertext or null. Label `people.date_of_birth`. Not filtered.                                 |
| `app.persons`            | `email`                  | `confidential-blind`     | Ciphertext or null. Label `people.email`. Not filtered.                                         |
| `app.persons`            | `email_bidx`             | `confidential-blind`     | 32-byte blind index or null. Equality only.                                                    |
| `app.persons`            | `phone`                  | `confidential-blind`     | Ciphertext or null. Label `people.phone`. Not filtered.                                         |
| `app.persons`            | `phone_bidx`             | `confidential-blind`     | 32-byte blind index or null. Equality only.                                                    |
| `app.guardian_links`     | `id`                     | `internal`               | UUIDv7.                                                                                        |
| `app.guardian_links`     | `org_id`                 | `internal`               | From the setting.                                                                              |
| `app.guardian_links`     | `community_id`           | `internal`               | From the setting.                                                                              |
| `app.guardian_links`     | `household_id`           | `internal`               | References `app.households (org_id, id)`.                                                      |
| `app.guardian_links`     | `guardian_person_id`     | `internal`               | References `app.persons (org_id, id)`.                                                         |
| `app.guardian_links`     | `child_person_id`        | `internal`               | References `app.persons (org_id, id)`.                                                         |
| `app.guardian_links`     | `consent`                | `internal`               | Boolean. Not personal data.                                                                    |
| `app.guardian_links`     | `pickup`                 | `internal`               | Boolean.                                                                                       |
| `app.guardian_links`     | `view`                   | `internal`               | Boolean.                                                                                       |
| `app.guardian_links`     | `manage`                 | `internal`               | Boolean.                                                                                       |
| `app.person_tags`        | `id`                     | `internal`               | UUIDv7.                                                                                        |
| `app.person_tags`        | `org_id`                 | `internal`               | From the setting.                                                                              |
| `app.person_tags`        | `community_id`           | `internal`               | From the setting.                                                                              |
| `app.person_tags`        | `label`                  | `internal`               | Clear category. Unique per community. Not a person's name.                                     |
| `app.person_tag_links`   | `org_id`                 | `internal`               | From the setting.                                                                              |
| `app.person_tag_links`   | `community_id`           | `internal`               | From the setting.                                                                              |
| `app.person_tag_links`   | `person_id`              | `internal`               | References `app.persons (org_id, id)`.                                                         |
| `app.person_tag_links`   | `tag_id`                 | `internal`               | References `app.person_tags (org_id, id)`.                                                     |
| `app.person_activity`    | `id`                     | `internal`               | UUIDv7.                                                                                        |
| `app.person_activity`    | `org_id`                 | `internal`               | From the setting.                                                                              |
| `app.person_activity`    | `community_id`           | `internal`               | From the setting.                                                                              |
| `app.person_activity`    | `person_id`              | `internal`               | References `app.persons (org_id, id)`.                                                         |
| `app.person_activity`    | `actor_user_id`          | `internal`               | UUID or null. No foreign key to `identity.users`.                                             |
| `app.person_activity`    | `kind`                   | `internal`               | One of the five kinds.                                                                         |
| `app.person_activity`    | `occurred_at`            | `internal`               | `timestamptz`. The command's `now`.                                                            |

Checks, exact:

- `key_version = '1'` on the three key tables.
- `is_minor` true implies `household_id` is not null, `given_name` is null, `family_name` is null, `given_name_restricted` is not null, and `family_name_restricted` is not null.
- `is_minor` false implies `given_name` is not null, `family_name` is not null, `given_name_restricted` is null, and `family_name_restricted` is null.
- `date_of_birth` is null exactly when `birthday_md` is null.
- `birthday_md` is null or (`birthday_md / 100` is between 1 and 12 and `birthday_md % 100` is between 1 and 31).
- `email` is null exactly when `email_bidx` is null. The same for `phone` and `phone_bidx`.
- `octet_length` of a non-null blind index is 32.
- Guardian rights: `consent or pickup or view or manage`.
- `guardian_person_id <> child_person_id`.
- `person_activity.kind` is one of `created`, `tagged`, `untagged`, `guardian_linked`, `guardian_unlinked`.
- Tag `label` matches `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`.

Unique indexes:

- `organisation_keys.org_id`.
- `community_keys.community_id`.
- `household_keys.household_id`.
- `person_tags (community_id, label)`.
- `guardian_links (household_id, guardian_person_id, child_person_id)`.
- `persons (community_id, email_bidx)` where `is_minor` is false and `email_bidx` is not null.
- `persons (household_id, email_bidx)` where `is_minor` is true and `email_bidx` is not null.
- The same two partial unique indexes for `phone_bidx`.

No index on a ciphertext column. Blind-index indexes are the partial unique indexes above. No index orders a blind index.

## Rules touched

Tenancy. Person rows are community-scoped `app` tables. The repository writes `org_id` and `community_id` from `current_setting`. It does not call `set_config`. A second organisation's transaction cannot select the first organisation's person. `identity` and `platform` cannot select these tables.

Residency. The rows live in the regional database. KMS context carries `org_id` and `key_version` only. Logs, errors, and audit rows carry ids and the fixed action names. They do not carry a name, an email, a phone, or a date of birth.

Children. `is_minor` true stores the name only in the restricted columns, under the household key. The minor's email and phone indexes use the household `bidx` key. This module has no `website` field, so it publishes no collection and no island. A minor does not appear in a community-wide email lookup.

Encryption. Ciphertext columns are not filtered, sorted, or aggregated. `is_minor` and `birthday_md` stay clear because SQL may filter them. Adult confidential fields use the community key. There is no cache of unwrapped keys.

Audit. A read or create that can return or store a restricted field appends `app.audit_events` in the same transaction. Tag and activity lists do not. The activity row has no personal field.

Money, consent, retention, and analytics. No payment fields, no consent row, no analytics SDK.

## Contracts

| Contract   | Value                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package    | `@community-hub/people`. Public exports are the commands below and `PeopleError`.                                                                              |
| Module     | `core.people`, version 1. No events, no entitlement, no permission, no website.                                                                                |
| Keys       | Organisation key via `generateKmsRoot`. Community and household keys via `generateAndWrap`. No cache.                                                          |
| Resolver   | `openPersonFieldKeys` returns `{ enc, bidx }` for the community key or the household key. It does not return `wrap`.                                           |
| Audit      | `people.person.created`, `people.person.read`, `people.household.created`, `people.household.read`.                                                            |
| Journal    | One additive entry in `packages/db/drizzle` after `0004`, plus hand-added `FORCE ROW LEVEL SECURITY` and the `REVOKE` list.                                    |
| Roles      | `app` can insert and select. Delete only on `guardian_links` and `person_tag_links`. `identity` and `platform` cannot.                                         |
| Staging    | Parked. No apply.                                                                                                                                              |
| db         | `appendAuditEvent(tx: OrgTransaction \| AppTransaction, ...)`.                                                                                                |

```ts
ensureOrganisationKey(tx: AppTransaction, kms: KmsPort, keyArn: string): Promise<{ keyId: string }>
ensureCommunityKey(tx: AppTransaction, kms: KmsPort, keyArn: string): Promise<{ keyId: string }>
createHousehold(tx: AppTransaction, kms: KmsPort, keyArn: string, input: HouseholdInput): Promise<{ householdId: string }>
readHousehold(tx: AppTransaction, kms: KmsPort, keyArn: string, input: { householdId: string; actorUserId: string | null }): Promise<{ householdId: string; label: string | null } | null>
createPerson(tx: AppTransaction, kms: KmsPort, keyArn: string, input: PersonInput): Promise<{ personId: string; isMinor: boolean }>
readPerson(tx: AppTransaction, kms: KmsPort, keyArn: string, input: { personId: string; actorUserId: string | null }): Promise<PersonView | null>
openPersonFieldKeys(tx: AppTransaction, kms: KmsPort, keyArn: string, input: { personId: string; actorUserId: string | null }): Promise<{ enc: CryptoKey; bidx: CryptoKey } | null>
linkGuardian(tx: AppTransaction, input: GuardianInput): Promise<{ linkId: string }>
unlinkGuardian(tx: AppTransaction, input: { now: Date; linkId: string; actorUserId: string | null }): Promise<void>
createTag(tx: AppTransaction, input: { label: string }): Promise<{ tagId: string }>
attachTag(tx: AppTransaction, input: TagLinkInput): Promise<void>
detachTag(tx: AppTransaction, input: TagLinkInput): Promise<void>
listPersonTags(tx: AppTransaction, personId: string): Promise<{ tagId: string; label: string }[] | null>
listPersonActivity(tx: AppTransaction, personId: string): Promise<ActivityView[] | null>
```

`PersonInput` is `{ now: Date; householdId: string | null; dateOfBirth: string | null; givenName: string; familyName: string; email: string | null; phone: string | null; actorUserId: string | null }`. `PersonView` is `{ personId, householdId, isMinor, birthdayMd, givenName, familyName, email, phone, dateOfBirth }` with `birthdayMd: number | null` and `dateOfBirth: string | null`. `HouseholdInput` is `{ now: Date; label: string | null; actorUserId: string | null }`. `GuardianInput` adds the four booleans to `{ now, householdId, guardianPersonId, childPersonId, actorUserId }`. `TagLinkInput` is `{ now: Date; personId: string; tagId: string; actorUserId: string | null }`. `ActivityView` is `{ id, kind, actorUserId, occurredAt }`.

`PeopleError` codes are `invalid_date`, `invalid_name`, `invalid_email`, `invalid_phone`, `invalid_tag`, `invalid_guardian`, `household_required`, `duplicate_email`, `duplicate_phone`, `duplicate_tag`, `duplicate_guardian_link`, and `not_found`.

## Dependencies

`@community-hub/people` depends on `@community-hub/crypto`, `@community-hub/db`, `@community-hub/kernel`, `drizzle-orm`, and `postgres`. It does not depend on `@community-hub/tenancy` or `@community-hub/identity`. Tests may call tenancy's public `createImplicitOrganisation` to mint ids. No new third-party package. `@community-hub/db` does not depend on people.

## Cost

No new resource billed by the hour or the month. No NAT gateway, load balancer, or interface endpoint. Staging stays parked, so this chunk adds no database charge and no task charge.

## Risks

| Risk                                                                              | Mitigation                                                                                                                                          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A minor's name is stored in the clear `given_name` column                        | The check requires that column to be null when `is_minor` is true. A test inserts a minor and selects a null clear name.                           |
| A minor's email index is community-wide                                           | The index is computed with the household `bidx` key. A test looks up the same address with the community key and finds no row.                     |
| Adult confidential fields are encrypted with the household key                    | The resolver test decrypts an adult email with the community key and fails with the household key.                                                 |
| Ciphertext is filtered or ordered                                                 | Columns use `encryptedColumn` and `blindIndexColumn`. The repository uses equality on the blind index only. The encrypted-column lint stays on.    |
| Unwrapped keys are cached or logged                                               | No module-level map. Return values are ids, clear fields, or non-extractable `CryptoKey`s. Errors carry a `code` only.                             |
| KMS context contains a name or an email                                           | Context is `{ key_kind: "org", org_id, key_version: "1" }`. A test rejects a call that adds another key.                                            |
| `org_id` is taken from the argument and crosses tenants                           | Inserts use `current_setting`. A second `withAppTransaction` cannot select the first tenant's person.                                              |
| The organisation-key table is given `community_id`                                | A test fails if that table's SQL contains `community_id`.                                                                                          |
| A community table omits `community_id` or the community predicate                 | A test fails if any new table other than `organisation_keys` lacks `community_id`, or if its policy lacks `app.community_id`.                      |
| `FORCE ROW LEVEL SECURITY` is missing because Kit does not emit it                | The migration hand-adds it. `schema-rls` fails the journal without it.                                                                             |
| A lost unique insert aborts the caller's transaction                              | The insert runs in a savepoint. A test runs two ensures and finds one key row.                                                                     |
| Restricted reads skip the audit chain                                             | `readPerson`, `createPerson`, `readHousehold`, `createHousehold`, and `openPersonFieldKeys` append in the same transaction. A test reads the row. |
| The activity row stores a name                                                    | The columns are ids, kind, and time. A test fails if a returned activity object has a name, email, or phone.                                       |
| A website collection includes a person                                            | The manifest has no `website` key. A test fails if it gains one.                                                                                   |
| Staging is unparked                                                               | The proof is the existing Docker Postgres. Staging flags stay parked.                                                                              |

## Tests

- Domain tests, no database. The three age examples above. `29 February 2008` against Sydney `2026-02-28` is a minor, and against `2026-03-01` is not. `invalid_date` for `2026-02-31`, `11/10/2008`, and a future Sydney date. `Ada@Example.com` becomes `ada@example.com`. A space in the middle is `invalid_email`. Phone `+61 412 345 678` becomes `61412345678`. `12` is `invalid_phone`. Tag `Choir` becomes `choir`. `A_b` is `invalid_tag`. A newline in a name is `invalid_name`.
- Integration, in the existing `@community-hub/db` Docker Postgres, one database. The test file is `modules/core/people/infrastructure/people.integration.test.ts`. It uses `withAppTransaction` and `withRequest`. `createImplicitOrganisation` mints the tenant. KMS is the test port from `@community-hub/crypto/testing`.
- An adult with date of birth `2008-10-11`, `now` `2026-10-11T00:00:00+11:00`, names `Ada` and `Example`, and email `ada@example.com` stores `is_minor` false, `birthday_md` 1011, clear names, null restricted names, and a community-key email index. `readPerson` returns those clear values and one `people.person.read` audit row. `createPerson` has already written `people.person.created` and activity kind `created`.
- A person with date of birth null requires a household, stores `is_minor` true, null `birthday_md`, null clear names, and restricted names that decrypt with the household key and fail with the community key. The clear email column's blind index is not equal to a community-key index of the same address.
- A second organisation's transaction selects none of the first organisation's persons. The `identity` login and the `platform` login cannot select `app.persons`. The `app` login can. `has_table_privilege` for `UPDATE` and `DELETE` is false on `app.persons` and true for `DELETE` on `app.guardian_links`.
- `linkGuardian` from the adult to the minor in the same household, with `consent` true and the other rights false, inserts one row and activity `guardian_linked`. The adult as the child is `invalid_guardian`. A second identical link is `duplicate_guardian_link`.
- `createTag` of `Choir`, `attachTag`, and `listPersonTags` return `choir`. `listPersonActivity` returns `created` then `tagged`, and the objects have no name field. `detachTag` adds `untagged`.
- Two concurrent `ensureOrganisationKey` calls leave one row. The test asserts the savepoint path by inserting the winner and then calling ensure again.
- The generated SQL for `app.organisation_keys` contains `org_id` and `FORCE ROW LEVEL SECURITY`, and does not contain `community_id`. Every other new table contains `community_id`, `org_id`, and `FORCE ROW LEVEL SECURITY`, and its policy contains `app.community_id`. No ciphertext column is an index column. `schema-rls` still passes.
- The manifest export has no `website`, no `publishes`, and no `entitlement`. A source check fails if `modules/core/people` imports `@community-hub/tenancy` or `@community-hub/identity`.
- `openPersonFieldKeys` for the adult and the minor return keys that are not interchangeable, and each call adds one `people.person.read` row. `exportKey` on the returned key throws.

## Out-of-band

- Legal: none. The age rule is the completed-years reading of "under 18" in §12.1. The counsel question on capacity to consent stays open. It is not `is_minor`.
- New subprocessor: none. No ADR. Architecture §12.2 changes by the one cache sentence in Catalogue. No other architecture edit.
- People and households are a sensitive chunk. The second fresh-context review starts when the pull request opens. The pull request is not merged until that line is closed.
- The human does not apply. The agent does not apply. Staging stays parked.

## Rollback

Drop, in a later contract migration, `app.person_activity`, `app.person_tag_links`, `app.guardian_links`, `app.person_tags`, `app.persons`, `app.household_keys`, `app.households`, `app.community_keys`, then `app.organisation_keys`. No earlier table references them. The journal entry is not edited after it ships.

## Next spec after this lands

`access-roles`, unless the human picks another Phase 1 row.
