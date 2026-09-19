import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db, people } from "../table.js";

export function run(): void {
  const col = new Map<string, AnyPgColumn>([["p", people.payload]]).get("p");
  db.select().from(people).orderBy(col!);
}
