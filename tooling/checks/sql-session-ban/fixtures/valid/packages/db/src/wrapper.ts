export async function scope(orgId: string): Promise<void> {
  await tx`select set_config('app.org_id', ${orgId}, ${true})`;
}

declare const tx: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<void>;
