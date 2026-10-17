export interface TransitionPrevious {
  readonly stripeStatus?: string | null;
  readonly stripe_status?: string | null;
  readonly unpaidSince?: Date | null;
  readonly unpaid_since?: Date | null;
  readonly graceUntil?: Date | null;
  readonly grace_until?: Date | null;
}

export interface TransitionResult {
  readonly unpaidSince: Date | null;
  readonly graceUntil: Date | null;
  readonly unpaid_since: Date | null;
  readonly grace_until: Date | null;
}

export function transition(
  prev: TransitionPrevious | null,
  nextStatus: string | null,
  now: Date,
  graceDays: number,
): TransitionResult {
  if (nextStatus === "unpaid") {
    const prevStatus = prev?.stripeStatus ?? prev?.stripe_status ?? null;
    if (prevStatus === "unpaid") {
      const prevUnpaidSince = prev?.unpaidSince ?? prev?.unpaid_since ?? now;
      const prevGraceUntil =
        prev?.graceUntil ?? prev?.grace_until ?? new Date(now.getTime() + graceDays * 86_400_000);
      return {
        unpaidSince: prevUnpaidSince,
        graceUntil: prevGraceUntil,
        unpaid_since: prevUnpaidSince,
        grace_until: prevGraceUntil,
      };
    }

    const calculatedGraceUntil = new Date(now.getTime() + graceDays * 86_400_000);
    return {
      unpaidSince: now,
      graceUntil: calculatedGraceUntil,
      unpaid_since: now,
      grace_until: calculatedGraceUntil,
    };
  }

  return {
    unpaidSince: null,
    graceUntil: null,
    unpaid_since: null,
    grace_until: null,
  };
}
