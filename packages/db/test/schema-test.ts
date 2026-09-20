import { sql } from "drizzle-orm";
import { pgPolicy, primaryKey, uuid } from "drizzle-orm/pg-core";

import { blindIndexColumn, encryptedColumn } from "../src/columns.js";
import { app } from "../src/schema.js";

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

export const syntheticCrypto = app
  .table(
    "synthetic_crypto",
    {
      orgId: uuid("org_id").notNull(),
      communityId: uuid("community_id").notNull(),
      id: uuid("id").notNull(),
      payload: encryptedColumn("payload", { label: "people.email" }).notNull(),
      emailBidx: blindIndexColumn("email_bidx", { purpose: "people.email" }).notNull(),
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

export const syntheticCommunity = app
  .table(
    "synthetic_community",
    {
      orgId: uuid("org_id").notNull(),
      communityId: uuid("community_id").notNull(),
      id: uuid("id").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      pgPolicy("community_isolation", {
        for: "all",
        using: sql`${t.orgId} = current_setting('app.org_id')::uuid and ${t.communityId} = current_setting('app.community_id')::uuid`,
      }),
    ],
  )
  .enableRLS();
