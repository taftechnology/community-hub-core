import { describe, expect, it } from "vitest";

import { PeopleError } from "./error.js";
import {
  birthdayMd,
  isMinor,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  normaliseTag,
  resolveAge,
} from "./person.js";

const SYDNEY_ELEVENTH = new Date("2026-10-11T00:00:00+11:00");

function throwsCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PeopleError);
    expect(error).toBeInstanceOf(Error);
    expect((error as PeopleError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("person domain", () => {
  it("computes a minor from the Sydney civil date", () => {
    expect(isMinor("2008-10-12", SYDNEY_ELEVENTH)).toBe(true);
    expect(isMinor("2008-10-11", SYDNEY_ELEVENTH)).toBe(false);
    expect(isMinor(null, SYDNEY_ELEVENTH)).toBe(true);
    expect(isMinor("2008-02-29", new Date("2026-02-28T12:00:00+11:00"))).toBe(true);
    expect(isMinor("2008-02-29", new Date("2026-03-01T12:00:00+11:00"))).toBe(false);
    expect(birthdayMd("2008-10-11")).toBe(1011);
    expect(birthdayMd(null)).toBeNull();
  });

  it("keeps a missing date of birth as a minor unless the caller declares an adult", () => {
    expect(resolveAge("2008-10-11", false, SYDNEY_ELEVENTH)).toEqual({
      isMinor: false,
      ageBasis: "date_of_birth",
    });
    expect(resolveAge("2008-10-11", true, SYDNEY_ELEVENTH)).toEqual({
      isMinor: false,
      ageBasis: "date_of_birth",
    });
    expect(resolveAge("2008-10-12", false, SYDNEY_ELEVENTH)).toEqual({
      isMinor: true,
      ageBasis: "date_of_birth",
    });
    throwsCode(() => resolveAge("2008-10-12", true, SYDNEY_ELEVENTH), "invalid_declaration");
    expect(resolveAge(null, true, SYDNEY_ELEVENTH)).toEqual({
      isMinor: false,
      ageBasis: "declared_adult",
    });
    expect(resolveAge(null, false, SYDNEY_ELEVENTH)).toEqual({
      isMinor: true,
      ageBasis: "unknown",
    });
  });

  it("treats only the boolean true as a declaration of adulthood", () => {
    const unknown = { isMinor: true, ageBasis: "unknown" };
    expect(resolveAge(null, "false" as never, SYDNEY_ELEVENTH)).toEqual(unknown);
    expect(resolveAge(null, 1 as never, SYDNEY_ELEVENTH)).toEqual(unknown);
    expect(resolveAge(null, "true" as never, SYDNEY_ELEVENTH)).toEqual(unknown);
  });

  it("rejects a date that is not a real past calendar day", () => {
    throwsCode(() => isMinor("2026-02-31", SYDNEY_ELEVENTH), "invalid_date");
    throwsCode(() => isMinor("11/10/2008", SYDNEY_ELEVENTH), "invalid_date");
    throwsCode(() => isMinor("2026-10-12", SYDNEY_ELEVENTH), "invalid_date");
  });

  it("normalises an email the way identity does", () => {
    expect(normaliseEmail("Ada@Example.com")).toBe("ada@example.com");
    expect(normaliseEmail("ada@example.com")).toBe("ada@example.com");
    for (const value of [
      "",
      "ada",
      "a da@example.com",
      "ada@@example.com",
      "ada@example",
      "ada@-example.com",
      "ada@exam\nple.com",
    ]) {
      throwsCode(() => normaliseEmail(value), "invalid_email");
    }
  });

  it("normalises a phone to digits", () => {
    expect(normalisePhone("+61 412 345 678")).toBe("61412345678");
    throwsCode(() => normalisePhone("12"), "invalid_phone");
  });

  it("trims a name and rejects a control character or 81 characters", () => {
    expect(normaliseName(" Ada ")).toBe("Ada");
    throwsCode(() => normaliseName("Ada\n"), "invalid_name");
    throwsCode(() => normaliseName("a".repeat(81)), "invalid_name");
  });

  it("stores a tag in lowercase", () => {
    expect(normaliseTag("Choir")).toBe("choir");
    throwsCode(() => normaliseTag("A_b"), "invalid_tag");
  });
});
