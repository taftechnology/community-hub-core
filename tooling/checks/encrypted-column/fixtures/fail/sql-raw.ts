import { sql } from "drizzle-orm";

export function run(): void {
  sql.raw("select payload from people");
}
