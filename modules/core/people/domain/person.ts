import { PeopleError } from "./error.js";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^[a-z0-9._%+-]{1,64}$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TAG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

type CivilDate = { year: number; month: number; day: number };

function parseDate(value: string): CivilDate {
  const match = DATE.exec(value);
  if (match === null) {
    throw new PeopleError("invalid_date");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999) {
    throw new PeopleError("invalid_date");
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new PeopleError("invalid_date");
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

function isAfter(dob: CivilDate, today: CivilDate): boolean {
  if (dob.year !== today.year) {
    return dob.year > today.year;
  }
  if (dob.month !== today.month) {
    return dob.month > today.month;
  }
  return dob.day > today.day;
}

function completedYears(dob: CivilDate, today: CivilDate): number {
  let age = today.year - dob.year;
  if (today.month < dob.month || (today.month === dob.month && today.day < dob.day)) {
    age -= 1;
  }
  return age;
}

export type AgeBasis = "date_of_birth" | "declared_adult" | "unknown";

export function resolveAge(
  dateOfBirth: string | null,
  declaredAdult: boolean,
  now: Date,
): { isMinor: boolean; ageBasis: AgeBasis } {
  const declared = declaredAdult === true;
  if (dateOfBirth !== null) {
    const minor = isMinor(dateOfBirth, now);
    if (declared && minor) {
      throw new PeopleError("invalid_declaration");
    }
    return { isMinor: minor, ageBasis: "date_of_birth" };
  }
  if (declared) {
    return { isMinor: false, ageBasis: "declared_adult" };
  }
  return { isMinor: true, ageBasis: "unknown" };
}

export function isMinor(dateOfBirth: string | null, now: Date): boolean {
  if (dateOfBirth === null) {
    return true;
  }
  const dob = parseDate(dateOfBirth);
  const today = sydneyCivilDate(now);
  if (isAfter(dob, today)) {
    throw new PeopleError("invalid_date");
  }
  return completedYears(dob, today) < 18;
}

export function birthdayMd(dateOfBirth: string | null): number | null {
  if (dateOfBirth === null) {
    return null;
  }
  const dob = parseDate(dateOfBirth);
  return dob.month * 100 + dob.day;
}

export function normaliseEmail(input: string): string {
  const email = input.replace(/^[ ]+|[ ]+$/g, "").toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || email.indexOf("@", at + 1) !== -1) {
    throw new PeopleError("invalid_email");
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!LOCAL.test(local) || domain.length < 1 || domain.length > 253 || !domain.includes(".")) {
    throw new PeopleError("invalid_email");
  }
  const labels = domain.split(".");
  if (labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw new PeopleError("invalid_email");
  }
  return email;
}

export function normalisePhone(input: string): string {
  const stripped = input.replaceAll(" ", "");
  const digits = stripped.startsWith("+") ? stripped.slice(1) : stripped;
  if (!/^[0-9]{8,15}$/.test(digits)) {
    throw new PeopleError("invalid_phone");
  }
  return digits;
}

export function normaliseName(input: string): string {
  const name = input.replace(/^[ ]+|[ ]+$/g, "");
  if (name.length === 0 || Array.from(name).length > 80 || hasControlCharacter(name)) {
    throw new PeopleError("invalid_name");
  }
  return name;
}

export function normaliseTag(input: string): string {
  const label = input.trim().toLowerCase();
  if (!TAG.test(label)) {
    throw new PeopleError("invalid_tag");
  }
  return label;
}
