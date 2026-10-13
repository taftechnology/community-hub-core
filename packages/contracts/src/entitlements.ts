import { z } from "zod";

const slug = z.string().min(1);
const entitlementKey = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);

export const listEntitlementsBody = z
  .object({
    communitySlug: slug,
  })
  .strict();

export const toggleEntitlementBody = z
  .object({
    communitySlug: slug,
    key: entitlementKey,
    enabled: z.boolean(),
  })
  .strict();
