export async function asMigrator(): Promise<void> {
  await sql`set role migrator`;
}

declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<void>;
