export async function path(): Promise<void> {
  await sql`SET search_path TO app`;
}

declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<void>;
