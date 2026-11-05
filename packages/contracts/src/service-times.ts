import { z } from "zod";

const slug = z.string().min(1);

/**
 * Maximum length in UTF-16 code units for the raw HTML payload accepted by the save route.
 */
export const SERVICE_TIMES_RAW_HTML_MAX = 120_000;

/**
 * Maximum length in UTF-16 code units for the cleaned/sanitised HTML string,
 * enforced after sanitisation by the server and displayed by the admin editor counter.
 */
export const SERVICE_TIMES_HTML_MAX = 20_000;

export const SERVICE_TIMES_ERROR_CODES = ["version_conflict", "invalid_input"] as const;
export type ServiceTimesErrorCode = (typeof SERVICE_TIMES_ERROR_CODES)[number];

export const serviceTimesGetBody = z
  .object({
    communitySlug: slug,
  })
  .strict();

export type ServiceTimesGetBody = z.infer<typeof serviceTimesGetBody>;

export const serviceTimesSaveBody = z
  .object({
    communitySlug: slug,
    html: z.string().max(SERVICE_TIMES_RAW_HTML_MAX),
    version: z.number().int().min(0),
  })
  .strict();

export type ServiceTimesSaveBody = z.infer<typeof serviceTimesSaveBody>;

export const serviceTimesResponse = z
  .object({
    html: z.string(),
    version: z.number().int().min(0),
  })
  .strict();

export type ServiceTimesResponse = z.infer<typeof serviceTimesResponse>;

export const serviceTimesPublicSchema = z
  .object({
    html: z.string(),
  })
  .strict();

export type ServiceTimesPublic = z.infer<typeof serviceTimesPublicSchema>;
