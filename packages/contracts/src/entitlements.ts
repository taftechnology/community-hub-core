import { z } from "zod";

const slug = z.string().min(1);

export const listEntitlementsBody = z
  .object({
    communitySlug: slug,
  })
  .strict();

export const toggleEntitlementBody = z
  .object({
    communitySlug: slug,
    key: z.string(),
    enabled: z.boolean(),
  })
  .strict();
