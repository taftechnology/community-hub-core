import { db, emailBidx, payload, people } from "../table.js";

export function run(): void {
  db.insert(people)
    .values({
      id: "018f0000-0000-7000-8000-000000000001",
      payload,
      emailBidx,
    })
    .onConflictDoNothing({ target: people.emailBidx });
  db.insert(people)
    .values({
      id: "018f0000-0000-7000-8000-000000000002",
      payload,
      emailBidx,
    })
    .onConflictDoUpdate({
      target: people.emailBidx,
      set: { payload },
    });
}
