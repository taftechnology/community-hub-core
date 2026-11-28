import { z } from "zod";

const slug = z.string().min(1);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const name = z.string().trim().min(1).max(100);
const search = z.string().trim().min(1).max(100);
const cursor = z.string().min(1).max(1024);
export const email = z.string().trim().email().max(254);
export const phone = z.string().trim().min(1).max(50);
const dateOfBirth = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PERSON_SOURCES = [
  "manual",
  "family_records",
  "website",
  "form",
  "donation",
  "event_rsvp",
  "event_booking",
  "volunteer_application",
  "mobile_app",
  "mobile_app_family",
  "auto",
] as const;

export type PersonSource = (typeof PERSON_SOURCES)[number];

export const PERSON_SOURCE_LABELS: Record<PersonSource, string> = {
  manual: "Manual",
  family_records: "Family Records",
  website: "Website",
  form: "Form",
  donation: "Donation",
  event_rsvp: "Event RSVP",
  event_booking: "Event Booking",
  volunteer_application: "Volunteer Application",
  mobile_app: "Mobile App",
  mobile_app_family: "Mobile App Family",
  auto: "Auto",
};

export const PERSON_STATUSES = ["active", "inactive"] as const;

export type PersonStatus = (typeof PERSON_STATUSES)[number];

const personSource = z.enum(PERSON_SOURCES);
const personStatus = z.enum(PERSON_STATUSES);
// "deleted" is a filter value on the list, never a stored status.
const listStatus = z.enum([...PERSON_STATUSES, "deleted"]);
const createUpdateSource = z.enum(["manual", "family_records"]);

export const listPeopleBody = z
  .object({
    communitySlug: slug,
    kind: z.enum(["adults", "minors"]).optional(),
    search: search.optional(),
    cursor: cursor.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    status: listStatus.optional(),
    source: personSource.optional(),
    groupId: uuid.optional(),
  })
  .strict()
  .refine(
    (data) =>
      !(
        data.kind === "minors" &&
        (data.status !== undefined || data.source !== undefined || data.groupId !== undefined)
      ),
    {
      message: "minors list does not accept status, source, or groupId",
    },
  )
  .refine(
    (data) =>
      !(data.status === "deleted" && (data.source !== undefined || data.groupId !== undefined)),
    {
      message: "the deleted list accepts a name search only, not source or groupId",
    },
  );

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
    source: createUpdateSource.optional(),
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
    source: createUpdateSource.optional(),
  })
  .strict();

export const personStatusBody = z
  .object({
    communitySlug: slug,
    personId: uuid,
    version: z.number().int().positive(),
    status: personStatus,
  })
  .strict();

export const personStatusResponse = z
  .object({
    version: z.number().int().positive(),
    status: personStatus,
  })
  .strict();

export const personDeleteBody = z
  .object({
    communitySlug: slug,
    personId: uuid,
    version: z.number().int().positive(),
  })
  .strict();

export const personDeleteResponse = z
  .object({
    personId: uuid,
    version: z.number().int().positive(),
    purgeAfter: z.string().datetime({ offset: true }),
  })
  .strict();

export const personRestoreBody = z
  .object({
    communitySlug: slug,
    personId: uuid,
    version: z.number().int().positive(),
  })
  .strict();

export const personRestoreResponse = z
  .object({
    personId: uuid,
    version: z.number().int().positive(),
  })
  .strict();

// The Deleted list returns names and dates only. Its cursor is opaque to clients.
export const deletedPersonListItem = z
  .object({
    id: uuid,
    givenName: z.string().min(1),
    familyName: z.string().min(1),
    deletedAt: z.string().datetime({ offset: true }),
    purgeAfter: z.string().datetime({ offset: true }),
    version: z.number().int().positive(),
  })
  .strict();

export const deletedPeopleListResponse = z
  .object({
    items: z.array(deletedPersonListItem),
    nextCursor: cursor.nullable(),
  })
  .strict();

// The new refusals answer 409 with a code. Every other answer stays status-only.
export const PEOPLE_ERROR_CODES = [
  "linked_user",
  "pending_invitation",
  "sole_guardian",
  "duplicate_deleted",
] as const;

export type PeopleErrorCode = (typeof PEOPLE_ERROR_CODES)[number];

export const peopleErrorBody = z
  .object({
    code: z.enum(PEOPLE_ERROR_CODES),
  })
  .strict();

export const peopleSummaryBody = z
  .object({
    communitySlug: slug,
    addedSince: z.string().datetime({ offset: true }),
  })
  .strict();

export const peopleSummaryResponse = z
  .object({
    total: z.number().int().min(0),
    active: z.number().int().min(0),
    inactive: z.number().int().min(0),
    addedSince: z.number().int().min(0),
    groups: z
      .array(
        z
          .object({
            id: uuid,
            name: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

// The Community Admin's View of a child (ADR 0017). Every field of a child is hidden until it is
// asked for, one field at a time, after a fresh second-factor check that the View uses up. The ids
// travel in the body, never in the URL.
export const MINOR_VIEW_FIELDS = ["name", "dateOfBirth", "email", "phone"] as const;
export type MinorViewField = (typeof MINOR_VIEW_FIELDS)[number];

export const MINOR_LIFE_EVENT_VIEW_FIELDS = ["type", "date", "place", "notes"] as const;
export type MinorLifeEventViewField = (typeof MINOR_LIFE_EVENT_VIEW_FIELDS)[number];

// POST /v1/people/minors/view
export const minorViewBody = z
  .object({
    communitySlug: slug,
    personId: uuid,
    field: z.enum(MINOR_VIEW_FIELDS),
  })
  .strict();

// POST /v1/people/minors/life-events/view. lifeEventId is the list's eventId.
export const minorLifeEventViewBody = z
  .object({
    communitySlug: slug,
    personId: uuid,
    lifeEventId: uuid,
    field: z.enum(MINOR_LIFE_EVENT_VIEW_FIELDS),
  })
  .strict();

// The answer for the name: its two parts, each null when it is not recorded.
export const minorViewNameResponse = z
  .object({
    value: z.object({ given: z.string().nullable(), family: z.string().nullable() }).strict(),
  })
  .strict();

// The answer for every other field, of the child or of a life event: null when it is not recorded.
export const minorViewValueResponse = z.object({ value: z.string().nullable() }).strict();

// A View's 403 with a code: the session needs a fresh second-factor check, or it is in the recovery
// window and cannot view at all. A caller who is not a Community Admin gets an empty 403.
export const MINOR_VIEW_ERROR_CODES = ["fresh_required", "recovery_session"] as const;
export type MinorViewErrorCode = (typeof MINOR_VIEW_ERROR_CODES)[number];

export const minorViewErrorBody = z
  .object({
    code: z.enum(MINOR_VIEW_ERROR_CODES),
  })
  .strict();

export type MinorViewBody = z.infer<typeof minorViewBody>;
export type MinorLifeEventViewBody = z.infer<typeof minorLifeEventViewBody>;
export type MinorViewNameResponse = z.infer<typeof minorViewNameResponse>;
export type MinorViewValueResponse = z.infer<typeof minorViewValueResponse>;
export type MinorViewErrorBody = z.infer<typeof minorViewErrorBody>;

export type ListPeopleBody = z.infer<typeof listPeopleBody>;
export type ReadPersonBody = z.infer<typeof readPersonBody>;
export type CreatePersonBody = z.infer<typeof createPersonBody>;
export type UpdatePersonBody = z.infer<typeof updatePersonBody>;
export type PersonStatusBody = z.infer<typeof personStatusBody>;
export type PersonStatusResponse = z.infer<typeof personStatusResponse>;
export type PersonDeleteBody = z.infer<typeof personDeleteBody>;
export type PersonDeleteResponse = z.infer<typeof personDeleteResponse>;
export type PersonRestoreBody = z.infer<typeof personRestoreBody>;
export type PersonRestoreResponse = z.infer<typeof personRestoreResponse>;
export type DeletedPersonListItem = z.infer<typeof deletedPersonListItem>;
export type DeletedPeopleListResponse = z.infer<typeof deletedPeopleListResponse>;
export type PeopleErrorBody = z.infer<typeof peopleErrorBody>;
export type PeopleSummaryBody = z.infer<typeof peopleSummaryBody>;
export type PeopleSummaryResponse = z.infer<typeof peopleSummaryResponse>;

export type AdultPersonListItem = {
  id: string;
  personId: string;
  isMinor: false;
  givenName: string;
  familyName: string;
  version: number;
  email: string | null;
  phone: string | null;
  age: number | null;
  createdAt: string;
  status: PersonStatus;
  source: PersonSource;
  groups?: { id: string; name: string }[];
};

// A child in the Community Admin's list (`kind: "minors"`): an id, the display label "Child n"
// (numbered inside the family) and the family. It carries no field of the child, the name
// included. householdLabel is the family's own label, an adult-level field. Everyone who is not a
// Community Admin gets 403 for this list (ADR 0017).
export type MinorPersonListItem = {
  personId: string;
  label: string;
  householdId: string;
  householdLabel: string | null;
};

export type PersonListItem = AdultPersonListItem | MinorPersonListItem;

export type ListPeopleResponse = {
  items: PersonListItem[];
  nextCursor: string | null;
};

export type ListAdultsResponse = {
  items: AdultPersonListItem[];
  nextCursor: string | null;
};

export type ListMinorsResponse = {
  items: MinorPersonListItem[];
  nextCursor: string | null;
};

export type AdultReadPersonResponse = {
  personId: string;
  householdId: string | null;
  isMinor: false;
  ageBasis: string;
  birthdayMd: number | null;
  givenName: string;
  familyName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  version: number;
  status: PersonStatus;
  source: PersonSource;
};

// `/v1/people/read` answers an adult. A minor is answered 404 with an empty body, for every
// caller, as a person that does not exist: a child's fields are read only through the Community
// Admin's View (ADR 0017).
export type ReadPersonResponse = AdultReadPersonResponse;

export type CreatePersonResponse = {
  personId: string;
};

export type UpdatePersonResponse = {
  version: number;
};
