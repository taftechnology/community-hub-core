import { db, people } from "../table.js";

export function run(): void {
  const cte = db.$with("c").as(db.select({ enc: people.payload }).from(people));
  db.with(cte).select().from(cte).orderBy(cte.enc);
}
