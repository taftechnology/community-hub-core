import { blindIndexColumn, encryptedColumn } from "@community-hub/db";
import { pgSchema, pgTable, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const households = app.table("households", {
  id: uuid("id").notNull(),
  label: encryptedColumn("label", { label: "people.household_label" }),
  emailBidx: blindIndexColumn("email_bidx", { purpose: "people.email" }),
});

export const people = pgTable("people_direct", {
  id: uuid("id").notNull(),
  payload: encryptedColumn("payload", { label: "people.email" }),
  phoneBidx: blindIndexColumn("phone_bidx", { purpose: "people.phone" }),
});
