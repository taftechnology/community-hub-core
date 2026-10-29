import { describe, expect, it } from "vitest";

import { GroupsError } from "./error.js";
import { normaliseName, parseGroupName } from "./name.js";

describe("normaliseName", () => {
  it("normalises padding and internal runs of spaces", () => {
    expect(normaliseName(" Youth  Group ")).toBe("youth group");
    expect(normaliseName("youth group")).toBe("youth group");
  });

  it("normalises NFC versus NFD to the same key", () => {
    const nfc = "Caf\u00e9";
    const nfd = "Cafe\u0301";
    expect(normaliseName(nfc)).toBe("caf\u00e9");
    expect(normaliseName(nfd)).toBe("caf\u00e9");
    expect(normaliseName(nfc)).toBe(normaliseName(nfd));
  });

  it("converts uppercase to lowercase", () => {
    expect(normaliseName("YOUTH GROUP")).toBe("youth group");
  });
});

describe("parseGroupName", () => {
  it("rejects an empty name", () => {
    expect(() => parseGroupName("")).toThrow(GroupsError);
    try {
      parseGroupName("");
    } catch (err) {
      expect(err).toBeInstanceOf(GroupsError);
      expect((err as GroupsError).code).toBe("invalid_input");
    }
  });

  it("rejects whitespace-only name", () => {
    expect(() => parseGroupName("   ")).toThrow(GroupsError);
    try {
      parseGroupName("   ");
    } catch (err) {
      expect(err).toBeInstanceOf(GroupsError);
      expect((err as GroupsError).code).toBe("invalid_input");
    }
  });

  it("rejects a name longer than 120 characters after trim", () => {
    const longName = "a".repeat(121);
    expect(() => parseGroupName(longName)).toThrow(GroupsError);
    try {
      parseGroupName(longName);
    } catch (err) {
      expect(err).toBeInstanceOf(GroupsError);
      expect((err as GroupsError).code).toBe("invalid_input");
    }
  });

  it("accepts a 120-character name", () => {
    const valid120 = "a".repeat(120);
    const parsed = parseGroupName(valid120);
    expect(parsed.name).toBe(valid120);
    expect(parsed.nameKey).toBe(valid120);
  });

  it("trims and returns both name and nameKey", () => {
    const parsed = parseGroupName("  Youth  Ministry  ");
    expect(parsed.name).toBe("Youth  Ministry");
    expect(parsed.nameKey).toBe("youth ministry");
  });
});
