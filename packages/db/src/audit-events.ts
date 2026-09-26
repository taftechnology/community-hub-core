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
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      unique("audit_events_org_id_seq_unique").on(t.orgId, t.seq),
      check("audit_events_seq_positive", sql`${t.seq} >= 1`),
      check("audit_events_prev_hash_len", sql`octet_length(${t.prevHash}) = 32`),
      check("audit_events_hash_len", sql`octet_length(${t.hash}) = 32`),
      check(
        "audit_events_actor",
        sql`${t.actorKind} in ('user', 'support', 'system')
          and (
            (${t.actorKind} = 'system' and ${t.actorId} is null)
            or (${t.actorKind} in ('user', 'support') and ${t.actorId} is not null)
          )`,
      ),
      // Matches AUDIT_NAME_RE in @community-hub/kernel (drizzle-kit cannot import that package).
      check(
        "audit_events_action",
        sql`${t.action} ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'`,
      ),
      check(
        "audit_events_purpose",
        sql`${t.purpose} ~ '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$'`,
      ),
      check(
        "audit_events_target_ids",
        sql`CASE
  WHEN cardinality(${t.targetIds}) = 0 THEN true
  WHEN array_ndims(${t.targetIds}) IS DISTINCT FROM 1 THEN false
  ELSE array_position(${t.targetIds}, NULL) IS NULL
END`,
      ),
      pgPolicy("audit_events_select", {
        for: "select",
        using: sql`${t.orgId} = current_setting('app.org_id')::uuid`,
      }),
      pgPolicy("audit_events_insert", {
        for: "insert",
        withCheck: sql`${t.orgId} = current_setting('app.org_id')::uuid`,
      }),
    ],
  )
  .enableRLS();
