import { index } from "drizzle-orm/pg-core";

import { people } from "../table.js";

export function run(): void {
  index("people_payload").on(people.payload);
}
