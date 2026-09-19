import { db } from "../table.js";

const queries = { raw: "select 1" };

export function run(): void {
  void db.execute(queries.raw);
}
