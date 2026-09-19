import { count, max, min } from "drizzle-orm";

import { db, people } from "../table.js";

export function run(): void {
  db.select({ n: count(people.payload) }).from(people);
  db.select({ n: max(people.payload) }).from(people);
  db.select({ n: min(people.emailBidx) }).from(people);
}
