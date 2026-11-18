type CivilDate = { year: number; month: number; day: number };

function parseCivilDate(value: string): CivilDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return null;
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

// Same form as the server (modules/core/people/domain/person.ts): formatToParts, not string formatting.
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

function completedYears(dob: CivilDate, today: CivilDate): number {
  let age = today.year - dob.year;
  if (today.month < dob.month || (today.month === dob.month && today.day < dob.day)) {
    age -= 1;
  }
  return age;
}

/** True when the person is under 18 on today's date in Australia/Sydney. Unparseable input is not refused here; the server decides. */
export function isUnder18OnSydneyDate(dateOfBirth: string, now: Date): boolean {
  const dob = parseCivilDate(dateOfBirth);
  if (dob === null) {
    return false;
  }
  return completedYears(dob, sydneyCivilDate(now)) < 18;
}
