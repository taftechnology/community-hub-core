import { z } from "zod";

const slug = z.string().min(1);
const planKey = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_]{1,31}$/);

export const checkoutBody = z
  .object({
    communitySlug: slug,
    planKey: planKey,
  })
  .strict();

export const portalBody = z
  .object({
    communitySlug: slug,
  })
  .strict();

export const statusBody = z
  .object({
    communitySlug: slug,
  })
  .strict();

export const plansBody = z
  .object({
    communitySlug: slug,
  })
  .strict();

export const plansResponse = z
  .object({
    plans: z.array(
      z
        .object({
          key: z.string(),
          trialAvailable: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export const urlResponse = z
  .object({
    url: z.string(),
  })
  .strict();

export const checkoutResponse = urlResponse;
export const portalResponse = urlResponse;

export const billingStateSchema = z.enum([
  "invoiced",
  "none",
  "ok",
  "retrying",
  "grace",
  "read_only",
]);

export const bannerStatusResponse = z
  .object({
    state: billingStateSchema,
    trial_end: z.string().nullable(),
    grace_until: z.string().nullable(),
    canView: z.boolean(),
    canManage: z.boolean(),
  })
  .strict();

export const fullStatusResponse = z
  .object({
    state: billingStateSchema,
    planKey: z.string().nullable(),
    quantity: z.number().int().nullable(),
    current_period_end: z.string().nullable(),
    trial_end: z.string().nullable(),
    grace_until: z.string().nullable(),
    canView: z.boolean(),
    canManage: z.boolean(),
  })
  .strict();

export const statusResponse = z.union([fullStatusResponse, bannerStatusResponse]);
