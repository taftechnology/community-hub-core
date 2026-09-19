import { inArray } from "drizzle-orm";

import { db, emailBidxList, people } from "../table.js";

export function run(): void {
  db.select().from(people).where(inArray(people.emailBidx, emailBidxList));
}
