# Spec: Users & Roles people details

Slug: users-roles-people-details
Status: approved (2026-11-11, Adnan Bin Hossen)
Architecture refs: §6.3, §8.3, §11.1, §11.2, §11.3, §12.1, §12.2.1, §12.3, §17, §19.1, §19.2; ADR 0017; roadmap Phase 2 row "Users & Roles people details"

## Problem

Settings → Users & Roles shows each user as a UUID and each built-in role as a key. An administrator cannot tell who a user is. They cannot safely grant, change or remove a role, or link a user to a contact. The access-roles spec put names, emails and phones out of scope (`docs/specs/2026-10-12-access-roles.md:47`). The restyle moved the fix to this row (`docs/specs/2026-11-07-admin-screens-restyle.md:33`).

The list route `POST /v1/access/grants/list` (`apps/api/src/access-routes.ts:389-421`) selects ids, role keys and permission strings only. The screen renders `userId` and `personId` (`apps/admin/src/users-roles.tsx:311-318`, `:373-376`).

## Where the details live today

- **Sign-in email:** `identity.users.email`, `confidential-blind`. It is a plain `bytea` (`modules/core/identity/db/schema.ts:32`) encrypted under the region's identity key, with AAD bound to the user id and region (`modules/core/identity/infrastructure/email-lookup.ts:114-123`). Nothing decrypts it today. The `app` and `platform` roles have no `USAGE` on `identity` and no `SELECT` on `identity.users`. An existing test pins this (`modules/core/identity/infrastructure/identity.integration.test.ts:104-122`).
- **Name and phone:** on the person linked to the user through `app.user_links` (owned by `core/access`, `modules/core/access/db/schema.ts:166-184`). The link is per community. For an adult, `given_name` and `family_name` are clear `internal` columns. `phone` is `confidential-blind`, encrypted under the community key.
- **Minors:** `linkUser` refuses a minor (`modules/core/access/infrastructure/grants.ts:186-192`, `minor_forbidden`), so the product never links a user to a minor. This spec still treats a minor link as possible, because data can arrive another way (an import, a later chunk).
- **Grants and links accept any well-formed user id.** They do no identity check and ask for no acceptance (`grants.ts:178-220`, `:411-500`). See Risks, "Grant-to-reveal".

## Scope

In:

- A new read route `POST /v1/access/users/list`. For every user in the caller's community directory, it returns that user's name, sign-in email and phone.
- A new `core/identity` public export that decrypts sign-in emails for a set of user ids, on the identity role, without ever creating a key.
- A new `core/people` public export that returns contact details for a set of linked person ids in one call, with at most one community-key unwrap.
- Zod request and response schemas in `packages/contracts`.
- The admin Users & Roles screen:
  - Shows a name, email and phone wherever it lists a user today: the grants list and the user links list (`apps/admin/src/users-roles.tsx:311-318`, `:373-376`). Ids stay available as secondary text for support.
  - Shows built-in roles by a display label (for example `community_admin` → "Community Admin") from a static map in the admin. Custom roles keep their key, which is the name their creator gave them.
- Audit events with ids only.
- `architecture.md` §11.1 and §12.2.1 say when an identity email may be decrypted (see Out-of-band).

Out (explicitly):

- Changing grants, links or roles, or their routes. `POST /v1/access/grants/list` keeps its response unchanged. `/v1/access/capabilities` is unchanged.
- The person's own email on `app.persons`. The screen shows the sign-in email, which is the one the user signs in with.
- Last sign-in (roadmap row "Tenant session audit").
- Search, filter or sort controls on the screen. The service sorts the list once.
- Inviting a user by email, and picking a user by name in the grant and link forms. Their User field stays a user-id input (`apps/admin/src/users-roles.tsx:434-436`), because a user with no grant or link has no details to show. Laravel can create users. The project owner approved the deferral (Owner decision O3), and the catalogue commit adds a roadmap row "User invitations".
- Any member, Parish Hub or website surface. No collection, island or block.
- A read across communities for organisation-level staff (§6.3 says a later chunk adds it).

## Behaviour

**Who is listed.** The directory, read in the RLS-scoped app transaction exactly as `loadDirectory` reads it (`apps/api/src/access-routes.ts:188-260`):

- users with a community role grant in this community;
- users with an organisation role grant in this organisation;
- users with a `user_links` row in this community.

Duplicates are merged. A user id never comes from the request body. An organisation-level user with no link in this community shows "No contact linked", even if they are linked in another community.

**Order of steps.** Everything below runs inside one app transaction. Any throw rolls the whole transaction back, so a 500 leaves no `listed` audit row.

1. Load the directory and the caller's permissions.
2. Check `access.roles.view` and `access.users.view`. On failure, append `access.permission.denied` and return 403. This mirrors `grants/list`.
3. Collect the user-id set.
4. Apply the cap. Over 500 returns 409 before any decrypt, and writes no audit row.
5. Read the linked persons.
6. If the caller holds `people.view`, open the community key once and decrypt the phones of linked adults. Skip the key when no linked adult has a phone. The people export appends one `people.person.read` event with the ids of the persons whose phone it opened. It appends nothing when no phone was opened.
7. From inside the transaction callback, call the identity export through `deps.checkout("identity", …)` with the user ids that are **not** linked to a minor. The identity checkout sets no app setting and runs no `set_config`. It holds a second connection for the length of that call only.
8. Append `access.users.listed` with the listed user ids.
9. Commit, then respond with `cache-control: no-store`.

**Per user, the route returns:**

| Field      | Source                                                    | When it is `null`                                                                             |
| ---------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `userId`   | the directory                                             | never                                                                                         |
| `personId` | `app.user_links` in this community                        | no link in this community                                                                     |
| `name`     | linked person's `given_name` + `family_name`              | no link, or the linked person is a minor                                                      |
| `email`    | `identity.users.email`, decrypted in `core/identity`      | the linked person is a minor (the id is never passed to identity), or no `identity.users` row |
| `phone`    | linked person's `phone`, decrypted with the community key | no link, no phone, the linked person is a minor, or the caller lacks `people.view`            |
| `minor`    | linked person's `is_minor`                                | never (`false` when there is no link)                                                         |

The response also carries `phoneVisible: boolean`, so the screen can tell "no phone" from "you may not see phones". The server decides it. The client never infers it from permissions.

**Minors (§1 rule 4, ADR 0017).** If a linked person has `is_minor = true`, the route returns `minor: true` and no name, email or phone, whatever the caller holds, `community_admin` included. That user id is not passed to the identity export. The minor's household key is never unwrapped. The screen shows "Details hidden".

**Sort.** In the service, after decryption:

1. Rows with a name come first, by family name, then by given name.
2. Rows without a name (unlinked or minor) come after them.
3. Ties break on email, with nulls last, and then on user id.

Comparisons use `localeCompare(…, "en-AU", { sensitivity: "base" })`. SQL never orders or filters on `email` or `phone` (§1 rule 3).

**Cap.** At most 500 users. If the directory holds more, the route returns 409 `too_many`. It never truncates silently. A first-customer parish has well under 100 users.

**States.**

- **The caller is the only user:** the list holds the caller.
- **User with no link:** the email shows, the name shows "No contact linked", and the phone shows "—".
- **User id with no sign-in account:** the email shows "No sign-in account".
- **Caller lacks `access.roles.view` or `access.users.view`:** 403 with an empty body and an `access.permission.denied` audit event. If `grants/list` succeeded, the screen keeps the ids view. It calls the new route only when the `permissions` in the `grants/list` response include `access.users.view`. It never renders a control that only 403s.
- **Unknown slug, or a community where the caller has no role:** the same empty 403 as `grants/list` (`apps/api/src/access-flow.integration.test.ts:284-299`).
- **409 `too_many`:** the screen keeps the ids view and shows "Too many users to show details".
- **A decrypt failure, a missing identity key or community key, or a KMS error:** 500 with an empty body. No key is created on this path. The log line carries the request id and an error class only. The screen keeps the ids view and shows a retry message.
- **Offline or a network error:** the same as a 500 on the screen.

## Permission matrix

| What                    | Needs                                           | Notes                                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access/users/list`     | `access.roles.view` **and** `access.users.view` | `access.roles.view` opens the screen today. `access.users.view` exists in the catalogue (`packages/policy/src/decide.ts:2`), but no route checks it yet. Both are needed, so a role that cannot open the screen gets no staff list through the API.                             |
| phone inside that route | the above **and** `people.view`                 | A phone is `confidential`. This is narrower than the All Contacts detail read, which also accepts `people.restricted.read` for adults (`modules/core/access/infrastructure/restricted-read.ts:46-63`). That is deliberate: the safeguarding role exists for children's records. |

Built-in roles (`packages/policy/src/decide.ts:19-27`):

- Names and emails: `org_owner`, `org_admin`, `org_auditor`, `community_admin` and `staff`.
- Phones as well: `org_owner`, `org_admin` and `community_admin`.
- Nothing new: `org_billing`, `safeguarding_officer` and `volunteer_coordinator`. They cannot open the screen today, and they still cannot.

A custom role sees what its permissions give it.

No entitlement gate. `grants/list` has none, and Users & Roles is a Settings screen.

## Data

No new table, column, index, grant or migration.

New reads:

| Reads                                                        | Role       | Class (§12.1)                                                          |
| ------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------- |
| `identity.users.id`, `identity.users.email`                  | `identity` | `internal`; `confidential-blind` (display value)                       |
| `identity.identity_keys` (existing row only)                 | `identity` | as today                                                               |
| `app.persons.given_name`, `family_name`, `is_minor`, `phone` | `app`      | `internal`; `internal`; `confidential-queryable`; `confidential-blind` |
| `app.user_links.user_id`, `person_id`                        | `app`      | `internal`                                                             |

No blind index is computed. The identity read is `where id = any($1::uuid[])`. The person read is `where id = any($1::uuid[])` under the RLS-scoped transaction. Neither statement names `email` or `phone` outside its select list.

## Rules touched

- **Module boundaries (§6, §8.3).** `apps/api` composes the call, as it already composes `readSession`. `core/access` does not import `core/identity` or the `identity` schema.
  - The identity export lives in `modules/core/identity/public/index.ts`. It takes an identity-role checkout and a list of user ids, and returns `{ userId, email }[]`. It is built from the key-derivation half of `deriveIdentityEmailKeys` (`email-lookup.ts:45-61`) without its `ensureIdentityKey` call: it reads the existing key and throws if there is none.
  - The people export lives in `modules/core/people/public/index.ts` and runs inside the caller's `AppTransaction`. It is built on `communityFieldKeys` (`modules/core/people/infrastructure/person-keys.ts:32-40`). It must not use `openPersonFieldKeys`, which works one person at a time and writes an audit row for each. It must not create an organisation or community key.
  - The only SQL on `identity.*` stays inside `core/identity`. No CI scan enforces that today (AGENTS.md §10 lists it as omitted). The database privilege does.
- **Tenancy.** `orgId` and `communityId` come from `findCommunityBySlug` and the session. The user-id set comes only from the scoped app transaction. The identity export trusts the ids it is handed. That is safe only because the route passes the scoped set, and a test pins that no request field can add an id. The people export resolves person ids under RLS and drops any it cannot see.
- **Identity email decrypt (new).** It runs in the regional service only, with one identity-key unwrap per call. The AAD binds the user id, so a ciphertext copied to another row will not open. The plaintext is never cached, logged, put in an error or written to audit.
- **Audit.**
  - New action and purpose `access.users.listed`, plus a new purpose `access.users.view` for the denial row. `appendAuditEvent` throws on an unregistered purpose (`packages/db/src/audit-append.ts:81-83`), and only `access.roles.view` and `access.users.manage` are registered today (`modules/core/access/public/index.ts:19-23`). Both are registered with `defineAuditAction` and `defineAuditPurpose` in that file.
  - Per successful call: one `access.users.listed` with the listed user ids. One `people.person.read` with the ids of the persons whose phone was opened, when there were any.
  - Denials reuse `access.permission.denied`.
  - No name, email or phone enters an audit row (§1 rule 5). `target_ids` has no size limit (`packages/db/drizzle/0002_rare_jimmy_woo.sql:27-31`).
- **Logs, traces, URLs (§1 rule 5, §19.1).** The POST body is `{ communitySlug }` only. No personal data goes in a path or a query string. Errors have empty bodies, and responses carry `cache-control: no-store`. The route logs no field value and makes no `console.*` call.
- **Residency, cost.** No new outbound call, subprocessor, AWS resource or recurring charge. The route adds two KMS Decrypt calls (the identity root and the organisation root) to the session's one. That is about USD 0.00001 per page load. The community key is a local unwrap (`modules/core/people/infrastructure/keys.ts:113-119`). Staging stays parked.
- **Usage facts.** None. This is a Settings read.

## Contracts

Zod in `packages/contracts/src/access.ts`, both strict:

- `listUsersBody`: `{ communitySlug }`.
- `listUsersResponse`: `{ phoneVisible: boolean, users: [{ userId, personId: uuid|null, name: { given, family }|null, email: string|null, phone: string|null, minor: boolean }] }`.

Route: `POST /v1/access/users/list`.

- Tenant surface, `billing: read`.
- Added to the route-class table in `apps/api/src/index.test.ts`, whose route count goes from 51 to 52 (`:814`).
- The foreign-host 404 check works as on the other access routes. It is tested where those are tested (`apps/api/src/access-routes.test.ts:325-336`).
- `too_many` maps to 409, whether through the route's `CONFLICT` set (`apps/api/src/access-routes.ts:55-64`) or a direct `empty(409)`.

Admin: `apps/admin/src/users-roles.tsx` calls the new route only after `grants/list` succeeds and its `permissions` include `access.users.view`. It joins the result to the directory by `userId`.

- The existing test "loads ids and role keys and does not render personal details" (`apps/admin/src/users-roles.test.tsx:82`) is replaced by tests for each state above.
- The ids-only path stays tested for a caller without `access.users.view`.
- The screen follows the admin stale-response rules. Each response has a generation guard, and a test fails without it.

No events published or consumed. No port is added to `packages/kernel` (see default 1). No website collection, island or block. No new workspace package, so no Dockerfile or `image.test.ts` change. If the plan finds one is needed, it stops and reports.

## Risks

- **A user from another organisation is decrypted.** The identity export decrypts any id it is handed. Mitigation: ids come from the RLS-scoped directory only. A two-organisation integration test checks that a user granted only in organisation B never appears for an organisation A caller, and that the identity export is never called with that id. A user who belongs to both organisations shows the same email in each, and nothing about the other membership.
- **Grant-to-reveal.** Grants and links accept any user id without the user's consent. An admin with `access.roles.manage` or `access.users.manage` who knows a user's id can grant it a role, then read that user's sign-in email here. A UUID with no identity row comes back with `email: null`, which shows whether the id belongs to a real user. The chunk owner's default is to accept this for now:
  - user ids are UUIDv7 with 74 random bits;
  - the grant is audited (`access.role.granted`);
  - `access.users.listed` names the revealed user;
  - invitations with acceptance are the "User invitations" row.

  The project owner accepted this for the chunk (Owner decision O1).

- **Two communities in one organisation.** A user linked or granted only in community 2 is not listed for community 1, unless they hold an organisation-level grant. Must-fail test.
- **Permission swap.** Must-fail tests:
  - a caller with `access.roles.view` only gets 403;
  - a caller with `access.users.view` only gets 403;
  - a caller with both but not `people.view` gets `phone: null` for every row and `phoneVisible: false`.
- **Minor exposure.** The fixture is a minor-linked user inserted directly, bypassing `linkUser`. For every role, `community_admin` included, it returns no name, email or phone. The test asserts this on the raw response body and on the rendered screen, and checks that the identity export never received that id.
- **Audit gap or audit leak.** Tests check that the `access.users.listed` and `people.person.read` rows exist, hold only uuids, and contain none of the fixture's name, email or phone strings. Two more tests check that a 500 leaves no `listed` row, and that a 409 writes none.
- **Log leak.** A test captures the logger during a list call and during a forced decrypt failure. It must find no fixture value, SQL text, hostname or stack.
- **Error leak.** An identity row whose ciphertext fails to open gives a 500 with an empty body.
- **A read that writes.** Tests check that a missing identity key or community key makes the route fail with 500, and that it creates no key row and makes no `GenerateDataKey` call.
- **Privilege drift.** The existing test (`identity.integration.test.ts:104-122`) stays green. The plan's mutation is a scratch-tree migration that grants `app` `USAGE` on `identity`.
- **Encrypted-column filtering.** The `no-encrypted-column-query` lint rule does not read SQL text in postgres.js templates, and `identity.users.email` is an unbranded `bytea`. So rule 3 is pinned by two tests: a unit test that the new SQL strings name `email` and `phone` only in their select lists, and the in-memory sort test.
- **Stale UI.** The screen merges two responses, so it follows the admin stale-response rules (see Contracts).

Security-relevant settings the plan must pin, each with a test and a source change that makes it fail:

1. the `access.roles.view` + `access.users.view` check;
2. the `people.view` phone check;
3. the minor exclusion, including no identity call for that id;
4. user ids taken only from the scoped directory;
5. the AAD user-id binding on decrypt;
6. both audit rows, with ids only, and rollback on failure;
7. registration of the denial purpose (the denial is a 403, not a 500);
8. empty error bodies and `no-store`;
9. the 500-user cap, enforced before any decrypt;
10. no key creation on this path;
11. the `app` role's lack of identity privileges.

## Out-of-band

- **Architecture change: yes, in this PR.** §11.1 gains one sentence: the sign-in email is decrypted only in `core/identity`, in the regional service, for the Users & Roles list, and only for users in the caller's community directory, never for a minor-linked user. §12.2.1's `identity.users.email` row says the same. §6.3's "identity rows are deliberately minimal" stands: no name or phone is added to `identity`. No ADR (O2, project owner).
- **Legal sign-off:** none requested. Staff already see these contacts in All Contacts. The new exposure is the sign-in email, shown to staff of a community where that user holds a role or a link.
- **New subprocessor:** none.
- **Sensitive:** identity, tenancy, encryption, and children's data through the minor rule. The second independent review starts when the pull request opens. It runs in a fresh session, on a model that is neither the implementer's (Gemini, through Antigravity) nor the reviewer agent's (Claude Opus 5.5).
- **Staging:** stays parked. The integration suite against Postgres and the admin tests verify this spec's behaviour. The check on the staging hostname is deferred to the next proof chunk that unparks, as the restyle did. The PR records this as an AGENTS.md §8 deviation.
- **Owner decisions (project owner, AGENTS.md §12), answered 2026-11-11 by Abdus Salam:**
  - O1. Grant-to-reveal (see Risks): **accepted for this chunk.** User ids are unguessable, and grants and reads are audited. Consent workflows belong to the "User invitations" row.
  - O2. Showing the sign-in email to tenant staff: **the decryption rules go in `architecture.md` §11.1 and §12.2.1 in this PR. No ADR.**
  - O3. **Approved.** User creation, invitations and the contact picker move to a new roadmap row, "User invitations", which the catalogue commit adds.
- **Defaults for the chunk owner to confirm or change:**
  1. Identity is reached through a new export in `core/identity/public`, called from `apps/api` with the identity checkout, as `readSession` is. There is no new `packages/kernel` port. A port would change no data path today, and every manifest has `ports: []`.
  2. A separate route `users/list`, rather than adding details to `grants/list`. This keeps the decrypting path behind its own permission check and leaves today's contract unchanged.
  3. Names and emails need `access.roles.view` and `access.users.view`. Phones also need `people.view`, and not `people.restricted.read`.
  4. The email shown is the sign-in email, not the person's email.
  5. A minor-linked user shows no details to anyone on this screen, `community_admin` included. ADR 0017's per-field View belongs to the children's data access chunk.
  6. The identity checkout runs inside the app transaction callback, and the `listed` row is written last, so a failure leaves no audit row.
  7. The cap is 500 users. Anything over gets 409 `too_many` and no audit row.
  8. Built-in roles are shown by display label from a static admin map.
  9. Staging verification is deferred to the next proof chunk.
