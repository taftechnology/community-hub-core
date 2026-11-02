import { describe, expect, it } from "vitest";

import {
  createLifeEventBody,
  createLifeEventResponse,
  LIFE_EVENT_TYPES,
  listLifeEventsBody,
  listLifeEventsResponse,
  updateLifeEventBody,
  updateLifeEventResponse,
} from "./life-events.js";

const VALID_UUID = "00000000-0000-4000-8000-000000000001";
const OTHER_UUID = "00000000-0000-4000-8000-000000000002";

describe("life-events contract schemas (pins 12, 15)", () => {
  it("parses valid life event request bodies", () => {
    // List
    expect(
      listLifeEventsBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
      }).success,
    ).toBe(true);

    // Create minimal
    expect(
      createLifeEventBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        type: "baptism",
        date: "2020-01-01",
      }).success,
    ).toBe(true);

    // Create full
    expect(
      createLifeEventBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        type: "marriage",
        date: "2024-06-15",
        place: "St Mary's Church",
        notes: "Witnesses present",
      }).success,
    ).toBe(true);

    // Create with null place and notes
    expect(
      createLifeEventBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        type: "first_communion",
        date: "2022-05-10",
        place: null,
        notes: null,
      }).success,
    ).toBe(true);

    // Update
    expect(
      updateLifeEventBody.safeParse({
        communitySlug: "parish-au",
        eventId: OTHER_UUID,
        version: 1,
        type: "funeral",
        date: "2026-01-15",
        place: "Memorial Chapel",
        notes: null,
      }).success,
    ).toBe(true);
  });

  it("Pin 12: validates event types across all allowed values and rejects unknown types", () => {
    expect(LIFE_EVENT_TYPES).toEqual(["baptism", "marriage", "first_communion", "funeral"]);

    for (const type of LIFE_EVENT_TYPES) {
      expect(
        createLifeEventBody.safeParse({
          communitySlug: "parish-au",
          personId: VALID_UUID,
          type,
          date: "2020-01-01",
        }).success,
      ).toBe(true);
    }

    const invalidTypes = ["confirmation", "ordination", "unknown", "", "BAPTISM"];
    for (const type of invalidTypes) {
      expect(
        createLifeEventBody.safeParse({
          communitySlug: "parish-au",
          personId: VALID_UUID,
          type,
          date: "2020-01-01",
        }).success,
      ).toBe(false);

      expect(
        updateLifeEventBody.safeParse({
          communitySlug: "parish-au",
          eventId: OTHER_UUID,
          version: 1,
          type,
          date: "2020-01-01",
        }).success,
      ).toBe(false);
    }
  });

  it("Pin 12: rejects future date, 1899, malformed dates, and impossible calendar dates", () => {
    const baseCreate = {
      communitySlug: "parish-au",
      personId: VALID_UUID,
      type: "baptism" as const,
    };

    // 1900-01-01 is accepted
    expect(
      createLifeEventBody.safeParse({
        ...baseCreate,
        date: "1900-01-01",
      }).success,
    ).toBe(true);

    // 1899 is rejected
    expect(
      createLifeEventBody.safeParse({
        ...baseCreate,
        date: "1899-12-31",
      }).success,
    ).toBe(false);

    // Future dates rejected
    expect(
      createLifeEventBody.safeParse({
        ...baseCreate,
        date: "2099-01-01",
      }).success,
    ).toBe(false);

    // Format / calendar invalid
    expect(
      createLifeEventBody.safeParse({
        ...baseCreate,
        date: "not-a-date",
      }).success,
    ).toBe(false);

    expect(
      createLifeEventBody.safeParse({
        ...baseCreate,
        date: "2021-02-29", // non-leap year
      }).success,
    ).toBe(false);

    expect(
      createLifeEventBody.safeParse({
        ...baseCreate,
        date: "2020-04-31", // April has 30 days
      }).success,
    ).toBe(false);
  });

  it("Pin 12: bounds place to 200 chars and notes to 2000 chars", () => {
    const baseCreate = {
      communitySlug: "parish-au",
      personId: VALID_UUID,
      type: "baptism" as const,
      date: "2020-01-01",
    };

    // Place at 200 chars ok, 201 rejected
    expect(
      createLifeEventBody.safeParse({
        ...baseCreate,
        place: "a".repeat(200),
      }).success,
    ).toBe(true);

    expect(
      createLifeEventBody.safeParse({
        ...baseCreate,
        place: "a".repeat(201),
      }).success,
    ).toBe(false);

    // Notes at 2000 chars ok, 2001 rejected
    expect(
      createLifeEventBody.safeParse({
        ...baseCreate,
        notes: "b".repeat(2000),
      }).success,
    ).toBe(true);

    expect(
      createLifeEventBody.safeParse({
        ...baseCreate,
        notes: "b".repeat(2001),
      }).success,
    ).toBe(false);
  });

  it("Pin 15: strict bodies reject unknown or request-supplied orgId, communityId, isMinor", () => {
    // List
    expect(
      listLifeEventsBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        orgId: VALID_UUID,
      }).success,
    ).toBe(false);

    expect(
      listLifeEventsBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        communityId: VALID_UUID,
      }).success,
    ).toBe(false);

    expect(
      listLifeEventsBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        isMinor: true,
      }).success,
    ).toBe(false);

    // Create
    expect(
      createLifeEventBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        type: "baptism",
        date: "2020-01-01",
        orgId: VALID_UUID,
      }).success,
    ).toBe(false);

    expect(
      createLifeEventBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        type: "baptism",
        date: "2020-01-01",
        communityId: VALID_UUID,
      }).success,
    ).toBe(false);

    expect(
      createLifeEventBody.safeParse({
        communitySlug: "parish-au",
        personId: VALID_UUID,
        type: "baptism",
        date: "2020-01-01",
        isMinor: false,
      }).success,
    ).toBe(false);

    // Update
    expect(
      updateLifeEventBody.safeParse({
        communitySlug: "parish-au",
        eventId: OTHER_UUID,
        version: 1,
        type: "baptism",
        date: "2020-01-01",
        orgId: VALID_UUID,
      }).success,
    ).toBe(false);

    expect(
      updateLifeEventBody.safeParse({
        communitySlug: "parish-au",
        eventId: OTHER_UUID,
        version: 1,
        type: "baptism",
        date: "2020-01-01",
        communityId: VALID_UUID,
      }).success,
    ).toBe(false);

    expect(
      updateLifeEventBody.safeParse({
        communitySlug: "parish-au",
        eventId: OTHER_UUID,
        version: 1,
        type: "baptism",
        date: "2020-01-01",
        personId: VALID_UUID, // person cannot change
      }).success,
    ).toBe(false);
  });

  it("validates response shapes and rejects extra fields", () => {
    // List response
    expect(
      listLifeEventsResponse.safeParse({
        items: [
          {
            eventId: VALID_UUID,
            version: 1,
            type: "baptism",
            date: "2020-01-01",
            place: "Chapel",
            notes: null,
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      listLifeEventsResponse.safeParse({
        items: [],
      }).success,
    ).toBe(true);

    expect(
      listLifeEventsResponse.safeParse({
        items: [],
        extra: "not allowed",
      }).success,
    ).toBe(false);

    // Create response
    expect(
      createLifeEventResponse.safeParse({
        eventId: VALID_UUID,
        version: 1,
      }).success,
    ).toBe(true);

    expect(
      createLifeEventResponse.safeParse({
        eventId: VALID_UUID,
        version: 1,
        extra: "not allowed",
      }).success,
    ).toBe(false);

    // Update response
    expect(
      updateLifeEventResponse.safeParse({
        version: 2,
      }).success,
    ).toBe(true);

    expect(
      updateLifeEventResponse.safeParse({
        version: 2,
        extra: "not allowed",
      }).success,
    ).toBe(false);
  });
});
