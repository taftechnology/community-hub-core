import { asc, desc } from "drizzle-orm";

import { db, people } from "../table.js";

export function run(): void {
  db.select().from(people).orderBy(asc(people.payload));
  db.select().from(people).orderBy(desc(people.emailBidx));
}
