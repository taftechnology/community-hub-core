import { describe, expect, it } from "vitest";

import { EntitlementError } from "./error.js";
import { parseEntitlementKey, parsePlanKey } from "./keys.js";

describe("entitlement keys", () => {
  it("accepts people.directory and rejects a plan key and a 65-character key", () => {
    expect(parseEntitlementKey("people.directory")).toBe("people.directory");
    expect(() => parseEntitlementKey("starter")).toThrow(EntitlementError);
    expect(() => parseEntitlementKey("starter")).toThrow(
      expect.objectContaining({ code: "invalid_key" }),
    );
    expect(() => parseEntitlementKey(`a.${"a".repeat(63)}`)).toThrow(EntitlementError);
  });
});

describe("plan keys", () => {
  it("accepts starter and rejects an entitlement key", () => {
    expect(parsePlanKey("starter")).toBe("starter");
    expect(() => parsePlanKey("people.directory")).toThrow(EntitlementError);
    expect(() => parsePlanKey("people.directory")).toThrow(
      expect.objectContaining({ code: "invalid_key" }),
    );
  });
});
