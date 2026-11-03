import { z } from "zod";

const slug = z.string().min(1);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

export const LIFE_EVENT_TYPES = [
  "baptism",
  "first_communion",
  "marriage",
  "funeral",
  "birth",
  "death",
  "graduation",
  "anniversary",
  "other",
] as const;

export type LifeEventType = (typeof LIFE_EVENT_TYPES)[number];

export const lifeEventTypeSchema = z.enum(LIFE_EVENT_TYPES);

function isValidLifeEventDate(val: string): boolean {
  const match = DATE_REGEX.exec(val);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999) return false;

  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return false;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Australia/Sydney",
    calendar: "gregory",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const nowYear = Number(parts.find((p) => p.type === "year")?.value);
  const nowMonth = Number(parts.find((p) => p.type === "month")?.value);
  const nowDay = Number(parts.find((p) => p.type === "day")?.value);

  if (year > nowYear) return false;
  if (year === nowYear && month > nowMonth) return false;
  if (year === nowYear && month === nowMonth && day > nowDay) return false;

  return true;
}

export const lifeEventDateSchema = z
  .string()
  .regex(DATE_REGEX, "Invalid date format, expected YYYY-MM-DD")
  .refine(isValidLifeEventDate, "Date must be a calendar date between 1900 and today");

export const listLifeEventsBody = z
  .object({
    communitySlug: slug,
    personId: uuid,
  })
  .strict();

export const createLifeEventBody = z
  .object({
    communitySlug: slug,
    personId: uuid,
    type: lifeEventTypeSchema,
    date: lifeEventDateSchema,
    place: z.string().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

export const updateLifeEventBody = z
  .object({
    communitySlug: slug,
    eventId: uuid,
    version: z.number().int().positive(),
    type: lifeEventTypeSchema,
    date: lifeEventDateSchema,
    place: z.string().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

export type ListLifeEventsBody = z.infer<typeof listLifeEventsBody>;
export type CreateLifeEventBody = z.infer<typeof createLifeEventBody>;
export type UpdateLifeEventBody = z.infer<typeof updateLifeEventBody>;

export const lifeEventItemSchema = z
  .object({
    eventId: uuid,
    version: z.number().int().positive(),
    type: lifeEventTypeSchema,
    date: z.string().regex(DATE_REGEX),
    place: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .strict();

export const listLifeEventsResponse = z
  .object({
    items: z.array(lifeEventItemSchema),
  })
  .strict();

export const createLifeEventResponse = z
  .object({
    eventId: uuid,
    version: z.number().int().positive(),
  })
  .strict();

export const updateLifeEventResponse = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

export type LifeEventItem = z.infer<typeof lifeEventItemSchema>;
export type ListLifeEventsResponse = z.infer<typeof listLifeEventsResponse>;
export type CreateLifeEventResponse = z.infer<typeof createLifeEventResponse>;
export type UpdateLifeEventResponse = z.infer<typeof updateLifeEventResponse>;
