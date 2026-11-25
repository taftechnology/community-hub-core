import { describe, expect, it } from "vitest";

import {
  EMERGENCY_CONTACT_RELATIONSHIPS,
  MAX_EMERGENCY_CONTACTS,
  validateEmergencyContacts,
} from "./emergency-contact.js";
import { PeopleError } from "./error.js";

describe("validateEmergencyContacts", () => {
  it("exports the exact relationship list in order and cap of 5", () => {
    expect(EMERGENCY_CONTACT_RELATIONSHIPS).toEqual([
      "spouse",
      "grandparent",
      "relative",
      "neighbour",
      "friend",
      "carer",
      "other",
    ]);
    expect(MAX_EMERGENCY_CONTACTS).toBe(5);
  });

  it("accepts a clean array of contacts with all allowed relationships", () => {
    const input = [
      { name: "Alice Smith", relationship: "spouse", phone: "+61 412 555 101" },
      { name: "Bob Jones", relationship: "grandparent", phone: "+61 412 555 102" },
      { name: "Carol White", relationship: "relative", phone: "+61 412 555 103" },
      { name: "David Brown", relationship: "neighbour", phone: "+61 412 555 104" },
      { name: "Eve Green", relationship: null, phone: "+61 412 555 105" },
    ];
    const clean = validateEmergencyContacts(input);
    expect(clean).toEqual([
      { name: "Alice Smith", relationship: "spouse", phone: "61412555101" },
      { name: "Bob Jones", relationship: "grandparent", phone: "61412555102" },
      { name: "Carol White", relationship: "relative", phone: "61412555103" },
      { name: "David Brown", relationship: "neighbour", phone: "61412555104" },
      { name: "Eve Green", relationship: null, phone: "61412555105" },
    ]);
  });

  it("accepts friend, carer, other and omitted relationship", () => {
    const input = [
      { name: "Frank Friend", relationship: "friend", phone: "+61 412 555 106" },
      { name: "Grace Carer", relationship: "carer", phone: "+61 412 555 107" },
      { name: "Hank Other", relationship: "other", phone: "+61 412 555 108" },
      { name: "Ian NoRel", phone: "+61 412 555 109" },
    ];
    const clean = validateEmergencyContacts(input);
    expect(clean).toEqual([
      { name: "Frank Friend", relationship: "friend", phone: "61412555106" },
      { name: "Grace Carer", relationship: "carer", phone: "61412555107" },
      { name: "Hank Other", relationship: "other", phone: "61412555108" },
      { name: "Ian NoRel", relationship: null, phone: "61412555109" },
    ]);
  });

  it("trims whitespace from name", () => {
    const input = [{ name: "   Jack Taylor   ", relationship: "spouse", phone: "+61 412 555 110" }];
    const clean = validateEmergencyContacts(input);
    expect(clean).toEqual([{ name: "Jack Taylor", relationship: "spouse", phone: "61412555110" }]);
  });

  it("accepts an empty array", () => {
    expect(validateEmergencyContacts([])).toEqual([]);
  });

  it("refuses non-array input with invalid_input", () => {
    for (const bad of [null, undefined, "not an array", 123, {}, true]) {
      expect(() => validateEmergencyContacts(bad)).toThrowError(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
  });

  it("refuses more than 5 contacts with invalid_input", () => {
    const input = [
      { name: "A", relationship: "spouse", phone: "+61 412 555 101" },
      { name: "B", relationship: "friend", phone: "+61 412 555 102" },
      { name: "C", relationship: "carer", phone: "+61 412 555 103" },
      { name: "D", relationship: "other", phone: "+61 412 555 104" },
      { name: "E", relationship: "relative", phone: "+61 412 555 105" },
      { name: "F", relationship: "neighbour", phone: "+61 412 555 106" },
    ];
    expect(() => validateEmergencyContacts(input)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("refuses unknown keys on contact entry with invalid_input", () => {
    const input = [
      { name: "A", relationship: "spouse", phone: "+61 412 555 101", notes: "Extra note" },
    ];
    expect(() => validateEmergencyContacts(input)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("refuses non-object or array contact entry with invalid_input", () => {
    for (const badEntry of [null, undefined, "string", 123, []]) {
      expect(() => validateEmergencyContacts([badEntry])).toThrowError(
        expect.objectContaining({ code: "invalid_input" }),
      );
    }
  });

  it("refuses empty or whitespace-only name with invalid_name", () => {
    for (const badName of ["", "   ", "\t"]) {
      expect(() =>
        validateEmergencyContacts([{ name: badName, phone: "+61 412 555 101" }]),
      ).toThrowError(expect.objectContaining({ code: "invalid_name" }));
    }
  });

  it("refuses non-string name with invalid_name", () => {
    expect(() =>
      validateEmergencyContacts([{ name: 123 as never, phone: "+61 412 555 101" }]),
    ).toThrowError(expect.objectContaining({ code: "invalid_name" }));
  });

  it("accepts name up to 100 characters", () => {
    const longName = "A".repeat(100);
    const clean = validateEmergencyContacts([{ name: longName, phone: "+61 412 555 101" }]);
    expect(clean[0]?.name).toBe(longName);
  });

  it("refuses name over 100 characters with invalid_name", () => {
    const longName = "A".repeat(101);
    expect(() =>
      validateEmergencyContacts([{ name: longName, phone: "+61 412 555 101" }]),
    ).toThrowError(expect.objectContaining({ code: "invalid_name" }));
  });

  it("refuses control characters in name with invalid_name", () => {
    for (const badName of ["Alice\nSmith", "Bob\tJones", "Carol\x00White", "David\x7fBrown"]) {
      expect(() =>
        validateEmergencyContacts([{ name: badName, phone: "+61 412 555 101" }]),
      ).toThrowError(expect.objectContaining({ code: "invalid_name" }));
    }
  });

  it("refuses a relationship outside the list, a child included", () => {
    for (const badRel of ["child", "daughter", "son", "mother", "father", "doctor", ""]) {
      expect(() =>
        validateEmergencyContacts([
          { name: "Test Person", relationship: badRel as never, phone: "+61 412 555 101" },
        ]),
      ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    }
  });

  it("refuses invalid phone with invalid_phone", () => {
    for (const badPhone of ["not-a-phone", "123", "abc", "+123"]) {
      expect(() =>
        validateEmergencyContacts([
          { name: "Test Person", relationship: "friend", phone: badPhone },
        ]),
      ).toThrowError(expect.objectContaining({ code: "invalid_phone" }));
    }
  });

  it("never puts input values in error messages", () => {
    try {
      validateEmergencyContacts([
        { name: "SecretName", relationship: "badRelValue", phone: "+61 412 555 101" },
      ]);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(PeopleError);
      const msg = (err as Error).message;
      expect(msg).not.toContain("SecretName");
      expect(msg).not.toContain("badRelValue");
    }
  });
});
