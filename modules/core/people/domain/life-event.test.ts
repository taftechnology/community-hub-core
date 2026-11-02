import { describe, expect, it } from "vitest";

import { PeopleError } from "./error.js";
import { validateLifeEventInput } from "./life-event.js";

const NOW = new Date("2026-11-01T00:00:00+11:00");

describe("life event domain validation", () => {
  it("accepts valid life event types, dates, places, and notes", () => {
    const validTypes = ["baptism", "marriage", "first_communion", "funeral"] as const;
    for (const type of validTypes) {
      const result = validateLifeEventInput(
        {
          type,
          date: "2026-10-01",
          place: "St Mary's Church",
          notes: "Recorded by parish secretary",
        },
        NOW,
      );
      expect(result).toEqual({
        type,
        date: "2026-10-01",
        place: "St Mary's Church",
        notes: "Recorded by parish secretary",
      });
    }

    const minDateResult = validateLifeEventInput(
      {
        type: "baptism",
        date: "1900-01-01",
        place: null,
        notes: null,
      },
      NOW,
    );
    expect(minDateResult.date).toBe("1900-01-01");
    expect(minDateResult.place).toBeNull();
    expect(minDateResult.notes).toBeNull();

    // Today's date in Sydney
    const todayResult = validateLifeEventInput(
      {
        type: "baptism",
        date: "2026-11-01",
      },
      NOW,
    );
    expect(todayResult.date).toBe("2026-11-01");
  });

  it("rejects a future date relative to now (Pin 12)", () => {
    expect(() =>
      validateLifeEventInput(
        {
          type: "baptism",
          date: "2026-11-02",
        },
        NOW,
      ),
    ).toThrowError(new PeopleError("invalid_life_event"));
  });

  it("rejects dates before 1900 (Pin 12)", () => {
    expect(() =>
      validateLifeEventInput(
        {
          type: "baptism",
          date: "1899-12-31",
        },
        NOW,
      ),
    ).toThrowError(new PeopleError("invalid_life_event"));
  });

  it("rejects invalid calendar dates (Pin 12)", () => {
    expect(() =>
      validateLifeEventInput(
        {
          type: "baptism",
          date: "2026-02-30",
        },
        NOW,
      ),
    ).toThrowError(new PeopleError("invalid_life_event"));

    expect(() =>
      validateLifeEventInput(
        {
          type: "baptism",
          date: "not-a-date",
        },
        NOW,
      ),
    ).toThrowError(new PeopleError("invalid_life_event"));
  });

  it("rejects unknown event types (Pin 12)", () => {
    expect(() =>
      validateLifeEventInput(
        {
          type: "confirmation",
          date: "2026-05-01",
        },
        NOW,
      ),
    ).toThrowError(new PeopleError("invalid_life_event"));

    expect(() =>
      validateLifeEventInput(
        {
          type: "",
          date: "2026-05-01",
        },
        NOW,
      ),
    ).toThrowError(new PeopleError("invalid_life_event"));
  });

  it("rejects place longer than 200 characters (Pin 12)", () => {
    expect(() =>
      validateLifeEventInput(
        {
          type: "baptism",
          date: "2026-05-01",
          place: "a".repeat(201),
        },
        NOW,
      ),
    ).toThrowError(new PeopleError("invalid_life_event"));
  });

  it("rejects notes longer than 2,000 characters (Pin 12)", () => {
    expect(() =>
      validateLifeEventInput(
        {
          type: "baptism",
          date: "2026-05-01",
          notes: "b".repeat(2001),
        },
        NOW,
      ),
    ).toThrowError(new PeopleError("invalid_life_event"));
  });
});
