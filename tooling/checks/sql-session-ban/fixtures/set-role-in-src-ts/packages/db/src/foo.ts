export async function asMigrator(): Promise<void> {
  await sql.unsafe("set role migrator");
}

declare const sql: { unsafe: (query: string) => Promise<void> };
