import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db, people } from "../table.js";

export function run(): void {
  const c: AnyPgColumn = people.payload;
  db.select().from(people).orderBy(c);
}
