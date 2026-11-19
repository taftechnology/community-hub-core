import { describe, expect, it } from "vitest";

import { isUnder18OnSydneyDate } from "./sydney-age";

describe("isUnder18OnSydneyDate", () => {
  it("is under 18 the day before the 18th birthday", () => {
    // 2026-11-18 12:00 in Sydney (UTC+11).
    const now = new Date("2026-11-18T01:00:00Z");
    expect(isUnder18OnSydneyDate("2008-11-19", now)).toBe(true);
  });

  it("is not under 18 on the 18th birthday", () => {
    const now = new Date("2026-11-18T01:00:00Z");
    expect(isUnder18OnSydneyDate("2008-11-18", now)).toBe(false);
  });

  it("counts the 18th birthday on the Sydney date when the UTC date is still the day before", () => {
    // 2026-11-17 20:00 UTC is 2026-11-18 07:00 in Sydney.
    const now = new Date("2026-11-17T20:00:00Z");
    expect(isUnder18OnSydneyDate("2008-11-18", now)).toBe(false);
  });

  it("treats a 29 February birthday as the server does", () => {
    // Born 2008-02-29: the 18th birthday falls in 2026, which has no 29 February.
    // The server counts completed years by month and day, so the birthday is reached on 1 March.
    expect(isUnder18OnSydneyDate("2008-02-29", new Date("2026-02-28T01:00:00Z"))).toBe(true);
    expect(isUnder18OnSydneyDate("2008-02-29", new Date("2026-03-01T01:00:00Z"))).toBe(false);
  });
});
