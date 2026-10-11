import { encryptedColumn } from "@community-hub/db";

import { db, people } from "../table.js";

export function run(): void {
  db.select()
    .from(people)
    .orderBy(encryptedColumn("payload", { label: "people.email" }));
}
