import { db, people } from "../table.js";

export function run(): void {
  const sub = db.select({ enc: people.payload }).from(people).as("sub");
  db.select().from(sub).orderBy(sub.enc);
}
