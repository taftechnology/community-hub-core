import { db, people } from "../../../../table.js";

export function run(): void {
  // eslint-disable-next-line @community-hub/no-encrypted-column-query
  db.select().from(people).orderBy(people.payload);
}
