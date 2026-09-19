import { sql } from "drizzle-orm";

import { people } from "../table.js";

export function run(): void {
  sql`${people.payload}`;
}
