import { gt } from "drizzle-orm";

import { db, payload, people } from "../table.js";

export function run(): void {
  db.select().from(people).where(gt(people.payload, payload));
}
