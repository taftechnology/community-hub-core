import { db, people } from "../../../../table.js";

/* eslint @community-hub/no-encrypted-column-query: "off" */
export function run(): void {
  db.select().from(people).orderBy(people.payload);
}
