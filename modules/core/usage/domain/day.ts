import { UsageError } from "./error.js";

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export function utcDay(at: Date): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new UsageError("invalid_time");
  }
  const iso = at.toISOString();
  const day = iso.slice(0, 10);
  if (!DAY_SHAPE.test(day)) {
    throw new UsageError("invalid_time");
  }
  return day;
}
