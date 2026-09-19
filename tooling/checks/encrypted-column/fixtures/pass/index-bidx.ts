import { index, uniqueIndex } from "drizzle-orm/pg-core";

import { people } from "../table.js";

export function run(): void {
  index("people_email_bidx").on(people.emailBidx);
  uniqueIndex("people_email_bidx_uq").on(people.emailBidx);
}
