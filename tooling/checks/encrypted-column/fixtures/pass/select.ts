import { db, people } from "../table.js";

export function run(): void {
  db.select({
    payload: people.payload,
    emailBidx: people.emailBidx,
  }).from(people);
}
