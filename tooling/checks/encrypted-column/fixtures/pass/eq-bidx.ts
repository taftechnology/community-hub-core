import { eq } from "drizzle-orm";

import { db, emailBidx, people } from "../table.js";

export function run(): void {
  db.select().from(people).where(eq(people.emailBidx, emailBidx));
}
