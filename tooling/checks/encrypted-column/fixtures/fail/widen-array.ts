import type { PgColumn } from "drizzle-orm/pg-core";

import { db, people } from "../table.js";

export function run(): void {
  const cols: PgColumn[] = [people.payload];
  db.select()
    .from(people)
    .orderBy(...cols);
}
