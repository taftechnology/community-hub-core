import type { InferInsertModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type RequireId<T> = T & { id: string };

export function insertEncrypted<TTable extends PgTable>(
  db: PostgresJsDatabase,
  table: TTable,
  values: RequireId<InferInsertModel<TTable>>,
) {
  return db.insert(table).values(values as InferInsertModel<TTable>);
}
