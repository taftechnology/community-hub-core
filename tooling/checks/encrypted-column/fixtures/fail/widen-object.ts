import { count } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db, people } from "../table.js";

export function run(): void {
  const o: { c: AnyPgColumn } = { c: people.payload };
  db.select({ n: count(o.c) }).from(people);
}
