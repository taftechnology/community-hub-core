import {
  capabilitiesBody,
  createCustomRoleBody,
  deleteCustomRoleBody,
  grantBody,
  linkUserBody,
  listGrantsBody,
  listUsersBody,
  revokeGrantBody,
  unlinkUserBody,
  CAPABILITIES_ALLOW_LIST,
  type CapabilitiesResponse,
} from "@community-hub/contracts/access";
import {
  AccessError,
  createCustomRole,
  deleteCustomRole,
  grantRole,
  holdsAnyGrant,
  holdsPermission,
  linkUser,
  revokeRole,
  unlinkUser,
} from "@community-hub/access";
import { appendAuditEvent, withAppTransaction, type AppTransaction } from "@community-hub/db";
import { bundle, catalogue, decide } from "@community-hub/policy";
import { findCommunityBySlug } from "@community-hub/tenancy";
import { readSession, readUserEmails } from "@community-hub/identity";
import { readLinkedContacts, type LinkedContact } from "@community-hub/people";
import { getRequestContext } from "@community-hub/kernel";

import type { Checkout } from "./checkout.js";
import type { GateRoute, RouteContext } from "./gate.js";
import type { BillingLogFields } from "./index.js";
import { guardWrite } from "./billing-guard.js";
import { checkEntitlement } from "./entitlement-guard.js";

type AccessSql = Parameters<typeof readSession>[0];

const DENIED = "access.permission.denied";
const VIEW = "access.roles.view";
const USERS_MANAGE = "access.users.manage";

const BUILT_IN = [
  ["org_owner", "organisation"],
  ["org_admin", "organisation"],
  ["org_billing", "organisation"],
  ["org_auditor", "organisation"],
  ["community_admin", "community"],
  ["staff", "community"],
  ["finance", "community"],
  ["safeguarding_officer", "community"],
  ["volunteer_coordinator", "community"],
  ["content_editor", "community"],
  ["member", "community"],
] as const;

const CONFLICT = new Set([
  "already_bootstrapped",
  "duplicate_grant",
  "duplicate_role",
  "duplicate_link",
  "last_owner",
  "limit_reached",
  "role_in_use",
  "minor_forbidden",
  "too_many",
]);

type Scope = { orgId: string; communityId: string };

type GrantView = {
  grantId: string;
  scope: "organisation" | "community";
  userId: string;
  roleKey: string | null;
  customRoleId: string | null;
  customRoleKey: string | null;
};

type CustomRoleView = {
  customRoleId: string;
  key: string;
  permissions: string[];
};

type Directory = {
  grants: GrantView[];
  customRoles: CustomRoleView[];
  userLinks: { userId: string; personId: string }[];
};

export type AccessLog = (message: string, fields: Record<string, unknown>) => void;

export type AccessDeps = {
  checkout: Checkout<AccessSql>;
  kms: Parameters<typeof readSession>[1];
  keyArn: string;
  now: () => Date;
  apiHostname: string;
  log: AccessLog;
  guardLog: (message: string, fields: BillingLogFields) => void;
};

function empty(status: number): Response {
  return new Response(null, { status });
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function errorClassFor(error: unknown): string {
  if (error instanceof Error) {
    const name: unknown = error.name;
    return typeof name === "string" && ERROR_CLASS.test(name) ? name : "Error";
  }
  return "NonError";
}

export type UserListItem = {
  userId: string;
  personId: string | null;
  name: { given: string; family: string } | null;
  email: string | null;
  phone: string | null;
  minor: boolean;
};

export function sortUsers(users: readonly UserListItem[]): UserListItem[] {
  return [...users].sort((a, b) => {
    if (a.name !== null && b.name === null) {
      return -1;
    }
    if (a.name === null && b.name !== null) {
      return 1;
    }
    if (a.name !== null && b.name !== null) {
      const fam = a.name.family.localeCompare(b.name.family, "en-AU", { sensitivity: "base" });
      if (fam !== 0) {
        return fam;
      }
      const giv = a.name.given.localeCompare(b.name.given, "en-AU", { sensitivity: "base" });
      if (giv !== 0) {
        return giv;
      }
    }
    if (a.email !== null && b.email === null) {
      return -1;
    }
    if (a.email === null && b.email !== null) {
      return 1;
    }
    if (a.email !== null && b.email !== null) {
      const em = a.email.localeCompare(b.email, "en-AU", { sensitivity: "base" });
      if (em !== 0) {
        return em;
      }
    }
    return a.userId.localeCompare(b.userId, "en-AU", { sensitivity: "base" });
  });
}

function presentedHostname(request: Request): string | undefined {
  const raw = request.headers.get("x-community-hub-hostname");
  if (raw === null || raw === "") {
    return undefined;
  }
  return raw.toLowerCase();
}

function jsonMediaType(request: Request): boolean {
  const raw = request.headers.get("content-type");
  if (raw === null) {
    return false;
  }
  return raw.split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function parse<T>(
  request: Request,
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
): Promise<T | undefined> {
  if (!jsonMediaType(request)) {
    return undefined;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

function bearer(request: Request): string | undefined {
  const raw = request.headers.get("authorization");
  if (raw === null) {
    return undefined;
  }
  const match = /^Bearer (\S+)$/i.exec(raw);
  return match?.[1];
}

function statusFor(error: AccessError): Response | undefined {
  if (error.code === "forbidden") {
    return empty(403);
  }
  if (error.code === "not_found") {
    return empty(404);
  }
  if (CONFLICT.has(error.code)) {
    return empty(409);
  }
  if (
    error.code === "invalid_id" ||
    error.code === "invalid_role" ||
    error.code === "invalid_permission"
  ) {
    return empty(400);
  }
  return undefined;
}

function allows(directory: Directory, actorUserId: string, permission: string): boolean {
  const mine = directory.grants.filter((grant) => grant.userId === actorUserId);
  const customIds = new Set(
    mine.flatMap((grant) => (grant.customRoleId === null ? [] : [grant.customRoleId])),
  );
  return decide({
    permission,
    organisationRoleKeys: mine.flatMap((grant) =>
      grant.scope === "organisation" && grant.roleKey !== null ? [grant.roleKey] : [],
    ),
    communityRoleKeys: mine.flatMap((grant) =>
      grant.scope === "community" && grant.roleKey !== null ? [grant.roleKey] : [],
    ),
    customPermissions: directory.customRoles
      .filter((role) => customIds.has(role.customRoleId))
      .flatMap((role) => role.permissions),
    guardianView: false,
    personScoped: false,
  });
}

async function loadDirectory(tx: AppTransaction): Promise<Directory> {
  const organisation = await tx<{ grant_id: string; user_id: string; role_key: string }[]>`
    select id::text as grant_id, user_id::text as user_id, role_key
    from app.organisation_role_grants
    where org_id = current_setting('app.org_id')::uuid
  `;
  const community = await tx<
    {
      grant_id: string;
      user_id: string;
      role_key: string | null;
      custom_role_id: string | null;
      custom_role_key: string | null;
    }[]
  >`
    select
      g.id::text as grant_id,
      g.user_id::text as user_id,
      g.role_key,
      g.custom_role_id::text as custom_role_id,
      r.key as custom_role_key
    from app.community_role_grants g
    left join app.custom_roles r on r.id = g.custom_role_id and r.org_id = g.org_id
    where g.org_id = current_setting('app.org_id')::uuid
      and g.community_id = current_setting('app.community_id')::uuid
  `;
  const roles = await tx<{ custom_role_id: string; key: string }[]>`
    select id::text as custom_role_id, key
    from app.custom_roles
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const permissions = await tx<{ custom_role_id: string; permission: string }[]>`
    select custom_role_id::text as custom_role_id, permission
    from app.custom_role_permissions
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  const links = await tx<{ user_id: string; person_id: string }[]>`
    select user_id::text as user_id, person_id::text as person_id
    from app.user_links
    where org_id = current_setting('app.org_id')::uuid
      and community_id = current_setting('app.community_id')::uuid
  `;
  return {
    grants: [
      ...organisation.map((row) => ({
        grantId: row.grant_id,
        scope: "organisation" as const,
        userId: row.user_id,
        roleKey: row.role_key,
        customRoleId: null,
        customRoleKey: null,
      })),
      ...community.map((row) => ({
        grantId: row.grant_id,
        scope: "community" as const,
        userId: row.user_id,
        roleKey: row.role_key,
        customRoleId: row.custom_role_id,
        customRoleKey: row.custom_role_key,
      })),
    ],
    customRoles: roles.map((role) => ({
      customRoleId: role.custom_role_id,
      key: role.key,
      permissions: permissions
        .filter((row) => row.custom_role_id === role.custom_role_id)
        .map((row) => row.permission),
    })),
    userLinks: links.map((row) => ({ userId: row.user_id, personId: row.person_id })),
  };
}

function callerPermissions(directory: Directory, actorUserId: string): string[] {
  return catalogue().filter((permission) => allows(directory, actorUserId, permission));
}

function listBody(
  directory: Directory,
  permissions: readonly string[],
): {
  grants: GrantView[];
  customRoles: CustomRoleView[];
  catalogue: readonly string[];
  builtIn: {
    roleKey: string;
    scope: "organisation" | "community";
    permissions: readonly string[];
  }[];
  userLinks: { userId: string; personId: string }[];
  permissions: readonly string[];
} {
  return {
    grants: directory.grants,
    customRoles: directory.customRoles,
    catalogue: catalogue(),
    builtIn: BUILT_IN.map(([roleKey, scope]) => ({
      roleKey,
      scope,
      permissions: bundle(roleKey) ?? [],
    })),
    userLinks: directory.userLinks,
    permissions,
  };
}

export function accessRoutes(deps: AccessDeps): GateRoute[] {
  function foreignHost(request: Request): Response | undefined {
    if (presentedHostname(request) !== deps.apiHostname.toLowerCase()) {
      return empty(404);
    }
    return undefined;
  }

  async function sessionUser(request: Request): Promise<{ userId: string } | Response> {
    const token = bearer(request);
    if (token === undefined) {
      return empty(401);
    }
    const session = await deps.checkout("identity", (sql) =>
      readSession(sql, deps.kms, deps.keyArn, {
        accessToken: token,
        now: deps.now(),
      }),
    );
    if (session === null) {
      return empty(401);
    }
    return { userId: session.userId };
  }

  async function communityScope(
    slug: string,
    context: RouteContext,
    userId: string,
  ): Promise<Scope | Response | null> {
    const found = await deps.checkout("platform", (sql) => findCommunityBySlug(sql, slug));
    if (found === null) {
      return null;
    }
    const scope = { orgId: found.organisationId, communityId: found.id };
    const blocked = await guardWrite(
      {
        checkout: deps.checkout,
        now: deps.now,
        guardLog: deps.guardLog,
      },
      scope,
      userId,
      context,
    );
    if (blocked !== null) {
      return blocked;
    }
    return scope;
  }

  async function transact<T>(
    scope: Scope,
    run: (tx: AppTransaction) => Promise<T>,
  ): Promise<T | AccessError> {
    return deps.checkout("app", (sql) =>
      withAppTransaction(sql, scope, async (tx) => {
        try {
          return await run(tx);
        } catch (error) {
          if (error instanceof AccessError) {
            return error;
          }
          throw error;
        }
      }),
    );
  }

  function finish<T>(outcome: T | AccessError, ok: (value: T) => Response): Response {
    if (outcome instanceof AccessError) {
      const response = statusFor(outcome);
      if (response !== undefined) {
        return response;
      }
      throw outcome;
    }
    return ok(outcome);
  }

  async function deny(tx: AppTransaction, actorUserId: string, purpose: string): Promise<never> {
    await appendAuditEvent(tx, {
      actorKind: "user",
      actorId: actorUserId,
      action: DENIED,
      purpose,
      targetIds: [actorUserId],
    });
    throw new AccessError("forbidden");
  }

  return [
    {
      method: "POST",
      pattern: "/v1/access/grants/list",
      surface: "tenant",
      billing: "read",
      handle: async (request, context) => {
        const hidden = foreignHost(request);
        if (hidden !== undefined) {
          return hidden;
        }
        const body = await parse(request, listGrantsBody);
        if (body === undefined) {
          return empty(400);
        }
        const actor = await sessionUser(request);
        if (actor instanceof Response) {
          return actor;
        }
        const scope = await communityScope(body.communitySlug, context, actor.userId);
        if (scope === null) {
          return empty(403);
        }
        if (scope instanceof Response) {
          return scope;
        }
        const outcome = await transact(scope, async (tx) => {
          const directory = await loadDirectory(tx);
          if (!allows(directory, actor.userId, VIEW)) {
            return deny(tx, actor.userId, VIEW);
          }
          return listBody(directory, callerPermissions(directory, actor.userId));
        });
        return finish(outcome, (value) => Response.json(value));
      },
    },
    {
      method: "POST",
      pattern: "/v1/access/users/list",
      surface: "tenant",
      billing: "read",
      handle: async (request, context) => {
        try {
          const hidden = foreignHost(request);
          if (hidden !== undefined) {
            return noStore(hidden);
          }
          const body = await parse(request, listUsersBody);
          if (body === undefined) {
            return noStore(empty(400));
          }
          const actor = await sessionUser(request);
          if (actor instanceof Response) {
            return noStore(actor);
          }
          const scope = await communityScope(body.communitySlug, context, actor.userId);
          if (scope === null) {
            return noStore(empty(403));
          }
          if (scope instanceof Response) {
            return noStore(scope);
          }

          const outcome = await transact(scope, async (tx) => {
            const directory = await loadDirectory(tx);
            const permissions = callerPermissions(directory, actor.userId);

            if (!permissions.includes("access.roles.view")) {
              return deny(tx, actor.userId, "access.roles.view");
            }
            if (!permissions.includes("access.users.view")) {
              return deny(tx, actor.userId, "access.users.view");
            }

            const userIds = Array.from(
              new Set([
                ...directory.grants.map((g) => g.userId),
                ...directory.userLinks.map((l) => l.userId),
              ]),
            );

            if (userIds.length > 500) {
              throw new AccessError("too_many");
            }

            const userToPersonId = new Map<string, string>();
            for (const link of directory.userLinks) {
              userToPersonId.set(link.userId, link.personId);
            }

            const personIds = Array.from(new Set(directory.userLinks.map((l) => l.personId)));
            const includePhone = permissions.includes("people.view");

            let linkedContacts = new Map<string, LinkedContact>();
            if (personIds.length > 0) {
              linkedContacts = await readLinkedContacts(tx, deps.kms, deps.keyArn, {
                personIds,
                includePhone,
                actorUserId: actor.userId,
              });
            }

            const emailUserIds: string[] = [];
            for (const userId of userIds) {
              const personId = userToPersonId.get(userId);
              const contact = personId !== undefined ? linkedContacts.get(personId) : undefined;
              if (contact?.minor !== true) {
                emailUserIds.push(userId);
              }
            }

            let userEmails = new Map<string, string>();
            if (emailUserIds.length > 0) {
              userEmails = await deps.checkout("identity", (sql) =>
                readUserEmails(sql, deps.kms, deps.keyArn, emailUserIds),
              );
            }

            const rows: UserListItem[] = userIds.map((userId) => {
              const personId = userToPersonId.get(userId) ?? null;
              const contact = personId !== null ? linkedContacts.get(personId) : undefined;
              const isMinor = contact?.minor === true;

              if (isMinor) {
                return {
                  userId,
                  personId,
                  name: null,
                  email: null,
                  phone: null,
                  minor: true,
                };
              }

              let name: { given: string; family: string } | null = null;
              let phone: string | null = null;
              if (contact !== undefined && !contact.minor) {
                name = { given: contact.given, family: contact.family };
                phone = includePhone ? contact.phone : null;
              }
              const email = userEmails.get(userId) ?? null;

              return {
                userId,
                personId,
                name,
                email,
                phone,
                minor: false,
              };
            });

            const sortedUsers = sortUsers(rows);

            await appendAuditEvent(tx, {
              actorKind: "user",
              actorId: actor.userId,
              action: "access.users.listed",
              purpose: "access.users.listed",
              targetIds: sortedUsers.map((u) => u.userId),
            });

            return {
              phoneVisible: includePhone,
              users: sortedUsers,
            };
          });

          return noStore(finish(outcome, (value) => Response.json(value)));
        } catch (error) {
          if (error instanceof AccessError) {
            const mapped = statusFor(error);
            if (mapped !== undefined) {
              return noStore(mapped);
            }
          }
          const errorClass = errorClassFor(error);
          deps.log("request", {
            path: new URL(request.url).pathname,
            status: "500",
            requestId: getRequestContext().requestId,
            errorClass,
          });
          return noStore(empty(500));
        }
      },
    },
    {
      method: "POST",
      pattern: "/v1/access/capabilities",
      surface: "tenant",
      billing: "read",
      handle: async (request) => {
        const hidden = foreignHost(request);
        if (hidden !== undefined) {
          return hidden;
        }
        const body = await parse(request, capabilitiesBody);
        if (body === undefined) {
          return empty(400);
        }
        const actor = await sessionUser(request);
        if (actor instanceof Response) {
          return actor;
        }
        const found = await deps.checkout("platform", (sql) =>
          findCommunityBySlug(sql, body.communitySlug),
        );
        if (found === null) {
          return empty(403);
        }
        const scope = { orgId: found.organisationId, communityId: found.id };

        const perms = await deps.checkout("app", (sql) =>
          withAppTransaction(sql, scope, async (tx) => {
            const hasRole = await holdsAnyGrant(tx, actor.userId);
            if (!hasRole) {
              return null;
            }
            const permissionEntries = await Promise.all(
              CAPABILITIES_ALLOW_LIST.permissions.map(
                async (perm) => [perm, await holdsPermission(tx, actor.userId, perm)] as const,
              ),
            );
            return Object.fromEntries(permissionEntries) as CapabilitiesResponse["permissions"];
          }),
        );

        if (perms === null) {
          return empty(403);
        }

        const entitlementEntries = await Promise.all(
          CAPABILITIES_ALLOW_LIST.entitlements.map(
            async (key) =>
              [
                key,
                await checkEntitlement(
                  { checkout: deps.checkout, now: deps.now, guardLog: deps.guardLog },
                  scope,
                  key,
                ),
              ] as const,
          ),
        );
        const entitlements = Object.fromEntries(
          entitlementEntries,
        ) as CapabilitiesResponse["entitlements"];

        const response: CapabilitiesResponse = {
          permissions: perms,
          entitlements,
        };

        return Response.json(response);
      },
    },
    {
      method: "POST",
      pattern: "/v1/access/grants",
      surface: "tenant",
      billing: "write",
      handle: async (request, context) => {
        const hidden = foreignHost(request);
        if (hidden !== undefined) {
          return hidden;
        }
        const body = await parse(request, grantBody);
        if (body === undefined) {
          return empty(400);
        }
        const actor = await sessionUser(request);
        if (actor instanceof Response) {
          return actor;
        }
        const scope = await communityScope(body.communitySlug, context, actor.userId);
        if (scope === null) {
          return empty(403);
        }
        if (scope instanceof Response) {
          return scope;
        }
        const outcome = await transact(scope, (tx) =>
          grantRole(tx, {
            now: deps.now(),
            userId: body.userId,
            roleKey: "roleKey" in body ? body.roleKey : null,
            customRoleId: "customRoleId" in body ? body.customRoleId : null,
            actorUserId: actor.userId,
          }),
        );
        return finish(outcome, (value) => Response.json(value));
      },
    },
    {
      method: "POST",
      pattern: "/v1/access/grants/revoke",
      surface: "tenant",
      billing: "write",
      handle: async (request, context) => {
        const hidden = foreignHost(request);
        if (hidden !== undefined) {
          return hidden;
        }
        const body = await parse(request, revokeGrantBody);
        if (body === undefined) {
          return empty(400);
        }
        const actor = await sessionUser(request);
        if (actor instanceof Response) {
          return actor;
        }
        const scope = await communityScope(body.communitySlug, context, actor.userId);
        if (scope === null) {
          return empty(403);
        }
        if (scope instanceof Response) {
          return scope;
        }
        const outcome = await transact(scope, (tx) =>
          revokeRole(tx, {
            now: deps.now(),
            grantId: body.grantId,
            scope: body.scope,
            actorUserId: actor.userId,
          }),
        );
        return finish(outcome, () => empty(200));
      },
    },
    {
      method: "POST",
      pattern: "/v1/access/custom-roles",
      surface: "tenant",
      billing: "write",
      handle: async (request, context) => {
        const hidden = foreignHost(request);
        if (hidden !== undefined) {
          return hidden;
        }
        const body = await parse(request, createCustomRoleBody);
        if (body === undefined) {
          return empty(400);
        }
        const actor = await sessionUser(request);
        if (actor instanceof Response) {
          return actor;
        }
        const scope = await communityScope(body.communitySlug, context, actor.userId);
        if (scope === null) {
          return empty(403);
        }
        if (scope instanceof Response) {
          return scope;
        }
        const outcome = await transact(scope, (tx) =>
          createCustomRole(tx, {
            now: deps.now(),
            key: body.key,
            permissions: body.permissions,
            actorUserId: actor.userId,
          }),
        );
        return finish(outcome, (value) => Response.json(value));
      },
    },
    {
      method: "POST",
      pattern: "/v1/access/custom-roles/delete",
      surface: "tenant",
      billing: "write",
      handle: async (request, context) => {
        const hidden = foreignHost(request);
        if (hidden !== undefined) {
          return hidden;
        }
        const body = await parse(request, deleteCustomRoleBody);
        if (body === undefined) {
          return empty(400);
        }
        const actor = await sessionUser(request);
        if (actor instanceof Response) {
          return actor;
        }
        const scope = await communityScope(body.communitySlug, context, actor.userId);
        if (scope === null) {
          return empty(403);
        }
        if (scope instanceof Response) {
          return scope;
        }
        const outcome = await transact(scope, (tx) =>
          deleteCustomRole(tx, {
            now: deps.now(),
            customRoleId: body.customRoleId,
            actorUserId: actor.userId,
          }),
        );
        return finish(outcome, () => empty(200));
      },
    },
    {
      method: "POST",
      pattern: "/v1/access/user-links",
      surface: "tenant",
      billing: "write",
      handle: async (request, context) => {
        const hidden = foreignHost(request);
        if (hidden !== undefined) {
          return hidden;
        }
        const body = await parse(request, linkUserBody);
        if (body === undefined) {
          return empty(400);
        }
        const actor = await sessionUser(request);
        if (actor instanceof Response) {
          return actor;
        }
        const scope = await communityScope(body.communitySlug, context, actor.userId);
        if (scope === null) {
          return empty(403);
        }
        if (scope instanceof Response) {
          return scope;
        }
        const outcome = await transact(scope, async (tx) => {
          const directory = await loadDirectory(tx);
          if (!allows(directory, actor.userId, USERS_MANAGE)) {
            return deny(tx, actor.userId, USERS_MANAGE);
          }
          return linkUser(tx, {
            now: deps.now(),
            userId: body.userId,
            personId: body.personId,
            actorUserId: actor.userId,
          });
        });
        return finish(outcome, (value) => Response.json(value));
      },
    },
    {
      method: "POST",
      pattern: "/v1/access/user-links/delete",
      surface: "tenant",
      billing: "write",
      handle: async (request, context) => {
        const hidden = foreignHost(request);
        if (hidden !== undefined) {
          return hidden;
        }
        const body = await parse(request, unlinkUserBody);
        if (body === undefined) {
          return empty(400);
        }
        const actor = await sessionUser(request);
        if (actor instanceof Response) {
          return actor;
        }
        const scope = await communityScope(body.communitySlug, context, actor.userId);
        if (scope === null) {
          return empty(403);
        }
        if (scope instanceof Response) {
          return scope;
        }
        const outcome = await transact(scope, async (tx) => {
          const directory = await loadDirectory(tx);
          if (!allows(directory, actor.userId, USERS_MANAGE)) {
            return deny(tx, actor.userId, USERS_MANAGE);
          }
          await unlinkUser(tx, {
            now: deps.now(),
            userId: body.userId,
            actorUserId: actor.userId,
          });
        });
        return finish(outcome, () => empty(200));
      },
    },
  ];
}
