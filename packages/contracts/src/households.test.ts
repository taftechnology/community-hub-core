import { describe, expect, it } from "vitest";

import {
  addAdultBody,
  addMinorBody,
  createHouseholdBody,
  deletedHouseholdListItem,
  deletedHouseholdsListResponse,
  emergencyContactInput,
  emergencyContactResponseItem,
  householdAdultMember,
  householdChildren,
  householdDeleteBody,
  householdDeleteResponse,
  householdErrorBody,
  householdGuardianLink,
  householdRestoreBody,
  householdRestoreResponse,
  householdStatusBody,
  householdStatusResponse,
  linkGuardianBody,
  listHouseholdsBody,
  listHouseholdsResponse,
  moveAdultBody,
  readEmergencyContactsBody,
  readEmergencyContactsResponse,
  readHouseholdBody,
  readHouseholdResponse,
  renameHouseholdBody,
  saveEmergencyContactsBody,
  saveEmergencyContactsResponse,
  unlinkGuardianBody,
} from "./households.js";

const VALID_UUID = "00000000-0000-4000-8000-000000000001";
const OTHER_UUID = "00000000-0000-4000-8000-000000000002";

describe("household contract schemas (pin 10)", () => {
  it("parses valid household request bodies", () => {
    expect(
      listHouseholdsBody.safeParse({
        communitySlug: "parish-au",
        cursor: "cursor-token",
        limit: 25,
      }).success,
    ).toBe(true);

    expect(
      readHouseholdBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
      }).success,
    ).toBe(true);

    expect(
      createHouseholdBody.safeParse({
        communitySlug: "parish-au",
        label: "The Smiths",
      }).success,
    ).toBe(true);

    expect(
      createHouseholdBody.safeParse({
        communitySlug: "parish-au",
      }).success,
    ).toBe(true);

    expect(
      renameHouseholdBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        version: 1,
        label: "The Joneses",
      }).success,
    ).toBe(true);

    expect(
      renameHouseholdBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        version: 2,
        label: null,
      }).success,
    ).toBe(true);

    expect(
      moveAdultBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        personId: OTHER_UUID,
        version: 1,
      }).success,
    ).toBe(true);

    expect(
      moveAdultBody.safeParse({
        communitySlug: "parish-au",
        householdId: null,
        personId: OTHER_UUID,
        version: 1,
      }).success,
    ).toBe(true);

    expect(
      addMinorBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        givenName: "Tommy",
        familyName: "Smith",
        dateOfBirth: "2015-06-01",
        guardianId: OTHER_UUID,
      }).success,
    ).toBe(true);

    expect(
      addMinorBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        givenName: "Tommy",
        familyName: "Smith",
        dateOfBirth: "2015-06-01",
        guardianId: OTHER_UUID,
        rights: { consent: true, pickup: false, view: true, manage: false },
      }).success,
    ).toBe(true);

    expect(
      linkGuardianBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        guardianId: OTHER_UUID,
        childId: "00000000-0000-4000-8000-000000000003",
        rights: { consent: true, pickup: true, view: false, manage: false },
      }).success,
    ).toBe(true);

    expect(
      unlinkGuardianBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        linkId: OTHER_UUID,
      }).success,
    ).toBe(true);
  });

  it("strictly rejects forbidden fields: includeRestricted, isMinor, orgId, communityId (pin 10)", () => {
    const cases = [
      { schema: listHouseholdsBody, base: { communitySlug: "slug" } },
      { schema: readHouseholdBody, base: { communitySlug: "slug", householdId: VALID_UUID } },
      { schema: createHouseholdBody, base: { communitySlug: "slug" } },
      {
        schema: renameHouseholdBody,
        base: { communitySlug: "slug", householdId: VALID_UUID, version: 1, label: "L" },
      },
      {
        schema: moveAdultBody,
        base: { communitySlug: "slug", householdId: VALID_UUID, personId: OTHER_UUID, version: 1 },
      },
      {
        schema: addMinorBody,
        base: {
          communitySlug: "slug",
          householdId: VALID_UUID,
          givenName: "T",
          familyName: "S",
          dateOfBirth: "2015-01-01",
          guardianId: OTHER_UUID,
        },
      },
      {
        schema: linkGuardianBody,
        base: {
          communitySlug: "slug",
          householdId: VALID_UUID,
          guardianId: OTHER_UUID,
          childId: VALID_UUID,
        },
      },
      {
        schema: unlinkGuardianBody,
        base: { communitySlug: "slug", householdId: VALID_UUID, linkId: OTHER_UUID },
      },
    ];

    for (const { schema, base } of cases) {
      expect(schema.safeParse({ ...base, includeRestricted: true }).success).toBe(false);
      expect(schema.safeParse({ ...base, isMinor: false }).success).toBe(false);
      expect(schema.safeParse({ ...base, orgId: VALID_UUID }).success).toBe(false);
      expect(schema.safeParse({ ...base, communityId: VALID_UUID }).success).toBe(false);
      expect(schema.safeParse({ ...base, extra: "forbidden" }).success).toBe(false);
    }
  });

  it("enforces household list limit <= 25", () => {
    expect(listHouseholdsBody.safeParse({ communitySlug: "slug", limit: 25 }).success).toBe(true);
    expect(listHouseholdsBody.safeParse({ communitySlug: "slug", limit: 1 }).success).toBe(true);
    expect(listHouseholdsBody.safeParse({ communitySlug: "slug", limit: 0 }).success).toBe(false);
    expect(listHouseholdsBody.safeParse({ communitySlug: "slug", limit: 26 }).success).toBe(false);
    expect(listHouseholdsBody.safeParse({ communitySlug: "slug", limit: 100 }).success).toBe(false);
  });

  it("requires dateOfBirth on addMinor and rejects email/phone", () => {
    const base = {
      communitySlug: "slug",
      householdId: VALID_UUID,
      givenName: "Tommy",
      familyName: "Smith",
      guardianId: OTHER_UUID,
    };

    // missing dateOfBirth
    expect(addMinorBody.safeParse(base).success).toBe(false);
    // null dateOfBirth
    expect(addMinorBody.safeParse({ ...base, dateOfBirth: null }).success).toBe(false);
    // invalid dateOfBirth format
    expect(addMinorBody.safeParse({ ...base, dateOfBirth: "invalid-date" }).success).toBe(false);
    // rejects email and phone fields
    expect(
      addMinorBody.safeParse({
        ...base,
        dateOfBirth: "2015-01-01",
        email: "tommy@example.com",
      }).success,
    ).toBe(false);
    expect(
      addMinorBody.safeParse({
        ...base,
        dateOfBirth: "2015-01-01",
        phone: "+61400000000",
      }).success,
    ).toBe(false);
  });

  it("requires all four rights booleans when rights are provided, and at least one true", () => {
    const validBase = {
      communitySlug: "slug",
      householdId: VALID_UUID,
      givenName: "Tommy",
      familyName: "Smith",
      dateOfBirth: "2015-01-01",
      guardianId: OTHER_UUID,
    };
    const linkBase = {
      communitySlug: "slug",
      householdId: VALID_UUID,
      guardianId: OTHER_UUID,
      childId: VALID_UUID,
    };

    // empty rights object
    expect(addMinorBody.safeParse({ ...validBase, rights: {} }).success).toBe(false);
    expect(linkGuardianBody.safeParse({ ...linkBase, rights: {} }).success).toBe(false);
    // all false rights
    expect(
      addMinorBody.safeParse({
        ...validBase,
        rights: { consent: false, pickup: false, view: false, manage: false },
      }).success,
    ).toBe(false);
    expect(
      linkGuardianBody.safeParse({
        ...linkBase,
        rights: { consent: false, pickup: false, view: false, manage: false },
      }).success,
    ).toBe(false);
    // partial objects rejected on both bodies
    for (const partial of [
      { view: true },
      { pickup: true },
      { consent: true },
      { manage: true },
    ] as const) {
      expect(addMinorBody.safeParse({ ...validBase, rights: partial }).success).toBe(false);
      expect(linkGuardianBody.safeParse({ ...linkBase, rights: partial }).success).toBe(false);
    }
    // full object with at least one true
    expect(
      addMinorBody.safeParse({
        ...validBase,
        rights: { consent: false, pickup: false, view: true, manage: false },
      }).success,
    ).toBe(true);
    expect(
      linkGuardianBody.safeParse({
        ...linkBase,
        rights: { consent: true, pickup: false, view: false, manage: false },
      }).success,
    ).toBe(true);
  });

  it("strictly rejects extra keys inside nested rights (finding 3)", () => {
    const minorBase = {
      communitySlug: "slug",
      householdId: VALID_UUID,
      givenName: "Tommy",
      familyName: "Smith",
      dateOfBirth: "2015-01-01",
      guardianId: OTHER_UUID,
    };
    const fullRights = { consent: true, pickup: false, view: true, manage: false };
    expect(
      addMinorBody.safeParse({
        ...minorBase,
        rights: { ...fullRights, orgId: VALID_UUID },
      }).success,
    ).toBe(false);
    expect(
      addMinorBody.safeParse({
        ...minorBase,
        rights: { ...fullRights, isMinor: false },
      }).success,
    ).toBe(false);
    expect(
      addMinorBody.safeParse({
        ...minorBase,
        rights: { ...fullRights, extra: "forbidden" },
      }).success,
    ).toBe(false);

    const linkBase = {
      communitySlug: "slug",
      householdId: VALID_UUID,
      guardianId: OTHER_UUID,
      childId: VALID_UUID,
    };
    expect(
      linkGuardianBody.safeParse({
        ...linkBase,
        rights: { ...fullRights, orgId: VALID_UUID },
      }).success,
    ).toBe(false);
    expect(
      linkGuardianBody.safeParse({
        ...linkBase,
        rights: { ...fullRights, extra: "forbidden" },
      }).success,
    ).toBe(false);
  });

  it("rejects non-uuid strings on household, person, guardian, child, and link id fields (finding 7)", () => {
    const invalidId = "not-a-valid-uuid";

    expect(
      readHouseholdBody.safeParse({
        communitySlug: "parish-au",
        householdId: invalidId,
      }).success,
    ).toBe(false);

    expect(
      renameHouseholdBody.safeParse({
        communitySlug: "parish-au",
        householdId: invalidId,
        version: 1,
        label: "Label",
      }).success,
    ).toBe(false);

    expect(
      moveAdultBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        personId: invalidId,
        version: 1,
      }).success,
    ).toBe(false);

    expect(
      moveAdultBody.safeParse({
        communitySlug: "parish-au",
        householdId: invalidId,
        personId: VALID_UUID,
        version: 1,
      }).success,
    ).toBe(false);

    expect(
      addMinorBody.safeParse({
        communitySlug: "parish-au",
        householdId: invalidId,
        givenName: "Tommy",
        familyName: "Smith",
        dateOfBirth: "2015-06-01",
        guardianId: VALID_UUID,
      }).success,
    ).toBe(false);

    expect(
      addMinorBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        givenName: "Tommy",
        familyName: "Smith",
        dateOfBirth: "2015-06-01",
        guardianId: invalidId,
      }).success,
    ).toBe(false);

    expect(
      linkGuardianBody.safeParse({
        communitySlug: "parish-au",
        householdId: invalidId,
        guardianId: VALID_UUID,
        childId: VALID_UUID,
      }).success,
    ).toBe(false);

    expect(
      linkGuardianBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        guardianId: invalidId,
        childId: VALID_UUID,
      }).success,
    ).toBe(false);

    expect(
      linkGuardianBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        guardianId: VALID_UUID,
        childId: invalidId,
      }).success,
    ).toBe(false);

    expect(
      unlinkGuardianBody.safeParse({
        communitySlug: "parish-au",
        householdId: invalidId,
        linkId: VALID_UUID,
      }).success,
    ).toBe(false);

    expect(
      unlinkGuardianBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        linkId: invalidId,
      }).success,
    ).toBe(false);
  });

  it("requires positive integer for version fields (finding 7)", () => {
    // 0 is not positive
    expect(
      renameHouseholdBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        version: 0,
        label: "Label",
      }).success,
    ).toBe(false);

    // negative integer is not positive
    expect(
      renameHouseholdBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        version: -1,
        label: "Label",
      }).success,
    ).toBe(false);

    expect(
      moveAdultBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        personId: VALID_UUID,
        version: 0,
      }).success,
    ).toBe(false);

    expect(
      moveAdultBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        personId: VALID_UUID,
        version: -1,
      }).success,
    ).toBe(false);
  });

  it("addAdultBody refuses isMinor, declaredAdult, orgId, communityId, personId and version", () => {
    const validBase = {
      communitySlug: "parish-au",
      householdId: VALID_UUID,
      givenName: "Jane",
      familyName: "Doe",
    };
    expect(addAdultBody.safeParse(validBase).success).toBe(true);

    expect(addAdultBody.safeParse({ ...validBase, isMinor: false }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...validBase, isMinor: true }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...validBase, declaredAdult: true }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...validBase, orgId: VALID_UUID }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...validBase, communityId: VALID_UUID }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...validBase, personId: VALID_UUID }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...validBase, version: 1 }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...validBase, extra: "forbidden" }).success).toBe(false);
  });

  it("addAdultBody requires a non-null householdId", () => {
    const validBase = {
      communitySlug: "parish-au",
      givenName: "Jane",
      familyName: "Doe",
    };
    expect(addAdultBody.safeParse({ ...validBase }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...validBase, householdId: null }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...validBase, householdId: undefined }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...validBase, householdId: "" }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...validBase, householdId: "not-a-valid-uuid" }).success).toBe(
      false,
    );
    expect(addAdultBody.safeParse({ ...validBase, householdId: VALID_UUID }).success).toBe(true);
  });

  it("addAdultBody accepts a body with only the required fields", () => {
    const result = addAdultBody.safeParse({
      communitySlug: "parish-au",
      householdId: VALID_UUID,
      givenName: "Jane",
      familyName: "Doe",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        givenName: "Jane",
        familyName: "Doe",
      });
    }
  });

  it("addAdultBody accepts null and omitted optional fields", () => {
    const base = {
      communitySlug: "parish-au",
      householdId: VALID_UUID,
      givenName: "Jane",
      familyName: "Doe",
    };

    expect(addAdultBody.safeParse(base).success).toBe(true);

    expect(
      addAdultBody.safeParse({
        ...base,
        email: null,
        phone: null,
        dateOfBirth: null,
      }).success,
    ).toBe(true);

    expect(
      addAdultBody.safeParse({
        ...base,
        email: "jane@example.test",
        phone: "+61 400 000 000",
        dateOfBirth: "1990-01-01",
      }).success,
    ).toBe(true);

    expect(
      addAdultBody.safeParse({
        ...base,
        email: "jane@example.test",
        phone: null,
      }).success,
    ).toBe(true);

    expect(
      addAdultBody.safeParse({
        ...base,
        email: "not-an-email",
      }).success,
    ).toBe(false);

    expect(
      addAdultBody.safeParse({
        ...base,
        phone: "",
      }).success,
    ).toBe(false);

    expect(
      addAdultBody.safeParse({
        ...base,
        dateOfBirth: "not-a-date",
      }).success,
    ).toBe(false);
  });

  it("addAdultBody refuses an empty given or family name", () => {
    const base = {
      communitySlug: "parish-au",
      householdId: VALID_UUID,
      givenName: "Jane",
      familyName: "Doe",
    };

    expect(addAdultBody.safeParse({ ...base, givenName: "" }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...base, givenName: "   " }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...base, familyName: "" }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...base, familyName: "   " }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...base, givenName: null }).success).toBe(false);
    expect(addAdultBody.safeParse({ ...base, familyName: null }).success).toBe(false);
  });

  it("emergency contacts refuse an unknown field", () => {
    const valid = {
      name: "Jane Doe",
      phone: "+61 400 000 000",
      relationship: "spouse",
    };
    expect(emergencyContactInput.safeParse(valid).success).toBe(true);
    const withUnknown = {
      ...valid,
      extra: "forbidden",
    };
    expect(emergencyContactInput.safeParse(withUnknown).success).toBe(false);
  });

  it("validates family parity request bodies and responses", () => {
    // Status body & response
    expect(
      householdStatusBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        version: 1,
        status: "inactive",
      }).success,
    ).toBe(true);

    expect(
      householdStatusBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        version: 1,
        status: "active",
      }).success,
    ).toBe(true);

    expect(
      householdStatusResponse.safeParse({
        householdId: VALID_UUID,
        version: 2,
        status: "inactive",
      }).success,
    ).toBe(true);

    expect(
      householdStatusResponse.safeParse({
        householdId: VALID_UUID,
        version: 2,
        status: "active",
      }).success,
    ).toBe(true);

    // Delete body & response
    expect(
      householdDeleteBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        version: 1,
      }).success,
    ).toBe(true);

    expect(
      householdDeleteResponse.safeParse({
        householdId: VALID_UUID,
        version: 2,
        purgeAfter: "2026-11-20T00:00:00.000Z",
      }).success,
    ).toBe(true);

    // Restore body & response
    expect(
      householdRestoreBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        version: 2,
      }).success,
    ).toBe(true);

    expect(
      householdRestoreResponse.safeParse({
        householdId: VALID_UUID,
        version: 3,
      }).success,
    ).toBe(true);

    // Emergency contacts read body & response
    expect(
      readEmergencyContactsBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
      }).success,
    ).toBe(true);

    expect(
      readEmergencyContactsResponse.safeParse({
        householdId: VALID_UUID,
        version: 1,
        contacts: [
          {
            name: "Grandma Smith",
            phone: "+61 400 111 222",
            relationship: "grandparent",
          },
          {
            name: "Neighbour Bob",
            phone: "+61 400 333 444",
            relationship: null,
          },
        ],
      }).success,
    ).toBe(true);

    // Emergency contacts save body & response
    expect(
      saveEmergencyContactsBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        version: 1,
        contacts: [
          {
            name: "Alice",
            phone: "+61 400 555 666",
            relationship: "friend",
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      saveEmergencyContactsResponse.safeParse({
        householdId: VALID_UUID,
        version: 2,
      }).success,
    ).toBe(true);

    // List with status filter
    expect(
      listHouseholdsBody.safeParse({
        communitySlug: "parish-au",
        status: "active",
      }).success,
    ).toBe(true);

    expect(
      listHouseholdsBody.safeParse({
        communitySlug: "parish-au",
        status: "deleted",
      }).success,
    ).toBe(true);

    // Deleted households list item and response
    expect(
      deletedHouseholdListItem.safeParse({
        householdId: VALID_UUID,
        label: "The Smiths",
        adultCount: 2,
        version: 3,
        deletedAt: "2026-10-01T12:00:00.000Z",
        purgeAfter: "2026-10-31T12:00:00.000Z",
      }).success,
    ).toBe(true);

    expect(
      deletedHouseholdsListResponse.safeParse({
        items: [
          {
            householdId: VALID_UUID,
            label: null,
            adultCount: 1,
            version: 1,
            deletedAt: "2026-10-01T12:00:00.000Z",
            purgeAfter: "2026-10-31T12:00:00.000Z",
          },
        ],
        nextCursor: "cursor-token",
      }).success,
    ).toBe(true);

    // Error body
    expect(
      householdErrorBody.safeParse({
        code: "household_has_children",
      }).success,
    ).toBe(true);

    // Emergency contact response item, list and read responses with status
    expect(
      emergencyContactResponseItem.safeParse({
        name: "Test",
        phone: "+61 400 000 000",
        relationship: "friend",
      }).success,
    ).toBe(true);

    expect(
      listHouseholdsResponse.safeParse({
        items: [
          {
            householdId: VALID_UUID,
            version: 1,
            label: "Smith",
            adultCount: 2,
            status: "active",
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);

    expect(
      readHouseholdResponse.safeParse({
        householdId: VALID_UUID,
        version: 1,
        status: "active",
        label: "Smith",
        adults: [],
        minors: { childCount: 0 },
        guardians: [],
      }).success,
    ).toBe(true);
  });

  it("the household read shows a child as a count, or as an id and a label, and nothing else", () => {
    const base = {
      householdId: VALID_UUID,
      version: 1,
      status: "active",
      label: "Smith",
      adults: [],
      guardians: [],
    };
    // A count, for everyone who may see the family.
    expect(readHouseholdResponse.safeParse({ ...base, minors: { childCount: 2 } }).success).toBe(
      true,
    );
    // Ids and labels, for a Community Admin.
    const children = [
      { personId: VALID_UUID, label: "Child 1" },
      { personId: OTHER_UUID, label: "Child 2" },
    ];
    expect(
      readHouseholdResponse.safeParse({ ...base, minors: { childCount: 2, children } }).success,
    ).toBe(true);
    expect(householdChildren.safeParse({ childCount: 0 }).success).toBe(true);

    // The count is required, and a negative or fractional count is refused.
    expect(readHouseholdResponse.safeParse(base).success).toBe(false);
    expect(householdChildren.safeParse({ children }).success).toBe(false);
    expect(householdChildren.safeParse({ childCount: -1 }).success).toBe(false);
    expect(householdChildren.safeParse({ childCount: 1.5 }).success).toBe(false);

    // The old shape (a list of children with their fields) is refused, and so is any field of a
    // child: a name, a date of birth, an email, a phone, an age, a version.
    expect(readHouseholdResponse.safeParse({ ...base, minors: children }).success).toBe(false);
    for (const extra of [
      { givenName: "Zephyrine" },
      { familyName: "Quillonwick" },
      { dateOfBirth: "2018-05-05" },
      { email: "a@zephyr.example.test" },
      { phone: "61400555301" },
      { age: 7 },
      { ageBasis: "date_of_birth" },
      { birthdayMd: 505 },
      { version: 1 },
    ]) {
      expect(
        householdChildren.safeParse({
          childCount: 1,
          children: [{ personId: VALID_UUID, label: "Child 1", ...extra }],
        }).success,
      ).toBe(false);
    }
    expect(householdChildren.safeParse({ childCount: 1, givenName: "Zephyrine" }).success).toBe(
      false,
    );
  });

  it("a guardian link names its child only as an id and a label", () => {
    const link = {
      linkId: VALID_UUID,
      id: VALID_UUID,
      guardianId: OTHER_UUID,
      childId: OTHER_UUID,
      rights: { consent: true, pickup: false, view: true, manage: false },
    };
    expect(householdGuardianLink.safeParse(link).success).toBe(true);
    expect(
      householdGuardianLink.safeParse({
        ...link,
        child: { personId: OTHER_UUID, label: "Child 1" },
      }).success,
    ).toBe(true);
    expect(
      householdGuardianLink.safeParse({
        ...link,
        child: { personId: OTHER_UUID, label: "Child 1", givenName: "Zephyrine" },
      }).success,
    ).toBe(false);
    expect(householdGuardianLink.safeParse({ ...link, child: { label: "Child 1" } }).success).toBe(
      false,
    );
  });

  it("a household read answer with an adult and a guardian link parses, with the ids it carries", () => {
    // The shape /v1/households/read answers: an adult and a link carry `id` beside their own id.
    const adult = {
      id: VALID_UUID,
      personId: VALID_UUID,
      givenName: "Aurelia",
      familyName: "Quillonwick",
      version: 2,
    };
    const link = {
      linkId: OTHER_UUID,
      id: OTHER_UUID,
      guardianId: VALID_UUID,
      childId: OTHER_UUID,
      child: { personId: OTHER_UUID, label: "Child 1" },
      rights: { consent: true, pickup: false, view: true, manage: false },
    };
    const answer = {
      householdId: VALID_UUID,
      version: 1,
      status: "active",
      label: "Quillonwick",
      adults: [adult],
      minors: { childCount: 1, children: [{ personId: OTHER_UUID, label: "Child 1" }] },
      guardians: [link],
    };
    expect(readHouseholdResponse.safeParse(answer).success).toBe(true);

    // The id is required, and both shapes stay strict.
    const adultWithoutId = {
      personId: adult.personId,
      givenName: adult.givenName,
      familyName: adult.familyName,
      version: adult.version,
    };
    expect(householdAdultMember.safeParse(adultWithoutId).success).toBe(false);
    expect(householdAdultMember.safeParse({ ...adult, email: null }).success).toBe(false);
    const linkWithoutId = {
      linkId: link.linkId,
      guardianId: link.guardianId,
      childId: link.childId,
      rights: link.rights,
    };
    expect(householdGuardianLink.safeParse(linkWithoutId).success).toBe(false);
    expect(householdGuardianLink.safeParse({ ...link, childName: "Zephyrine" }).success).toBe(
      false,
    );
  });

  it("the household error body carries each household refusal code and nothing else", () => {
    for (const code of [
      "household_has_children",
      "duplicate_deleted",
      "label_contains_child_name",
    ]) {
      expect(householdErrorBody.safeParse({ code }).success, code).toBe(true);
    }
    expect(
      householdErrorBody.safeParse({ code: "label_contains_child_name", label: "Zephyrine" })
        .success,
    ).toBe(false);
    expect(householdErrorBody.safeParse({ code: "conflict" }).success).toBe(false);
  });

  it("refuses invalid emergency contacts data", () => {
    // Relationship outside enum
    expect(
      emergencyContactInput.safeParse({
        name: "Test",
        phone: "+61 400 000 000",
        relationship: "child",
      }).success,
    ).toBe(false);

    // More than 5 emergency contacts
    const sixContacts = Array.from({ length: 6 }, (_, i) => ({
      name: `Contact ${i}`,
      phone: "+61 400 000 000",
      relationship: "relative" as const,
    }));
    expect(
      saveEmergencyContactsBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        version: 1,
        contacts: sixContacts,
      }).success,
    ).toBe(false);

    // Name empty or too long
    expect(
      emergencyContactInput.safeParse({
        name: "",
        phone: "+61 400 000 000",
      }).success,
    ).toBe(false);
    expect(
      emergencyContactInput.safeParse({
        name: "a".repeat(101),
        phone: "+61 400 000 000",
      }).success,
    ).toBe(false);

    // Phone invalid
    expect(
      emergencyContactInput.safeParse({
        name: "Valid Name",
        phone: "",
      }).success,
    ).toBe(false);
  });
});
