import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db, people } from "../table.js";

function f(c: AnyPgColumn = people.payload): void {
  db.select().from(people).orderBy(c);
}

export function run(): void {
  f();
}
