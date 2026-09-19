import { db, people } from "../../../../../table.js";

export function run(): void {
  db.select().from(people).orderBy(people.payload);
}
