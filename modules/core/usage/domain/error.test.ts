import { describe, expect, it } from "vitest";
import { UsageError } from "./error.js";
import { parseFeatureKey } from "./keys.js";

describe("UsageError", () => {
  it("carries the code only in message and does not leak keys", () => {
    const error = new UsageError("invalid_feature_key");
    expect(error.message).toBe("invalid_feature_key");
    expect(error.code).toBe("invalid_feature_key");
    expect(error.name).toBe("UsageError");

    let thrown: unknown;
    try {
      parseFeatureKey("Bad.Key");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as UsageError).message).toBe("invalid_feature_key");
    expect((thrown as UsageError).message).not.toContain("Bad.Key");
  });
});
