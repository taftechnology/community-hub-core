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

export const listUsersBody = z
  .object({
    communitySlug: slug,
  })
  .strict();

export type ListUsersBody = z.infer<typeof listUsersBody>;

const userListItem = z
  .object({
    userId: uuid,
    personId: uuid.nullable(),
    name: z
      .object({
        given: z.string(),
        family: z.string(),
      })
      .strict()
      .nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    minor: z.boolean(),
  })
  .strict();

export const listUsersResponse = z
  .object({
    phoneVisible: z.boolean(),
    users: z.array(userListItem),
  })
  .strict();

export type ListUsersResponse = z.infer<typeof listUsersResponse>;

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

export const capabilitiesBody = z
  .object({
    communitySlug: slug,
  })
  .strict();

export type CapabilitiesBody = z.infer<typeof capabilitiesBody>;

export const CAPABILITIES_PERMISSIONS = [
  "people.view",
  "people.manage",
  "people.restricted.read",
  "service_times.manage",
] as const;

export const CAPABILITIES_ENTITLEMENTS = [
  "people.directory",
  "people.households",
  "module.engagement",
] as const;

export type CapabilityPermission = (typeof CAPABILITIES_PERMISSIONS)[number];
export type CapabilityEntitlement = (typeof CAPABILITIES_ENTITLEMENTS)[number];

export const CAPABILITIES_ALLOW_LIST = {
  permissions: CAPABILITIES_PERMISSIONS,
  entitlements: CAPABILITIES_ENTITLEMENTS,
} as const;

export const capabilitiesResponse = z
  .object({
    permissions: z
      .object({
        "people.view": z.boolean(),
        "people.manage": z.boolean(),
        "people.restricted.read": z.boolean(),
        "service_times.manage": z.boolean(),
      })
      .strict(),
    entitlements: z
      .object({
        "people.directory": z.boolean(),
        "people.households": z.boolean(),
        "module.engagement": z.boolean(),
      })
      .strict(),
  })
  .strict();

export type CapabilitiesResponse = z.infer<typeof capabilitiesResponse>;
