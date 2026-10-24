import { describe, expect, it } from "vitest";

import { normaliseEnrolmentCode } from "./enrolment-code.js";

describe("normaliseEnrolmentCode", () => {
  it("refuses codes under 26 characters and accepts 26 characters", () => {
    expect(normaliseEnrolmentCode("A".repeat(25))).toBeNull();
    expect(normaliseEnrolmentCode("A".repeat(26))).toBe("A".repeat(26));
  });

  it("refuses digits 0, 1, 8, 9 and underscore", () => {
    expect(normaliseEnrolmentCode("0" + "A".repeat(25))).toBeNull();
    expect(normaliseEnrolmentCode("1" + "A".repeat(25))).toBeNull();
    expect(normaliseEnrolmentCode("8" + "A".repeat(25))).toBeNull();
    expect(normaliseEnrolmentCode("9" + "A".repeat(25))).toBeNull();
    expect(normaliseEnrolmentCode("_" + "A".repeat(25))).toBeNull();
    expect(normaliseEnrolmentCode("A".repeat(25) + "_")).toBeNull();
  });

  it("refuses padding: = at start, = at end, and a 26-character code containing one =", () => {
    expect(normaliseEnrolmentCode("=" + "A".repeat(26))).toBeNull();
    expect(normaliseEnrolmentCode("A".repeat(26) + "=")).toBeNull();
    expect(normaliseEnrolmentCode("A".repeat(25) + "=")).toBeNull();
    expect(normaliseEnrolmentCode("=" + "A".repeat(25))).toBeNull();
    expect(normaliseEnrolmentCode("A".repeat(12) + "=" + "A".repeat(13))).toBeNull();
  });

  it("normalises lower case, spaces and hyphens", () => {
    expect(normaliseEnrolmentCode("abcd efgh-ijkl mnop qrst uvwx yz")).toBe(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    );
    expect(normaliseEnrolmentCode("2345-67ab-cdef-ghij-klmn-opqr-stuv")).toBe(
      "234567ABCDEFGHIJKLMNOPQRSTUV",
    );
  });

  it("refuses codes above 128 characters", () => {
    expect(normaliseEnrolmentCode("A".repeat(128))).toBe("A".repeat(128));
    expect(normaliseEnrolmentCode("A".repeat(129))).toBeNull();
    expect(normaliseEnrolmentCode("A".repeat(150))).toBeNull();
  });

  it("refuses empty or whitespace-only input", () => {
    expect(normaliseEnrolmentCode("")).toBeNull();
    expect(normaliseEnrolmentCode("   --  ")).toBeNull();
  });
});
