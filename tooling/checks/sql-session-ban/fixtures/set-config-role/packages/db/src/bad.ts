export async function switchRole(): Promise<void> {
  await sql`select set_config('role', ${"migrator"}, ${true})`;
}

declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<void>;
