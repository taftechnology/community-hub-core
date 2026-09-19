import type { Ciphertext } from "@community-hub/crypto";

import { db, people } from "../table.js";

export function run(blob: Ciphertext | null): void {
  db.select().from(people).orderBy(blob);
}
