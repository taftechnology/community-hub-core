import type { Sql } from "postgres";

export type BillingEventOutcome = "received" | "processed" | "ignored";

export function isReplayOutcome(outcome: BillingEventOutcome): boolean {
  return outcome === "processed" || outcome === "ignored";
}

export async function recordReceived(
  sql: Sql,
  eventId: string,
  type: string,
): Promise<BillingEventOutcome> {
  const rows = await sql<{ outcome: BillingEventOutcome }[]>`
    insert into platform.billing_stripe_events (
      event_id,
      type,
      outcome,
      received_at
    ) values (
      ${eventId},
      ${type},
      'received',
      now()
    )
    on conflict (event_id) do update
      set type = excluded.type
    returning outcome
  `;
  return rows[0]!.outcome;
}

export async function markOutcome(
  sql: Sql,
  eventId: string,
  outcome: "processed" | "ignored",
): Promise<void> {
  await sql`
    update platform.billing_stripe_events
    set
      outcome = ${outcome},
      processed_at = now()
    where event_id = ${eventId}
  `;
}
