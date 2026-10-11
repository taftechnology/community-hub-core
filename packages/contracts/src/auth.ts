import { z } from "zod";

const bytes = z.string().min(1);

export const startEmailOtpBody = z.strictObject({
  email: z.string().min(1),
});

export const verifyEmailOtpBody = z.strictObject({
  email: z.string().min(1),
  code: z.string().regex(/^\d{8}$/),
});

export const passkeyRegisterOptionsBody = z.strictObject({});

export const passkeyRegisterVerifyBody = z.strictObject({
  clientDataJSON: bytes,
  attestationObject: bytes,
});

export const passkeyAuthenticateOptionsBody = z.strictObject({});

export const passkeyAuthenticateVerifyBody = z.strictObject({
  credentialId: bytes,
  clientDataJSON: bytes,
  authenticatorData: bytes,
  signature: bytes,
});

export const refreshSessionBody = z.strictObject({
  refreshToken: bytes,
});
