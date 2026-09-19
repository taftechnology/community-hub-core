export async function upsert(): Promise<void> {
  await sql`insert into app.communities (id) values (${"x"}) on conflict (id) do update set updated_at = now()`;
}

declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<void>;
