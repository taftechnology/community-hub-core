import { sql } from "drizzle-orm";
import { jsonb, pgPolicy, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { app } from "./namespaces.js";

export const outbox = app
  .table(
    "outbox",
    {
      id: uuid("id").notNull(),
      orgId: uuid("org_id").notNull(),
      eventName: text("event_name").notNull(),
      payload: jsonb("payload").notNull(),
      occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
      idempotencyKey: text("idempotency_key").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      unique().on(t.orgId, t.eventName, t.idempotencyKey),
      pgPolicy("tenant_isolation", {
        for: "all",
        using: sql`${t.orgId} = current_setting('app.org_id')::uuid`,
      }),
    ],
  )
  .enableRLS();
