import { db } from "../table.js";

export function run(): void {
  void db.execute("select 1");
}
