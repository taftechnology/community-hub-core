import { like } from "drizzle-orm";

import { db, people } from "../table.js";

export function run(): void {
  db.select().from(people).where(like(people.payload, "%x%"));
}
