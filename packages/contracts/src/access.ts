import { z } from "zod";

const slug = z.string().min(1);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const community = z
  .object({
    communitySlug: slug,
  })
  .strict();

export const listGrantsBody = community;
export const bootstrapOwnerBody = community;

const grantRoleBody = z
  .object({
    communitySlug: slug,
    userId: uuid,
    roleKey: z.string(),
  })
  .strict();

const grantCustomBody = z
  .object({
    communitySlug: slug,
    userId: uuid,
    customRoleId: uuid,
  })
  .strict();

export const grantBody = z.union([grantRoleBody, grantCustomBody]);

export const revokeGrantBody = z
  .object({
    communitySlug: slug,
    grantId: uuid,
    scope: z.enum(["organisation", "community"]),
  })
  .strict();

export const createCustomRoleBody = z
  .object({
    communitySlug: slug,
    key: z.string(),
    permissions: z.array(z.string()),
  })
  .strict();

export const deleteCustomRoleBody = z
  .object({
    communitySlug: slug,
    customRoleId: uuid,
  })
  .strict();

export const linkUserBody = z
  .object({
    communitySlug: slug,
    userId: uuid,
    personId: uuid,
  })
  .strict();

export const unlinkUserBody = z
  .object({
    communitySlug: slug,
    userId: uuid,
  })
  .strict();
