import { sql, type SQL } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";

function communityPredicate(orgId: PgColumn, communityId: PgColumn): SQL {
  return sql`${orgId} = current_setting('app.org_id')::uuid and ${communityId} = current_setting('app.community_id')::uuid`;
}

export interface GroupsSchemaRefs {
  readonly persons: {
    readonly orgId: PgColumn;
    readonly id: PgColumn;
  };
}

export function groupsTables(app: PgSchema, refs: GroupsSchemaRefs) {
  const groups = app
    .table(
      "groups",
      {
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        id: uuid("id").notNull(),
        name: text("name").notNull(),
        nameKey: text("name_key").notNull(),
        description: text("description"),
        kind: text("kind").notNull(),
        status: text("status").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        uniqueIndex("groups_active_name_key_unique")
          .on(t.orgId, t.communityId, t.nameKey)
          .where(sql`${t.status} = 'active'`),
        check("groups_name_len", sql`char_length(${t.name}) between 1 and 120`),
        check(
          "groups_description_len",
          sql`${t.description} is null or char_length(${t.description}) <= 2000`,
        ),
        check("groups_kind", sql`${t.kind} in ('ministry', 'group')`),
        check("groups_status", sql`${t.status} in ('active', 'archived')`),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  const groupMembers = app
    .table(
      "group_members",
      {
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        groupId: uuid("group_id").notNull(),
        personId: uuid("person_id").notNull(),
        role: text("role").notNull(),
        addedAt: timestamp("added_at", { withTimezone: true, mode: "date" }).notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.groupId, t.personId] }),
        foreignKey({
          columns: [t.orgId, t.groupId],
          foreignColumns: [groups.orgId, groups.id],
          name: "group_members_group_fk",
        }).onDelete("restrict"),
        foreignKey({
          columns: [t.orgId, t.personId],
          foreignColumns: [refs.persons.orgId, refs.persons.id],
          name: "group_members_person_fk",
        }).onDelete("restrict"),
        check("group_members_role", sql`${t.role} in ('leader', 'member')`),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  return {
    groups,
    groupMembers,
  };
}
