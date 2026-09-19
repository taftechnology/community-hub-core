import { db, people } from "../table.js";

export function run(): void {
  db.insert(people)
    .values({
      id: "018f0000-0000-7000-8000-000000000001",
    })
    .returning({
      payload: people.payload,
      emailBidx: people.emailBidx,
    });
}
