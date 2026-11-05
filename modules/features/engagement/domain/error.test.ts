import { describe, expect, it } from "vitest";

import { ServiceTimesError, type ServiceTimesErrorCode } from "./error.js";

describe("ServiceTimesError", () => {
  it("creates error for version_conflict with correct name, code, and message", () => {
    const error = new ServiceTimesError("version_conflict");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ServiceTimesError);
    expect(error.name).toBe("ServiceTimesError");
    expect(error.code).toBe("version_conflict");
    expect(error.message).toBe("version_conflict");
  });

  it("creates error for invalid_input with correct name, code, and message", () => {
    const error = new ServiceTimesError("invalid_input");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ServiceTimesError);
    expect(error.name).toBe("ServiceTimesError");
    expect(error.code).toBe("invalid_input");
    expect(error.message).toBe("invalid_input");
  });

  it("only permits defined error codes at type level", () => {
    const codes: ServiceTimesErrorCode[] = ["version_conflict", "invalid_input"];
    expect(codes).toHaveLength(2);
  });
});
