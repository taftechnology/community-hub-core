export async function scope(id: string): Promise<void> {
  await sql`SET app.org_id = ${id}`;
}

declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<void>;
