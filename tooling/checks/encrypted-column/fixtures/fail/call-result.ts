import { db, people } from "../table.js";

function payloadCol() {
  return people.payload;
}

export function run(): void {
  db.select().from(people).orderBy(payloadCol());
}
