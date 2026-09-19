export async function clear(): Promise<void> {
  await sql.unsafe("reset app.org_id");
}

declare const sql: { unsafe: (query: string) => Promise<void> };
