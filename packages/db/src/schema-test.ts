import { sql } from "drizzle-orm";
import { pgPolicy, primaryKey, uuid } from "drizzle-orm/pg-core";

import { app } from "./schema.js";

export const synthetic = app
  .table(
    "synthetic",
    {
      orgId: uuid("org_id").notNull(),
      id: uuid("id").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      pgPolicy("tenant_isolation", {
        for: "all",
        using: sql`${t.orgId} = current_setting('app.org_id')::uuid`,
      }),
    ],
  )
  .enableRLS();
