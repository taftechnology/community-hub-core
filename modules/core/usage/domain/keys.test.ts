import { describe, expect, it } from "vitest";
import { UsageError } from "./error.js";
import { parseFeatureKey } from "./keys.js";

describe("parseFeatureKey", () => {
  it("accepts valid feature keys", () => {
    expect(parseFeatureKey("people.directory")).toBe("people.directory");
    expect(parseFeatureKey("a.b_c.d1")).toBe("a.b_c.d1");

    const key64 = "a." + "b".repeat(62);
    expect(key64.length).toBe(64);
    expect(parseFeatureKey(key64)).toBe(key64);
  });

  it("rejects invalid feature keys", () => {
    const invalidKeys = [
      "People.directory",
      "people",
      ".people",
      "people.",
      "",
      "a." + "b".repeat(63), // 65 chars
    ];

    for (const key of invalidKeys) {
      expect(() => parseFeatureKey(key)).toThrow(UsageError);
      try {
        parseFeatureKey(key);
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).code).toBe("invalid_feature_key");
      }
    }
  });
});
