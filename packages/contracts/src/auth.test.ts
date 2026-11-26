import { describe, expect, it } from "vitest";

import {
  adminSessionAnswer,
  endSessionBody,
  firstFactorBackupCodesAnswer,
  freshPasskeyOptionsBody,
  freshPasskeyVerifyBody,
  freshTotpBody,
  passkeyAuthenticateOptionsAnswer,
  passkeyAuthenticateOptionsBody,
  passkeyAuthenticateVerifyBody,
  passkeyRegisterOptionsAnswer,
  passkeyRegisterOptionsBody,
  passkeyRegisterVerifyBody,
  refreshSessionBody,
  regenerateBackupCodesAnswer,
  regenerateBackupCodesBody,
  removePasskeyBody,
  removeTotpBody,
  secondFactorListAnswer,
  secondFactorPasskeyOptionsBody,
  secondFactorPasskeyVerifyBody,
  secondFactorVerifyAnswer,
  secondFactorVerifyBody,
  startEmailOtpBody,
  totpConfirmBody,
  totpStartAnswer,
  totpStartBody,
  verifyEmailOtpAnswer,
  verifyEmailOtpBody,
} from "./auth.js";

// A stand-in for a TOTP key. It is built at run time, so no key-shaped literal sits in the source.
const SYNTHETIC_KEY = "A".repeat(32);

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
    expect(endSessionBody.safeParse({}).success).toBe(true);
    expect(endSessionBody.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("validates second-factor request bodies strictly", () => {
    expect(secondFactorVerifyBody.safeParse({ method: "totp", code: "123456" }).success).toBe(true);
    expect(
      secondFactorVerifyBody.safeParse({ method: "backup_code", code: "ABCD-EFGH-IJKL" }).success,
    ).toBe(true);
    expect(secondFactorVerifyBody.safeParse({ method: "email", code: "12345678" }).success).toBe(
      false,
    );
    expect(
      secondFactorVerifyBody.safeParse({ method: "totp", code: "123456", extra: true }).success,
    ).toBe(false);

    expect(secondFactorPasskeyOptionsBody.safeParse({}).success).toBe(true);
    expect(secondFactorPasskeyOptionsBody.safeParse({ extra: 1 }).success).toBe(false);
    expect(
      secondFactorPasskeyVerifyBody.safeParse({
        credentialId: "a",
        clientDataJSON: "b",
        authenticatorData: "c",
        signature: "d",
      }).success,
    ).toBe(true);
    expect(
      secondFactorPasskeyVerifyBody.safeParse({
        credentialId: "a",
        clientDataJSON: "b",
        authenticatorData: "c",
        signature: "d",
        extra: 1,
      }).success,
    ).toBe(false);

    expect(totpStartBody.safeParse({}).success).toBe(true);
    expect(totpStartBody.safeParse({ extra: 1 }).success).toBe(false);
    expect(totpConfirmBody.safeParse({ code: "123456" }).success).toBe(true);
    expect(totpConfirmBody.safeParse({ code: "123456", extra: 1 }).success).toBe(false);

    expect(freshTotpBody.safeParse({ code: "123456" }).success).toBe(true);
    expect(freshTotpBody.safeParse({ code: "123456", extra: 1 }).success).toBe(false);
    expect(freshPasskeyOptionsBody.safeParse({}).success).toBe(true);
    expect(freshPasskeyOptionsBody.safeParse({ extra: 1 }).success).toBe(false);
    expect(
      freshPasskeyVerifyBody.safeParse({
        credentialId: "a",
        clientDataJSON: "b",
        authenticatorData: "c",
        signature: "d",
        extra: 1,
      }).success,
    ).toBe(false);

    expect(removeTotpBody.safeParse({}).success).toBe(true);
    expect(removeTotpBody.safeParse({ extra: 1 }).success).toBe(false);
    expect(
      removePasskeyBody.safeParse({
        passkeyId: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(true);
    expect(
      removePasskeyBody.safeParse({
        passkeyId: "00000000-0000-4000-8000-000000000001",
        extra: 1,
      }).success,
    ).toBe(false);
    expect(regenerateBackupCodesBody.safeParse({}).success).toBe(true);
    expect(regenerateBackupCodesBody.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("auth answers", () => {
  it("the email-code verify answer rejects a payload with a refresh token", () => {
    const valid = {
      secondFactor: "verify",
      methods: ["totp", "passkey", "backup_code"],
      passkeysAvailable: true,
      accessToken: "access-token",
      expiresIn: 900,
    };
    expect(verifyEmailOtpAnswer.safeParse(valid).success).toBe(true);
    expect(
      verifyEmailOtpAnswer.safeParse({
        ...valid,
        refreshToken: "refresh-token",
      }).success,
    ).toBe(false);
  });

  it("the factor list answer rejects a payload with a secret", () => {
    const valid = {
      totp: { confirmedAt: "2026-11-26T00:00:00.000Z" },
      passkeys: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          createdAt: "2026-11-26T00:00:00.000Z",
        },
      ],
      backupCodesLeft: 8,
      freshUntil: "2026-11-26T00:05:00.000Z",
    };
    expect(secondFactorListAnswer.safeParse(valid).success).toBe(true);
    expect(
      secondFactorListAnswer.safeParse({
        ...valid,
        secret: SYNTHETIC_KEY,
      }).success,
    ).toBe(false);
    expect(
      secondFactorListAnswer.safeParse({
        ...valid,
        totp: {
          confirmedAt: "2026-11-26T00:00:00.000Z",
          secret: SYNTHETIC_KEY,
        },
      }).success,
    ).toBe(false);
  });

  it("validates the remaining strict answer schemas", () => {
    const adminSession = {
      userId: "00000000-0000-4000-8000-000000000001",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 900,
    };
    expect(adminSessionAnswer.safeParse(adminSession).success).toBe(true);
    expect(adminSessionAnswer.safeParse({ ...adminSession, extra: 1 }).success).toBe(false);

    expect(secondFactorVerifyAnswer.safeParse(adminSession).success).toBe(true);
    expect(
      secondFactorVerifyAnswer.safeParse({ ...adminSession, backupCodesLeft: 9 }).success,
    ).toBe(true);
    expect(secondFactorVerifyAnswer.safeParse({ ...adminSession, extra: 1 }).success).toBe(false);

    expect(
      totpStartAnswer.safeParse({
        secret: SYNTHETIC_KEY,
        otpauthUri: `otpauth://totp/Community%20Hub?secret=${SYNTHETIC_KEY}&issuer=Community%20Hub&algorithm=SHA1&digits=6&period=30`,
      }).success,
    ).toBe(true);
    expect(
      totpStartAnswer.safeParse({
        secret: SYNTHETIC_KEY,
        otpauthUri: "otpauth://totp/Community%20Hub",
        extra: 1,
      }).success,
    ).toBe(false);

    expect(
      firstFactorBackupCodesAnswer.safeParse({
        ...adminSession,
        backupCodes: ["AAAAAAAAAAAA"],
      }).success,
    ).toBe(true);
    expect(
      firstFactorBackupCodesAnswer.safeParse({
        ...adminSession,
        backupCodes: ["AAAAAAAAAAAA"],
        extra: 1,
      }).success,
    ).toBe(false);

    expect(regenerateBackupCodesAnswer.safeParse({ backupCodes: ["AAAAAAAAAAAA"] }).success).toBe(
      true,
    );
    expect(
      regenerateBackupCodesAnswer.safeParse({ backupCodes: ["AAAAAAAAAAAA"], extra: 1 }).success,
    ).toBe(false);

    expect(
      passkeyAuthenticateOptionsAnswer.safeParse({
        challenge: "YQ",
        rpId: "admin.au.example.test",
        userVerification: "required",
      }).success,
    ).toBe(true);
    expect(
      passkeyAuthenticateOptionsAnswer.safeParse({
        challenge: "YQ",
        rpId: "admin.au.example.test",
        userVerification: "preferred",
      }).success,
    ).toBe(false);

    expect(
      passkeyRegisterOptionsAnswer.safeParse({
        challenge: "YQ",
        rp: { id: "admin.au.example.test", name: "Community Hub" },
        user: { id: "YQ", name: "ada@example.test", displayName: "ada@example.test" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        attestation: "none",
        authenticatorSelection: { userVerification: "required", residentKey: "required" },
        excludeCredentials: [],
      }).success,
    ).toBe(true);
  });
});
