import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db, people } from "../table.js";

function payloadCol() {
  return people.payload;
}

export function run(): void {
  const c: AnyPgColumn = payloadCol();
  db.select().from(people).orderBy(c);
}
