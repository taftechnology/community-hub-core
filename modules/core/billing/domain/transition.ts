export interface TransitionPrevious {
  readonly stripeStatus?: string | null;
  readonly unpaidSince?: Date | null;
  readonly graceUntil?: Date | null;
}

export interface TransitionResult {
  readonly unpaidSince: Date | null;
  readonly graceUntil: Date | null;
}

export function transition(
  prev: TransitionPrevious | null,
  nextStatus: string | null,
  now: Date,
  graceDays: number,
): TransitionResult {
  if (nextStatus === "unpaid") {
    const prevStatus = prev?.stripeStatus ?? null;
    if (prevStatus === "unpaid") {
      const prevUnpaidSince = prev?.unpaidSince ?? now;
      const prevGraceUntil = prev?.graceUntil ?? new Date(now.getTime() + graceDays * 86_400_000);
      return {
        unpaidSince: prevUnpaidSince,
        graceUntil: prevGraceUntil,
      };
    }

    const calculatedGraceUntil = new Date(now.getTime() + graceDays * 86_400_000);
    return {
      unpaidSince: now,
      graceUntil: calculatedGraceUntil,
    };
  }

  return {
    unpaidSince: null,
    graceUntil: null,
  };
}
