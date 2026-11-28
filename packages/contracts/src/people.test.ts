import { describe, expect, it } from "vitest";

import {
  createPersonBody,
  deletedPeopleListResponse,
  listPeopleBody,
  minorLifeEventViewBody,
  minorViewBody,
  minorViewErrorBody,
  minorViewNameResponse,
  minorViewValueResponse,
  peopleErrorBody,
  peopleSummaryBody,
  peopleSummaryResponse,
  personDeleteBody,
  personDeleteResponse,
  personRestoreBody,
  personRestoreResponse,
  personStatusBody,
  personStatusResponse,
  PERSON_SOURCES,
  readPersonBody,
  updatePersonBody,
} from "./people.js";

const VALID_UUID = "00000000-0000-4000-8000-000000000001";

describe("people contract schemas (pin 2)", () => {
  it("parses valid list, read, create, and update bodies", () => {
    expect(
      listPeopleBody.safeParse({
        communitySlug: "parish-au",
        kind: "adults",
        search: "John",
        limit: 50,
      }).success,
    ).toBe(true);

    expect(
      listPeopleBody.safeParse({
        communitySlug: "parish-au",
        kind: "minors",
        cursor: "opaque-cursor-token",
      }).success,
    ).toBe(true);

    expect(
      readPersonBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
      }).success,
    ).toBe(true);

    expect(
      createPersonBody.safeParse({
        communitySlug: "parish-au",
        givenName: "Jane",
        familyName: "Doe",
        email: "jane.doe@example.com",
        phone: "+61411111111",
        dateOfBirth: "1990-01-01",
      }).success,
    ).toBe(true);

    expect(
      updatePersonBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        version: 1,
        givenName: "Janet",
        email: null,
      }).success,
    ).toBe(true);
  });

  it("strictly rejects forbidden fields: includeRestricted, isMinor, orgId, communityId (pin 2)", () => {
    for (const schema of [listPeopleBody, readPersonBody, createPersonBody, updatePersonBody]) {
      const base =
        schema === listPeopleBody
          ? { communitySlug: "slug" }
          : schema === readPersonBody
            ? { communitySlug: "slug", personId: VALID_UUID }
            : schema === createPersonBody
              ? { communitySlug: "slug", givenName: "A", familyName: "B" }
              : schema === updatePersonBody
                ? { communitySlug: "slug", personId: VALID_UUID, version: 1 }
                : { communitySlug: "slug" };

      expect(schema.safeParse({ ...base, includeRestricted: true }).success).toBe(false);
      expect(schema.safeParse({ ...base, isMinor: false }).success).toBe(false);
      expect(schema.safeParse({ ...base, orgId: VALID_UUID }).success).toBe(false);
      expect(schema.safeParse({ ...base, communityId: VALID_UUID }).success).toBe(false);
      expect(schema.safeParse({ ...base, extra: "forbidden" }).success).toBe(false);
    }
  });

  it("enforces validation constraints on fields", () => {
    // kind must be adults or minors
    expect(listPeopleBody.safeParse({ communitySlug: "slug", kind: "unknown" }).success).toBe(
      false,
    );

    // limit bounds 1 to 100
    expect(listPeopleBody.safeParse({ communitySlug: "slug", limit: 0 }).success).toBe(false);
    expect(listPeopleBody.safeParse({ communitySlug: "slug", limit: 101 }).success).toBe(false);

    // search length cap 100
    expect(
      listPeopleBody.safeParse({ communitySlug: "slug", search: "a".repeat(101) }).success,
    ).toBe(false);

    // cursor length cap 1024
    expect(
      listPeopleBody.safeParse({ communitySlug: "slug", cursor: "c".repeat(1024) }).success,
    ).toBe(true);
    expect(
      listPeopleBody.safeParse({ communitySlug: "slug", cursor: "c".repeat(1025) }).success,
    ).toBe(false);

    // names min 1 max 100
    expect(
      createPersonBody.safeParse({
        communitySlug: "slug",
        givenName: "",
        familyName: "Doe",
      }).success,
    ).toBe(false);
    expect(
      createPersonBody.safeParse({
        communitySlug: "slug",
        givenName: "a".repeat(101),
        familyName: "Doe",
      }).success,
    ).toBe(false);

    // version must be a positive integer
    expect(
      updatePersonBody.safeParse({
        communitySlug: "slug",
        personId: VALID_UUID,
        version: 0,
      }).success,
    ).toBe(false);
    expect(
      updatePersonBody.safeParse({
        communitySlug: "slug",
        personId: VALID_UUID,
        version: -1,
      }).success,
    ).toBe(false);
    expect(
      updatePersonBody.safeParse({
        communitySlug: "slug",
        personId: VALID_UUID,
        version: 1.5,
      }).success,
    ).toBe(false);

    // UUID validation
    expect(
      readPersonBody.safeParse({
        communitySlug: "slug",
        personId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("fits well under the 4096-byte request body cap at maximum field lengths", () => {
    const maxCreateBody = {
      communitySlug: "a".repeat(100),
      givenName: "g".repeat(100),
      familyName: "f".repeat(100),
      email: `${"e".repeat(50)}@${"example".repeat(5)}.com`,
      phone: "+614" + "1".repeat(20),
      dateOfBirth: "1999-12-31",
    };
    expect(createPersonBody.safeParse(maxCreateBody).success).toBe(true);
    const serializedCreate = JSON.stringify(maxCreateBody);
    expect(Buffer.byteLength(serializedCreate, "utf8")).toBeLessThan(4096);

    const maxUpdateBody = {
      communitySlug: "a".repeat(100),
      personId: VALID_UUID,
      version: 999999,
      givenName: "g".repeat(100),
      familyName: "f".repeat(100),
      email: `${"e".repeat(50)}@${"example".repeat(5)}.com`,
      phone: "+614" + "1".repeat(20),
      dateOfBirth: "1999-12-31",
    };
    expect(updatePersonBody.safeParse(maxUpdateBody).success).toBe(true);
    const serializedUpdate = JSON.stringify(maxUpdateBody);
    expect(Buffer.byteLength(serializedUpdate, "utf8")).toBeLessThan(4096);
  });

  it("listPeopleBody refuses status, source and groupId with kind minors", () => {
    // With kind minors, status, source and groupId are each refused
    expect(
      listPeopleBody.safeParse({
        communitySlug: "slug",
        kind: "minors",
        status: "active",
      }).success,
    ).toBe(false);

    expect(
      listPeopleBody.safeParse({
        communitySlug: "slug",
        kind: "minors",
        source: "manual",
      }).success,
    ).toBe(false);

    expect(
      listPeopleBody.safeParse({
        communitySlug: "slug",
        kind: "minors",
        groupId: VALID_UUID,
      }).success,
    ).toBe(false);

    // Without kind: "minors", status, source and groupId are accepted
    expect(
      listPeopleBody.safeParse({
        communitySlug: "slug",
        kind: "adults",
        status: "active",
        source: "manual",
        groupId: VALID_UUID,
      }).success,
    ).toBe(true);

    expect(
      listPeopleBody.safeParse({
        communitySlug: "slug",
        status: "inactive",
        source: "family_records",
      }).success,
    ).toBe(true);

    // Kind minors without those filters is accepted
    expect(
      listPeopleBody.safeParse({
        communitySlug: "slug",
        kind: "minors",
      }).success,
    ).toBe(true);

    // Negative cases: non-UUID groupId and unknown status
    expect(
      listPeopleBody.safeParse({
        communitySlug: "slug",
        groupId: "not-a-uuid",
      }).success,
    ).toBe(false);

    expect(
      listPeopleBody.safeParse({
        communitySlug: "slug",
        status: "unknown-status",
      }).success,
    ).toBe(false);
  });

  it("createPersonBody and updatePersonBody accept only manual and family_records as source", () => {
    // createPersonBody accepts manual and family_records
    expect(
      createPersonBody.safeParse({
        communitySlug: "slug",
        givenName: "Jane",
        familyName: "Doe",
        source: "manual",
      }).success,
    ).toBe(true);

    expect(
      createPersonBody.safeParse({
        communitySlug: "slug",
        givenName: "Jane",
        familyName: "Doe",
        source: "family_records",
      }).success,
    ).toBe(true);

    expect(
      createPersonBody.safeParse({
        communitySlug: "slug",
        givenName: "Jane",
        familyName: "Doe",
      }).success,
    ).toBe(true);

    // updatePersonBody accepts manual and family_records
    expect(
      updatePersonBody.safeParse({
        communitySlug: "slug",
        personId: VALID_UUID,
        version: 1,
        source: "manual",
      }).success,
    ).toBe(true);

    expect(
      updatePersonBody.safeParse({
        communitySlug: "slug",
        personId: VALID_UUID,
        version: 1,
        source: "family_records",
      }).success,
    ).toBe(true);

    expect(
      updatePersonBody.safeParse({
        communitySlug: "slug",
        personId: VALID_UUID,
        version: 1,
      }).success,
    ).toBe(true);

    // Both reject other sources from PERSON_SOURCES or arbitrary strings
    for (const source of [
      "website",
      "form",
      "donation",
      "event_rsvp",
      "event_booking",
      "volunteer_application",
      "mobile_app",
      "mobile_app_family",
      "auto",
      "other",
    ]) {
      expect(
        createPersonBody.safeParse({
          communitySlug: "slug",
          givenName: "Jane",
          familyName: "Doe",
          source,
        }).success,
      ).toBe(false);

      expect(
        updatePersonBody.safeParse({
          communitySlug: "slug",
          personId: VALID_UUID,
          version: 1,
          source,
        }).success,
      ).toBe(false);
    }
  });

  it("PERSON_SOURCES lists the eleven keys in order", () => {
    expect(PERSON_SOURCES).toEqual([
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
    ]);
  });

  it("peopleSummaryBody refuses an addedSince without an offset", () => {
    // Rejects naive datetime without timezone offset
    expect(
      peopleSummaryBody.safeParse({
        communitySlug: "parish-au",
        addedSince: "2026-10-01T00:00:00",
      }).success,
    ).toBe(false);

    // Rejects date-only string
    expect(
      peopleSummaryBody.safeParse({
        communitySlug: "parish-au",
        addedSince: "2026-10-01",
      }).success,
    ).toBe(false);

    // Accepts ISO 8601 instants with UTC offset Z
    expect(
      peopleSummaryBody.safeParse({
        communitySlug: "parish-au",
        addedSince: "2026-10-01T00:00:00Z",
      }).success,
    ).toBe(true);

    // Accepts ISO 8601 instants with numeric positive offset
    expect(
      peopleSummaryBody.safeParse({
        communitySlug: "parish-au",
        addedSince: "2026-10-01T00:00:00+11:00",
      }).success,
    ).toBe(true);

    // Accepts ISO 8601 instants with numeric negative offset
    expect(
      peopleSummaryBody.safeParse({
        communitySlug: "parish-au",
        addedSince: "2026-10-01T00:00:00-05:00",
      }).success,
    ).toBe(true);

    // Accepts ISO 8601 instants with fractional seconds
    expect(
      peopleSummaryBody.safeParse({
        communitySlug: "parish-au",
        addedSince: "2026-10-01T00:00:00.123+11:00",
      }).success,
    ).toBe(true);
  });

  it("personStatusBody parses valid bodies and strictly rejects invalid or extra fields", () => {
    expect(
      personStatusBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        version: 1,
        status: "active",
      }).success,
    ).toBe(true);

    expect(
      personStatusBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        version: 2,
        status: "inactive",
      }).success,
    ).toBe(true);

    // Rejects invalid status
    expect(
      personStatusBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        version: 1,
        status: "unknown",
      }).success,
    ).toBe(false);

    // Rejects non-positive or non-integer version
    expect(
      personStatusBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        version: 0,
        status: "active",
      }).success,
    ).toBe(false);

    expect(
      personStatusBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        version: 1.5,
        status: "active",
      }).success,
    ).toBe(false);

    // Rejects non-UUID personId
    expect(
      personStatusBody.safeParse({
        communitySlug: "parish-au",
        personId: "not-a-uuid",
        version: 1,
        status: "active",
      }).success,
    ).toBe(false);

    // Strictly rejects extra fields
    expect(
      personStatusBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        version: 1,
        status: "active",
        extra: "forbidden",
      }).success,
    ).toBe(false);
  });

  it("personStatusResponse parses valid responses and strictly rejects invalid or extra fields", () => {
    expect(
      personStatusResponse.safeParse({
        version: 1,
        status: "active",
      }).success,
    ).toBe(true);

    expect(
      personStatusResponse.safeParse({
        version: 5,
        status: "inactive",
      }).success,
    ).toBe(true);

    // Rejects invalid status
    expect(
      personStatusResponse.safeParse({
        version: 1,
        status: "other",
      }).success,
    ).toBe(false);

    // Rejects non-positive version
    expect(
      personStatusResponse.safeParse({
        version: 0,
        status: "active",
      }).success,
    ).toBe(false);

    // Strictly rejects extra fields
    expect(
      personStatusResponse.safeParse({
        version: 1,
        status: "active",
        extra: "forbidden",
      }).success,
    ).toBe(false);
  });

  it("peopleSummaryBody parses valid bodies and strictly rejects invalid or extra fields", () => {
    expect(
      peopleSummaryBody.safeParse({
        communitySlug: "parish-au",
        addedSince: "2026-10-01T00:00:00Z",
      }).success,
    ).toBe(true);

    // Missing addedSince
    expect(
      peopleSummaryBody.safeParse({
        communitySlug: "parish-au",
      }).success,
    ).toBe(false);

    // Missing communitySlug
    expect(
      peopleSummaryBody.safeParse({
        addedSince: "2026-10-01T00:00:00Z",
      }).success,
    ).toBe(false);

    // Empty communitySlug
    expect(
      peopleSummaryBody.safeParse({
        communitySlug: "",
        addedSince: "2026-10-01T00:00:00Z",
      }).success,
    ).toBe(false);

    // Strictly rejects extra fields
    expect(
      peopleSummaryBody.safeParse({
        communitySlug: "parish-au",
        addedSince: "2026-10-01T00:00:00Z",
        extra: "forbidden",
      }).success,
    ).toBe(false);
  });

  it("peopleSummaryResponse parses valid responses and strictly rejects invalid or extra fields", () => {
    expect(
      peopleSummaryResponse.safeParse({
        total: 10,
        active: 8,
        inactive: 2,
        addedSince: 3,
      }).success,
    ).toBe(true);

    expect(
      peopleSummaryResponse.safeParse({
        total: 10,
        active: 8,
        inactive: 2,
        addedSince: 3,
        groups: [
          { id: VALID_UUID, name: "Choir" },
          { id: "00000000-0000-4000-8000-000000000002", name: "Youth" },
        ],
      }).success,
    ).toBe(true);

    expect(
      peopleSummaryResponse.safeParse({
        total: 0,
        active: 0,
        inactive: 0,
        addedSince: 0,
        groups: [],
      }).success,
    ).toBe(true);

    // Rejects negative counts
    expect(
      peopleSummaryResponse.safeParse({
        total: -1,
        active: 0,
        inactive: 0,
        addedSince: 0,
      }).success,
    ).toBe(false);

    // Rejects non-integer counts
    expect(
      peopleSummaryResponse.safeParse({
        total: 1.5,
        active: 0,
        inactive: 0,
        addedSince: 0,
      }).success,
    ).toBe(false);

    // Rejects invalid group in groups array
    expect(
      peopleSummaryResponse.safeParse({
        total: 1,
        active: 1,
        inactive: 0,
        addedSince: 1,
        groups: [{ id: "not-a-uuid", name: "Choir" }],
      }).success,
    ).toBe(false);

    // Strictly rejects extra fields
    expect(
      peopleSummaryResponse.safeParse({
        total: 1,
        active: 1,
        inactive: 0,
        addedSince: 1,
        extra: "forbidden",
      }).success,
    ).toBe(false);
  });
});

describe("contact delete contracts", () => {
  const listed = {
    id: VALID_UUID,
    givenName: "Gina",
    familyName: "Example",
    deletedAt: "2026-11-23T01:02:03.456Z",
    purgeAfter: "2026-12-23T01:02:03.456Z",
    version: 3,
  };

  it("the list body refuses status deleted with source, groupId or kind minors", () => {
    expect(listPeopleBody.safeParse({ communitySlug: "slug", status: "deleted" }).success).toBe(
      true,
    );
    expect(
      listPeopleBody.safeParse({
        communitySlug: "slug",
        kind: "adults",
        status: "deleted",
        search: "Gin",
        limit: 20,
        cursor: "opaque",
      }).success,
    ).toBe(true);
    expect(
      listPeopleBody.safeParse({ communitySlug: "slug", status: "deleted", source: "manual" })
        .success,
    ).toBe(false);
    expect(
      listPeopleBody.safeParse({ communitySlug: "slug", status: "deleted", groupId: VALID_UUID })
        .success,
    ).toBe(false);
    expect(
      listPeopleBody.safeParse({ communitySlug: "slug", kind: "minors", status: "deleted" })
        .success,
    ).toBe(false);
    // The other statuses still take source and groupId.
    expect(
      listPeopleBody.safeParse({
        communitySlug: "slug",
        status: "active",
        source: "manual",
        groupId: VALID_UUID,
      }).success,
    ).toBe(true);
  });

  it("delete and restore bodies take a person id and a version only", () => {
    for (const schema of [personDeleteBody, personRestoreBody]) {
      expect(
        schema.safeParse({ communitySlug: "slug", personId: VALID_UUID, version: 1 }).success,
      ).toBe(true);
      expect(schema.safeParse({ communitySlug: "slug", personId: VALID_UUID }).success).toBe(false);
      expect(
        schema.safeParse({ communitySlug: "slug", personId: VALID_UUID, version: 0 }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ communitySlug: "slug", personId: "not-a-uuid", version: 1 }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          communitySlug: "slug",
          personId: VALID_UUID,
          version: 1,
          extra: "forbidden",
        }).success,
      ).toBe(false);
    }
  });

  it("delete and restore responses are strict", () => {
    expect(
      personDeleteResponse.safeParse({
        personId: VALID_UUID,
        version: 2,
        purgeAfter: "2026-12-23T01:02:03.456Z",
      }).success,
    ).toBe(true);
    expect(
      personDeleteResponse.safeParse({ personId: VALID_UUID, version: 2, purgeAfter: "soon" })
        .success,
    ).toBe(false);
    expect(personDeleteResponse.safeParse({ personId: VALID_UUID, version: 2 }).success).toBe(
      false,
    );
    expect(personRestoreResponse.safeParse({ personId: VALID_UUID, version: 3 }).success).toBe(
      true,
    );
    expect(
      personRestoreResponse.safeParse({ personId: VALID_UUID, version: 3, extra: 1 }).success,
    ).toBe(false);
  });

  it("the deleted list response carries names and dates only", () => {
    expect(deletedPeopleListResponse.safeParse({ items: [listed], nextCursor: null }).success).toBe(
      true,
    );
    expect(
      deletedPeopleListResponse.safeParse({ items: [listed], nextCursor: "opaque" }).success,
    ).toBe(true);
    expect(
      deletedPeopleListResponse.safeParse({
        items: [{ ...listed, email: "gina@example.test" }],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      deletedPeopleListResponse.safeParse({
        items: [{ ...listed, deletedAt: "yesterday" }],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(deletedPeopleListResponse.safeParse({ items: [listed] }).success).toBe(false);
  });

  it("the error body is a code from the four refusals and nothing else", () => {
    for (const code of [
      "linked_user",
      "pending_invitation",
      "sole_guardian",
      "duplicate_deleted",
    ]) {
      expect(peopleErrorBody.safeParse({ code }).success).toBe(true);
    }
    expect(peopleErrorBody.safeParse({ code: "conflict" }).success).toBe(false);
    expect(peopleErrorBody.safeParse({}).success).toBe(false);
    expect(peopleErrorBody.safeParse({ code: "linked_user", message: "x" }).success).toBe(false);
  });
});

describe("the View contracts for a child's fields", () => {
  const OTHER_UUID = "00000000-0000-4000-8000-000000000002";
  const person = { communitySlug: "parish-au", personId: VALID_UUID };
  const lifeEvent = { ...person, lifeEventId: OTHER_UUID };
  const PERSON_FIELDS = ["name", "dateOfBirth", "email", "phone"];
  const EVENT_FIELDS = ["type", "date", "place", "notes"];

  it("pin 72: each View body takes only its own fields; the person route refuses notes", () => {
    expect(minorViewBody.safeParse({ ...person, field: "notes" }).success).toBe(false);
    for (const field of PERSON_FIELDS) {
      expect(minorViewBody.safeParse({ ...person, field }).success, field).toBe(true);
    }
    for (const field of EVENT_FIELDS) {
      expect(minorLifeEventViewBody.safeParse({ ...lifeEvent, field }).success, field).toBe(true);
    }
    for (const field of [...EVENT_FIELDS, "givenName", "birthdayMd", "all", "", null]) {
      expect(minorViewBody.safeParse({ ...person, field }).success, String(field)).toBe(false);
    }
    for (const field of [...PERSON_FIELDS, "all", "", null]) {
      expect(minorLifeEventViewBody.safeParse({ ...lifeEvent, field }).success, String(field)).toBe(
        false,
      );
    }
  });

  it("each View body is strict: one field, the ids as uuids, and nothing else", () => {
    // One field per View: a list of fields is refused.
    expect(minorViewBody.safeParse({ ...person, field: ["name", "email"] }).success).toBe(false);
    expect(minorViewBody.safeParse(person).success).toBe(false);
    expect(minorViewBody.safeParse({ ...person, personId: "child-1", field: "name" }).success).toBe(
      false,
    );
    expect(minorViewBody.safeParse({ personId: VALID_UUID, field: "name" }).success).toBe(false);
    for (const extra of [
      { lifeEventId: OTHER_UUID },
      { includeRestricted: true },
      { childView: "admin" },
      { orgId: OTHER_UUID },
    ]) {
      expect(minorViewBody.safeParse({ ...person, field: "name", ...extra }).success).toBe(false);
    }
    expect(minorLifeEventViewBody.safeParse({ ...person, field: "type" }).success).toBe(false);
    expect(
      minorLifeEventViewBody.safeParse({ ...lifeEvent, lifeEventId: "first", field: "type" })
        .success,
    ).toBe(false);
    expect(
      minorLifeEventViewBody.safeParse({ ...lifeEvent, field: "type", eventId: OTHER_UUID })
        .success,
    ).toBe(false);
  });

  it("a name View answers its two parts, each of which may be empty, and nothing else", () => {
    for (const value of [
      { given: "Zephyrine", family: "Quillonwick" },
      { given: null, family: "Quillonwick" },
      { given: "Zephyrine", family: null },
      { given: null, family: null },
    ]) {
      expect(minorViewNameResponse.safeParse({ value }).success).toBe(true);
    }
    for (const answer of [
      { value: null },
      { value: "Zephyrine" },
      { value: { given: "Zephyrine" } },
      { value: { given: "Zephyrine", family: null, dateOfBirth: "2018-05-05" } },
      { value: { given: null, family: null }, personId: VALID_UUID },
    ]) {
      expect(minorViewNameResponse.safeParse(answer).success, JSON.stringify(answer)).toBe(false);
    }
  });

  it("every other View answers one string or null, and nothing else", () => {
    expect(minorViewValueResponse.safeParse({ value: "2018-05-05" }).success).toBe(true);
    expect(minorViewValueResponse.safeParse({ value: null }).success).toBe(true);
    for (const answer of [
      {},
      { value: 505 },
      { value: { given: null, family: null } },
      { value: "a", field: "email" },
    ]) {
      expect(minorViewValueResponse.safeParse(answer).success, JSON.stringify(answer)).toBe(false);
    }
  });

  it("the View error body is fresh_required or recovery_session and nothing else", () => {
    for (const code of ["fresh_required", "recovery_session"]) {
      expect(minorViewErrorBody.safeParse({ code }).success, code).toBe(true);
    }
    expect(minorViewErrorBody.safeParse({ code: "forbidden" }).success).toBe(false);
    expect(minorViewErrorBody.safeParse({ code: "not_fresh" }).success).toBe(false);
    expect(
      minorViewErrorBody.safeParse({ code: "fresh_required", personId: VALID_UUID }).success,
    ).toBe(false);
    expect(minorViewErrorBody.safeParse({}).success).toBe(false);
  });
});
