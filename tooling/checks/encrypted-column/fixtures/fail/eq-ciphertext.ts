import { eq } from "drizzle-orm";

import { db, payload, people } from "../table.js";

export function run(): void {
  db.select().from(people).where(eq(people.payload, payload));
}
