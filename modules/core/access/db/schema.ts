import { sql, type SQL } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgPolicy,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  type PgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";

type PersonKey = {
  orgId: PgColumn;
  id: PgColumn;
};

let personKey: PersonKey | undefined;

export function rememberPersonKey(columns: PersonKey): void {
  personKey = columns;
}

function requirePersonKey(): PersonKey {
  if (personKey === undefined) {
    throw new Error("person key is missing");
  }
  return personKey;
}

function orgPredicate(orgId: PgColumn): SQL {
  return sql`${orgId} = current_setting('app.org_id')::uuid`;
}

function communityPredicate(orgId: PgColumn, communityId: PgColumn): SQL {
  return sql`${orgId} = current_setting('app.org_id')::uuid and ${communityId} = current_setting('app.community_id')::uuid`;
}

export function accessTables(app: PgSchema) {
  const persons = requirePersonKey();

  const organisationRoleGrants = app
    .table(
      "organisation_role_grants",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        userId: uuid("user_id").notNull(),
        roleKey: text("role_key").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        unique("organisation_role_grants_user_role_unique").on(t.orgId, t.userId, t.roleKey),
        check(
          "organisation_role_grants_role_key",
          sql`${t.roleKey} in ('org_owner', 'org_admin', 'org_billing', 'org_auditor')`,
        ),
        pgPolicy("org_isolation", {
          for: "all",
          using: orgPredicate(t.orgId),
          withCheck: orgPredicate(t.orgId),
        }),
      ],
    )
    .enableRLS();

  const customRoles = app
    .table(
      "custom_roles",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        key: text("key").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        unique("custom_roles_community_key_unique").on(t.communityId, t.key),
        check(
          "custom_roles_key",
          sql`${t.key} ~ '^[a-z][a-z0-9_]{1,31}$' and ${t.key} not in ('org_owner', 'org_admin', 'org_billing', 'org_auditor', 'community_admin', 'staff', 'finance', 'safeguarding_officer', 'volunteer_coordinator', 'content_editor', 'member', 'platform_admin', 'platform_support', 'platform_security')`,
        ),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  const communityRoleGrants = app
    .table(
      "community_role_grants",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        userId: uuid("user_id").notNull(),
        roleKey: text("role_key"),
        customRoleId: uuid("custom_role_id"),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        uniqueIndex("community_role_grants_user_role_unique")
          .on(t.communityId, t.userId, t.roleKey)
          .where(sql`${t.roleKey} is not null`),
        uniqueIndex("community_role_grants_user_custom_unique")
          .on(t.communityId, t.userId, t.customRoleId)
          .where(sql`${t.customRoleId} is not null`),
        foreignKey({
          columns: [t.orgId, t.customRoleId],
          foreignColumns: [customRoles.orgId, customRoles.id],
          name: "community_role_grants_custom_role_fk",
        }).onDelete("restrict"),
        check(
          "community_role_grants_role_key",
          sql`${t.roleKey} is null or ${t.roleKey} in ('community_admin', 'staff', 'finance', 'safeguarding_officer', 'volunteer_coordinator', 'content_editor', 'member')`,
        ),
        check(
          "community_role_grants_one_target",
          sql`(${t.roleKey} is null) <> (${t.customRoleId} is null)`,
        ),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  const customRolePermissions = app
    .table(
      "custom_role_permissions",
      {
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        customRoleId: uuid("custom_role_id").notNull(),
        permission: text("permission").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.customRoleId, t.permission] }),
        foreignKey({
          columns: [t.orgId, t.customRoleId],
          foreignColumns: [customRoles.orgId, customRoles.id],
          name: "custom_role_permissions_custom_role_fk",
        }).onDelete("restrict"),
        check(
          "custom_role_permissions_permission",
          sql`${t.permission} in ('access.users.view', 'access.users.manage', 'access.roles.view', 'access.roles.manage', 'people.restricted.read')`,
        ),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  const userLinks = app
    .table(
      "user_links",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        userId: uuid("user_id").notNull(),
        personId: uuid("person_id").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        unique("user_links_community_user_unique").on(t.communityId, t.userId),
        unique("user_links_community_person_unique").on(t.communityId, t.personId),
        foreignKey({
          columns: [t.orgId, t.personId],
          foreignColumns: [persons.orgId, persons.id],
          name: "user_links_person_fk",
        }).onDelete("restrict"),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  return {
    organisationRoleGrants,
    communityRoleGrants,
    customRoles,
    customRolePermissions,
    userLinks,
  };
}
