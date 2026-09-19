import { db, people } from "../table.js";

export function run(): void {
  db.select().from(people).groupBy(people.payload);
  db.select().from(people).groupBy(people.emailBidx);
}
