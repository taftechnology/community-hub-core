import { db } from "../table.js";

const queryVar = "select 1";

export function run(): void {
  void db.execute(queryVar);
}
