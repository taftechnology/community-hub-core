import { sql as s } from "drizzle-orm";

export function run(): void {
  s.raw("select payload from people");
}
