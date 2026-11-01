import { z } from "zod";

const slug = z.string().min(1);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const name = z.string().trim().min(1).max(100);
const search = z.string().trim().min(1).max(100);
const cursor = z.string().min(1).max(1024);
const email = z.string().trim().email().max(254);
const phone = z.string().trim().min(1).max(50);
const dateOfBirth = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const listPeopleBody = z
  .object({
    communitySlug: slug,
    kind: z.enum(["adults", "minors"]).optional(),
    search: search.optional(),
    cursor: cursor.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const readPersonBody = z
  .object({
    communitySlug: slug,
    personId: uuid,
  })
  .strict();

export const createPersonBody = z
  .object({
    communitySlug: slug,
    givenName: name,
    familyName: name,
    email: email.nullable().optional(),
    phone: phone.nullable().optional(),
    dateOfBirth: dateOfBirth.nullable().optional(),
  })
  .strict();

export const updatePersonBody = z
  .object({
    communitySlug: slug,
    personId: uuid,
    version: z.number().int().positive(),
    givenName: name.optional(),
    familyName: name.optional(),
    email: email.nullable().optional(),
    phone: phone.nullable().optional(),
    dateOfBirth: dateOfBirth.nullable().optional(),
  })
  .strict();

export type ListPeopleBody = z.infer<typeof listPeopleBody>;
export type ReadPersonBody = z.infer<typeof readPersonBody>;
export type CreatePersonBody = z.infer<typeof createPersonBody>;
export type UpdatePersonBody = z.infer<typeof updatePersonBody>;

export type PersonListItem = {
  id: string;
  personId: string;
  isMinor: boolean;
  givenName: string;
  familyName: string;
  version: number;
};

export type ListPeopleResponse = {
  items: PersonListItem[];
  nextCursor: string | null;
};

export type ReadPersonResponse = {
  personId: string;
  householdId: string | null;
  isMinor: boolean;
  ageBasis: string;
  birthdayMd: number | null;
  givenName: string;
  familyName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  version: number;
};

export type CreatePersonResponse = {
  personId: string;
};

export type UpdatePersonResponse = {
  version: number;
};
