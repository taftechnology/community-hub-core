export async function bleed(): Promise<void> {
  await sql.unsafe("set role app");
  await sql`select set_config('app.org_id', ${"x"}, ${false})`;
}

declare const sql: {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<void>;
  unsafe: (query: string) => Promise<void>;
};
