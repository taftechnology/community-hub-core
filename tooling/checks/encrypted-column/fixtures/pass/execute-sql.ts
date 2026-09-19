import { sql } from "drizzle-orm";

import { db } from "../table.js";

export function run(): void {
  void db.execute(sql`select 1`);
}
