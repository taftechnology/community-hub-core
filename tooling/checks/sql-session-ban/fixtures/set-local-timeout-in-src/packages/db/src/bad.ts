export async function timeouts(): Promise<void> {
  await sql.unsafe("SET LOCAL lock_timeout = '5s'");
  await sql.unsafe("SET LOCAL statement_timeout TO '30s'");
}

declare const sql: { unsafe: (query: string) => Promise<void> };
