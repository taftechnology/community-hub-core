import { sql } from "drizzle-orm";

const queryVar = "select payload from people";

export function run(): void {
  sql.raw(queryVar);
}
