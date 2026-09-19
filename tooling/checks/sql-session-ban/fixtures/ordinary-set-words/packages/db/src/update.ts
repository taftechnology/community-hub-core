export async function rename(n: string): Promise<void> {
  await sql`update app.communities set name = ${n} where id = ${"x"}`;
}

declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<void>;
