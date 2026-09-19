import type { BlindIndex, Ciphertext } from "@community-hub/crypto";
import { blindIndexColumn, encryptedColumn } from "@community-hub/db";
import { pgTable, uuid } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export const people = pgTable("people", {
  id: uuid("id").notNull(),
  payload: encryptedColumn("payload", { label: "people.email" }),
  emailBidx: blindIndexColumn("email_bidx", { purpose: "people.email" }),
  phoneBidx: blindIndexColumn("phone_bidx", { purpose: "people.phone" }),
});

export declare const db: PostgresJsDatabase;
export declare const payload: Ciphertext;
export declare const emailBidx: BlindIndex<"people.email">;
export declare const emailBidxList: BlindIndex<"people.email">[];
