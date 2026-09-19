export async function apply(): Promise<void> {
  await sql.unsafe("set role migrator");
  await sql.unsafe("reset role");
}

declare const sql: { unsafe: (query: string) => Promise<void> };
