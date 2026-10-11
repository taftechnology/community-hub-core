import { blindIndexColumn, encryptedColumn } from "@community-hub/db";
import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  pgPolicy,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

function tz(name: string) {
  return timestamp(name, { withTimezone: true, mode: "date" });
}

function orgPredicate(orgId: PgColumn): SQL {
  return sql`${orgId} = current_setting('app.org_id')::uuid`;
}

function communityPredicate(orgId: PgColumn, communityId: PgColumn): SQL {
  return sql`${orgId} = current_setting('app.org_id')::uuid and ${communityId} = current_setting('app.community_id')::uuid`;
}

export function peopleTables(app: PgSchema) {
  const organisationKeys = app
    .table(
      "organisation_keys",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        wrapped: bytea("wrapped").notNull(),
        keyVersion: text("key_version").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        unique("organisation_keys_org_id_unique").on(t.orgId),
        check("organisation_keys_key_version", sql`${t.keyVersion} = '1'`),
        pgPolicy("tenant_isolation", {
          for: "all",
          using: orgPredicate(t.orgId),
          withCheck: orgPredicate(t.orgId),
        }),
      ],
    )
    .enableRLS();

  const communityKeys = app
    .table(
      "community_keys",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        wrapped: bytea("wrapped").notNull(),
        keyVersion: text("key_version").notNull(),
        parentKeyId: uuid("parent_key_id").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        unique("community_keys_community_id_unique").on(t.communityId),
        check("community_keys_key_version", sql`${t.keyVersion} = '1'`),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  const households = app
    .table(
      "households",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        label: encryptedColumn("label", { label: "people.household_label" }),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  const householdKeys = app
    .table(
      "household_keys",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        householdId: uuid("household_id").notNull(),
        wrapped: bytea("wrapped").notNull(),
        keyVersion: text("key_version").notNull(),
        parentKeyId: uuid("parent_key_id").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        unique("household_keys_household_id_unique").on(t.householdId),
        foreignKey({
          columns: [t.orgId, t.householdId],
          foreignColumns: [households.orgId, households.id],
          name: "household_keys_household_fk",
        }).onDelete("restrict"),
        check("household_keys_key_version", sql`${t.keyVersion} = '1'`),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  const persons = app
    .table(
      "persons",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        householdId: uuid("household_id"),
        isMinor: boolean("is_minor").notNull(),
        ageBasis: text("age_basis").notNull(),
        birthdayMd: smallint("birthday_md"),
        givenName: text("given_name"),
        familyName: text("family_name"),
        givenNameRestricted: encryptedColumn("given_name_restricted", {
          label: "people.given_name",
        }),
        familyNameRestricted: encryptedColumn("family_name_restricted", {
          label: "people.family_name",
        }),
        dateOfBirth: encryptedColumn("date_of_birth", { label: "people.date_of_birth" }),
        email: encryptedColumn("email", { label: "people.email" }),
        emailBidx: blindIndexColumn("email_bidx", { purpose: "people.email" }),
        phone: encryptedColumn("phone", { label: "people.phone" }),
        phoneBidx: blindIndexColumn("phone_bidx", { purpose: "people.phone" }),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        foreignKey({
          columns: [t.orgId, t.householdId],
          foreignColumns: [households.orgId, households.id],
          name: "persons_household_fk",
        }).onDelete("restrict"),
        uniqueIndex("persons_adult_email_bidx")
          .on(t.communityId, t.emailBidx)
          .where(sql`${t.isMinor} = false and ${t.emailBidx} is not null`),
        uniqueIndex("persons_minor_email_bidx")
          .on(t.householdId, t.emailBidx)
          .where(sql`${t.isMinor} = true and ${t.emailBidx} is not null`),
        uniqueIndex("persons_adult_phone_bidx")
          .on(t.communityId, t.phoneBidx)
          .where(sql`${t.isMinor} = false and ${t.phoneBidx} is not null`),
        uniqueIndex("persons_minor_phone_bidx")
          .on(t.householdId, t.phoneBidx)
          .where(sql`${t.isMinor} = true and ${t.phoneBidx} is not null`),
        check(
          "persons_age_basis",
          sql`${t.ageBasis} in ('date_of_birth', 'declared_adult', 'unknown')`,
        ),
        check(
          "persons_age_basis_dob",
          sql`(${t.ageBasis} = 'date_of_birth') = (${t.dateOfBirth} is not null)`,
        ),
        check(
          "persons_age_basis_declared",
          sql`${t.ageBasis} <> 'declared_adult' or ${t.isMinor} = false`,
        ),
        check("persons_age_basis_unknown", sql`${t.ageBasis} <> 'unknown' or ${t.isMinor} = true`),
        check(
          "persons_name_split",
          sql`(
            ${t.isMinor} = true
            and ${t.householdId} is not null
            and ${t.givenName} is null
            and ${t.familyName} is null
            and ${t.givenNameRestricted} is not null
            and ${t.familyNameRestricted} is not null
          ) or (
            ${t.isMinor} = false
            and ${t.givenName} is not null
            and ${t.familyName} is not null
            and ${t.givenNameRestricted} is null
            and ${t.familyNameRestricted} is null
          )`,
        ),
        check("persons_birthday_pair", sql`(${t.dateOfBirth} is null) = (${t.birthdayMd} is null)`),
        check(
          "persons_birthday_md_range",
          sql`${t.birthdayMd} is null or (${t.birthdayMd} / 100 between 1 and 12 and ${t.birthdayMd} % 100 between 1 and 31)`,
        ),
        check("persons_email_pair", sql`(${t.email} is null) = (${t.emailBidx} is null)`),
        check("persons_phone_pair", sql`(${t.phone} is null) = (${t.phoneBidx} is null)`),
        check(
          "persons_email_bidx_len",
          sql`${t.emailBidx} is null or octet_length(${t.emailBidx}) = 32`,
        ),
        check(
          "persons_phone_bidx_len",
          sql`${t.phoneBidx} is null or octet_length(${t.phoneBidx}) = 32`,
        ),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  const guardianLinks = app
    .table(
      "guardian_links",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        householdId: uuid("household_id").notNull(),
        guardianPersonId: uuid("guardian_person_id").notNull(),
        childPersonId: uuid("child_person_id").notNull(),
        consent: boolean("consent").notNull(),
        pickup: boolean("pickup").notNull(),
        view: boolean("view").notNull(),
        manage: boolean("manage").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        unique("guardian_links_triple_unique").on(
          t.householdId,
          t.guardianPersonId,
          t.childPersonId,
        ),
        foreignKey({
          columns: [t.orgId, t.householdId],
          foreignColumns: [households.orgId, households.id],
          name: "guardian_links_household_fk",
        }).onDelete("restrict"),
        foreignKey({
          columns: [t.orgId, t.guardianPersonId],
          foreignColumns: [persons.orgId, persons.id],
          name: "guardian_links_guardian_fk",
        }).onDelete("restrict"),
        foreignKey({
          columns: [t.orgId, t.childPersonId],
          foreignColumns: [persons.orgId, persons.id],
          name: "guardian_links_child_fk",
        }).onDelete("restrict"),
        check(
          "guardian_links_rights",
          sql`${t.consent} or ${t.pickup} or ${t.view} or ${t.manage}`,
        ),
        check("guardian_links_distinct", sql`${t.guardianPersonId} <> ${t.childPersonId}`),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  const personTags = app
    .table(
      "person_tags",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        label: text("label").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        unique("person_tags_community_label_unique").on(t.communityId, t.label),
        check("person_tags_label", sql`${t.label} ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'`),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  const personTagLinks = app
    .table(
      "person_tag_links",
      {
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        personId: uuid("person_id").notNull(),
        tagId: uuid("tag_id").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.personId, t.tagId] }),
        foreignKey({
          columns: [t.orgId, t.personId],
          foreignColumns: [persons.orgId, persons.id],
          name: "person_tag_links_person_fk",
        }).onDelete("restrict"),
        foreignKey({
          columns: [t.orgId, t.tagId],
          foreignColumns: [personTags.orgId, personTags.id],
          name: "person_tag_links_tag_fk",
        }).onDelete("restrict"),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  const personActivity = app
    .table(
      "person_activity",
      {
        id: uuid("id").notNull(),
        orgId: uuid("org_id").notNull(),
        communityId: uuid("community_id").notNull(),
        personId: uuid("person_id").notNull(),
        actorUserId: uuid("actor_user_id"),
        kind: text("kind").notNull(),
        occurredAt: tz("occurred_at").notNull(),
      },
      (t) => [
        primaryKey({ columns: [t.orgId, t.id] }),
        foreignKey({
          columns: [t.orgId, t.personId],
          foreignColumns: [persons.orgId, persons.id],
          name: "person_activity_person_fk",
        }).onDelete("restrict"),
        index("person_activity_person_idx").on(t.orgId, t.personId),
        check(
          "person_activity_kind",
          sql`${t.kind} in ('created', 'tagged', 'untagged', 'guardian_linked', 'guardian_unlinked')`,
        ),
        pgPolicy("community_isolation", {
          for: "all",
          using: communityPredicate(t.orgId, t.communityId),
          withCheck: communityPredicate(t.orgId, t.communityId),
        }),
      ],
    )
    .enableRLS();

  return {
    organisationKeys,
    communityKeys,
    householdKeys,
    households,
    persons,
    guardianLinks,
    personTags,
    personTagLinks,
    personActivity,
  };
}
