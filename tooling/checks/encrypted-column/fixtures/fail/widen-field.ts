import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db, people } from "../table.js";

class Repo {
  col: AnyPgColumn = people.payload;

  list() {
    return db.select().from(people).orderBy(this.col);
  }
}

export function run(): void {
  new Repo().list();
}
