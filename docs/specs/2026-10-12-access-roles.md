# Spec: Users and roles

Slug: access-roles
Status: approved (2026-10-12, Adnan Bin Hossen)
Architecture refs: §6.1, §6.3, §8.1, §8.3, §11.2, §11.3, §12.1, §12.3. Implements the `access-roles` row. Depends on `admin-shell`, `tenancy-implicit-org`, `identity-otp`, and `people-households`, all on `main`. Staging stays parked.

## Problem

A community cannot say who may administer it. Architecture already names organisation roles and community roles, treats a role as a bundle of manifest permissions, and keeps a person separate from a user. `people-households` stored no `user_id` on `app.persons` and declared no permission. `people.restricted.read` was left for this chunk. The admin shell still renders Dashboard only, so Settings → Users & Roles does not exist.

## Scope

**In**

- `modules/core/access`, package `@community-hub/access`. `pnpm-workspace.yaml` gains the line `modules/core/access`. No other workspace glob.
- `packages/policy`, package `@community-hub/policy`. It has no runtime dependency. It does not import `@community-hub/db`, `@community-hub/people`, `@community-hub/identity`, or `@community-hub/crypto`.
- `module.manifest.ts` calls `defineModule` with `key` `core.access`, `version` 1, `requires: ["core.people"]`, empty `publishes`, `subscribes`, and `ports`. No `entitlement`. No `features`. No `website`. `permissions` is `access.users.view`, `access.users.manage`, `access.roles.view`, and `access.roles.manage`, in that order. `dataClasses` lists every column in [Data](#data).
- `modules/core/people/module.manifest.ts` gains `permissions: ["people.restricted.read"]`. No other field on that manifest changes. `readPerson` and `openPersonFieldKeys` stay as they are.
- Two people reads that do not decrypt and do not append an audit event: `personIsMinor(tx, personId)` and `hasGuardianView(tx, guardianPersonId, childPersonId)`. They live in `modules/core/people/infrastructure/access-facts.ts` and are re-exported from `modules/core/people/public/index.ts`. They take an `AppTransaction`. They do not open a connection and do not call `set_config`.
- Tables in the `app` schema, contributed from `modules/core/access/db/schema.ts` as `accessTables(app)`. That function does not call `pgSchema`. `packages/db` keeps the only product journal. `packages/db/drizzle.schema.ts` imports `app` from `packages/db/src/namespaces.ts` and calls `accessTables`. `packages/db/src` does not import `@community-hub/access`.
- One new product journal entry after `0006_people_org_scoped_uniques`. Drizzle Kit generates it. Kit does not emit `FORCE ROW LEVEL SECURITY`. After generate, the same migration hand-adds `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` on every new `app` table, and the `REVOKE` statements named below. The migration is additive. It does not drop, and it does not alter a people table, `app.audit_events`, or `app.outbox`.
- Ids are minted with `newId()` from `@community-hub/db`. The SQL has no `DEFAULT` for `id`. `org_id` and `community_id` are written from `current_setting`, not from a function argument.
- Every new `app` table has `org_id`, row level security, and `FORCE ROW LEVEL SECURITY`. `app.organisation_role_grants` is organisation-level: it has no `community_id`. Every other new table has `community_id`. Policies are `FOR ALL TO public`, with `USING` and `WITH CHECK` the same predicate. The organisation-grant predicate is `org_id = current_setting('app.org_id')::uuid`. Every other predicate is that comparison and `community_id = current_setting('app.community_id')::uuid`. `schema-rls` is not changed.
- Grants stay the default privileges from `0000_schemas.sql`, then this migration revokes. `app.organisation_role_grants`, `app.community_role_grants`, `app.custom_roles`, `app.custom_role_permissions`, and `app.user_links`: `REVOKE UPDATE, TRUNCATE` from `app`. Delete stays, because a revoke or a removed custom role is a delete. `identity` and `platform` receive none of these tables.
- Foreign keys stay inside `app`. They use `ON DELETE RESTRICT`. There is no foreign key to `platform` or `identity`. `app` cannot read those schemas. `user_id` is a uuid with no foreign key, the same shape as `app.person_activity.actor_user_id`.
- The public functions take `tx: AppTransaction` from `@community-hub/db` first. The caller has already entered `withAppTransaction`. The functions do not open a connection, do not call `set_config`, and do not call `sql.begin`. A unique-key race uses a savepoint on `tx`. The savepoint rolls back. The caller's transaction does not.
- Domain code under `modules/core/access/domain/` and under `packages/policy` imports no framework, no Drizzle, and no `@community-hub/crypto`.
- Built-in organisation roles and community roles from architecture §11.3, custom roles, role grants, and the person-to-user link, as specified under Behaviour.
- `packages/policy` decides a permission from a snapshot the access module loaded. The access module reads its own tables. It calls `personIsMinor` and `hasGuardianView`. It does not read `app.persons` or `app.guardian_links` itself.
- `readPersonForActor` is the restricted-read check `people-households` left here. It calls `readPerson` only after `decide` allows `people.restricted.read`. It does not call `generateDataKey` or `decrypt`.
- Routes on the regional service, in `apps/api/src/access-routes.ts`, surface `tenant`. The presented hostname must be the API hostname. The auth, webhooks, and ops hostnames answer 404 for these paths. `GET /health` is unchanged.
- The admin shell shows Settings, and under it only Users & Roles. Sign-in is the page that obtains the bearer token those screens send. It calls the email one-time-code routes `identity-otp` already shipped. It does not add a mail vendor.
- `@community-hub/contracts` gains the export `./access`. The `.` export stays `auth.js`.
- The CloudFront response-headers policy `connect-src` gains the API origin and the auth origin. The other directives stay. The agent does not apply.
- The catalogue commit updates `docs/roadmap.md` and the repository-state sentence in `AGENTS.md`. It updates the `withAppTransaction` open item as [Catalogue](#catalogue) says. It does not edit `architecture.md`.

**Out**

- Platform roles `platform_admin`, `platform_support`, and `platform_security`. Operator sign-in, the two-passkey rule, support grants, and break-glass. Those stay with `ops-console`. The `platform` login still has no privilege on `app`.
- A read path across communities. An organisation grant is evaluated inside the current community transaction. It does not select another community's rows. Architecture §6.3 already leaves that path to a later chunk.
- `group_leader_of`. There is no group table. The groups journey adds that predicate.
- Entitlements, community toggles, and hiding a nav item by plan. Settings appears because this chunk fills it. `entitlements-plans` is the next row.
- General Settings and Email Settings. Q9 stays open. The boot mail implementation still rejects with `email_unavailable`.
- A change to `readPerson`, `openPersonFieldKeys`, session tokens, or the identity tables.
- Cookies, refresh in the admin, passkeys in the admin, and `expo-secure-store`.
- A `user_id` column on `app.persons`.
- Showing a name, an email, or a phone on the Users & Roles page. The page shows ids and role keys.
- Unparking staging. `enable_database` stays false, `desired_count` stays 0, and no committed var file gains `service_image`. No new Terraform resource. The header change is the existing response-headers policy.
- A new dependency and a new subprocessor.

## Behaviour

`now` is an argument on the commands that append an audit event. Those functions do not read the clock, except `newId()`.

A command that fails throws `AccessError` and writes nothing, except `readPersonForActor` when permission is denied: that path appends `access.permission.denied` and does not call `readPerson`. `AccessError` extends `Error`. Its discriminating property is `code`.

The caller passes an `AppTransaction` that already has `app.org_id` and `app.community_id` set for this transaction only. Organisation grants are visible because their policy matches `app.org_id` only.

### Permission catalogue

The catalogue is these five strings, in this order:

1. `access.users.view`
2. `access.users.manage`
3. `access.roles.view`
4. `access.roles.manage`
5. `people.restricted.read`

`catalogue()` returns that list. A custom role permission outside it is `invalid_permission`.

Built-in bundles:

| Role                    | Scope        | Permissions                                   |
| ----------------------- | ------------ | --------------------------------------------- |
| `org_owner`             | organisation | all five                                      |
| `org_admin`             | organisation | all five                                      |
| `org_billing`           | organisation | `access.users.view`                           |
| `org_auditor`           | organisation | `access.users.view`, `access.roles.view`      |
| `community_admin`       | community    | all five                                      |
| `staff`                 | community    | `access.users.view`, `access.roles.view`      |
| `finance`               | community    | none                                          |
| `safeguarding_officer`  | community    | `people.restricted.read`, `access.users.view` |
| `volunteer_coordinator` | community    | `access.users.view`                           |
| `content_editor`        | community    | none                                          |
| `member`                | community    | none                                          |

`bundle(roleKey)` returns that list, or `null` when `roleKey` is not one of those eleven. `decide` ignores a key whose bundle is `null`.

`decide` returns true when the permission is in an organisation bundle the snapshot holds, or in a community bundle the snapshot holds, or in the snapshot's custom permission list. It also returns true when the permission is `people.restricted.read`, the call is person-scoped, and `guardianView` is true. Any other permission is false for a guardian. A guardian check does not grant `access.users.manage` or `access.roles.manage`.

### People facts

`personIsMinor` returns `null` when the person id is not in this community. Otherwise it returns the clear `is_minor` boolean. It does not select a name, an email, a phone, or a date of birth.

`hasGuardianView` returns true only when a `app.guardian_links` row in this community has that guardian, that child, and `view` true. Otherwise it returns false. It does not decrypt.

### Link

`linkUser(tx, input)` takes `{ now, userId, personId, actorUserId }`. `userId` and `personId` are UUIDs. Anything else is `invalid_id`.

`personIsMinor` null is `not_found`. `true` is `minor_forbidden`. Nothing is written. A second link of the same user or the same person in this community is `duplicate_link`. Success inserts `app.user_links` and appends `access.user.linked` with target the new link id.

`unlinkUser(tx, input)` takes `{ now, userId, actorUserId }`. A missing link is `not_found` and writes no audit row. Success deletes the link and appends `access.user.unlinked` with target the user id. Grants for that user stay.

### Grants

`bootstrapOwner(tx, input)` takes `{ now, userId, actorUserId }`. `userId` must equal `actorUserId`. Otherwise `invalid_id`, and nothing is written. It inserts `org_owner` and `community_admin` for that user when the organisation has no organisation grant and this community has no community grant. Otherwise `already_bootstrapped`, and nothing is written. Success appends one `access.owner.bootstrapped` with both grant ids.

`grantRole(tx, input)` takes `{ now, userId, roleKey, customRoleId, actorUserId }`. Exactly one of `roleKey` and `customRoleId` is set. Otherwise `invalid_role`.

The actor must `decide` to `access.roles.manage`. Otherwise the function appends `access.permission.denied`, purpose `access.roles.manage`, target the actor id, and throws `forbidden`.

A built-in `roleKey` must be one of the seven community keys or one of the four organisation keys. A custom role must be a row in this community. Otherwise `invalid_role`.

The actor may grant a role only when every permission in that role is a permission `decide` already allows the actor. Otherwise `forbidden`, with the same denial audit, and no grant row. An organisation role additionally requires the actor to hold `org_owner` or `org_admin`. A community role does not require an organisation role.

When the user has a link and that person is a minor, the result is `minor_forbidden` and no grant. A user with no link is not a minor check. This chunk does not query `identity.users`. A uuid that is not a user can be granted. The HTTP layer only does that for a uuid the client sends; the actor is always a session user.

A duplicate of the same user and the same role is `duplicate_grant`.

An organisation role inserts `app.organisation_role_grants`. A community role or a custom role inserts `app.community_role_grants`. Success appends `access.role.granted` with target the grant id.

`revokeRole(tx, input)` takes `{ now, grantId, scope, actorUserId }`. `scope` is `organisation` or `community`. The actor must hold `access.roles.manage`, with the same denial audit otherwise. The grant must be in scope. Otherwise `not_found`. Revoking the last `org_owner` in the organisation is `last_owner`, and the row stays. Success deletes the row and appends `access.role.revoked` with target the grant id.

### Custom roles

`createCustomRole(tx, input)` takes `{ now, key, permissions, actorUserId }`. The actor must hold `access.roles.manage`. The key matches `^[a-z][a-z0-9_]{1,31}$`. It must not be one of the eleven built-in keys, and it must not be `platform_admin`, `platform_support`, or `platform_security`. Otherwise `invalid_role`.

`permissions` is a non-empty subset of the catalogue, without duplicates. Otherwise `invalid_permission`. The actor must already hold every permission in the list. Otherwise `forbidden`.

The community may hold 20 custom roles. The twenty-first is `limit_reached`, and nothing is written. A duplicate key in the community is `duplicate_role`.

Success inserts `app.custom_roles` and one `app.custom_role_permissions` row per permission, then appends `access.custom_role.created` with target the role id.

`deleteCustomRole(tx, input)` takes `{ now, customRoleId, actorUserId }`. The actor must hold `access.roles.manage`. An unknown id is `not_found`. A role that still has a community grant is `role_in_use`, and nothing is deleted. Success deletes the permission rows, then the role, and appends `access.custom_role.deleted` with target the role id.

### Restricted read

`readPersonForActor(tx, kms, keyArn, input)` takes `{ personId, actorUserId }`. It loads the actor's grants and custom permissions, and `hasGuardianView` for the actor's linked person and this `personId`. No link means `guardianView` is false. It calls `decide` for `people.restricted.read` with `personScoped` true.

Denied: append `access.permission.denied`, purpose `people.restricted.read`, target the person id, throw `forbidden`, and do not call `readPerson`. Allowed: return the `readPerson` result, including `null`. `readPerson` writes its own audit when the row exists. This function does not write a second one.

### HTTP

Each access route is `POST`, `Content-Type: application/json`, surface `tenant`. The presented hostname must equal the API hostname. Any other known hostname is 404 with an empty body. A missing or invalid bearer token is 401 with an empty body. The token is the access token `readSession` already accepts. The body is a strict object. An unknown key, a wrong type, or a non-JSON body is 400 with an empty body.

The community slug is a field in the JSON body. It is not a path segment and not a query parameter. `findCommunityBySlug` on the platform login returns the organisation id and the community id. The route passes that pair to `withAppTransaction`. It never reads an organisation id or a community id from the body. An unknown slug, after a valid session, is 403 with an empty body on every route except bootstrap. Bootstrap of an unknown slug is 404 with an empty body.

`AccessError` maps as follows. `forbidden` is 403. `not_found` is 404. `already_bootstrapped`, `duplicate_grant`, `duplicate_role`, `duplicate_link`, `last_owner`, `limit_reached`, `role_in_use`, and `minor_forbidden` are 409. `invalid_id`, `invalid_role`, and `invalid_permission` are 400. Every error body is empty. A 200 body is JSON and contains ids, role keys, scopes, and permission strings only.

| Route                                 | Permission            | Body                                                                              | Success                                                  |
| ------------------------------------- | --------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `POST /v1/access/grants/list`         | `access.roles.view`   | `{ communitySlug }`                                                               | `{ grants, customRoles, catalogue, builtIn, userLinks }` |
| `POST /v1/access/owner/bootstrap`     | none                  | `{ communitySlug }`                                                               | `{ organisationGrantId, communityGrantId }`              |
| `POST /v1/access/grants`              | `access.roles.manage` | `{ communitySlug, userId, roleKey }` or `{ communitySlug, userId, customRoleId }` | `{ grantId, scope }`                                     |
| `POST /v1/access/grants/revoke`       | `access.roles.manage` | `{ communitySlug, grantId, scope }`                                               | empty 200                                                |
| `POST /v1/access/custom-roles`        | `access.roles.manage` | `{ communitySlug, key, permissions }`                                             | `{ customRoleId }`                                       |
| `POST /v1/access/custom-roles/delete` | `access.roles.manage` | `{ communitySlug, customRoleId }`                                                 | empty 200                                                |
| `POST /v1/access/user-links`          | `access.users.manage` | `{ communitySlug, userId, personId }`                                             | `{ linkId }`                                             |
| `POST /v1/access/user-links/delete`   | `access.users.manage` | `{ communitySlug, userId }`                                                       | empty 200                                                |

`grants` entries are `{ grantId, scope, userId, roleKey, customRoleId, customRoleKey }`. `roleKey` is null on a custom grant. `customRoleId` and `customRoleKey` are null on a built-in grant. `customRoles` entries are `{ customRoleId, key, permissions }`. `builtIn` entries are `{ roleKey, scope, permissions }`, all eleven, in the table order above. `userLinks` entries are `{ userId, personId }`. `catalogue` is the five strings.

List requires `access.roles.view`. A session with no grant gets 403 and the denial audit. Bootstrap does not require a grant. Its actor is the session user, and that user receives the two grants.

Logs for these routes use the existing request log. They include the path, the status, and the request id. They do not include a body, a token, a slug, or an id.

### Admin

The frozen label list stays. The sidebar still has accessible name `Admin`. Dashboard remains a link to `/`. Settings is text in that nav, not a link. Its only child is a link named `Users & Roles` to `/settings/users`. The other fourteen labels stay absent. General Settings and Email Settings stay absent. There is no Website control, no community switcher, and no person name. Dashboard's heading and Refresh button stay. Refresh still reloads and does not call `fetch`.

`/sign-in` and `/settings/users` are routes. A fetch from those pages uses `VITE_API_ORIGIN` and `VITE_AUTH_ORIGIN`. When either is missing, both pages show `Directory unavailable` and do not call `fetch`. The unit tests set `https://au.api.example.test` and `https://auth.au.example.test`. The browser does not set `x-community-hub-hostname`.

The access token is kept in `sessionStorage` under `community-hub.access-token`. The email and the refresh token are not stored. A 401 removes the access token.

Sign-in has an email field named `Email`, a button `Send code`, a code field named `Code`, and a button `Verify`. Send code `POST`s `{ email }` to `{VITE_AUTH_ORIGIN}/v1/auth/email-otp/start`. Verify `POST`s `{ email, code }` to `{VITE_AUTH_ORIGIN}/v1/auth/email-otp/verify`. A 200 stores `accessToken` and navigates to `/settings/users`. Any other status shows `Sign-in failed` and does not show the address or the code. The boot process still has no mail vendor, so a live sign-in against that process receives the existing 503. Tests use a mail double, as `identity-otp` already does.

Users & Roles has heading `Users & Roles`. With no token, the page shows `Sign in required` and a link `Sign in` to `/sign-in`, and it does not call `fetch`. With a token, it shows a field named `Community`, a button `Load`, and no list until Load succeeds. Load `POST`s `{ communitySlug }` to `{VITE_API_ORIGIN}/v1/access/grants/list`. An empty `grants` array shows `No role grants` and a button `Become the owner`. That button is absent when any grant is returned. Become the owner `POST`s bootstrap, then loads again.

The loaded page can grant, revoke, create a custom role, delete a custom role, link a user to a person, and unlink. Each control has an accessible name: `User`, `Role`, `Person`, `Grant`, `Revoke`, `Custom role key`, `Create custom role`, `Delete custom role`, `Link`, `Unlink`. At 20 custom roles, `Create custom role` is absent and the page shows `Custom role limit reached`. A 403 shows `You cannot manage roles`. A 409 shows `That change was rejected`. A network failure shows `Directory unavailable`. The page never renders a name, an email, or a phone.

The response-headers policy in `infra/modules/aws-admin-static` keeps every directive except `connect-src`. `connect-src` becomes `'self' https://au.api.${zone_name} https://auth.au.${zone_name}`. The existing test zone is `example.net`, so that test expects `connect-src 'self' https://au.api.example.net https://auth.au.example.net`. No other header changes.

`admin-publish` fails when `ADMIN_API_ORIGIN` or `ADMIN_AUTH_ORIGIN` is unset. It passes them as `VITE_API_ORIGIN` and `VITE_AUTH_ORIGIN`. A pull request build uses the example origins above and does not publish. The values are origins, not secrets. They are not written into the repo.

### Catalogue

The last commit marks the Phase 1 row done and links this spec. The snapshot stays on Phase `1 — Core platform`. Last shipped becomes `access-roles`. Next chunk becomes `entitlements-plans`. The Phase 0 count stays `24 rows: 23 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stays `not started`. The sentence under the Phase 0 table becomes `Next is entitlements-plans.` The Next spec section names `entitlements-plans`.

In `AGENTS.md`, the repository-state cell names `entitlements-plans` as next. The Phase 0 counts in that cell stay as they are. That is the only `AGENTS.md` edit.

The roadmap open item that says the first route calling a people function derives both ids from the platform directory row is updated to record that the access routes do that through `findCommunityBySlug`, and that `withAppTransaction` still does not verify the pair. Later routes follow the same lookup. The startup sentence, the key-cache sentence, the `is_minor` sentence, and the Fargate sentence stay.

No ADR. `architecture.md` is not edited.

## Data

Primary key of `app.organisation_role_grants`, `app.community_role_grants`, `app.custom_roles`, and `app.user_links` is `(org_id, id)`. Primary key of `app.custom_role_permissions` is `(org_id, custom_role_id, permission)`.

| Table                          | Column           | Classification | Notes                                                                       |
| ------------------------------ | ---------------- | -------------- | --------------------------------------------------------------------------- |
| `app.organisation_role_grants` | `id`             | `internal`     | UUIDv7. No `community_id`.                                                  |
| `app.organisation_role_grants` | `org_id`         | `internal`     | From `current_setting('app.org_id')`.                                       |
| `app.organisation_role_grants` | `user_id`        | `internal`     | UUID. No foreign key to `identity.users`.                                   |
| `app.organisation_role_grants` | `role_key`       | `internal`     | One of the four organisation roles. Clear. Not personal data.               |
| `app.community_role_grants`    | `id`             | `internal`     | UUIDv7.                                                                     |
| `app.community_role_grants`    | `org_id`         | `internal`     | From the setting.                                                           |
| `app.community_role_grants`    | `community_id`   | `internal`     | From the setting.                                                           |
| `app.community_role_grants`    | `user_id`        | `internal`     | UUID. No foreign key to `identity.users`.                                   |
| `app.community_role_grants`    | `role_key`       | `internal`     | A community built-in key, or null when `custom_role_id` is set.             |
| `app.community_role_grants`    | `custom_role_id` | `internal`     | Null when `role_key` is set. References `app.custom_roles (org_id, id)`.    |
| `app.custom_roles`             | `id`             | `internal`     | UUIDv7.                                                                     |
| `app.custom_roles`             | `org_id`         | `internal`     | From the setting.                                                           |
| `app.custom_roles`             | `community_id`   | `internal`     | From the setting.                                                           |
| `app.custom_roles`             | `key`            | `internal`     | Clear category. Unique per community. Not a person's name.                  |
| `app.custom_role_permissions`  | `org_id`         | `internal`     | From the setting.                                                           |
| `app.custom_role_permissions`  | `community_id`   | `internal`     | From the setting.                                                           |
| `app.custom_role_permissions`  | `custom_role_id` | `internal`     | References `app.custom_roles (org_id, id)`.                                 |
| `app.custom_role_permissions`  | `permission`     | `internal`     | One of the five catalogue strings. Clear. SQL may filter it. Not encrypted. |
| `app.user_links`               | `id`             | `internal`     | UUIDv7.                                                                     |
| `app.user_links`               | `org_id`         | `internal`     | From the setting.                                                           |
| `app.user_links`               | `community_id`   | `internal`     | From the setting.                                                           |
| `app.user_links`               | `user_id`        | `internal`     | UUID. No foreign key to `identity.users`.                                   |
| `app.user_links`               | `person_id`      | `internal`     | References `app.persons (org_id, id)`.                                      |

Checks, exact:

- `organisation_role_grants.role_key` is one of `org_owner`, `org_admin`, `org_billing`, `org_auditor`.
- `community_role_grants.role_key` is null or one of `community_admin`, `staff`, `finance`, `safeguarding_officer`, `volunteer_coordinator`, `content_editor`, `member`.
- Exactly one of `community_role_grants.role_key` and `community_role_grants.custom_role_id` is null.
- `custom_roles.key` matches `^[a-z][a-z0-9_]{1,31}$` and is not a built-in key and not a `platform_*` key named in Behaviour.
- `custom_role_permissions.permission` is one of the five catalogue strings.
- `user_id` and `person_id` columns are `uuid`.

Unique indexes:

- `organisation_role_grants (org_id, user_id, role_key)`.
- `community_role_grants (community_id, user_id, role_key)` where `role_key` is not null.
- `community_role_grants (community_id, user_id, custom_role_id)` where `custom_role_id` is not null.
- `custom_roles (community_id, key)`.
- `user_links (community_id, user_id)`.
- `user_links (community_id, person_id)`.

No ciphertext column. No index on a personal field. Role keys and permission strings are categories.

## Rules touched

Tenancy. Community tables are community-scoped. `app.organisation_role_grants` is organisation-level and has no `community_id`. Inserts use `current_setting`. The HTTP routes take the pair from `findCommunityBySlug` and never from the body. A second organisation's transaction cannot select the first organisation's grants. `identity` and `platform` cannot select these tables.

Residency. The rows live in the regional database. Logs, errors, and audit rows carry ids and the fixed action names. They do not carry a name, an email, a phone, a code, or a token.

Children. A minor cannot be linked to a user and cannot receive a role while linked. `people.restricted.read` is required before `readPerson`. A guardian with `view` true is allowed for that child only. The Users & Roles page does not render a person. This module has no `website` field.

Encryption. No new ciphertext column. Permission strings and role keys stay clear because SQL filters them. This chunk does not cache an unwrapped key. `readPersonForActor` does not decrypt on a denied call.

Audit. Grant, revoke, bootstrap, custom-role create and delete, link, unlink, and a denied permission append `app.audit_events` in the same transaction. The names are registered with `defineAuditAction` and `defineAuditPurpose` when `@community-hub/access` is imported. Each string is both an action and a purpose. No name ends in `.v1`.

The names are `access.owner.bootstrapped`, `access.role.granted`, `access.role.revoked`, `access.custom_role.created`, `access.custom_role.deleted`, `access.user.linked`, `access.user.unlinked`, and `access.permission.denied`.

Money, consent, retention, and analytics. No payment fields, no consent row, no analytics SDK.

## Contracts

| Contract  | Value                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| Package   | `@community-hub/access`. Public exports are the commands below, `readPersonForActor`, and `AccessError`.                    |
| Policy    | `@community-hub/policy` exports `catalogue`, `bundle`, and `decide`.                                                        |
| Module    | `core.access`, version 1. Requires `core.people`. Four access permissions. No events, no entitlement, no website.           |
| People    | `core.people` gains `people.restricted.read`. New exports `personIsMinor` and `hasGuardianView`.                            |
| Audit     | The eight names under Rules touched.                                                                                        |
| Journal   | One additive entry in `packages/db/drizzle` after `0006`, plus hand-added `FORCE ROW LEVEL SECURITY` and the `REVOKE` list. |
| HTTP      | The eight `POST` routes under Behaviour. Empty error bodies.                                                                |
| Contracts | `@community-hub/contracts/access`. The `.` export stays the auth schemas.                                                   |
| Admin     | Settings → Users & Roles, plus `/sign-in`. Token in `sessionStorage` under `community-hub.access-token`.                    |
| Header    | `connect-src` adds the API origin and the auth origin on the existing policy.                                               |
| Staging   | Parked. The agent does not apply.                                                                                           |
| Roles     | `app` can insert, select, and delete. It cannot update or truncate. `identity` and `platform` cannot.                       |

```ts
decide(input: DecideInput): boolean
catalogue(): readonly string[]
bundle(roleKey: string): readonly string[] | null

personIsMinor(tx: AppTransaction, personId: string): Promise<boolean | null>
hasGuardianView(tx: AppTransaction, guardianPersonId: string, childPersonId: string): Promise<boolean>

linkUser(tx: AppTransaction, input: LinkInput): Promise<{ linkId: string }>
unlinkUser(tx: AppTransaction, input: { now: Date; userId: string; actorUserId: string }): Promise<void>
bootstrapOwner(tx: AppTransaction, input: { now: Date; userId: string; actorUserId: string }): Promise<{ organisationGrantId: string; communityGrantId: string }>
grantRole(tx: AppTransaction, input: GrantInput): Promise<{ grantId: string; scope: "organisation" | "community" }>
revokeRole(tx: AppTransaction, input: { now: Date; grantId: string; scope: "organisation" | "community"; actorUserId: string }): Promise<void>
createCustomRole(tx: AppTransaction, input: { now: Date; key: string; permissions: string[]; actorUserId: string }): Promise<{ customRoleId: string }>
deleteCustomRole(tx: AppTransaction, input: { now: Date; customRoleId: string; actorUserId: string }): Promise<void>
readPersonForActor(tx: AppTransaction, kms: KmsPort, keyArn: string, input: { personId: string; actorUserId: string }): Promise<PersonView | null>
```

`DecideInput` is `{ permission: string; organisationRoleKeys: readonly string[]; communityRoleKeys: readonly string[]; customPermissions: readonly string[]; guardianView: boolean; personScoped: boolean }`. `LinkInput` is `{ now: Date; userId: string; personId: string; actorUserId: string }`. `GrantInput` is `{ now: Date; userId: string; roleKey: string | null; customRoleId: string | null; actorUserId: string }`. `PersonView` stays the people type.

`AccessError` codes are `invalid_id`, `invalid_role`, `invalid_permission`, `not_found`, `forbidden`, `minor_forbidden`, `duplicate_link`, `duplicate_grant`, `duplicate_role`, `already_bootstrapped`, `last_owner`, `limit_reached`, and `role_in_use`.

## Dependencies

`@community-hub/access` depends on `@community-hub/policy`, `@community-hub/people`, `@community-hub/db`, `@community-hub/kernel`, `drizzle-orm`, and `postgres`. It does not depend on `@community-hub/tenancy` or `@community-hub/identity`. It does not call `generateDataKey` or `decrypt`. `@community-hub/policy` has no runtime dependency. `@community-hub/people` does not depend on access or policy. `apps/api` calls tenancy's `findCommunityBySlug`, identity's `readSession`, and access's commands. No new third-party package.

## Cost

No new resource billed by the hour or the month. The response-headers policy already exists. No NAT gateway, load balancer, or interface endpoint. Staging stays parked, so this chunk adds no database charge and no task charge.

## Risks

| Risk                                                                  | Mitigation                                                                                                                                           |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A minor is linked to a user or granted a role                         | `personIsMinor` true is `minor_forbidden`. A test links an adult and rejects a minor.                                                                |
| `people.restricted.read` decrypts before the check                    | `readPersonForActor` throws `forbidden` before `readPerson`. A test shows no `people.person.read` row on that path.                                  |
| A guardian reads every child                                          | `decide` is person-scoped. A test allows the linked child and denies another person.                                                                 |
| A community admin grants `org_owner`                                  | Organisation roles require `org_owner` or `org_admin` on the actor. A test expects `forbidden` and no row.                                           |
| The last owner is revoked                                             | `last_owner` leaves the row. A test revokes a second owner and fails on the last one.                                                                |
| Custom roles exceed the limit or escape the catalogue                 | The twenty-first key is `limit_reached`. A permission outside the five strings is `invalid_permission`. The check constraint lists the five strings. |
| `org_id` is taken from the request body                               | The route uses `findCommunityBySlug`. A test sends a different organisation id in the JSON and still writes the directory pair. An extra key is 400. |
| Another tenant sees the grants                                        | A second `withAppTransaction` selects nothing. `identity` and `platform` cannot select.                                                              |
| `app.organisation_role_grants` gains `community_id`                   | A test fails if that table's SQL contains `community_id`.                                                                                            |
| A community table omits `community_id` or the community predicate     | A test fails if any new table other than `organisation_role_grants` lacks `community_id`, or if its policy lacks `app.community_id`.                 |
| The settings page shows a name or an email                            | The list type has no name field. A test fails if the rendered page includes the fixture email.                                                       |
| The admin stores the address or the code                              | `sessionStorage` is asserted to hold only `community-hub.access-token`.                                                                              |
| `connect-src` stays `'self'` only, so the browser cannot call the API | The header string in Terraform and its test include the two origins.                                                                                 |
| Staging is unparked                                                   | The proof is the existing Docker Postgres and the admin unit tests. Staging flags stay parked. The agent does not apply.                             |

## Tests

- Domain tests, no database. `decide` allows `org_owner` all five, allows `staff` only the two view permissions, and denies `member` all five. `people.restricted.read` is true for a person-scoped guardian and false for `access.roles.manage` with the same guardian flag. `bundle("platform_admin")` is `null`. A custom key `Org_Owner` is `invalid_role`. The twenty-first custom role is `limit_reached` by a pure count the domain function takes as an argument.
- Integration, in the existing `@community-hub/db` Docker Postgres, one database. The test file is `modules/core/access/infrastructure/access.integration.test.ts`. It uses `withAppTransaction` and `withRequest`. `createImplicitOrganisation` mints the tenant. KMS is the test port from `@community-hub/crypto/testing` only inside the `readPersonForActor` case.
- `bootstrapOwner` writes one organisation grant and one community grant, and one `access.owner.bootstrapped` row. A second call throws `already_bootstrapped` and does not add a grant. `grantRole` of `staff` by that owner writes `access.role.granted`. `grantRole` of `org_owner` by a `community_admin` throws `forbidden` and writes `access.permission.denied`. Revoking the only `org_owner` throws `last_owner`.
- `linkUser` of an adult person returns a link id. `linkUser` of a minor throws `minor_forbidden` and writes no link. `readPersonForActor` as `safeguarding_officer` returns the minor and writes `people.person.read`. The same call as `member` throws `forbidden`, does not call through to a second person-read audit, and writes `access.permission.denied`. A guardian with `view` true reads that child and is denied for a different person.
- A second organisation's transaction selects none of the first organisation's grants. The `identity` login and the `platform` login cannot select `app.community_role_grants`. `has_table_privilege` for `UPDATE` is false and for `DELETE` is true on that table.
- The generated SQL for `app.organisation_role_grants` contains `org_id` and `FORCE ROW LEVEL SECURITY`, and does not contain `community_id`. Every other new table contains `community_id`, `org_id`, and `FORCE ROW LEVEL SECURITY`, and its policy contains `app.community_id`. `schema-rls` still passes.
- `modules/core/access` does not import `@community-hub/tenancy` or `@community-hub/identity`. `packages/policy` does not import `@community-hub/db`. The people manifest `permissions` array is exactly `["people.restricted.read"]`. The access manifest has no `website`.
- API tests in `apps/api` cover 401, 400 on an extra JSON key, 403 for an unknown slug after a valid session, bootstrap 404 for an unknown slug, and a grant whose body includes `organisationId` rejected as 400. The hostname test uses `au.api.example.test` for 200 and `auth.au.example.test` for 404.
- Admin tests. Dashboard still does not call `fetch`. `/settings/users` without a token does not call `fetch` and shows `Sign in required`. With a token, Load posts the slug and renders the returned user id and role key, and does not render a fixture email. Sign-in stores only the access token. The Terraform header test matches the `example.net` string under Behaviour.

## Out-of-band

- Legal: none. The minor rule is the existing `is_minor` flag. This chunk does not decide capacity to consent.
- New subprocessor: none. No ADR. `architecture.md` is not edited.
- The custom-role cap is 20 per community. That number is part of this draft. Approval accepts it or replaces it before the plan.
- Users and roles are a sensitive chunk. The work touches authorisation and a minor's restricted read. The second fresh-context review starts when the pull request opens. The pull request is not merged until that line is closed.
- The human applies the response-headers change. The agent does not apply. Staging stays parked. Live email stays Q9, so a booted process still returns 503 from the existing mail port.

## Rollback

Drop, in a later contract migration, `app.custom_role_permissions`, `app.community_role_grants`, `app.user_links`, `app.custom_roles`, then `app.organisation_role_grants`. No earlier table references them. The journal entry is not edited after it ships. The people manifest permission is removed in that same later change only after nothing grants it.

## Next spec after this lands

`entitlements-plans`, unless the human picks another Phase 1 row.
