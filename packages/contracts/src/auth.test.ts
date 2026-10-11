import { describe, expect, it } from "vitest";

import {
  passkeyAuthenticateOptionsBody,
  passkeyAuthenticateVerifyBody,
  passkeyRegisterOptionsBody,
  passkeyRegisterVerifyBody,
  refreshSessionBody,
  startEmailOtpBody,
  verifyEmailOtpBody,
} from "./auth.js";

describe("auth bodies", () => {
  it("accepts an email start and rejects an unknown key", () => {
    expect(startEmailOtpBody.safeParse({ email: "ada@example.com" }).success).toBe(true);
    expect(startEmailOtpBody.safeParse({ email: "ada@example.com", extra: 1 }).success).toBe(false);
  });

  it("accepts an eight-digit code and rejects a seven-digit code", () => {
    expect(
      verifyEmailOtpBody.safeParse({ email: "ada@example.com", code: "01234567" }).success,
    ).toBe(true);
    expect(
      verifyEmailOtpBody.safeParse({ email: "ada@example.com", code: "0123456" }).success,
    ).toBe(false);
  });

  it("rejects unknown keys on the other auth bodies", () => {
    expect(passkeyRegisterOptionsBody.safeParse({}).success).toBe(true);
    expect(passkeyRegisterOptionsBody.safeParse({ extra: 1 }).success).toBe(false);
    expect(
      passkeyRegisterVerifyBody.safeParse({
        clientDataJSON: "a",
        attestationObject: "b",
        extra: 1,
      }).success,
    ).toBe(false);
    expect(passkeyAuthenticateOptionsBody.safeParse({}).success).toBe(true);
    expect(passkeyAuthenticateVerifyBody.safeParse({ extra: 1 }).success).toBe(false);
    expect(refreshSessionBody.safeParse({ refreshToken: "a", extra: 1 }).success).toBe(false);
  });
});
