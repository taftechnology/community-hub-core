import { z } from "zod";

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

export const listHouseholdsBody = z
  .object({
    communitySlug: slug,
    cursor: cursor.optional(),
    limit: z.number().int().min(1).max(25).optional(),
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
export type LinkGuardianBody = z.infer<typeof linkGuardianBody>;
export type UnlinkGuardianBody = z.infer<typeof unlinkGuardianBody>;

export type HouseholdListItem = {
  householdId: string;
  version: number;
  label: string | null;
  adultCount: number;
};

export type ListHouseholdsResponse = {
  items: HouseholdListItem[];
  nextCursor: string | null;
};

export type HouseholdAdultMember = {
  personId: string;
  givenName: string;
  familyName: string;
  version: number;
};

export type HouseholdMinorMember = {
  personId: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string | null;
  version: number;
};

export type HouseholdGuardianRights = {
  consent: boolean;
  pickup: boolean;
  view: boolean;
  manage: boolean;
};

export type HouseholdGuardianLink = {
  linkId: string;
  guardianId: string;
  childId: string;
  rights: HouseholdGuardianRights;
};

export type ReadHouseholdResponse = {
  householdId: string;
  version: number;
  label: string | null;
  adults: HouseholdAdultMember[];
  minors?: HouseholdMinorMember[];
  guardians: HouseholdGuardianLink[];
};

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
