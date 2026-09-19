export async function bleed(orgId: string): Promise<void> {
  await sql`select set_config('app.org_id', ${orgId}, ${false})`;
}

declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<void>;
