import { describe, expect, it } from "vitest";

import {
  addMinorBody,
  createHouseholdBody,
  linkGuardianBody,
  listHouseholdsBody,
  moveAdultBody,
  readHouseholdBody,
  renameHouseholdBody,
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
        rights: { view: true },
      }).success,
    ).toBe(true);

    expect(
      linkGuardianBody.safeParse({
        communitySlug: "parish-au",
        householdId: VALID_UUID,
        guardianId: OTHER_UUID,
        childId: "00000000-0000-4000-8000-000000000003",
        rights: { consent: true, pickup: true },
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

  it("requires at least one right to be true when rights are provided", () => {
    const validBase = {
      communitySlug: "slug",
      householdId: VALID_UUID,
      givenName: "Tommy",
      familyName: "Smith",
      dateOfBirth: "2015-01-01",
      guardianId: OTHER_UUID,
    };

    // empty rights object
    expect(addMinorBody.safeParse({ ...validBase, rights: {} }).success).toBe(false);
    // all false rights
    expect(
      addMinorBody.safeParse({
        ...validBase,
        rights: { consent: false, pickup: false, view: false, manage: false },
      }).success,
    ).toBe(false);
    // single true right
    expect(addMinorBody.safeParse({ ...validBase, rights: { view: true } }).success).toBe(true);
    expect(addMinorBody.safeParse({ ...validBase, rights: { consent: true } }).success).toBe(true);
    expect(addMinorBody.safeParse({ ...validBase, rights: { pickup: true } }).success).toBe(true);
    expect(addMinorBody.safeParse({ ...validBase, rights: { manage: true } }).success).toBe(true);

    // linkGuardian also enforces at least one right
    const linkBase = {
      communitySlug: "slug",
      householdId: VALID_UUID,
      guardianId: OTHER_UUID,
      childId: VALID_UUID,
    };
    expect(linkGuardianBody.safeParse({ ...linkBase, rights: {} }).success).toBe(false);
    expect(
      linkGuardianBody.safeParse({
        ...linkBase,
        rights: { consent: false, pickup: false, view: false, manage: false },
      }).success,
    ).toBe(false);
    expect(linkGuardianBody.safeParse({ ...linkBase, rights: { consent: true } }).success).toBe(
      true,
    );
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
    expect(
      addMinorBody.safeParse({
        ...minorBase,
        rights: { view: true, orgId: VALID_UUID },
      }).success,
    ).toBe(false);
    expect(
      addMinorBody.safeParse({
        ...minorBase,
        rights: { view: true, isMinor: false },
      }).success,
    ).toBe(false);
    expect(
      addMinorBody.safeParse({
        ...minorBase,
        rights: { view: true, extra: "forbidden" },
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
        rights: { view: true, orgId: VALID_UUID },
      }).success,
    ).toBe(false);
    expect(
      linkGuardianBody.safeParse({
        ...linkBase,
        rights: { view: true, extra: "forbidden" },
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
});
