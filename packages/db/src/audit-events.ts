import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  pgPolicy,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { app } from "./namespaces.js";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

// Matches AUDIT_NAME_RE in @community-hub/kernel (drizzle-kit cannot import that package).
const auditNameSql = sql.raw(
  `'^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'`,
);

export const auditEvents = app
  .table(
    "audit_events",
    {
      id: uuid("id").notNull(),
      orgId: uuid("org_id").notNull(),
      seq: bigint("seq", { mode: "bigint" }).notNull(),
      hashVersion: smallint("hash_version").notNull(),
      prevHash: bytea("prev_hash").notNull(),
      hash: bytea("hash").notNull(),
      actorKind: text("actor_kind").notNull(),
      actorId: uuid("actor_id"),
      action: text("action").notNull(),
      targetIds: uuid("target_ids").array().notNull(),
      purpose: text("purpose").notNull(),
      requestId: uuid("request_id").notNull(),
      occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    },
    () => [
      primaryKey({ columns: [auditEvents.orgId, auditEvents.id] }),
      unique("audit_events_org_id_seq_unique").on(auditEvents.orgId, auditEvents.seq),
      check("audit_events_seq_positive", sql`${auditEvents.seq} >= 1`),
      check("audit_events_prev_hash_len", sql`octet_length(${auditEvents.prevHash}) = 32`),
      check("audit_events_hash_len", sql`octet_length(${auditEvents.hash}) = 32`),
      check(
        "audit_events_actor",
        sql`${auditEvents.actorKind} in ('user', 'support', 'system')
          and (
            (${auditEvents.actorKind} = 'system' and ${auditEvents.actorId} is null)
            or (${auditEvents.actorKind} in ('user', 'support') and ${auditEvents.actorId} is not null)
          )`,
      ),
      check("audit_events_action", sql`${auditEvents.action} ~ ${auditNameSql}`),
      check("audit_events_purpose", sql`${auditEvents.purpose} ~ ${auditNameSql}`),
      check(
        "audit_events_target_ids",
        sql`CASE
  WHEN cardinality(${auditEvents.targetIds}) = 0 THEN true
  WHEN array_ndims(${auditEvents.targetIds}) IS DISTINCT FROM 1 THEN false
  ELSE array_position(${auditEvents.targetIds}, NULL) IS NULL
END`,
      ),
      pgPolicy("audit_events_select", {
        for: "select",
        using: sql`${auditEvents.orgId} = current_setting('app.org_id')::uuid`,
      }),
      pgPolicy("audit_events_insert", {
        for: "insert",
        withCheck: sql`${auditEvents.orgId} = current_setting('app.org_id')::uuid`,
      }),
    ],
  )
  .enableRLS();
