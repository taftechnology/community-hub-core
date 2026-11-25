import { z } from "zod";

import { email, phone } from "./people.js";

const slug = z.string().min(1);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const name = z.string().trim().min(1).max(100);
const cursor = z.string().min(1).max(1024);
const dateOfBirth = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const guardianRightsInput = z
  .object({
    consent: z.boolean(),
    pickup: z.boolean(),
    view: z.boolean(),
    manage: z.boolean(),
  })
  .strict()
  .refine(
    (val) =>
      val.consent === true || val.pickup === true || val.view === true || val.manage === true,
    { message: "At least one right must be true" },
  );

export const HOUSEHOLD_STATUSES = ["active", "inactive"] as const;
export type HouseholdStatus = (typeof HOUSEHOLD_STATUSES)[number];
export const householdStatus = z.enum(HOUSEHOLD_STATUSES);

export const listHouseholdStatus = z.enum([...HOUSEHOLD_STATUSES, "deleted"]);
export type ListHouseholdStatus = z.infer<typeof listHouseholdStatus>;

export const EMERGENCY_CONTACT_RELATIONSHIPS = [
  "spouse",
  "grandparent",
  "relative",
  "neighbour",
  "friend",
  "carer",
  "other",
] as const;
export type EmergencyContactRelationship = (typeof EMERGENCY_CONTACT_RELATIONSHIPS)[number];
export const emergencyContactRelationship = z.enum(EMERGENCY_CONTACT_RELATIONSHIPS);

export const MAX_EMERGENCY_CONTACTS = 5;

export const emergencyContactInput = z
  .object({
    name: name,
    phone: phone,
    relationship: emergencyContactRelationship.nullable().optional(),
  })
  .strict();
export type EmergencyContactInput = z.infer<typeof emergencyContactInput>;

export const emergencyContactResponseItem = z
  .object({
    name: name,
    phone: phone,
    relationship: emergencyContactRelationship.nullable(),
  })
  .strict();
export type EmergencyContactResponseItem = z.infer<typeof emergencyContactResponseItem>;

export const listHouseholdsBody = z
  .object({
    communitySlug: slug,
    cursor: cursor.optional(),
    limit: z.number().int().min(1).max(25).optional(),
    status: listHouseholdStatus.optional(),
  })
  .strict();

export const readHouseholdBody = z
  .object({
    communitySlug: slug,
    householdId: uuid,
  })
  .strict();

export const createHouseholdBody = z
  .object({
    communitySlug: slug,
    label: name.nullable().optional(),
  })
  .strict();

export const renameHouseholdBody = z
  .object({
    communitySlug: slug,
    householdId: uuid,
    version: z.number().int().positive(),
    label: name.nullable(),
  })
  .strict();

export const moveAdultBody = z
  .object({
    communitySlug: slug,
    householdId: uuid.nullable(),
    personId: uuid,
    version: z.number().int().positive(),
  })
  .strict();

export const addMinorBody = z
  .object({
    communitySlug: slug,
    householdId: uuid,
    givenName: name,
    familyName: name,
    dateOfBirth: dateOfBirth,
    guardianId: uuid,
    rights: guardianRightsInput.optional(),
  })
  .strict();

export const addAdultBody = z
  .object({
    communitySlug: slug,
    householdId: uuid,
    givenName: name,
    familyName: name,
    email: email.nullable().optional(),
    phone: phone.nullable().optional(),
    dateOfBirth: dateOfBirth.nullable().optional(),
  })
  .strict();

export const linkGuardianBody = z
  .object({
    communitySlug: slug,
    householdId: uuid,
    guardianId: uuid,
    childId: uuid,
    rights: guardianRightsInput.optional(),
  })
  .strict();

export const unlinkGuardianBody = z
  .object({
    communitySlug: slug,
    householdId: uuid,
    linkId: uuid,
  })
  .strict();

export type GuardianRightsInput = z.infer<typeof guardianRightsInput>;
export type ListHouseholdsBody = z.infer<typeof listHouseholdsBody>;
export type ReadHouseholdBody = z.infer<typeof readHouseholdBody>;
export type CreateHouseholdBody = z.infer<typeof createHouseholdBody>;
export type RenameHouseholdBody = z.infer<typeof renameHouseholdBody>;
export type MoveAdultBody = z.infer<typeof moveAdultBody>;
export type AddMinorBody = z.infer<typeof addMinorBody>;
export type AddAdultBody = z.infer<typeof addAdultBody>;
export type LinkGuardianBody = z.infer<typeof linkGuardianBody>;
export type UnlinkGuardianBody = z.infer<typeof unlinkGuardianBody>;

export const householdStatusBody = z
  .object({
    communitySlug: slug,
    householdId: uuid,
    version: z.number().int().positive(),
    status: householdStatus,
  })
  .strict();
export type HouseholdStatusBody = z.infer<typeof householdStatusBody>;

export const householdStatusResponse = z
  .object({
    householdId: uuid,
    version: z.number().int().positive(),
    status: householdStatus,
  })
  .strict();
export type HouseholdStatusResponse = z.infer<typeof householdStatusResponse>;

export const householdDeleteBody = z
  .object({
    communitySlug: slug,
    householdId: uuid,
    version: z.number().int().positive(),
  })
  .strict();
export type HouseholdDeleteBody = z.infer<typeof householdDeleteBody>;

export const householdDeleteResponse = z
  .object({
    householdId: uuid,
    version: z.number().int().positive(),
    purgeAfter: z.string().datetime({ offset: true }),
  })
  .strict();
export type HouseholdDeleteResponse = z.infer<typeof householdDeleteResponse>;

export const householdRestoreBody = z
  .object({
    communitySlug: slug,
    householdId: uuid,
    version: z.number().int().positive(),
  })
  .strict();
export type HouseholdRestoreBody = z.infer<typeof householdRestoreBody>;

export const householdRestoreResponse = z
  .object({
    householdId: uuid,
    version: z.number().int().positive(),
  })
  .strict();
export type HouseholdRestoreResponse = z.infer<typeof householdRestoreResponse>;

export const readEmergencyContactsBody = z
  .object({
    communitySlug: slug,
    householdId: uuid,
  })
  .strict();
export type ReadEmergencyContactsBody = z.infer<typeof readEmergencyContactsBody>;

export const readEmergencyContactsResponse = z
  .object({
    householdId: uuid,
    version: z.number().int().positive(),
    contacts: z.array(emergencyContactResponseItem).max(MAX_EMERGENCY_CONTACTS),
  })
  .strict();
export type ReadEmergencyContactsResponse = z.infer<typeof readEmergencyContactsResponse>;

export const saveEmergencyContactsBody = z
  .object({
    communitySlug: slug,
    householdId: uuid,
    version: z.number().int().positive(),
    contacts: z.array(emergencyContactInput).max(MAX_EMERGENCY_CONTACTS),
  })
  .strict();
export type SaveEmergencyContactsBody = z.infer<typeof saveEmergencyContactsBody>;

export const saveEmergencyContactsResponse = z
  .object({
    householdId: uuid,
    version: z.number().int().positive(),
  })
  .strict();
export type SaveEmergencyContactsResponse = z.infer<typeof saveEmergencyContactsResponse>;

export const deletedHouseholdListItem = z
  .object({
    householdId: uuid,
    label: name.nullable(),
    adultCount: z.number().int().min(0),
    version: z.number().int().positive(),
    deletedAt: z.string().datetime({ offset: true }),
    purgeAfter: z.string().datetime({ offset: true }),
  })
  .strict();
export type DeletedHouseholdListItem = z.infer<typeof deletedHouseholdListItem>;

export const deletedHouseholdsListResponse = z
  .object({
    items: z.array(deletedHouseholdListItem),
    nextCursor: cursor.nullable(),
  })
  .strict();
export type DeletedHouseholdsListResponse = z.infer<typeof deletedHouseholdsListResponse>;

export const HOUSEHOLD_ERROR_CODES = ["household_has_children", "duplicate_deleted"] as const;
export type HouseholdErrorCode = (typeof HOUSEHOLD_ERROR_CODES)[number];

export const householdErrorBody = z
  .object({
    code: z.enum(HOUSEHOLD_ERROR_CODES),
  })
  .strict();
export type HouseholdErrorBody = z.infer<typeof householdErrorBody>;

export const householdListItem = z
  .object({
    householdId: uuid,
    version: z.number().int().positive(),
    label: name.nullable(),
    adultCount: z.number().int().min(0),
    status: householdStatus,
  })
  .strict();
export type HouseholdListItem = z.infer<typeof householdListItem>;

export const listHouseholdsResponse = z
  .object({
    items: z.array(householdListItem),
    nextCursor: cursor.nullable(),
  })
  .strict();
export type ListHouseholdsResponse = z.infer<typeof listHouseholdsResponse>;

export const householdAdultMember = z
  .object({
    personId: uuid,
    givenName: name,
    familyName: name,
    version: z.number().int().positive(),
  })
  .strict();
export type HouseholdAdultMember = z.infer<typeof householdAdultMember>;

export const householdMinorMember = z
  .object({
    personId: uuid,
    givenName: name,
    familyName: name,
    dateOfBirth: dateOfBirth.nullable(),
    version: z.number().int().positive(),
  })
  .strict();
export type HouseholdMinorMember = z.infer<typeof householdMinorMember>;

export const householdGuardianRights = z
  .object({
    consent: z.boolean(),
    pickup: z.boolean(),
    view: z.boolean(),
    manage: z.boolean(),
  })
  .strict();
export type HouseholdGuardianRights = z.infer<typeof householdGuardianRights>;

export const householdGuardianLink = z
  .object({
    linkId: uuid,
    guardianId: uuid,
    childId: uuid,
    rights: householdGuardianRights,
  })
  .strict();
export type HouseholdGuardianLink = z.infer<typeof householdGuardianLink>;

export const readHouseholdResponse = z
  .object({
    householdId: uuid,
    version: z.number().int().positive(),
    status: householdStatus,
    label: name.nullable(),
    adults: z.array(householdAdultMember),
    minors: z.array(householdMinorMember).optional(),
    guardians: z.array(householdGuardianLink),
  })
  .strict();
export type ReadHouseholdResponse = z.infer<typeof readHouseholdResponse>;

export type CreateHouseholdResponse = {
  householdId: string;
  version: number;
};

export type RenameHouseholdResponse = {
  version: number;
};

export type MoveAdultResponse = {
  version: number;
};

export type AddMinorResponse = {
  personId: string;
  linkId: string;
};

export type LinkGuardianResponse = {
  linkId: string;
};

export type UnlinkGuardianResponse = Record<string, never>;
