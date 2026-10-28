import { describe, expect, it } from "vitest";
import { utcDay } from "./day.js";
import { UsageError } from "./error.js";

describe("utcDay", () => {
  it("formats valid dates into UTC day strings", () => {
    expect(utcDay(new Date("2026-03-01T23:59:59.999Z"))).toBe("2026-03-01");
    expect(utcDay(new Date("2026-03-02T00:00:00.000Z"))).toBe("2026-03-02");
    expect(utcDay(new Date("2028-02-29T12:00:00Z"))).toBe("2028-02-29");
    expect(utcDay(new Date("9999-12-31T23:59:59.999Z"))).toBe("9999-12-31");
  });

  it("throws invalid_time on invalid or out-of-range dates", () => {
    const invalidDates = [new Date("x"), new Date(Date.UTC(10000, 0, 1))];

    for (const d of invalidDates) {
      expect(() => utcDay(d)).toThrow(UsageError);
      try {
        utcDay(d);
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).code).toBe("invalid_time");
      }
    }
  });
});
