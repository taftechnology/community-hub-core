import { PeopleError } from "./error.js";

export type LifeEventType = "baptism" | "marriage" | "first_communion" | "funeral";

export const LIFE_EVENT_TYPES: readonly LifeEventType[] = [
  "baptism",
  "marriage",
  "first_communion",
  "funeral",
] as const;

export type RawLifeEventInput = {
  type: string;
  date: string;
  place?: string | null | undefined;
  notes?: string | null | undefined;
};

export type ValidatedLifeEvent = {
  type: LifeEventType;
  date: string;
  place: string | null;
  notes: string | null;
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type CivilDate = { year: number; month: number; day: number };

function parseDate(value: string): CivilDate {
  const match = DATE.exec(value);
  if (match === null) {
    throw new PeopleError("invalid_life_event");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999) {
    throw new PeopleError("invalid_life_event");
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new PeopleError("invalid_life_event");
  }
  return { year, month, day };
}

function sydneyCivilDate(now: Date): CivilDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    calendar: "gregory",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return { year, month, day };
}

function isAfter(target: CivilDate, today: CivilDate): boolean {
  if (target.year !== today.year) {
    return target.year > today.year;
  }
  if (target.month !== today.month) {
    return target.month > today.month;
  }
  return target.day > today.day;
}

export function validateLifeEventInput(input: RawLifeEventInput, now: Date): ValidatedLifeEvent {
  if (!LIFE_EVENT_TYPES.includes(input.type as LifeEventType)) {
    throw new PeopleError("invalid_life_event");
  }

  const parsed = parseDate(input.date);
  const today = sydneyCivilDate(now);
  if (isAfter(parsed, today)) {
    throw new PeopleError("invalid_life_event");
  }

  let place: string | null = null;
  if (input.place !== undefined && input.place !== null) {
    if (input.place.length > 200) {
      throw new PeopleError("invalid_life_event");
    }
    place = input.place;
  }

  let notes: string | null = null;
  if (input.notes !== undefined && input.notes !== null) {
    if (input.notes.length > 2000) {
      throw new PeopleError("invalid_life_event");
    }
    notes = input.notes;
  }

  return {
    type: input.type as LifeEventType,
    date: input.date,
    place,
    notes,
  };
}
