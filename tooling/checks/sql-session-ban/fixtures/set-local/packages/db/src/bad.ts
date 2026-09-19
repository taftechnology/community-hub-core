export async function scope(): Promise<void> {
  await sql.unsafe("SET LOCAL app.org_id = 'x'");
}

declare const sql: { unsafe: (query: string) => Promise<void> };
