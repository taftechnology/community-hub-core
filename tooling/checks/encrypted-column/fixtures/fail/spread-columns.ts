import { getTableColumns } from "drizzle-orm";

import { db, people } from "../table.js";

export function run(): void {
  const cols = getTableColumns(people);
  db.select().from(people).orderBy(cols.payload);
}
