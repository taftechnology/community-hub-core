import { asc } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db, people } from "../table.js";

function col(): AnyPgColumn {
  return people.payload;
}

export function run(): void {
  db.select().from(people).orderBy(asc(col()));
}
